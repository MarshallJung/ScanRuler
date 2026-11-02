// SPDX-License-Identifier: AGPL-3.0-only

import type { SolidFaceMeta } from '../../../src/app/solids'
import { assembleLinearSystem, recoverReactionsAndEquilibrium } from '../core/assembly'
import { validateIsotropicMaterial } from '../core/materials'
import { generateTet10Mesh } from '../core/mesher'
import { buildSurfacePatches } from '../core/patches'
import { recoverStressesAndDiagnostics } from '../core/postprocess'
import {
  auditTopologyAndThickness,
  centerCoordinates,
  weldSolidSeams,
} from '../core/preflight'
import { verifyBoundaryConditions } from '../core/rigidity'
import { solvePcgBsr3 } from '../core/solver'
import type {
  BoundaryCondition,
  FeaMeshSettings,
  FeaSolutionPayload,
  IsotropicMaterial,
  PreflightReport,
  RigidityReport,
  WeldedSurfaceMesh,
} from '../core/types'

export interface FeaPreflightInput {
  positions: Float32Array
  indices: Uint32Array
  faceHash?: Int32Array
  faces?: readonly SolidFaceMeta[]
  mergedPairs: ReadonlyArray<readonly [number, number]>
}

export interface FeaPreflightOutput {
  welded: WeldedSurfaceMesh
  preflight: PreflightReport
}

export interface FeaRigidityInput {
  welded: WeldedSurfaceMesh
  bcs: readonly BoundaryCondition[]
}

export interface FeaSolveInput {
  welded: WeldedSurfaceMesh
  material: IsotropicMaterial
  bcs: readonly BoundaryCondition[]
  meshSettings: FeaMeshSettings
}

export interface FeaSolveOutput {
  rigidity: RigidityReport
  solution: FeaSolutionPayload
}

export type FeaWorkerReq =
  | { requestId: number; type: 'preflight'; payload: FeaPreflightInput }
  | { requestId: number; type: 'checkRigidity'; payload: FeaRigidityInput }
  | { requestId: number; type: 'solvePipeline'; payload: FeaSolveInput }

export type FeaWorkerRes =
  | { requestId: number; type: 'progress'; stage: string }
  | { requestId: number; type: 'preflightResult'; result: FeaPreflightOutput }
  | { requestId: number; type: 'rigidityResult'; result: RigidityReport }
  | { requestId: number; type: 'solveResult'; result: FeaSolveOutput }
  | { requestId: number; type: 'error'; message: string }

/**
 * Execute Stage 1-2 pre-flight geometry & topology verification.
 */
export function executePreflightPipeline(
  input: FeaPreflightInput,
  onProgress?: (stage: string) => void,
): FeaPreflightOutput {
  onProgress?.('Gate 1.3: Centering solid coordinates...')
  const { centered, centroidOffset, bboxMin, bboxMax } = centerCoordinates(input.positions)

  onProgress?.('Gate 2.1: Welding B-Rep seam vertices...')
  const seamResult = weldSolidSeams(centered, input.indices)

  onProgress?.('Segmenting CAD faces / dihedral patches...')
  const patchResult = buildSurfacePatches(
    seamResult.positions,
    seamResult.indices,
    input.faceHash,
    input.faces,
    input.mergedPairs,
  )

  const welded: WeldedSurfaceMesh = {
    positions: seamResult.positions,
    indices: seamResult.indices,
    trianglePatch: patchResult.trianglePatch,
    patches: patchResult.patches,
    reentrantEdges: patchResult.reentrantEdges,
    centroidOffset,
    bboxMin,
    bboxMax,
  }

  onProgress?.('Gate 2.1-2.6: Auditing watertight topology and wall thickness...')
  const preflight = auditTopologyAndThickness(welded)
  return { welded, preflight }
}

/**
 * Execute Stage 4 boundary condition and rigid-body restraint verification.
 */
export function executeRigidityCheck(input: FeaRigidityInput): RigidityReport {
  return verifyBoundaryConditions(input.welded, input.bcs)
}

/**
 * Execute full Stage 3-7 FEA pipeline (`Tet10` meshing, `BSR-3` assembly,
 * `PCG` solve, `ZZ-SPR` stress recovery, and equilibrium/linearity checks).
 */
export function executeSolvePipeline(
  input: FeaSolveInput,
  onProgress?: (stage: string) => void,
): FeaSolveOutput {
  const tStart = performance.now()

  // Gate 3: Material positivity & compressibility
  const matCheck = validateIsotropicMaterial(input.material)
  if (!matCheck.passed) {
    throw new Error(`Gate 3 failed: ${matCheck.errors.join(' ')}`)
  }

  // Gate 4: Boundary condition disjointness, finite patch area, and 6-RBM restraint
  onProgress?.('Gate 4: Verifying rigid-body restraint...')
  const rigidity = verifyBoundaryConditions(input.welded, input.bcs)
  if (!rigidity.passed) {
    throw new Error(`Gate 4 failed: ${rigidity.blockingErrors.join(' ')}`)
  }

  // Gate 5: Tet10 volume meshing and Jacobian / Knupp quality audit
  onProgress?.('Gate 5: Generating 10-node quadratic tetrahedral mesh...')
  const mesh = generateTet10Mesh(input.welded, input.meshSettings, onProgress)
  if (mesh.invertedCount > 0) {
    throw new Error(
      `Gate 5.2 failed: Volume mesh contains ${mesh.invertedCount} inverted Tet10 element(s) (min det(J) = ${mesh.minJacobianDet.toExponential(2)}).`,
    )
  }

  // Gate 6.1: BSR-3 sparse assembly & symmetric Dirichlet elimination
  onProgress?.('Gate 6.1: Assembling BSR-3 stiffness and boundary conditions...')
  const system = assembleLinearSystem(mesh, input.material, input.bcs, onProgress)

  // Gate 6.2: Preconditioned Conjugate Gradient solve
  onProgress?.('Gate 6.2: Solving linear system via Preconditioned Conjugate Gradient...')
  const pcg = solvePcgBsr3(system.systemMatrix, system.systemRhs, {
    tol: 1e-10,
    isConstrainedDof: system.isConstrainedDofRcm,
    nodeCoords: system.nodesRcm,
    onProgress: (iter, relRes) => {
      onProgress?.(`Gate 6.2: PCG iteration ${iter} (rel. residual ${relRes.toExponential(2)})...`)
    },
  })

  if (!pcg.converged && pcg.trueRelativeResidual > 1e-4) {
    throw new Error(
      `Gate 6.2 failed: PCG solver did not converge (residual ${pcg.trueRelativeResidual.toExponential(2)} after ${pcg.iterations} iterations).`,
    )
  }

  // Gate 6.3-6.4: Reaction recovery & global force/moment equilibrium check
  onProgress?.('Gate 6.4: Verifying global force and moment equilibrium...')
  const { displacementsOrig, reactionsOrig, equilibrium } = recoverReactionsAndEquilibrium(
    system,
    pcg.solution,
  )

  const solveTimeMs = Math.max(1, performance.now() - tStart)

  // Gate 7.1-7.6: ZZ-SPR stress recovery, Cardano principal stresses, FoS, and singularity masking
  onProgress?.('Gate 7: Recovering ZZ-SPR stresses and computing safety metrics...')
  const post = recoverStressesAndDiagnostics(
    mesh,
    input.material,
    input.bcs,
    displacementsOrig,
    equilibrium,
    {
      iterations: pcg.iterations,
      relativeResidual: pcg.trueRelativeResidual,
      solveTimeMs,
    },
    input.welded.reentrantEdges,
    input.welded.positions,
  )

  const dispF32 = new Float32Array(displacementsOrig.length)
  const reactF32 = new Float32Array(reactionsOrig.length)
  for (let i = 0; i < displacementsOrig.length; i++) {
    dispF32[i] = displacementsOrig[i]
    reactF32[i] = reactionsOrig[i]
  }

  const solution: FeaSolutionPayload = {
    mesh,
    displacements: dispF32,
    reactions: reactF32,
    vonMises: post.vonMises,
    sigma1: post.sigma1,
    sigma3: post.sigma3,
    safetyFactor: post.safetyFactor,
    nodalEtaZz: post.nodalEtaZz,
    singularFaceMask: post.singularFaceMask,
    metrics: post.metrics,
  }

  return { rigidity, solution }
}

// SPDX-License-Identifier: AGPL-3.0-only

import {
  addBlock3x3Upper,
  buildBsr3Graph,
  computeRcmOrdering,
  spmvBsr3,
} from './bsrMatrix'
import {
  TRI6_QUAD6,
  computeTet10ElementStiffness,
  evalTri6ShapeAndGrad,
  integrateTri6RobinStiffness,
  integrateTri6Traction,
} from './elements'
import { buildIsotropicVoigt6x6 } from './materials'
import type {
  BoundaryCondition,
  BsrMatrix3x3,
  EquilibriumReport,
  IsotropicMaterial,
  Rbe3BoundaryCondition,
  Tet10VolumeMesh,
} from './types'

export interface AssembledLinearSystem {
  /** Symmetrically Dirichlet-eliminated BSR-3 matrix in RCM block ordering */
  systemMatrix: BsrMatrix3x3
  /** Purely elastic BSR-3 stiffness matrix (without Dirichlet elimination or Robin springs) in RCM block ordering */
  elasticMatrix: BsrMatrix3x3
  /** Robin + oblique-sliding stiffness matrix in RCM block ordering */
  robinMatrix: BsrMatrix3x3
  /** Symmetrically Dirichlet-eliminated right-hand side vector in RCM DOF ordering (length 3*N) */
  systemRhs: Float64Array
  /** Unmodified external nodal force vector in RCM DOF ordering (length 3*N) */
  externalForceRcm: Float64Array
  /** Prescribed displacement vector in RCM DOF ordering (length 3*N) */
  prescribedDispRcm: Float64Array
  /** 1 if RCM DOF d is constrained by a Dirichlet BC, 0 if free (length 3*N) */
  isConstrainedDofRcm: Uint8Array
  /** RCM permutation: original node I -> RCM block B */
  oldToNewNode: Int32Array
  /** Inverse RCM permutation: RCM block B -> original node I */
  newToOldNode: Int32Array
  /** Node coordinates in RCM block ordering (length 3*N) */
  nodesRcm: Float64Array
  /** Mean diagonal stiffness entry used for Dirichlet scaling */
  kDiagMean: number
  /** Diagonal ratio max(K_ii) / min(K_ii) before Dirichlet elimination (Gate 6.1) */
  diagConditionRatio: number
  /** Characteristic external load norm (N) for equilibrium normalization */
  characteristicForceN: number
}

/**
 * Assemble the global `BSR-3` stiffness matrix, Robin foundation stiffness,
 * external surface traction/pressure/RBE3 loads, and apply symmetric Dirichlet
 * elimination (`Gate 6.1`).
 */
export function assembleLinearSystem(
  mesh: Tet10VolumeMesh,
  material: IsotropicMaterial,
  bcs: readonly BoundaryCondition[],
  onProgress?: (stage: string) => void,
): AssembledLinearSystem {
  const nodeCount = mesh.nodes.length / 3
  const elemCount = mesh.tet10.length / 10
  const triCount = mesh.tri6.length / 6

  onProgress?.('Computing Reverse Cuthill-McKee bandwidth reduction...')

  // Build element node lists for RCM and BSR-3 graph construction
  const rawElemNodes: Int32Array[] = new Array(elemCount)
  for (let e = 0; e < elemCount; e++) {
    const arr = new Int32Array(10)
    const base = e * 10
    for (let i = 0; i < 10; i++) arr[i] = mesh.tet10[base + i]
    rawElemNodes[e] = arr
  }

  const { oldToNew: oldToNewNode, newToOld: newToOldNode } = computeRcmOrdering(nodeCount, rawElemNodes)

  const nodesRcm = new Float64Array(nodeCount * 3)
  for (let b = 0; b < nodeCount; b++) {
    const orig = newToOldNode[b]
    nodesRcm[b * 3] = mesh.nodes[orig * 3]
    nodesRcm[b * 3 + 1] = mesh.nodes[orig * 3 + 1]
    nodesRcm[b * 3 + 2] = mesh.nodes[orig * 3 + 2]
  }

  // Convert element connectivity into RCM block indices
  const rcmElemNodes: Int32Array[] = new Array(elemCount)
  for (let e = 0; e < elemCount; e++) {
    const arr = new Int32Array(10)
    const base = e * 10
    for (let i = 0; i < 10; i++) {
      arr[i] = oldToNewNode[mesh.tet10[base + i]]
    }
    rcmElemNodes[e] = arr
  }

  onProgress?.('Building BSR-3 sparse block graph...')
  const elasticMatrix = buildBsr3Graph(nodeCount, rcmElemNodes)
  const robinMatrix: BsrMatrix3x3 = {
    blockRows: nodeCount,
    rowPtr: elasticMatrix.rowPtr,
    colIdx: elasticMatrix.colIdx,
    values: new Float64Array(elasticMatrix.values.length),
    diagPtr: elasticMatrix.diagPtr,
  }

  onProgress?.('Integrating 10-node quadratic tetrahedral stiffnesses...')
  const cVoigt = buildIsotropicVoigt6x6(material.youngsModulusMPa, material.poissonsRatio)
  const elemCoords = new Float64Array(30)
  const ke = new Float64Array(900)
  const block9 = new Float64Array(9)

  for (let e = 0; e < elemCount; e++) {
    const base = e * 10
    for (let a = 0; a < 10; a++) {
      const ni = mesh.tet10[base + a] * 3
      elemCoords[a * 3] = mesh.nodes[ni]
      elemCoords[a * 3 + 1] = mesh.nodes[ni + 1]
      elemCoords[a * 3 + 2] = mesh.nodes[ni + 2]
    }
    computeTet10ElementStiffness(elemCoords, cVoigt, ke)

    const rcmNodes = rcmElemNodes[e]
    for (let a = 0; a < 10; a++) {
      const rowBlock = rcmNodes[a]
      for (let b = 0; b < 10; b++) {
        const colBlock = rcmNodes[b]
        if (rowBlock > colBlock) continue
        for (let r = 0; r < 3; r++) {
          const rowDof = a * 3 + r
          for (let c = 0; c < 3; c++) {
            block9[r * 3 + c] = ke[rowDof * 30 + (b * 3 + c)]
          }
        }
        addBlock3x3Upper(elasticMatrix, rowBlock, colBlock, block9, 1)
      }
    }
  }

  // Compute Patch areas from Tri6 faces for uniform traction conversion
  const patchAreas = new Map<number, number>()
  const triCoords = new Float64Array(18)
  const fLocal = new Float64Array(18)
  const krLocal = new Float64Array(324)

  for (let f = 0; f < triCount; f++) {
    const pid = mesh.tri6Patch[f]
    const b6 = f * 6
    for (let a = 0; a < 6; a++) {
      const ni = mesh.tri6[b6 + a] * 3
      triCoords[a * 3] = mesh.nodes[ni]
      triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
      triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
    }
    const { area } = integrateTri6Traction(triCoords, () => [0, 0, 0], fLocal)
    patchAreas.set(pid, (patchAreas.get(pid) ?? 0) + area)
  }

  onProgress?.('Assembling surface tractions, Robin springs, and RBE3 couplings...')
  const externalForceRcm = new Float64Array(nodeCount * 3)
  let characteristicForceN = 0

  for (let i = 0; i < bcs.length; i++) {
    const bc = bcs[i]
    if (bc.type === 'pressure') {
      let patchForceMag = 0
      for (let f = 0; f < triCount; f++) {
        if (mesh.tri6Patch[f] !== bc.patchId) continue
        const b6 = f * 6
        for (let a = 0; a < 6; a++) {
          const ni = mesh.tri6[b6 + a] * 3
          triCoords[a * 3] = mesh.nodes[ni]
          triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
          triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
        }
        const { area } = integrateTri6Traction(
          triCoords,
          (_x, _y, _z, nx, ny, nz) => [-bc.pressureMPa * nx, -bc.pressureMPa * ny, -bc.pressureMPa * nz],
          fLocal,
        )
        patchForceMag += Math.abs(bc.pressureMPa) * area
        for (let a = 0; a < 6; a++) {
          const rb = oldToNewNode[mesh.tri6[b6 + a]] * 3
          externalForceRcm[rb] += fLocal[a * 3]
          externalForceRcm[rb + 1] += fLocal[a * 3 + 1]
          externalForceRcm[rb + 2] += fLocal[a * 3 + 2]
        }
      }
      characteristicForceN += patchForceMag
    } else if (bc.type === 'traction') {
      const area = Math.max(1e-12, patchAreas.get(bc.patchId) ?? 0)
      const tx = bc.tractionMPa ? bc.tractionMPa[0] : (bc.totalForceN?.[0] ?? 0) / area
      const ty = bc.tractionMPa ? bc.tractionMPa[1] : (bc.totalForceN?.[1] ?? 0) / area
      const tz = bc.tractionMPa ? bc.tractionMPa[2] : (bc.totalForceN?.[2] ?? 0) / area
      characteristicForceN += Math.hypot(tx, ty, tz) * area

      for (let f = 0; f < triCount; f++) {
        if (mesh.tri6Patch[f] !== bc.patchId) continue
        const b6 = f * 6
        for (let a = 0; a < 6; a++) {
          const ni = mesh.tri6[b6 + a] * 3
          triCoords[a * 3] = mesh.nodes[ni]
          triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
          triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
        }
        integrateTri6Traction(triCoords, () => [tx, ty, tz], fLocal)
        for (let a = 0; a < 6; a++) {
          const rb = oldToNewNode[mesh.tri6[b6 + a]] * 3
          externalForceRcm[rb] += fLocal[a * 3]
          externalForceRcm[rb + 1] += fLocal[a * 3 + 1]
          externalForceRcm[rb + 2] += fLocal[a * 3 + 2]
        }
      }
    } else if (bc.type === 'rbe3') {
      const rbeForce = assembleRbe3Traction(mesh, bc, oldToNewNode, externalForceRcm)
      characteristicForceN += rbeForce
    } else if (bc.type === 'robin') {
      for (let f = 0; f < triCount; f++) {
        if (mesh.tri6Patch[f] !== bc.patchId) continue
        const b6 = f * 6
        for (let a = 0; a < 6; a++) {
          const ni = mesh.tri6[b6 + a] * 3
          triCoords[a * 3] = mesh.nodes[ni]
          triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
          triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
        }
        integrateTri6RobinStiffness(triCoords, bc.stiffnessNPerMm3, krLocal)
        for (let a = 0; a < 6; a++) {
          const rowBlock = oldToNewNode[mesh.tri6[b6 + a]]
          for (let b = 0; b < 6; b++) {
            const colBlock = oldToNewNode[mesh.tri6[b6 + b]]
            if (rowBlock > colBlock) continue
            for (let r = 0; r < 3; r++) {
              const rowDof = a * 3 + r
              for (let c = 0; c < 3; c++) {
                block9[r * 3 + c] = krLocal[rowDof * 18 + (b * 3 + c)]
              }
            }
            addBlock3x3Upper(robinMatrix, rowBlock, colBlock, block9, 1)
          }
        }
      }
    }
  }

  // Gate 6.1: Check diagonal positivity and compute kDiagMean
  let minDiag = Infinity
  let maxDiag = 0
  let sumDiag = 0
  for (let b = 0; b < nodeCount; b++) {
    const p = elasticMatrix.diagPtr[b] * 9
    const r = robinMatrix.diagPtr[b] * 9
    const d0 = elasticMatrix.values[p] + robinMatrix.values[r]
    const d1 = elasticMatrix.values[p + 4] + robinMatrix.values[r + 4]
    const d2 = elasticMatrix.values[p + 8] + robinMatrix.values[r + 8]
    minDiag = Math.min(minDiag, d0, d1, d2)
    maxDiag = Math.max(maxDiag, d0, d1, d2)
    sumDiag += d0 + d1 + d2
  }
  const kDiagMean = Math.max(1e-6, sumDiag / (3 * nodeCount))
  const diagConditionRatio = minDiag > 0 ? maxDiag / minDiag : Infinity

  // Collect Dirichlet constraints in RCM DOF space
  const isConstrainedDofRcm = new Uint8Array(nodeCount * 3)
  const prescribedDispRcm = new Float64Array(nodeCount * 3)

  for (let i = 0; i < bcs.length; i++) {
    const bc = bcs[i]
    if (bc.type !== 'dirichlet') continue

    if (bc.subtype === 'fixed') {
      for (let f = 0; f < triCount; f++) {
        if (mesh.tri6Patch[f] !== bc.patchId) continue
        const b6 = f * 6
        for (let a = 0; a < 6; a++) {
          const rb = oldToNewNode[mesh.tri6[b6 + a]] * 3
          isConstrainedDofRcm[rb] = 1
          isConstrainedDofRcm[rb + 1] = 1
          isConstrainedDofRcm[rb + 2] = 1
          prescribedDispRcm[rb] = 0
          prescribedDispRcm[rb + 1] = 0
          prescribedDispRcm[rb + 2] = 0
        }
      }
    } else if (bc.subtype === 'prescribed') {
      const disp = bc.displacementMm ?? {}
      for (let f = 0; f < triCount; f++) {
        if (mesh.tri6Patch[f] !== bc.patchId) continue
        const b6 = f * 6
        for (let a = 0; a < 6; a++) {
          const rb = oldToNewNode[mesh.tri6[b6 + a]] * 3
          if (disp.ux !== undefined) {
            isConstrainedDofRcm[rb] = 1
            prescribedDispRcm[rb] = disp.ux
          }
          if (disp.uy !== undefined) {
            isConstrainedDofRcm[rb + 1] = 1
            prescribedDispRcm[rb + 1] = disp.uy
          }
          if (disp.uz !== undefined) {
            isConstrainedDofRcm[rb + 2] = 1
            prescribedDispRcm[rb + 2] = disp.uz
          }
        }
      }
    } else if (bc.subtype === 'sliding_normal') {
      // Accumulate area-weighted outward normals at each node of the patch
      const nodeNormals = new Map<number, [number, number, number]>()
      for (let f = 0; f < triCount; f++) {
        if (mesh.tri6Patch[f] !== bc.patchId) continue
        const b6 = f * 6
        const i0 = mesh.tri6[b6] * 3
        const i1 = mesh.tri6[b6 + 1] * 3
        const i2 = mesh.tri6[b6 + 2] * 3
        const ux = mesh.nodes[i1] - mesh.nodes[i0]
        const uy = mesh.nodes[i1 + 1] - mesh.nodes[i0 + 1]
        const uz = mesh.nodes[i1 + 2] - mesh.nodes[i0 + 2]
        const vx = mesh.nodes[i2] - mesh.nodes[i0]
        const vy = mesh.nodes[i2 + 1] - mesh.nodes[i0 + 1]
        const vz = mesh.nodes[i2 + 2] - mesh.nodes[i0 + 2]
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        for (let a = 0; a < 6; a++) {
          const nid = mesh.tri6[b6 + a]
          const prev = nodeNormals.get(nid)
          if (prev) {
            prev[0] += nx
            prev[1] += ny
            prev[2] += nz
          } else {
            nodeNormals.set(nid, [nx, ny, nz])
          }
        }
      }

      for (const [nid, nVec] of nodeNormals.entries()) {
        const len = Math.hypot(nVec[0], nVec[1], nVec[2])
        if (len <= 1e-15) continue
        const nx = nVec[0] / len
        const ny = nVec[1] / len
        const nz = nVec[2] / len
        const rcmBlock = oldToNewNode[nid]
        const rb = rcmBlock * 3

        // If normal is aligned with a coordinate axis, eliminate that exact axis
        if (Math.abs(nx) > 0.999) {
          isConstrainedDofRcm[rb] = 1
          prescribedDispRcm[rb] = 0
        } else if (Math.abs(ny) > 0.999) {
          isConstrainedDofRcm[rb + 1] = 1
          prescribedDispRcm[rb + 1] = 0
        } else if (Math.abs(nz) > 0.999) {
          isConstrainedDofRcm[rb + 2] = 1
          prescribedDispRcm[rb + 2] = 0
        } else {
          // Oblique sliding normal: add directional normal projection stiffness k_pen * (n (x) n)
          const kPen = 1e5 * kDiagMean
          const nOuter = [
            kPen * nx * nx, kPen * nx * ny, kPen * nx * nz,
            kPen * ny * nx, kPen * ny * ny, kPen * ny * nz,
            kPen * nz * nx, kPen * nz * ny, kPen * nz * nz,
          ]
          addBlock3x3Upper(robinMatrix, rcmBlock, rcmBlock, nOuter, 1)
        }
      }
    }
  }

  // Build combined matrix K = K_elastic + K_robin before Dirichlet elimination
  const systemValues = new Float64Array(elasticMatrix.values.length)
  for (let i = 0; i < systemValues.length; i++) {
    systemValues[i] = elasticMatrix.values[i] + robinMatrix.values[i]
  }
  const systemMatrix: BsrMatrix3x3 = {
    blockRows: nodeCount,
    rowPtr: elasticMatrix.rowPtr,
    colIdx: elasticMatrix.colIdx,
    values: systemValues,
    diagPtr: elasticMatrix.diagPtr,
  }

  // Symmetric Dirichlet elimination:
  // 1) Subtract K_{fc} * u_prescribed from free DOFs
  const systemRhs = externalForceRcm.slice()
  let hasNonZeroPrescribed = false
  for (let i = 0; i < prescribedDispRcm.length; i++) {
    if (isConstrainedDofRcm[i] && Math.abs(prescribedDispRcm[i]) > 0) {
      hasNonZeroPrescribed = true
      break
    }
  }
  if (hasNonZeroPrescribed) {
    const kuBar = new Float64Array(nodeCount * 3)
    spmvBsr3(systemMatrix, prescribedDispRcm, kuBar)
    for (let d = 0; d < systemRhs.length; d++) {
      if (!isConstrainedDofRcm[d]) {
        systemRhs[d] -= kuBar[d]
      }
    }
    let uBarMax = 0
    for (let d = 0; d < prescribedDispRcm.length; d++) {
      uBarMax = Math.max(uBarMax, Math.abs(prescribedDispRcm[d]))
    }
    characteristicForceN = Math.max(characteristicForceN, kDiagMean * uBarMax)
  }

  // 2) Zero constrained rows and columns in systemMatrix, set diagonal to kDiagMean
  const { rowPtr, colIdx, values } = systemMatrix
  for (let i = 0; i < nodeCount; i++) {
    const i3 = i * 3
    const start = rowPtr[i]
    const end = rowPtr[i + 1]

    // Diagonal block (i, i)
    if (start < end && colIdx[start] === i) {
      const b = start * 9
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          if (isConstrainedDofRcm[i3 + r] || isConstrainedDofRcm[i3 + c]) {
            values[b + r * 3 + c] = r === c ? kDiagMean : 0
          }
        }
      }
    }

    // Off-diagonal upper blocks (i, j) with j > i
    for (let p = start + 1; p < end; p++) {
      const j3 = colIdx[p] * 3
      const b = p * 9
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          if (isConstrainedDofRcm[i3 + r] || isConstrainedDofRcm[j3 + c]) {
            values[b + r * 3 + c] = 0
          }
        }
      }
    }

    for (let r = 0; r < 3; r++) {
      const d = i3 + r
      if (isConstrainedDofRcm[d]) {
        systemRhs[d] = kDiagMean * prescribedDispRcm[d]
      }
    }
  }

  return {
    systemMatrix,
    elasticMatrix,
    robinMatrix,
    systemRhs,
    externalForceRcm,
    prescribedDispRcm,
    isConstrainedDofRcm,
    oldToNewNode,
    newToOldNode,
    nodesRcm,
    kDiagMean,
    diagConditionRatio,
    characteristicForceN: Math.max(characteristicForceN, 1e-9),
  }
}

/**
 * Recover nodal displacements in original mesh node ordering and verify global
 * force and moment equilibrium (`Gate 6.3` & `Gate 6.4`).
 */
export function recoverReactionsAndEquilibrium(
  system: AssembledLinearSystem,
  uRcm: Float64Array,
): {
  displacementsOrig: Float64Array
  reactionsOrig: Float64Array
  equilibrium: EquilibriumReport
} {
  const nodeCount = system.oldToNewNode.length

  // Enforce exact prescribed values at constrained DOFs
  const uCleanRcm = uRcm.slice()
  for (let d = 0; d < uCleanRcm.length; d++) {
    if (system.isConstrainedDofRcm[d]) {
      uCleanRcm[d] = system.prescribedDispRcm[d]
    }
  }

  // Compute purely elastic internal nodal forces K_elastic * u
  // and Robin spring forces K_robin * u
  const fElasticRcm = new Float64Array(nodeCount * 3)
  const fRobinRcm = new Float64Array(nodeCount * 3)
  spmvBsr3(system.elasticMatrix, uCleanRcm, fElasticRcm)
  spmvBsr3(system.robinMatrix, uCleanRcm, fRobinRcm)

  // Support reactions (Dirichlet + Robin):
  // - At constrained Dirichlet DOFs c: r_Dirichlet,c = (K_elastic u)_c + (K_robin u)_c - f_ext,c
  // - At Robin DOFs: r_Robin = -(K_robin u)
  // Thus total support reaction r_support = r_Dirichlet + r_Robin
  const reactionsRcm = new Float64Array(nodeCount * 3)
  for (let d = 0; d < nodeCount * 3; d++) {
    const rDirichlet = system.isConstrainedDofRcm[d]
      ? fElasticRcm[d] + fRobinRcm[d] - system.externalForceRcm[d]
      : 0
    const rRobin = -fRobinRcm[d]
    reactionsRcm[d] = rDirichlet + rRobin
  }

  // Compute centroid of all nodes for moment equilibrium verification
  let cx = 0
  let cy = 0
  let cz = 0
  for (let b = 0; b < nodeCount; b++) {
    cx += system.nodesRcm[b * 3]
    cy += system.nodesRcm[b * 3 + 1]
    cz += system.nodesRcm[b * 3 + 2]
  }
  cx /= Math.max(1, nodeCount)
  cy /= Math.max(1, nodeCount)
  cz /= Math.max(1, nodeCount)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  const appliedForceN: [number, number, number] = [0, 0, 0]
  const reactionForceN: [number, number, number] = [0, 0, 0]
  const appliedMomentNmm: [number, number, number] = [0, 0, 0]
  const reactionMomentNmm: [number, number, number] = [0, 0, 0]

  for (let b = 0; b < nodeCount; b++) {
    const b3 = b * 3
    const x = system.nodesRcm[b3]
    const y = system.nodesRcm[b3 + 1]
    const z = system.nodesRcm[b3 + 2]
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)

    const rx = x - cx
    const ry = y - cy
    const rz = z - cz

    const fx = system.externalForceRcm[b3]
    const fy = system.externalForceRcm[b3 + 1]
    const fz = system.externalForceRcm[b3 + 2]
    appliedForceN[0] += fx
    appliedForceN[1] += fy
    appliedForceN[2] += fz
    appliedMomentNmm[0] += ry * fz - rz * fy
    appliedMomentNmm[1] += rz * fx - rx * fz
    appliedMomentNmm[2] += rx * fy - ry * fx

    const rcx = reactionsRcm[b3]
    const rcy = reactionsRcm[b3 + 1]
    const rcz = reactionsRcm[b3 + 2]
    reactionForceN[0] += rcx
    reactionForceN[1] += rcy
    reactionForceN[2] += rcz
    reactionMomentNmm[0] += ry * rcz - rz * rcy
    reactionMomentNmm[1] += rz * rcx - rx * rcz
    reactionMomentNmm[2] += rx * rcy - ry * rcx
  }

  const lChar = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ))
  const fScale = Math.max(
    system.characteristicForceN,
    Math.hypot(appliedForceN[0], appliedForceN[1], appliedForceN[2]),
    Math.hypot(reactionForceN[0], reactionForceN[1], reactionForceN[2]),
    1e-9,
  )

  const dfx = appliedForceN[0] + reactionForceN[0]
  const dfy = appliedForceN[1] + reactionForceN[1]
  const dfz = appliedForceN[2] + reactionForceN[2]
  const forceImbalanceRatio = Math.hypot(dfx, dfy, dfz) / fScale

  const dmx = appliedMomentNmm[0] + reactionMomentNmm[0]
  const dmy = appliedMomentNmm[1] + reactionMomentNmm[1]
  const dmz = appliedMomentNmm[2] + reactionMomentNmm[2]
  const momentImbalanceRatio = Math.hypot(dmx, dmy, dmz) / (fScale * lChar)

  // Permute displacements and reactions back to original mesh node indices
  const displacementsOrig = new Float64Array(nodeCount * 3)
  const reactionsOrig = new Float64Array(nodeCount * 3)
  for (let b = 0; b < nodeCount; b++) {
    const orig = system.newToOldNode[b]
    displacementsOrig[orig * 3] = uCleanRcm[b * 3]
    displacementsOrig[orig * 3 + 1] = uCleanRcm[b * 3 + 1]
    displacementsOrig[orig * 3 + 2] = uCleanRcm[b * 3 + 2]
    reactionsOrig[orig * 3] = reactionsRcm[b * 3]
    reactionsOrig[orig * 3 + 1] = reactionsRcm[b * 3 + 1]
    reactionsOrig[orig * 3 + 2] = reactionsRcm[b * 3 + 2]
  }

  return {
    displacementsOrig,
    reactionsOrig,
    equilibrium: {
      appliedForceN,
      reactionForceN,
      forceImbalanceRatio,
      appliedMomentNmm,
      reactionMomentNmm,
      momentImbalanceRatio,
      passed: forceImbalanceRatio < 1e-3 && momentImbalanceRatio < 1e-3,
    },
  }
}

/**
 * Continuum-consistent distributing coupling (`RBE3`, Section 4.3):
 * Integrates a smooth linear traction field over the `Tri6` faces of `bc.patchId`
 * whose resultant force and moment about `bc.refPointMm` equal `bc.forceN` and `bc.momentNmm`.
 */
function assembleRbe3Traction(
  mesh: Tet10VolumeMesh,
  bc: Rbe3BoundaryCondition,
  oldToNewNode: Int32Array,
  externalForceRcm: Float64Array,
): number {
  const triCount = mesh.tri6.length / 6
  const triCoords = new Float64Array(18)
  const nShape = new Float64Array(6)
  const dNdXi = new Float64Array(6)
  const dNdEta = new Float64Array(6)
  const fLocal = new Float64Array(18)

  // Pass 1: Compute patch area A and centroid x_c
  let area = 0
  let cx = 0
  let cy = 0
  let cz = 0

  for (let f = 0; f < triCount; f++) {
    if (mesh.tri6Patch[f] !== bc.patchId) continue
    const b6 = f * 6
    for (let a = 0; a < 6; a++) {
      const ni = mesh.tri6[b6 + a] * 3
      triCoords[a * 3] = mesh.nodes[ni]
      triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
      triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
    }
    for (let q = 0; q < TRI6_QUAD6.length; q++) {
      const qp = TRI6_QUAD6[q]
      evalTri6ShapeAndGrad(qp.xi, qp.eta, nShape, dNdXi, dNdEta)
      let x = 0, y = 0, z = 0
      let dxXi = 0, dyXi = 0, dzXi = 0
      let dxEta = 0, dyEta = 0, dzEta = 0
      for (let a = 0; a < 6; a++) {
        const na = nShape[a]
        const dxi = dNdXi[a]
        const deta = dNdEta[a]
        const px = triCoords[a * 3]
        const py = triCoords[a * 3 + 1]
        const pz = triCoords[a * 3 + 2]
        x += na * px; y += na * py; z += na * pz
        dxXi += dxi * px; dyXi += dxi * py; dzXi += dxi * pz
        dxEta += deta * px; dyEta += deta * py; dzEta += deta * pz
      }
      const jx = dyXi * dzEta - dzXi * dyEta
      const jy = dzXi * dxEta - dxXi * dzEta
      const jz = dxXi * dyEta - dyXi * dxEta
      const dA = qp.w * Math.hypot(jx, jy, jz)
      area += dA
      cx += dA * x
      cy += dA * y
      cz += dA * z
    }
  }

  if (area <= 1e-12) return 0
  cx /= area
  cy /= area
  cz /= area

  // Pass 2: Compute 3x3 surface inertia tensor I_c about x_c
  const ic = new Float64Array(9)
  for (let f = 0; f < triCount; f++) {
    if (mesh.tri6Patch[f] !== bc.patchId) continue
    const b6 = f * 6
    for (let a = 0; a < 6; a++) {
      const ni = mesh.tri6[b6 + a] * 3
      triCoords[a * 3] = mesh.nodes[ni]
      triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
      triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
    }
    for (let q = 0; q < TRI6_QUAD6.length; q++) {
      const qp = TRI6_QUAD6[q]
      evalTri6ShapeAndGrad(qp.xi, qp.eta, nShape, dNdXi, dNdEta)
      let x = 0, y = 0, z = 0
      let dxXi = 0, dyXi = 0, dzXi = 0
      let dxEta = 0, dyEta = 0, dzEta = 0
      for (let a = 0; a < 6; a++) {
        const na = nShape[a]
        const dxi = dNdXi[a]
        const deta = dNdEta[a]
        const px = triCoords[a * 3]
        const py = triCoords[a * 3 + 1]
        const pz = triCoords[a * 3 + 2]
        x += na * px; y += na * py; z += na * pz
        dxXi += dxi * px; dyXi += dxi * py; dzXi += dxi * pz
        dxEta += deta * px; dyEta += deta * py; dzEta += deta * pz
      }
      const jx = dyXi * dzEta - dzXi * dyEta
      const jy = dzXi * dxEta - dxXi * dzEta
      const jz = dxXi * dyEta - dyXi * dxEta
      const dA = qp.w * Math.hypot(jx, jy, jz)
      const rx = x - cx
      const ry = y - cy
      const rz = z - cz
      const r2 = rx * rx + ry * ry + rz * rz
      ic[0] += dA * (r2 - rx * rx)
      ic[1] += dA * (-rx * ry)
      ic[2] += dA * (-rx * rz)
      ic[3] += dA * (-ry * rx)
      ic[4] += dA * (r2 - ry * ry)
      ic[5] += dA * (-ry * rz)
      ic[6] += dA * (-rz * rx)
      ic[7] += dA * (-rz * ry)
      ic[8] += dA * (r2 - rz * rz)
    }
  }

  // Transfer moment from x_ref to x_c: M_c = M_ref + (x_ref - x_c) x F_ref
  const dxRef = bc.refPointMm[0] - cx
  const dyRef = bc.refPointMm[1] - cy
  const dzRef = bc.refPointMm[2] - cz
  const fx = bc.forceN[0]
  const fy = bc.forceN[1]
  const fz = bc.forceN[2]
  const mcx = bc.momentNmm[0] + (dyRef * fz - dzRef * fy)
  const mcy = bc.momentNmm[1] + (dzRef * fx - dxRef * fz)
  const mcz = bc.momentNmm[2] + (dxRef * fy - dyRef * fx)

  const omega = solve3x3Regularized(ic, mcx, mcy, mcz)

  // Pass 3: Integrate t(x) = (1/A) F_ref + omega x (x - x_c)
  for (let f = 0; f < triCount; f++) {
    if (mesh.tri6Patch[f] !== bc.patchId) continue
    const b6 = f * 6
    for (let a = 0; a < 6; a++) {
      const ni = mesh.tri6[b6 + a] * 3
      triCoords[a * 3] = mesh.nodes[ni]
      triCoords[a * 3 + 1] = mesh.nodes[ni + 1]
      triCoords[a * 3 + 2] = mesh.nodes[ni + 2]
    }
    integrateTri6Traction(
      triCoords,
      (x, y, z) => {
        const rx = x - cx
        const ry = y - cy
        const rz = z - cz
        return [
          fx / area + (omega[1] * rz - omega[2] * ry),
          fy / area + (omega[2] * rx - omega[0] * rz),
          fz / area + (omega[0] * ry - omega[1] * rx),
        ]
      },
      fLocal,
    )
    for (let a = 0; a < 6; a++) {
      const rb = oldToNewNode[mesh.tri6[b6 + a]] * 3
      externalForceRcm[rb] += fLocal[a * 3]
      externalForceRcm[rb + 1] += fLocal[a * 3 + 1]
      externalForceRcm[rb + 2] += fLocal[a * 3 + 2]
    }
  }

  return Math.hypot(fx, fy, fz) + Math.hypot(mcx, mcy, mcz) / Math.sqrt(area)
}

function solve3x3Regularized(
  m: Float64Array,
  bx: number,
  by: number,
  bz: number,
): [number, number, number] {
  const tr = Math.max(1e-12, m[0] + m[4] + m[8])
  const reg = 1e-9 * tr
  const a00 = m[0] + reg, a01 = m[1], a02 = m[2]
  const a10 = m[3], a11 = m[4] + reg, a12 = m[5]
  const a20 = m[6], a21 = m[7], a22 = m[8] + reg

  const c00 = a11 * a22 - a12 * a21
  const c01 = -(a10 * a22 - a12 * a20)
  const c02 = a10 * a21 - a11 * a20
  const c10 = -(a01 * a22 - a02 * a21)
  const c11 = a00 * a22 - a02 * a20
  const c12 = -(a00 * a21 - a01 * a20)
  const c20 = a01 * a12 - a02 * a11
  const c21 = -(a00 * a12 - a02 * a10)
  const c22 = a00 * a11 - a01 * a10

  const det = a00 * c00 + a01 * c01 + a02 * c02
  if (Math.abs(det) <= 1e-24) return [0, 0, 0]
  const invDet = 1 / det
  return [
    (c00 * bx + c10 * by + c20 * bz) * invDet,
    (c01 * bx + c11 * by + c21 * bz) * invDet,
    (c02 * bx + c12 * by + c22 * bz) * invDet,
  ]
}

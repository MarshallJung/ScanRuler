// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import { assembleLinearSystem, recoverReactionsAndEquilibrium } from '../core/assembly'
import { buildStructuredBoxTet10Mesh } from '../core/mesher'
import { recoverStressesAndDiagnostics } from '../core/postprocess'
import { solvePcgBsr3 } from '../core/solver'
import type { BoundaryCondition, IsotropicMaterial } from '../core/types'

describe('Constant-Strain / Uniaxial Tension Patch Test (Section 5.1)', () => {
  it('reproduces exact linear displacement, uniform 100 MPa von Mises stress, and zero ZZ error', () => {
    const L = 10
    const E = 200000
    const nu = 0.3
    const sigmaApplied = 100 // MPa tensile traction on X = L

    const mesh = buildStructuredBoxTet10Mesh(L, L, L, 2, 2, 2, {
      xMin: 0,
      xMax: 1,
      yMin: 2,
      yMax: 3,
      zMin: 4,
      zMax: 5,
    })

    const material: IsotropicMaterial = {
      id: 'steel-test',
      name: 'Test Steel',
      youngsModulusMPa: E,
      poissonsRatio: nu,
      densityKgM3: 7850,
      failureCriterion: 'ductile',
      yieldStrengthMPa: 250,
    }

    // Symmetry rollers on X=0 (patch 0), Y=0 (patch 2), Z=0 (patch 4)
    // Uniform tensile traction +100 MPa along +X on X=L (patch 1)
    const bcs: BoundaryCondition[] = [
      { id: 'r-x0', patchId: 0, type: 'dirichlet', subtype: 'sliding_normal' },
      { id: 'r-y0', patchId: 2, type: 'dirichlet', subtype: 'sliding_normal' },
      { id: 'r-z0', patchId: 4, type: 'dirichlet', subtype: 'sliding_normal' },
      { id: 't-xL', patchId: 1, type: 'traction', tractionMPa: [sigmaApplied, 0, 0] },
    ]

    const system = assembleLinearSystem(mesh, material, bcs)
    const pcg = solvePcgBsr3(system.systemMatrix, system.systemRhs, {
      tol: 1e-12,
      isConstrainedDof: system.isConstrainedDofRcm,
      nodeCoords: system.nodesRcm,
    })
    expect(pcg.converged).toBe(true)
    expect(pcg.trueRelativeResidual).toBeLessThan(1e-9)

    const { displacementsOrig, equilibrium } = recoverReactionsAndEquilibrium(system, pcg.solution)
    expect(equilibrium.passed).toBe(true)
    expect(equilibrium.forceImbalanceRatio).toBeLessThan(1e-8)
    expect(equilibrium.appliedForceN[0]).toBeCloseTo(sigmaApplied * L * L, 5)
    expect(equilibrium.reactionForceN[0]).toBeCloseTo(-sigmaApplied * L * L, 5)

    // Verify exact analytical displacements at every node:
    //   ux(x) = (sigma / E) * x
    //   uy(y) = -nu * (sigma / E) * y
    //   uz(z) = -nu * (sigma / E) * z
    const nodeCount = mesh.nodes.length / 3
    for (let i = 0; i < nodeCount; i++) {
      const x = mesh.nodes[i * 3]
      const y = mesh.nodes[i * 3 + 1]
      const z = mesh.nodes[i * 3 + 2]
      const uxExact = (sigmaApplied / E) * x
      const uyExact = (-nu * sigmaApplied / E) * y
      const uzExact = (-nu * sigmaApplied / E) * z
      expect(displacementsOrig[i * 3]).toBeCloseTo(uxExact, 8)
      expect(displacementsOrig[i * 3 + 1]).toBeCloseTo(uyExact, 8)
      expect(displacementsOrig[i * 3 + 2]).toBeCloseTo(uzExact, 8)
    }

    const post = recoverStressesAndDiagnostics(mesh, material, bcs, displacementsOrig, equilibrium, {
      iterations: pcg.iterations,
      relativeResidual: pcg.trueRelativeResidual,
      solveTimeMs: 5,
    })

    // Every node's recovered von Mises stress and sigma1 must equal 100.0 MPa
    for (let i = 0; i < nodeCount; i++) {
      expect(post.vonMises[i]).toBeCloseTo(sigmaApplied, 4)
      expect(post.sigma1[i]).toBeCloseTo(sigmaApplied, 4)
      expect(post.sigma3[i]).toBeCloseTo(0, 4)
      expect(post.safetyFactor[i]).toBeCloseTo(250 / sigmaApplied, 4)
    }
    expect(post.metrics.etaZzPercent).toBeLessThan(1e-4)
  })
})

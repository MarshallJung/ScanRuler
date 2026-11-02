// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import { assembleLinearSystem, recoverReactionsAndEquilibrium } from '../core/assembly'
import { buildStructuredBoxTet10Mesh } from '../core/mesher'
import { recoverStressesAndDiagnostics } from '../core/postprocess'
import { solvePcgBsr3 } from '../core/solver'
import type { BoundaryCondition, IsotropicMaterial } from '../core/types'

describe('NAFEMS / Euler-Bernoulli Cantilever Beam Benchmark (Section 5.1)', () => {
  it('matches analytical tip deflection and global reaction equilibrium within 3%', () => {
    const L = 100 // mm
    const b = 10 // mm
    const h = 10 // mm
    const E = 200000 // MPa
    const nu = 0.3
    const P = 1000 // N tip shear load along -Y

    // Analytical Timoshenko cantilever deflection:
    //   I = b * h^3 / 12 = 10000 / 12 = 833.3333 mm^4
    //   w_EB = P * L^3 / (3 * E * I) = 1000 * 1e6 / (3 * 200000 * 833.3333) = 2.000 mm
    //   w_shear = P * L / (kappa * G * A) ≈ 0.0156 mm
    //   Fixed-root 3D Poisson restraint stiffens root slightly -> w_3D ≈ 1.98 mm
    const I = (b * Math.pow(h, 3)) / 12
    const wAnalytical = (P * Math.pow(L, 3)) / (3 * E * I)

    const mesh = buildStructuredBoxTet10Mesh(L, h, b, 12, 2, 2, {
      xMin: 0,
      xMax: 1,
      yMin: 2,
      yMax: 3,
      zMin: 4,
      zMax: 5,
    })

    const material: IsotropicMaterial = {
      id: 'steel-cantilever',
      name: 'Structural Steel',
      youngsModulusMPa: E,
      poissonsRatio: nu,
      densityKgM3: 7850,
      failureCriterion: 'ductile',
      yieldStrengthMPa: 460,
    }

    const bcs: BoundaryCondition[] = [
      { id: 'fix-root', patchId: 0, type: 'dirichlet', subtype: 'fixed' },
      { id: 'tip-load', patchId: 1, type: 'traction', totalForceN: [0, -P, 0] },
    ]

    const system = assembleLinearSystem(mesh, material, bcs)
    const pcg = solvePcgBsr3(system.systemMatrix, system.systemRhs, {
      tol: 1e-10,
      isConstrainedDof: system.isConstrainedDofRcm,
      nodeCoords: system.nodesRcm,
    })
    expect(pcg.converged).toBe(true)

    const { displacementsOrig, equilibrium } = recoverReactionsAndEquilibrium(system, pcg.solution)
    expect(equilibrium.passed).toBe(true)
    expect(equilibrium.appliedForceN[1]).toBeCloseTo(-P, 3)
    expect(equilibrium.reactionForceN[1]).toBeCloseTo(P, 3)
    expect(equilibrium.forceImbalanceRatio).toBeLessThan(1e-6)
    expect(equilibrium.momentImbalanceRatio).toBeLessThan(1e-6)

    const post = recoverStressesAndDiagnostics(mesh, material, bcs, displacementsOrig, equilibrium, {
      iterations: pcg.iterations,
      relativeResidual: pcg.trueRelativeResidual,
      solveTimeMs: 10,
    })

    const relErrorDeflection = Math.abs(post.metrics.maxDisplacementMm - wAnalytical) / wAnalytical
    expect(relErrorDeflection).toBeLessThan(0.03)
  })
})

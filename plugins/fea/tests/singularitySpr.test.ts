// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import { getMaterialPreset } from '../core/materials'
import {
  computePrincipalStressesCardano,
  computeVonMises,
} from '../core/postprocess'
import {
  executePreflightPipeline,
  executeSolvePipeline,
} from '../worker/protocol'

/**
 * Construct a watertight, outward-oriented triangle mesh of a 3D L-bracket:
 *   Union of vertical leg [0, 10] x [0, 30] x [0, 6]
 *   and horizontal leg [10, 30] x [0, 10] x [0, 6]
 * which has a 270 deg internal (90 deg re-entrant) concave corner along (x=10, y=10, z in [0,6]).
 */
function makeLBracketSurfaceMesh(): { positions: Float32Array; indices: Uint32Array } {
  // 6 vertices in z=0 plane and 6 vertices in z=6 plane
  // L-polygon CCW in XY:
  //   0:(0,0), 1:(30,0), 2:(30,10), 3:(10,10) [re-entrant!], 4:(10,30), 5:(0,30)
  // prettier-ignore
  const positions = new Float32Array([
    // z = 0 (0..5)
    0, 0, 0,
    30, 0, 0,
    30, 10, 0,
    10, 10, 0,
    10, 30, 0,
    0, 30, 0,
    // z = 6 (6..11)
    0, 0, 6,
    30, 0, 6,
    30, 10, 6,
    10, 10, 6,
    10, 30, 6,
    0, 30, 6,
  ])

  // Outward CCW triangles
  // prettier-ignore
  const indices = new Uint32Array([
    // Bottom face (z = 0, normal -Z): (0,3,1), (1,3,2), (0,5,3), (3,5,4)
    0, 3, 1,
    1, 3, 2,
    0, 5, 3,
    3, 5, 4,
    // Top face (z = 6, normal +Z): (6,7,9), (7,8,9), (6,9,11), (9,10,11)
    6, 7, 9,
    7, 8, 9,
    6, 9, 11,
    9, 10, 11,
    // Side 0->1 (y=0, normal -Y)
    0, 1, 7,  0, 7, 6,
    // Side 1->2 (x=30, normal +X)
    1, 2, 8,  1, 8, 7,
    // Side 2->3 (y=10, normal +Y, horizontal inner step)
    2, 3, 9,  2, 9, 8,
    // Side 3->4 (x=10, normal +X, vertical inner step)
    3, 4, 10, 3, 10, 9,
    // Side 4->5 (y=30, normal +Y)
    4, 5, 11, 4, 11, 10,
    // Side 5->0 (x=0, normal -X)
    5, 0, 6,  5, 6, 11,
  ])

  return { positions, indices }
}

describe('Cardano Principal Stresses, ZZ-SPR & Re-Entrant Singularity Masking (Gate 7)', () => {
  it('computes exact Cardano principal stresses for hydrostatic, uniaxial, and pure shear states', () => {
    // Hydrostatic [50, 50, 50, 0, 0, 0]
    const hydro = computePrincipalStressesCardano([50, 50, 50, 0, 0, 0])
    expect(hydro[0]).toBeCloseTo(50, 8)
    expect(hydro[1]).toBeCloseTo(50, 8)
    expect(hydro[2]).toBeCloseTo(50, 8)
    expect(computeVonMises([50, 50, 50, 0, 0, 0])).toBeCloseTo(0, 8)

    // Pure shear tau_xy = 40 MPa -> principal stresses [+40, 0, -40], von Mises = sqrt(3)*40
    const shear = computePrincipalStressesCardano([0, 0, 0, 40, 0, 0])
    expect(shear[0]).toBeCloseTo(40, 8)
    expect(shear[1]).toBeCloseTo(0, 8)
    expect(shear[2]).toBeCloseTo(-40, 8)
    expect(computeVonMises([0, 0, 0, 40, 0, 0])).toBeCloseTo(Math.sqrt(3) * 40, 8)
  })

  it('detects 90-deg re-entrant concave edge on L-bracket and masks 2*h_e singularity zone', () => {
    const raw = makeLBracketSurfaceMesh()
    const { welded, preflight } = executePreflightPipeline({
      positions: raw.positions,
      indices: raw.indices,
      mergedPairs: [],
    })

    expect(preflight.passed).toBe(true)
    // Volume of L-bracket = (10*30 + 20*10) * 6 = 500 * 6 = 3000 mm^3
    expect(preflight.signedVolumeMm3).toBeCloseTo(3000, 2)
    // Must detect the concave edge at (x=10, y=10)
    expect(welded.reentrantEdges.length).toBeGreaterThanOrEqual(1)
    expect(welded.reentrantEdges[0].internalAngleDeg).toBeCloseTo(270, 1)

    // Find top face patch (y=30, normal +Y) to fix, and right tip patch (x=30, normal +X) to load
    const topPatch = welded.patches.find(
      (p) => p.normal[1] > 0.9 && p.centroid[1] > welded.bboxMax[1] - 1,
    )!
    const tipPatch = welded.patches.find(
      (p) => p.normal[0] > 0.9 && p.centroid[0] > welded.bboxMax[0] - 1,
    )!

    const { solution } = executeSolvePipeline({
      welded,
      material: getMaterialPreset('6061-T6')!,
      bcs: [
        { id: 'fix-top', patchId: topPatch.id, type: 'dirichlet', subtype: 'fixed' },
        { id: 'pull-tip', patchId: tipPatch.id, type: 'traction', totalForceN: [0, -600, 0] },
      ],
      meshSettings: { preset: 'coarse', targetEdgeMm: 5 },
    })

    expect(solution.metrics.equilibrium.passed).toBe(true)
    expect(solution.metrics.singularFaceCount).toBeGreaterThan(0)
    expect(solution.metrics.maxVonMisesRawMPa).toBeGreaterThan(0)
    expect(solution.metrics.maxVonMisesMaskedMPa).toBeGreaterThan(0)
    expect(solution.metrics.maxVonMisesMaskedMPa).toBeLessThanOrEqual(
      solution.metrics.maxVonMisesRawMPa,
    )
  })
})

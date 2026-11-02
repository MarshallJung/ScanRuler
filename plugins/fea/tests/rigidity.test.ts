// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import { buildSurfacePatches } from '../core/patches'
import { centerCoordinates, weldSolidSeams } from '../core/preflight'
import { evaluateRbmModeDisplacements, verifyBoundaryConditions } from '../core/rigidity'
import type { BoundaryCondition, WeldedSurfaceMesh } from '../core/types'
import { makeBoxSurfaceMesh } from './preflight.test'

function makeWeldedBox(): WeldedSurfaceMesh {
  const raw = makeBoxSurfaceMesh(0, 20, 0, 10, 0, 10)
  const { centered, centroidOffset, bboxMin, bboxMax } = centerCoordinates(raw.positions)
  const seam = weldSolidSeams(centered, raw.indices)
  const patched = buildSurfacePatches(seam.positions, seam.indices)
  return {
    positions: seam.positions,
    indices: seam.indices,
    trianglePatch: patched.trianglePatch,
    patches: patched.patches,
    reentrantEdges: patched.reentrantEdges,
    centroidOffset,
    bboxMin,
    bboxMax,
  }
}

describe('FEA Boundary Condition & 6-DOF Rigidity Gate (Gate 4)', () => {
  it('Gate 4.3: rejects unconstrained solid with rank 0 and 6 free modes', () => {
    const welded = makeWeldedBox()
    const rep = verifyBoundaryConditions(welded, [])
    expect(rep.passed).toBe(false)
    expect(rep.rank).toBe(0)
    expect(rep.freeModes.length).toBe(6)
    expect(rep.blockingErrors.some((e) => e.includes('Gate 4.3'))).toBe(true)
  })

  it('Gate 4.3: single roller plane has rank 3 (1 translation + 2 out-of-plane rotations) and 3 free modes', () => {
    const welded = makeWeldedBox()
    const bcs: BoundaryCondition[] = [
      { id: 'roller-0', patchId: welded.patches[0].id, type: 'dirichlet', subtype: 'sliding_normal' },
    ]
    const rep = verifyBoundaryConditions(welded, bcs)
    expect(rep.passed).toBe(false)
    expect(rep.rank).toBe(3)
    expect(rep.freeModes.length).toBe(3)

    // Verify free mode displacement field is non-zero
    const disp = evaluateRbmModeDisplacements(
      welded.positions,
      rep.centroid,
      rep.freeModes[0],
      5,
    )
    let maxD = 0
    for (let i = 0; i < disp.length; i++) maxD = Math.max(maxD, Math.abs(disp[i]))
    expect(maxD).toBeCloseTo(5, 3)
  })

  it('Gate 4.3: 3 mutually orthogonal roller planes achieve full rank 6', () => {
    const welded = makeWeldedBox()
    // Find one patch facing -X, one facing -Y, one facing -Z
    const pX = welded.patches.find((p) => p.normal[0] < -0.9)!
    const pY = welded.patches.find((p) => p.normal[1] < -0.9)!
    const pZ = welded.patches.find((p) => p.normal[2] < -0.9)!

    const bcs: BoundaryCondition[] = [
      { id: 'r-x', patchId: pX.id, type: 'dirichlet', subtype: 'sliding_normal' },
      { id: 'r-y', patchId: pY.id, type: 'dirichlet', subtype: 'sliding_normal' },
      { id: 'r-z', patchId: pZ.id, type: 'dirichlet', subtype: 'sliding_normal' },
    ]
    const rep = verifyBoundaryConditions(welded, bcs)
    expect(rep.passed).toBe(true)
    expect(rep.rank).toBe(6)
    expect(rep.freeModes.length).toBe(0)
  })

  it('Gate 4.1: rejects simultaneous Dirichlet and Neumann BC on the same patch', () => {
    const welded = makeWeldedBox()
    const pid = welded.patches[0].id
    const bcs: BoundaryCondition[] = [
      { id: 'fix', patchId: pid, type: 'dirichlet', subtype: 'fixed' },
      { id: 'load', patchId: pid, type: 'pressure', pressureMPa: 10 },
    ]
    const rep = verifyBoundaryConditions(welded, bcs)
    expect(rep.passed).toBe(false)
    expect(rep.blockingErrors.some((e) => e.includes('Gate 4.1'))).toBe(true)
  })
})

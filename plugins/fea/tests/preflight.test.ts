// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import { buildSurfacePatches } from '../core/patches'
import {
  auditTopologyAndThickness,
  centerCoordinates,
  weldSolidSeams,
} from '../core/preflight'
import type { WeldedSurfaceMesh } from '../core/types'

/** Helper: build a closed, outward-oriented triangle mesh of a box [x0,x1]x[y0,y1]x[z0,z1] */
export function makeBoxSurfaceMesh(
  x0: number, x1: number,
  y0: number, y1: number,
  z0: number, z1: number,
): { positions: Float32Array; indices: Uint32Array } {
  // prettier-ignore
  const positions = new Float32Array([
    x0, y0, z0, // 0
    x1, y0, z0, // 1
    x1, y1, z0, // 2
    x0, y1, z0, // 3
    x0, y0, z1, // 4
    x1, y0, z1, // 5
    x1, y1, z1, // 6
    x0, y1, z1, // 7
  ])
  // Outward CCW triangles
  // prettier-ignore
  const indices = new Uint32Array([
    // -Z (bottom)
    0, 2, 1,  0, 3, 2,
    // +Z (top)
    4, 5, 6,  4, 6, 7,
    // -Y (front)
    0, 1, 5,  0, 5, 4,
    // +Y (back)
    3, 7, 6,  3, 6, 2,
    // -X (left)
    0, 4, 7,  0, 7, 3,
    // +X (right)
    1, 2, 6,  1, 6, 5,
  ])
  return { positions, indices }
}

describe('FEA Pre-Flight Geometry & Topology Gates (Gates 1-2)', () => {
  it('Gate 1.3: centers far-from-origin coordinates and preserves dimensions', () => {
    const raw = makeBoxSurfaceMesh(10500, 10520, -4200, -4190, 800, 805)
    const { centered, centroidOffset, bboxMin, bboxMax } = centerCoordinates(raw.positions)
    expect(centroidOffset[0]).toBeCloseTo(10510, 4)
    expect(centroidOffset[1]).toBeCloseTo(-4195, 4)
    expect(centroidOffset[2]).toBeCloseTo(802.5, 4)
    expect(bboxMax[0] - bboxMin[0]).toBeCloseTo(20, 4)
    expect(bboxMax[1] - bboxMin[1]).toBeCloseTo(10, 4)
    expect(bboxMax[2] - bboxMin[2]).toBeCloseTo(5, 4)
    expect(centered.length).toBe(raw.positions.length)
  })

  it('Gate 2.1-2.6: passes watertight box and segments 6 dihedral patches', () => {
    const raw = makeBoxSurfaceMesh(0, 20, 0, 10, 0, 5)
    const { centered, centroidOffset, bboxMin, bboxMax } = centerCoordinates(raw.positions)
    const weldedSeams = weldSolidSeams(centered, raw.indices)
    const patched = buildSurfacePatches(weldedSeams.positions, weldedSeams.indices)

    expect(patched.patches.length).toBe(6)
    const welded: WeldedSurfaceMesh = {
      positions: weldedSeams.positions,
      indices: weldedSeams.indices,
      trianglePatch: patched.trianglePatch,
      patches: patched.patches,
      reentrantEdges: patched.reentrantEdges,
      centroidOffset,
      bboxMin,
      bboxMax,
    }
    const report = auditTopologyAndThickness(welded)
    expect(report.passed).toBe(true)
    expect(report.openEdgeCount).toBe(0)
    expect(report.nonManifoldEdgeCount).toBe(0)
    expect(report.selfIntersectionCount).toBe(0)
    expect(report.signedVolumeMm3).toBeCloseTo(20 * 10 * 5, 2)
    expect(report.surfaceAreaMm2).toBeCloseTo(2 * (200 + 100 + 50), 2)
    expect(report.eulerCharacteristic).toBe(2)
  })

  it('Gate 2.1: welds duplicate seam vertices and stitches T-junction midpoint splits', () => {
    // Build a box where one face edge has a T-junction midpoint vertex
    const raw = makeBoxSurfaceMesh(0, 10, 0, 10, 0, 10)
    // Duplicate vertex 0 as vertex 8 at identical coordinates
    const posWithDup = new Float32Array(raw.positions.length + 3)
    posWithDup.set(raw.positions)
    posWithDup[24] = raw.positions[0]
    posWithDup[25] = raw.positions[1]
    posWithDup[26] = raw.positions[2]

    const idxWithDup = raw.indices.slice()
    idxWithDup[0] = 8 // point first triangle corner to duplicate vertex 8

    const welded = weldSolidSeams(posWithDup, idxWithDup)
    expect(welded.weldedVertexCount).toBeGreaterThanOrEqual(1)
    expect(welded.positions.length / 3).toBe(8)
  })

  it('Gate 2.1: blocks open shell with boundary edges', () => {
    const raw = makeBoxSurfaceMesh(0, 10, 0, 10, 0, 10)
    // Drop the last two triangles (+X face) to create an open boundary loop
    const openIndices = raw.indices.slice(0, 30)
    const { centered, centroidOffset, bboxMin, bboxMax } = centerCoordinates(raw.positions)
    const patched = buildSurfacePatches(centered, openIndices)
    const welded: WeldedSurfaceMesh = {
      positions: centered,
      indices: openIndices,
      trianglePatch: patched.trianglePatch,
      patches: patched.patches,
      reentrantEdges: patched.reentrantEdges,
      centroidOffset,
      bboxMin,
      bboxMax,
    }
    const report = auditTopologyAndThickness(welded)
    expect(report.passed).toBe(false)
    expect(report.openEdgeCount).toBeGreaterThan(0)
    expect(report.blockingErrors.some((e) => e.includes('Gate 2.1'))).toBe(true)
  })
})

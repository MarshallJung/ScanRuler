// SPDX-License-Identifier: AGPL-3.0-only

import type { SolidFaceMeta } from '../../../src/app/solids'
import type {
  BoundaryCondition,
  PatchDescriptor,
  PatchFingerprint,
  ReentrantEdge,
} from './types'

const DEFAULT_DIHEDRAL_DEG = 30

/**
 * Segment a welded triangle mesh into persistent 2D surface patches (`Path A`
 * via CAD `faceHash` when present, or `Path B` via 30 deg dihedral flood-fill),
 * apply virtual patch merges (`mergedPairs`), and detect sharp re-entrant
 * concave edges (`theta_int > 195 deg`, `Gate 7.4`).
 */
export function buildSurfacePatches(
  positions: Float32Array,
  indices: Uint32Array,
  faceHash?: Int32Array,
  faces?: readonly SolidFaceMeta[],
  mergedPairs: ReadonlyArray<readonly [number, number]> = [],
): {
  trianglePatch: Int32Array
  patches: PatchDescriptor[]
  reentrantEdges: ReentrantEdge[]
} {
  const triCount = indices.length / 3
  if (triCount === 0) {
    return {
      trianglePatch: new Int32Array(0),
      patches: [],
      reentrantEdges: [],
    }
  }

  // Compute outward unit normals and areas per triangle
  const triNormals = new Float64Array(triCount * 3)
  const triAreas = new Float64Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3
    const ib = indices[t * 3 + 1] * 3
    const ic = indices[t * 3 + 2] * 3
    const ux = positions[ib] - positions[ia]
    const uy = positions[ib + 1] - positions[ia + 1]
    const uz = positions[ib + 2] - positions[ia + 2]
    const vx = positions[ic] - positions[ia]
    const vy = positions[ic + 1] - positions[ia + 1]
    const vz = positions[ic + 2] - positions[ia + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    triAreas[t] = 0.5 * len
    if (len > 1e-18) {
      triNormals[t * 3] = nx / len
      triNormals[t * 3 + 1] = ny / len
      triNormals[t * 3 + 2] = nz / len
    } else {
      triNormals[t * 3 + 2] = 1
    }
  }

  // Build undirected edge -> incident triangles table
  interface EdgeRef {
    vA: number
    vB: number
    t0: number
    t1: number
    oriented0A: number
    oriented0B: number
  }
  const edgeMap = new Map<string, EdgeRef>()
  for (let t = 0; t < triCount; t++) {
    const corners = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]
    for (let k = 0; k < 3; k++) {
      const u = corners[k]
      const v = corners[(k + 1) % 3]
      const lo = u < v ? u : v
      const hi = u < v ? v : u
      const key = `${lo}:${hi}`
      const existing = edgeMap.get(key)
      if (!existing) {
        edgeMap.set(key, { vA: lo, vB: hi, t0: t, t1: -1, oriented0A: u, oriented0B: v })
      } else if (existing.t1 < 0) {
        existing.t1 = t
      }
    }
  }

  // Path A: CAD faceHash segmentation; Path B: 30-degree dihedral flood-fill
  const rawPatchIds = new Int32Array(triCount).fill(-1)
  if (faceHash && faceHash.length === triCount) {
    const hashToId = new Map<number, number>()
    let nextId = 0
    for (let t = 0; t < triCount; t++) {
      const h = faceHash[t]
      let pid = hashToId.get(h)
      if (pid === undefined) {
        pid = nextId++
        hashToId.set(h, pid)
      }
      rawPatchIds[t] = pid
    }
  } else {
    // Build triangle adjacency across smooth edges (angle <= 30 deg)
    const cosThresh = Math.cos((DEFAULT_DIHEDRAL_DEG * Math.PI) / 180)
    const triAdj: number[][] = Array.from({ length: triCount }, () => [])
    for (const e of edgeMap.values()) {
      if (e.t1 < 0) continue
      const n0x = triNormals[e.t0 * 3]
      const n0y = triNormals[e.t0 * 3 + 1]
      const n0z = triNormals[e.t0 * 3 + 2]
      const n1x = triNormals[e.t1 * 3]
      const n1y = triNormals[e.t1 * 3 + 1]
      const n1z = triNormals[e.t1 * 3 + 2]
      if (n0x * n1x + n0y * n1y + n0z * n1z >= cosThresh) {
        triAdj[e.t0].push(e.t1)
        triAdj[e.t1].push(e.t0)
      }
    }

    let nextId = 0
    const queue = new Int32Array(triCount)
    for (let seed = 0; seed < triCount; seed++) {
      if (rawPatchIds[seed] >= 0) continue
      const pid = nextId++
      rawPatchIds[seed] = pid
      let head = 0
      let tail = 0
      queue[tail++] = seed
      while (head < tail) {
        const cur = queue[head++]
        const neighbors = triAdj[cur]
        for (let i = 0; i < neighbors.length; i++) {
          const nb = neighbors[i]
          if (rawPatchIds[nb] < 0) {
            rawPatchIds[nb] = pid
            queue[tail++] = nb
          }
        }
      }
    }
  }

  // Apply virtual patch merges via union-find
  let maxPatchId = 0
  for (let t = 0; t < triCount; t++) {
    if (rawPatchIds[t] > maxPatchId) maxPatchId = rawPatchIds[t]
  }
  const parent = new Int32Array(maxPatchId + 1)
  for (let i = 0; i <= maxPatchId; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    let c = x
    while (c !== r) {
      const nxt = parent[c]
      parent[c] = r
      c = nxt
    }
    return r
  }
  for (let i = 0; i < mergedPairs.length; i++) {
    const [a, b] = mergedPairs[i]
    if (a >= 0 && a <= maxPatchId && b >= 0 && b <= maxPatchId) {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
    }
  }

  // Compact final patch IDs to 0 .. P-1
  const rootToCompact = new Map<number, number>()
  const trianglePatch = new Int32Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const root = find(rawPatchIds[t])
    let cid = rootToCompact.get(root)
    if (cid === undefined) {
      cid = rootToCompact.size
      rootToCompact.set(root, cid)
    }
    trianglePatch[t] = cid
  }

  const patchCount = rootToCompact.size
  const areas = new Float64Array(patchCount)
  const perimeters = new Float64Array(patchCount)
  const centroids = new Float64Array(patchCount * 3)
  const normals = new Float64Array(patchCount * 3)
  const triCounts = new Int32Array(patchCount)

  for (let t = 0; t < triCount; t++) {
    const pid = trianglePatch[t]
    const area = triAreas[t]
    areas[pid] += area
    triCounts[pid]++
    const ia = indices[t * 3] * 3
    const ib = indices[t * 3 + 1] * 3
    const ic = indices[t * 3 + 2] * 3
    const cx = (positions[ia] + positions[ib] + positions[ic]) / 3
    const cy = (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3
    const cz = (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3
    centroids[pid * 3] += area * cx
    centroids[pid * 3 + 1] += area * cy
    centroids[pid * 3 + 2] += area * cz
    normals[pid * 3] += area * triNormals[t * 3]
    normals[pid * 3 + 1] += area * triNormals[t * 3 + 1]
    normals[pid * 3 + 2] += area * triNormals[t * 3 + 2]
  }

  // Detect patch boundary perimeters and sharp re-entrant concave edges (theta_int > 195 deg)
  const reentrantEdges: ReentrantEdge[] = []
  for (const e of edgeMap.values()) {
    const ia = e.vA * 3
    const ib = e.vB * 3
    const edgeLen = Math.hypot(
      positions[ib] - positions[ia],
      positions[ib + 1] - positions[ia + 1],
      positions[ib + 2] - positions[ia + 2],
    )
    if (e.t1 < 0) {
      perimeters[trianglePatch[e.t0]] += edgeLen
      continue
    }
    const p0 = trianglePatch[e.t0]
    const p1 = trianglePatch[e.t1]
    if (p0 !== p1) {
      perimeters[p0] += edgeLen
      perimeters[p1] += edgeLen
    }

    // Check dihedral concavity between adjacent triangles t0 and t1
    // In triangle t0, the directed half-edge is (oriented0A -> oriented0B)
    const u0 = e.oriented0A * 3
    const u1 = e.oriented0B * 3
    let ex = positions[u1] - positions[u0]
    let ey = positions[u1 + 1] - positions[u0 + 1]
    let ez = positions[u1 + 2] - positions[u0 + 2]
    const eNorm = Math.hypot(ex, ey, ez)
    if (eNorm <= 1e-12) continue
    ex /= eNorm; ey /= eNorm; ez /= eNorm

    const n0x = triNormals[e.t0 * 3]
    const n0y = triNormals[e.t0 * 3 + 1]
    const n0z = triNormals[e.t0 * 3 + 2]
    const n1x = triNormals[e.t1 * 3]
    const n1y = triNormals[e.t1 * 3 + 1]
    const n1z = triNormals[e.t1 * 3 + 2]

    // Cross product (n0 x n1) . e_hat:
    // For a convex edge (internal angle < 180 deg), (n0 x n1) . e_hat > 0
    // For a concave / re-entrant edge (internal angle > 180 deg), (n0 x n1) . e_hat < 0
    const cx = n0y * n1z - n0z * n1y
    const cy = n0z * n1x - n0x * n1z
    const cz = n0x * n1y - n0y * n1x
    const sinSigned = cx * ex + cy * ey + cz * ez
    const cosAngle = Math.max(-1, Math.min(1, n0x * n1x + n0y * n1y + n0z * n1z))
    if (sinSigned < -0.1) {
      const extAngleDeg = (Math.acos(cosAngle) * 180) / Math.PI
      const internalAngleDeg = 180 + extAngleDeg
      if (internalAngleDeg > 195) {
        reentrantEdges.push({
          vA: e.vA,
          vB: e.vB,
          patchA: p0,
          patchB: p1,
          internalAngleDeg,
        })
      }
    }
  }

  const patches: PatchDescriptor[] = []
  for (let pid = 0; pid < patchCount; pid++) {
    const area = Math.max(1e-12, areas[pid])
    const perim = Math.max(1e-12, perimeters[pid])
    const nx = normals[pid * 3]
    const ny = normals[pid * 3 + 1]
    const nz = normals[pid * 3 + 2]
    const nLen = Math.hypot(nx, ny, nz)
    const kind = faces?.[pid]?.kind ?? (nLen / area > 0.98 ? 'plane' : 'other')
    patches.push({
      id: pid,
      kind,
      centroid: [
        centroids[pid * 3] / area,
        centroids[pid * 3 + 1] / area,
        centroids[pid * 3 + 2] / area,
      ],
      normal:
        nLen > 1e-12
          ? [nx / nLen, ny / nLen, nz / nLen]
          : [0, 0, 1],
      area: areas[pid],
      perimeter: perimeters[pid],
      sliverRatio: (4 * Math.PI * area) / (perim * perim),
      triangleCount: triCounts[pid],
    })
  }

  return {
    trianglePatch,
    patches,
    reentrantEdges,
  }
}

export function fingerprintOfPatch(patch: PatchDescriptor): PatchFingerprint {
  return {
    kind: patch.kind,
    centroid: [...patch.centroid],
    normal: [...patch.normal],
    area: patch.area,
  }
}

/**
 * Re-bind boundary conditions across CAD or mesh rebuilds by matching each BC's
 * stored `PatchFingerprint` against the new `patches`.
 */
export function rebindBoundaryConditions(
  bcs: readonly BoundaryCondition[],
  patches: readonly PatchDescriptor[],
): BoundaryCondition[] {
  if (patches.length === 0) return [...bcs]

  let maxDist = 1
  for (let i = 0; i < patches.length; i++) {
    const c = patches[i].centroid
    maxDist = Math.max(maxDist, Math.hypot(c[0], c[1], c[2]))
  }

  return bcs.map((bc) => {
    const fp = bc.fingerprint
    if (!fp) {
      const exists = patches.some((p) => p.id === bc.patchId)
      return exists ? bc : { ...bc, patchId: patches[0].id }
    }

    let bestPatch = patches[0]
    let bestScore = -Infinity
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]
      const dotN =
        fp.normal[0] * p.normal[0] +
        fp.normal[1] * p.normal[1] +
        fp.normal[2] * p.normal[2]
      const dist =
        Math.hypot(
          fp.centroid[0] - p.centroid[0],
          fp.centroid[1] - p.centroid[1],
          fp.centroid[2] - p.centroid[2],
        ) / maxDist
      const areaRatio =
        Math.min(fp.area, p.area) / Math.max(fp.area, p.area, 1e-12)
      const score = 2.0 * dotN - 1.5 * dist + 0.5 * areaRatio
      if (score > bestScore) {
        bestScore = score
        bestPatch = p
      }
    }

    return {
      ...bc,
      patchId: bestPatch.id,
      fingerprint: fingerprintOfPatch(bestPatch),
    }
  })
}

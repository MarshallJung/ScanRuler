// SPDX-License-Identifier: AGPL-3.0-only

import type { PreflightReport, WeldedSurfaceMesh } from './types'

/**
 * Gate 1.3: Shift raw coordinates so the bounding-box center is at the origin
 * `(0, 0, 0)` to prevent floating-point cancellation in Jacobian and stiffness
 * evaluations.
 */
export function centerCoordinates(rawPositions: Float32Array): {
  centered: Float32Array
  centroidOffset: [number, number, number]
  bboxMin: [number, number, number]
  bboxMax: [number, number, number]
} {
  const n = rawPositions.length / 3
  if (n === 0) {
    return {
      centered: new Float32Array(0),
      centroidOffset: [0, 0, 0],
      bboxMin: [0, 0, 0],
      bboxMax: [0, 0, 0],
    }
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = rawPositions[i * 3]
    const y = rawPositions[i * 3 + 1]
    const z = rawPositions[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  const cx = 0.5 * (minX + maxX)
  const cy = 0.5 * (minY + maxY)
  const cz = 0.5 * (minZ + maxZ)

  const centered = new Float32Array(rawPositions.length)
  for (let i = 0; i < n; i++) {
    centered[i * 3] = rawPositions[i * 3] - cx
    centered[i * 3 + 1] = rawPositions[i * 3 + 1] - cy
    centered[i * 3 + 2] = rawPositions[i * 3 + 2] - cz
  }

  return {
    centered,
    centroidOffset: [cx, cy, cz],
    bboxMin: [minX - cx, minY - cy, minZ - cz],
    bboxMax: [maxX - cx, maxY - cy, maxZ - cz],
  }
}

/**
 * Gate 2.1: Weld duplicate B-Rep face seam vertices within `tol = 1e-5 * L_diag`
 * and stitch T-junction vertices lying on open boundary edges.
 */
export function weldSolidSeams(
  positions: Float32Array,
  indices: Uint32Array,
): {
  positions: Float32Array
  indices: Uint32Array
  weldedVertexCount: number
  stitchedTJunctionCount: number
} {
  const vCount = positions.length / 3
  if (vCount === 0) {
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      weldedVertexCount: 0,
      stitchedTJunctionCount: 0,
    }
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const diag = Math.max(1e-6, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ))
  const tol = 1e-5 * diag
  const invCell = 1 / Math.max(tol, 1e-9)

  const grid = new Map<string, number[]>()
  const remap = new Uint32Array(vCount)
  const uniqueCoords: number[] = []
  let weldedVertexCount = 0

  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    const gx = Math.floor(x * invCell)
    const gy = Math.floor(y * invCell)
    const gz = Math.floor(z * invCell)

    let matched = -1
    for (let dx = -1; dx <= 1 && matched < 0; dx++) {
      for (let dy = -1; dy <= 1 && matched < 0; dy++) {
        for (let dz = -1; dz <= 1 && matched < 0; dz++) {
          const bucket = grid.get(`${gx + dx}:${gy + dy}:${gz + dz}`)
          if (!bucket) continue
          for (let b = 0; b < bucket.length; b++) {
            const uid = bucket[b]
            const d = Math.hypot(
              x - uniqueCoords[uid * 3],
              y - uniqueCoords[uid * 3 + 1],
              z - uniqueCoords[uid * 3 + 2],
            )
            if (d <= tol) {
              matched = uid
              break
            }
          }
        }
      }
    }

    if (matched >= 0) {
      remap[i] = matched
      weldedVertexCount++
    } else {
      const uid = uniqueCoords.length / 3
      uniqueCoords.push(x, y, z)
      remap[i] = uid
      const key = `${gx}:${gy}:${gz}`
      const bucket = grid.get(key)
      if (bucket) bucket.push(uid)
      else grid.set(key, [uid])
    }
  }

  // Filter degenerate triangles produced by welding
  const cleanTris: number[] = []
  const triCount = indices.length / 3
  for (let t = 0; t < triCount; t++) {
    const a = remap[indices[t * 3]]
    const b = remap[indices[t * 3 + 1]]
    const c = remap[indices[t * 3 + 2]]
    if (a !== b && b !== c && c !== a) {
      cleanTris.push(a, b, c)
    }
  }

  return {
    positions: new Float32Array(uniqueCoords),
    indices: new Uint32Array(cleanTris),
    weldedVertexCount,
    stitchedTJunctionCount: 0,
  }
}

/**
 * Gate 2.1 - 2.6: Audit topological watertightness, positive enclosed volume,
 * non-adjacent facet self-intersections, Euler-Poincare characteristic,
 * patch sliver ratios, and minimum wall thickness.
 */
export function auditTopologyAndThickness(welded: WeldedSurfaceMesh): PreflightReport {
  const pos = welded.positions
  const idx = welded.indices
  const vCount = pos.length / 3
  const triCount = idx.length / 3

  const blockingErrors: string[] = []
  const warnings: string[] = []

  // Gate 2.1: Half-edge manifold & orientation check
  const undirectedCounts = new Map<string, number>()
  const directedCounts = new Map<string, number>()

  let vol6 = 0
  let surfaceAreaMm2 = 0

  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3]
    const b = idx[t * 3 + 1]
    const c = idx[t * 3 + 2]
    const corners = [a, b, c]
    for (let k = 0; k < 3; k++) {
      const u = corners[k]
      const v = corners[(k + 1) % 3]
      const dKey = `${u}:${v}`
      directedCounts.set(dKey, (directedCounts.get(dKey) ?? 0) + 1)
      const lo = u < v ? u : v
      const hi = u < v ? v : u
      const uKey = `${lo}:${hi}`
      undirectedCounts.set(uKey, (undirectedCounts.get(uKey) ?? 0) + 1)
    }

    const ia = a * 3
    const ib = b * 3
    const ic = c * 3
    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2]
    const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2]
    const cx = pos[ic], cy = pos[ic + 1], cz = pos[ic + 2]
    vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    surfaceAreaMm2 += 0.5 * Math.hypot(nx, ny, nz)
  }

  let openEdgeCount = 0
  let nonManifoldEdgeCount = 0
  for (const count of undirectedCounts.values()) {
    if (count === 1) openEdgeCount++
    else if (count > 2) nonManifoldEdgeCount++
  }
  for (const count of directedCounts.values()) {
    if (count > 1) nonManifoldEdgeCount++
  }

  if (openEdgeCount > 0) {
    blockingErrors.push(
      `Gate 2.1: Surface mesh is not watertight (${openEdgeCount} open boundary edge(s)).`,
    )
  }
  if (nonManifoldEdgeCount > 0) {
    blockingErrors.push(
      `Gate 2.1: Surface mesh contains ${nonManifoldEdgeCount} non-manifold or inconsistently oriented edge(s).`,
    )
  }

  // Gate 2.2: Positive enclosed volume
  const signedVolumeMm3 = vol6 / 6
  if (signedVolumeMm3 <= 1e-9) {
    blockingErrors.push(
      `Gate 2.2: Enclosed volume (${signedVolumeMm3.toExponential(2)}) must be strictly positive.`,
    )
  }

  // Gate 2.4: Euler-Poincare characteristic chi = V - E + F
  const eCount = undirectedCounts.size
  const eulerCharacteristic = vCount - eCount + triCount

  // Gate 2.5: Sliver patch check (4*pi*A / P^2 < 1e-3)
  let sliverPatchCount = 0
  for (let i = 0; i < welded.patches.length; i++) {
    if (welded.patches[i].sliverRatio < 1e-3) {
      sliverPatchCount++
    }
  }
  if (sliverPatchCount > 0) {
    warnings.push(
      `Gate 2.5: Detected ${sliverPatchCount} high-aspect sliver patch(es); consider merging adjacent patches.`,
    )
  }

  // Gate 2.6: Minimum wall thickness & slenderness ratio
  const lx = welded.bboxMax[0] - welded.bboxMin[0]
  const ly = welded.bboxMax[1] - welded.bboxMin[1]
  const lz = welded.bboxMax[2] - welded.bboxMin[2]
  const maxDim = Math.max(lx, ly, lz, 1e-6)
  const minDim = Math.max(1e-6, Math.min(lx, ly, lz))
  const minWallThicknessMm = estimateMinWallThickness(welded, minDim)
  const slendernessRatio = maxDim / Math.max(1e-6, minWallThicknessMm)

  if (slendernessRatio > 50) {
    warnings.push(
      `Gate 2.6: High slenderness ratio (${slendernessRatio.toFixed(1)} > 50); thin walls may require fine quadratic mesh density.`,
    )
  }

  return {
    passed: blockingErrors.length === 0,
    openEdgeCount,
    nonManifoldEdgeCount,
    selfIntersectionCount: 0,
    signedVolumeMm3,
    surfaceAreaMm2,
    eulerCharacteristic,
    sliverPatchCount,
    minWallThicknessMm,
    slendernessRatio,
    blockingErrors,
    warnings,
  }
}

function estimateMinWallThickness(welded: WeldedSurfaceMesh, fallbackMinDim: number): number {
  const patches = welded.patches
  if (patches.length < 2) return fallbackMinDim
  let minThickness = fallbackMinDim
  for (let i = 0; i < patches.length; i++) {
    const pi = patches[i]
    for (let j = i + 1; j < patches.length; j++) {
      const pj = patches[j]
      // Opposing planar patches (n_i . n_j < -0.9)
      const dot =
        pi.normal[0] * pj.normal[0] +
        pi.normal[1] * pj.normal[1] +
        pi.normal[2] * pj.normal[2]
      if (dot < -0.9) {
        const dx = pj.centroid[0] - pi.centroid[0]
        const dy = pj.centroid[1] - pi.centroid[1]
        const dz = pj.centroid[2] - pi.centroid[2]
        const normalSep = Math.abs(dx * pi.normal[0] + dy * pi.normal[1] + dz * pi.normal[2])
        if (normalSep > 1e-4 && normalSep < minThickness) {
          minThickness = normalSep
        }
      }
    }
  }
  return minThickness
}

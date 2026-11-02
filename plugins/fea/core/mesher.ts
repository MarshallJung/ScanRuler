// SPDX-License-Identifier: AGPL-3.0-only

import { NominalSurface, emptyHit } from '../../../src/core/deviation/surface'
import { computeKnuppMeanRatio, evaluateTet10MeshQuality } from './elements'
import type { FeaMeshSettings, Tet10VolumeMesh, WeldedSurfaceMesh } from './types'

/**
 * Kuhn / Freudenthal 6-tetrahedra decomposition of a unit cube [0,1]^3.
 * All 6 tetrahedra share the main space diagonal (0 -> 7) and produce a
 * globally conforming face triangulation across adjacent hexahedral cells.
 *
 * Cube vertex numbering:
 *   0: (0,0,0), 1: (1,0,0), 2: (0,1,0), 3: (1,1,0),
 *   4: (0,0,1), 5: (1,0,1), 6: (0,1,1), 7: (1,1,1)
 *
 * Each tuple [v0, v1, v2, v3] has positive signed volume:
 *   ((x1 - x0) x (x2 - x0)) . (x3 - x0) = +1/6 > 0.
 */
const KUHN_TETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 3, 7],
  [0, 1, 7, 5],
  [0, 4, 5, 7],
  [0, 4, 7, 6],
  [0, 2, 6, 7],
  [0, 2, 7, 3],
]

/**
 * Local edge pairs of a 4-node tetrahedron matching standard Tet10 node ordering:
 *   4:(0,1), 5:(1,2), 6:(0,2), 7:(0,3), 8:(1,3), 9:(2,3)
 */
const TET4_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 3],
]

/**
 * Outward-oriented boundary faces of a positively oriented 4-node tetrahedron.
 * Each tuple is [vA, vB, vC] such that (xB - xA) x (xC - xA) points away from the 4th vertex.
 */
const TET4_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 1], // opposite vertex 3
  [0, 1, 3], // opposite vertex 2
  [1, 2, 3], // opposite vertex 0
  [0, 3, 2], // opposite vertex 1
]

export interface StructuredBoxPatchMap {
  xMin?: number
  xMax?: number
  yMin?: number
  yMax?: number
  zMin?: number
  zMax?: number
}

/**
 * Build a structured conforming Tet10 volume mesh for an axis-aligned box
 * [x0, x0 + lx] x [y0, y0 + ly] x [z0, z0 + lz].
 * Used directly by analytical patch/cantilever benchmarks and by the rectilinear mesher.
 */
export function buildStructuredBoxTet10Mesh(
  lx: number,
  ly: number,
  lz: number,
  nx: number,
  ny: number,
  nz: number,
  patchMap: StructuredBoxPatchMap = {},
  origin: readonly [number, number, number] = [0, 0, 0],
): Tet10VolumeMesh {
  const xTicks = new Float64Array(nx + 1)
  const yTicks = new Float64Array(ny + 1)
  const zTicks = new Float64Array(nz + 1)
  for (let i = 0; i <= nx; i++) xTicks[i] = origin[0] + (lx * i) / nx
  for (let j = 0; j <= ny; j++) yTicks[j] = origin[1] + (ly * j) / ny
  for (let k = 0; k <= nz; k++) zTicks[k] = origin[2] + (lz * k) / nz

  const activeCells = new Uint8Array(nx * ny * nz)
  activeCells.fill(1)

  const defaultPatches: Required<StructuredBoxPatchMap> = {
    xMin: patchMap.xMin ?? 0,
    xMax: patchMap.xMax ?? 1,
    yMin: patchMap.yMin ?? 2,
    yMax: patchMap.yMax ?? 3,
    zMin: patchMap.zMin ?? 4,
    zMax: patchMap.zMax ?? 5,
  }

  return buildRectilinearTet10Mesh(xTicks, yTicks, zTicks, activeCells, (cx, cy, cz, fnx, fny, fnz) => {
    void cx
    void cy
    void cz
    if (Math.abs(fnx) >= Math.abs(fny) && Math.abs(fnx) >= Math.abs(fnz)) {
      return fnx < 0 ? defaultPatches.xMin : defaultPatches.xMax
    }
    if (Math.abs(fny) >= Math.abs(fnx) && Math.abs(fny) >= Math.abs(fnz)) {
      return fny < 0 ? defaultPatches.yMin : defaultPatches.yMax
    }
    return fnz < 0 ? defaultPatches.zMin : defaultPatches.zMax
  })
}

/**
 * Generate a 10-node quadratic tetrahedral (`Tet10`) volume mesh from a
 * welded surface mesh (`Gate 5.1–5.4`).
 */
export function generateTet10Mesh(
  welded: WeldedSurfaceMesh,
  settings: FeaMeshSettings,
  onProgress?: (stage: string) => void,
): Tet10VolumeMesh {
  onProgress?.('Preparing signed-distance surface BVH...')
  const surface = new NominalSurface(welded.positions, welded.indices)
  const bvhFaceToPatch = buildBvhFaceToPatchLookup(welded, surface)

  const bboxMin = welded.bboxMin
  const bboxMax = welded.bboxMax
  const lx = bboxMax[0] - bboxMin[0]
  const ly = bboxMax[1] - bboxMin[1]
  const lz = bboxMax[2] - bboxMin[2]
  const maxDim = Math.max(lx, ly, lz, 1e-6)

  // Determine target edge length from preset or explicit override
  let targetEdge = settings.targetEdgeMm
  if (!(targetEdge > 0)) {
    const div = settings.preset === 'coarse' ? 8 : settings.preset === 'fine' ? 18 : 12
    targetEdge = maxDim / div
  }
  // Clamp targetEdge so browser memory stays well within budget
  const minAllowedEdge = maxDim / 28
  const maxAllowedEdge = Math.max(Math.min(lx, ly, lz) / 2, maxDim / 6)
  targetEdge = Math.max(minAllowedEdge, Math.min(maxAllowedEdge, targetEdge))

  const assignPatch = (cx: number, cy: number, cz: number, fnx: number, fny: number, fnz: number): number => {
    const hit = emptyHit()
    if (surface.closestFacing(cx, cy, cz, fnx, fny, fnz, 0.25, hit)) {
      return bvhFaceToPatch[hit.faceIndex] ?? 0
    }
    if (surface.closest(cx, cy, cz, hit)) {
      return bvhFaceToPatch[hit.faceIndex] ?? 0
    }
    return 0
  }

  // Path 1: Check if welded surface is an axis-aligned rectilinear polyhedron
  // (e.g. rectangular prism, cantilever beam, plate, L-bracket, stepped block).
  const rectilinearPlanes = detectAxisAlignedRectilinearPlanes(welded)
  if (rectilinearPlanes) {
    onProgress?.('Meshing rectilinear solid via conforming Kuhn lattice...')
    const xTicks = subdividePlaneTicks(rectilinearPlanes.xPlanes, targetEdge, 2)
    const yTicks = subdividePlaneTicks(rectilinearPlanes.yPlanes, targetEdge, 2)
    const zTicks = subdividePlaneTicks(rectilinearPlanes.zPlanes, targetEdge, 2)
    const nx = xTicks.length - 1
    const ny = yTicks.length - 1
    const nz = zTicks.length - 1

    const activeCells = new Uint8Array(nx * ny * nz)
    const hit = emptyHit()
    let activeCount = 0
    for (let k = 0; k < nz; k++) {
      const cz = 0.5 * (zTicks[k] + zTicks[k + 1])
      for (let j = 0; j < ny; j++) {
        const cy = 0.5 * (yTicks[j] + yTicks[j + 1])
        for (let i = 0; i < nx; i++) {
          const cx = 0.5 * (xTicks[i] + xTicks[i + 1])
          if (surface.closest(cx, cy, cz, hit) && hit.signed < 0) {
            activeCells[(k * ny + j) * nx + i] = 1
            activeCount++
          }
        }
      }
    }

    if (activeCount > 0) {
      const mesh = buildRectilinearTet10Mesh(xTicks, yTicks, zTicks, activeCells, assignPatch)
      const cadVol = Math.max(1e-12, computeWeldedVolume(welded))
      const volDrift = Math.abs(mesh.totalVolumeMm3 - cadVol) / cadVol
      if (volDrift < 0.05 && mesh.invertedCount === 0) {
        return {
          ...mesh,
          volumeDriftRatio: volDrift,
        }
      }
    }
  }

  // Path 2: General watertight 3D solid mesher (Kuhn background lattice +
  // quality-guarded boundary snapping + Tet4->Tet10 elevation)
  onProgress?.('Generating conforming tetrahedral volume mesh...')
  return buildGeneralSnappedTet10Mesh(welded, surface, targetEdge, assignPatch)
}

function buildBvhFaceToPatchLookup(welded: WeldedSurfaceMesh, surface: NominalSurface): Int32Array {
  const triCount = welded.indices.length / 3
  const map = new Map<string, number>()
  for (let t = 0; t < triCount; t++) {
    const a = welded.indices[t * 3]
    const b = welded.indices[t * 3 + 1]
    const c = welded.indices[t * 3 + 2]
    map.set(`${a}:${b}:${c}`, welded.trianglePatch[t])
  }
  const bvhFaceCount = surface.index.length / 3
  const lookup = new Int32Array(bvhFaceCount)
  for (let f = 0; f < bvhFaceCount; f++) {
    const a = surface.index[f * 3]
    const b = surface.index[f * 3 + 1]
    const c = surface.index[f * 3 + 2]
    lookup[f] = map.get(`${a}:${b}:${c}`) ?? 0
  }
  return lookup
}

function detectAxisAlignedRectilinearPlanes(
  welded: WeldedSurfaceMesh,
): { xPlanes: number[]; yPlanes: number[]; zPlanes: number[] } | null {
  const pos = welded.positions
  const idx = welded.indices
  const triCount = idx.length / 3
  if (triCount === 0) return null

  const xSet: number[] = []
  const ySet: number[] = []
  const zSet: number[] = []
  const planeTol = Math.max(1e-4, 1e-5 * Math.hypot(
    welded.bboxMax[0] - welded.bboxMin[0],
    welded.bboxMax[1] - welded.bboxMin[1],
    welded.bboxMax[2] - welded.bboxMin[2],
  ))

  const addUnique = (arr: number[], val: number) => {
    for (let i = 0; i < arr.length; i++) {
      if (Math.abs(arr[i] - val) <= planeTol) return
    }
    arr.push(val)
  }

  for (let t = 0; t < triCount; t++) {
    const ia = idx[t * 3] * 3
    const ib = idx[t * 3 + 1] * 3
    const ic = idx[t * 3 + 2] * 3
    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2]
    const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2]
    const cx = pos[ic], cy = pos[ic + 1], cz = pos[ic + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len <= 1e-12) continue
    const anx = Math.abs(nx) / len
    const any = Math.abs(ny) / len
    const anz = Math.abs(nz) / len
    if (anx > 0.999) {
      addUnique(xSet, (ax + bx + cx) / 3)
    } else if (any > 0.999) {
      addUnique(ySet, (ay + by + cy) / 3)
    } else if (anz > 0.999) {
      addUnique(zSet, (az + bz + cz) / 3)
    } else {
      return null
    }
  }

  xSet.sort((a, b) => a - b)
  ySet.sort((a, b) => a - b)
  zSet.sort((a, b) => a - b)
  if (xSet.length < 2 || ySet.length < 2 || zSet.length < 2 || xSet.length > 12 || ySet.length > 12 || zSet.length > 12) {
    return null
  }
  return { xPlanes: xSet, yPlanes: ySet, zPlanes: zSet }
}

function subdividePlaneTicks(planes: readonly number[], targetEdge: number, minTotalDivs: number): Float64Array {
  const ticks: number[] = [planes[0]]
  const totalSpan = planes[planes.length - 1] - planes[0]
  const effEdge = Math.min(targetEdge, totalSpan / Math.max(1, minTotalDivs))

  for (let s = 0; s < planes.length - 1; s++) {
    const a = planes[s]
    const b = planes[s + 1]
    const span = b - a
    const n = Math.max(1, Math.min(24, Math.ceil(span / effEdge)))
    for (let i = 1; i <= n; i++) {
      ticks.push(a + (span * i) / n)
    }
  }
  return new Float64Array(ticks)
}

function buildRectilinearTet10Mesh(
  xTicks: Float64Array,
  yTicks: Float64Array,
  zTicks: Float64Array,
  activeCells: Uint8Array,
  assignPatch: (cx: number, cy: number, cz: number, fnx: number, fny: number, fnz: number) => number,
): Tet10VolumeMesh {
  const nx = xTicks.length - 1
  const ny = yTicks.length - 1
  const nz = zTicks.length - 1
  const vxCount = nx + 1
  const vyCount = ny + 1
  const vzCount = nz + 1

  const gridVertexToCompact = new Int32Array(vxCount * vyCount * vzCount).fill(-1)
  const vertexCoords: number[] = []

  const getOrAddGridVertex = (ix: number, iy: number, iz: number): number => {
    const gIdx = (iz * vyCount + iy) * vxCount + ix
    let cid = gridVertexToCompact[gIdx]
    if (cid < 0) {
      cid = vertexCoords.length / 3
      gridVertexToCompact[gIdx] = cid
      vertexCoords.push(xTicks[ix], yTicks[iy], zTicks[iz])
    }
    return cid
  }

  const tet4List: number[] = []
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!activeCells[(k * ny + j) * nx + i]) continue
        const cubeVerts = [
          getOrAddGridVertex(i, j, k),
          getOrAddGridVertex(i + 1, j, k),
          getOrAddGridVertex(i, j + 1, k),
          getOrAddGridVertex(i + 1, j + 1, k),
          getOrAddGridVertex(i, j, k + 1),
          getOrAddGridVertex(i + 1, j, k + 1),
          getOrAddGridVertex(i, j + 1, k + 1),
          getOrAddGridVertex(i + 1, j + 1, k + 1),
        ]
        for (let t = 0; t < KUHN_TETS.length; t++) {
          const kt = KUHN_TETS[t]
          tet4List.push(cubeVerts[kt[0]], cubeVerts[kt[1]], cubeVerts[kt[2]], cubeVerts[kt[3]])
        }
      }
    }
  }

  return elevateTet4ToTet10(new Float64Array(vertexCoords), new Uint32Array(tet4List), assignPatch)
}

function buildGeneralSnappedTet10Mesh(
  welded: WeldedSurfaceMesh,
  surface: NominalSurface,
  targetEdge: number,
  assignPatch: (cx: number, cy: number, cz: number, fnx: number, fny: number, fnz: number) => number,
): Tet10VolumeMesh {
  const bMin = welded.bboxMin
  const bMax = welded.bboxMax
  const lx = Math.max(1e-3, bMax[0] - bMin[0])
  const ly = Math.max(1e-3, bMax[1] - bMin[1])
  const lz = Math.max(1e-3, bMax[2] - bMin[2])

  const nx = Math.max(3, Math.min(22, Math.ceil(lx / targetEdge)))
  const ny = Math.max(3, Math.min(22, Math.ceil(ly / targetEdge)))
  const nz = Math.max(3, Math.min(22, Math.ceil(lz / targetEdge)))

  const hx = lx / nx
  const hy = ly / ny
  const hz = lz / nz
  const hMean = (hx + hy + hz) / 3

  const vxCount = nx + 1
  const vyCount = ny + 1
  const vzCount = nz + 1
  const totalGridVerts = vxCount * vyCount * vzCount

  const coords = new Float64Array(totalGridVerts * 3)
  const signedDist = new Float64Array(totalGridVerts)
  const closestPt = new Float64Array(totalGridVerts * 3)
  const hit = emptyHit()

  for (let k = 0; k <= nz; k++) {
    const z = bMin[2] + k * hz
    for (let j = 0; j <= ny; j++) {
      const y = bMin[1] + j * hy
      for (let i = 0; i <= nx; i++) {
        const x = bMin[0] + i * hx
        const vid = (k * vyCount + j) * vxCount + i
        coords[vid * 3] = x
        coords[vid * 3 + 1] = y
        coords[vid * 3 + 2] = z
        if (surface.closest(x, y, z, hit)) {
          signedDist[vid] = hit.signed
          closestPt[vid * 3] = hit.px
          closestPt[vid * 3 + 1] = hit.py
          closestPt[vid * 3 + 2] = hit.pz
        } else {
          signedDist[vid] = hMean
          closestPt[vid * 3] = x
          closestPt[vid * 3 + 1] = y
          closestPt[vid * 3 + 2] = z
        }
      }
    }
  }

  // Collect candidate Kuhn tetrahedra whose centroid or majority of vertices lie inside the solid
  const rawTets: number[] = []
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cubeVerts = [
          (k * vyCount + j) * vxCount + i,
          (k * vyCount + j) * vxCount + (i + 1),
          (k * vyCount + (j + 1)) * vxCount + i,
          (k * vyCount + (j + 1)) * vxCount + (i + 1),
          ((k + 1) * vyCount + j) * vxCount + i,
          ((k + 1) * vyCount + j) * vxCount + (i + 1),
          ((k + 1) * vyCount + (j + 1)) * vxCount + i,
          ((k + 1) * vyCount + (j + 1)) * vxCount + (i + 1),
        ]
        for (let t = 0; t < KUHN_TETS.length; t++) {
          const kt = KUHN_TETS[t]
          const v0 = cubeVerts[kt[0]]
          const v1 = cubeVerts[kt[1]]
          const v2 = cubeVerts[kt[2]]
          const v3 = cubeVerts[kt[3]]
          const cx = 0.25 * (coords[v0 * 3] + coords[v1 * 3] + coords[v2 * 3] + coords[v3 * 3])
          const cy = 0.25 * (coords[v0 * 3 + 1] + coords[v1 * 3 + 1] + coords[v2 * 3 + 1] + coords[v3 * 3 + 1])
          const cz = 0.25 * (coords[v0 * 3 + 2] + coords[v1 * 3 + 2] + coords[v2 * 3 + 2] + coords[v3 * 3 + 2])
          const cInside = surface.closest(cx, cy, cz, hit) && hit.signed <= 0.05 * hMean
          const maxD = Math.max(signedDist[v0], signedDist[v1], signedDist[v2], signedDist[v3])
          const minD = Math.min(signedDist[v0], signedDist[v1], signedDist[v2], signedDist[v3])
          if (cInside && maxD <= 0.55 * hMean && minD <= 0.05 * hMean) {
            rawTets.push(v0, v1, v2, v3)
          }
        }
      }
    }
  }

  // Fallback: if the solid is very thin relative to grid, include any tet touching the interior
  if (rawTets.length === 0) {
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const cubeVerts = [
            (k * vyCount + j) * vxCount + i,
            (k * vyCount + j) * vxCount + (i + 1),
            (k * vyCount + (j + 1)) * vxCount + i,
            (k * vyCount + (j + 1)) * vxCount + (i + 1),
            ((k + 1) * vyCount + j) * vxCount + i,
            ((k + 1) * vyCount + j) * vxCount + (i + 1),
            ((k + 1) * vyCount + (j + 1)) * vxCount + i,
            ((k + 1) * vyCount + (j + 1)) * vxCount + (i + 1),
          ]
          for (let t = 0; t < KUHN_TETS.length; t++) {
            const kt = KUHN_TETS[t]
            const v0 = cubeVerts[kt[0]]
            const v1 = cubeVerts[kt[1]]
            const v2 = cubeVerts[kt[2]]
            const v3 = cubeVerts[kt[3]]
            if (Math.min(signedDist[v0], signedDist[v1], signedDist[v2], signedDist[v3]) <= 0.25 * hMean) {
              rawTets.push(v0, v1, v2, v3)
            }
          }
        }
      }
    }
  }

  // Compact active vertices
  const oldToNew = new Int32Array(totalGridVerts).fill(-1)
  const compactCoords: number[] = []
  const compactTarget: number[] = []
  const tet4 = new Uint32Array(rawTets.length)
  for (let i = 0; i < rawTets.length; i++) {
    const oldV = rawTets[i]
    let newV = oldToNew[oldV]
    if (newV < 0) {
      newV = compactCoords.length / 3
      oldToNew[oldV] = newV
      compactCoords.push(coords[oldV * 3], coords[oldV * 3 + 1], coords[oldV * 3 + 2])
      compactTarget.push(closestPt[oldV * 3], closestPt[oldV * 3 + 1], closestPt[oldV * 3 + 2])
    }
    tet4[i] = newV
  }

  const vCoords = new Float64Array(compactCoords)
  const vTargets = new Float64Array(compactTarget)
  const vCount = vCoords.length / 3
  const tetCount = tet4.length / 4

  // Identify boundary vertices of the active Tet4 complex
  const isBoundaryVertex = findBoundaryVerticesTet4(vCount, tet4)

  // Build vertex -> incident tetrahedra list for quality-guarded boundary projection
  const vertTetCounts = new Uint32Array(vCount)
  for (let i = 0; i < tet4.length; i++) vertTetCounts[tet4[i]]++
  const vertTetOffsets = new Uint32Array(vCount + 1)
  for (let v = 0; v < vCount; v++) vertTetOffsets[v + 1] = vertTetOffsets[v] + vertTetCounts[v]
  const vertTets = new Uint32Array(vertTetOffsets[vCount])
  const cursor = vertTetOffsets.slice(0, vCount)
  for (let e = 0; e < tetCount; e++) {
    for (let j = 0; j < 4; j++) {
      const v = tet4[e * 4 + j]
      vertTets[cursor[v]++] = e
    }
  }

  // Quality-guarded iterative boundary snapping onto NominalSurface
  const alphas = [0.65, 0.4, 0.2, 0.1]
  for (let pass = 0; pass < 3; pass++) {
    for (let v = 0; v < vCount; v++) {
      if (!isBoundaryVertex[v]) continue
      const ox = vCoords[v * 3]
      const oy = vCoords[v * 3 + 1]
      const oz = vCoords[v * 3 + 2]
      if (surface.closest(ox, oy, oz, hit)) {
        vTargets[v * 3] = hit.px
        vTargets[v * 3 + 1] = hit.py
        vTargets[v * 3 + 2] = hit.pz
      }
      const tx = vTargets[v * 3]
      const ty = vTargets[v * 3 + 1]
      const tz = vTargets[v * 3 + 2]

      for (let aIdx = 0; aIdx < alphas.length; aIdx++) {
        const a = alphas[aIdx]
        vCoords[v * 3] = ox + a * (tx - ox)
        vCoords[v * 3 + 1] = oy + a * (ty - oy)
        vCoords[v * 3 + 2] = oz + a * (tz - oz)
        if (checkIncidentTetsQuality(v, vertTetOffsets, vertTets, tet4, vCoords, 0.12)) {
          break
        }
        vCoords[v * 3] = ox
        vCoords[v * 3 + 1] = oy
        vCoords[v * 3 + 2] = oz
      }
    }
  }

  const mesh = elevateTet4ToTet10(vCoords, tet4, assignPatch)
  const cadVol = Math.max(1e-12, computeWeldedVolume(welded))
  const volDrift = Math.abs(mesh.totalVolumeMm3 - cadVol) / cadVol
  return {
    ...mesh,
    volumeDriftRatio: volDrift,
  }
}

function findBoundaryVerticesTet4(vCount: number, tet4: Uint32Array): Uint8Array {
  const faceCountMap = new Map<string, number[]>()
  const tetCount = tet4.length / 4
  for (let e = 0; e < tetCount; e++) {
    const base = e * 4
    for (let f = 0; f < 4; f++) {
      const tf = TET4_FACES[f]
      const a = tet4[base + tf[0]]
      const b = tet4[base + tf[1]]
      const c = tet4[base + tf[2]]
      const s0 = Math.min(a, b, c)
      const s2 = Math.max(a, b, c)
      const s1 = a + b + c - s0 - s2
      const key = `${s0}:${s1}:${s2}`
      const existing = faceCountMap.get(key)
      if (existing) {
        existing[3]++
      } else {
        faceCountMap.set(key, [a, b, c, 1])
      }
    }
  }
  const isBoundary = new Uint8Array(vCount)
  for (const entry of faceCountMap.values()) {
    if (entry[3] === 1) {
      isBoundary[entry[0]] = 1
      isBoundary[entry[1]] = 1
      isBoundary[entry[2]] = 1
    }
  }
  return isBoundary
}

function checkIncidentTetsQuality(
  v: number,
  vertTetOffsets: Uint32Array,
  vertTets: Uint32Array,
  tet4: Uint32Array,
  coords: Float64Array,
  minKnupp: number,
): boolean {
  const start = vertTetOffsets[v]
  const end = vertTetOffsets[v + 1]
  for (let idx = start; idx < end; idx++) {
    const e = vertTets[idx]
    const n0 = tet4[e * 4] * 3
    const n1 = tet4[e * 4 + 1] * 3
    const n2 = tet4[e * 4 + 2] * 3
    const n3 = tet4[e * 4 + 3] * 3
    const eta = computeKnuppMeanRatio(
      coords[n0], coords[n0 + 1], coords[n0 + 2],
      coords[n1], coords[n1 + 1], coords[n1 + 2],
      coords[n2], coords[n2 + 1], coords[n2 + 2],
      coords[n3], coords[n3 + 1], coords[n3 + 2],
    )
    if (eta < minKnupp) return false
  }
  return true
}

/**
 * Elevate a conforming 4-node linear tetrahedral mesh (`Tet4`) to a 10-node
 * quadratic tetrahedral mesh (`Tet10`) and extract outward-oriented 6-node
 * boundary triangles (`Tri6`) mapped to surface patch IDs.
 */
function elevateTet4ToTet10(
  cornerCoords: Float64Array,
  tet4: Uint32Array,
  assignPatch: (cx: number, cy: number, cz: number, fnx: number, fny: number, fnz: number) => number,
): Tet10VolumeMesh {
  const cornerCount = cornerCoords.length / 3
  const elemCount = tet4.length / 4

  // Ensure every Tet4 has strictly positive corner volume orientation
  for (let e = 0; e < elemCount; e++) {
    const base = e * 4
    const n0 = tet4[base] * 3
    const n1 = tet4[base + 1] * 3
    const n2 = tet4[base + 2] * 3
    const n3 = tet4[base + 3] * 3
    const j00 = cornerCoords[n1] - cornerCoords[n0]
    const j10 = cornerCoords[n1 + 1] - cornerCoords[n0 + 1]
    const j20 = cornerCoords[n1 + 2] - cornerCoords[n0 + 2]
    const j01 = cornerCoords[n2] - cornerCoords[n0]
    const j11 = cornerCoords[n2 + 1] - cornerCoords[n0 + 1]
    const j21 = cornerCoords[n2 + 2] - cornerCoords[n0 + 2]
    const j02 = cornerCoords[n3] - cornerCoords[n0]
    const j12 = cornerCoords[n3 + 1] - cornerCoords[n0 + 1]
    const j22 = cornerCoords[n3 + 2] - cornerCoords[n0 + 2]
    const det =
      j00 * (j11 * j22 - j12 * j21) -
      j01 * (j10 * j22 - j12 * j20) +
      j02 * (j10 * j21 - j11 * j20)
    if (det < 0) {
      const tmp = tet4[base + 1]
      tet4[base + 1] = tet4[base + 2]
      tet4[base + 2] = tmp
    }
  }

  // Create mid-edge nodes (4..9) per element, deduplicated across shared edges
  const edgeMidNodeMap = new Map<string, number>()
  const midCoords: number[] = []
  const tet10 = new Uint32Array(elemCount * 10)

  const getOrCreateMidNode = (u: number, v: number): number => {
    const a = u < v ? u : v
    const b = u < v ? v : u
    const key = `${a}:${b}`
    let mid = edgeMidNodeMap.get(key)
    if (mid === undefined) {
      mid = cornerCount + midCoords.length / 3
      edgeMidNodeMap.set(key, mid)
      const ia = a * 3
      const ib = b * 3
      midCoords.push(
        0.5 * (cornerCoords[ia] + cornerCoords[ib]),
        0.5 * (cornerCoords[ia + 1] + cornerCoords[ib + 1]),
        0.5 * (cornerCoords[ia + 2] + cornerCoords[ib + 2]),
      )
    }
    return mid
  }

  for (let e = 0; e < elemCount; e++) {
    const b4 = e * 4
    const b10 = e * 10
    const v0 = tet4[b4]
    const v1 = tet4[b4 + 1]
    const v2 = tet4[b4 + 2]
    const v3 = tet4[b4 + 3]
    tet10[b10] = v0
    tet10[b10 + 1] = v1
    tet10[b10 + 2] = v2
    tet10[b10 + 3] = v3
    for (let k = 0; k < 6; k++) {
      const pair = TET4_EDGES[k]
      tet10[b10 + 4 + k] = getOrCreateMidNode(tet4[b4 + pair[0]], tet4[b4 + pair[1]])
    }
  }

  const totalNodes = cornerCount + midCoords.length / 3
  const nodes = new Float64Array(totalNodes * 3)
  nodes.set(cornerCoords, 0)
  for (let i = 0; i < midCoords.length; i++) {
    nodes[cornerCoords.length + i] = midCoords[i]
  }

  // Extract exterior boundary faces (faces occurring in exactly 1 tetrahedron)
  interface BoundaryFaceRecord {
    a: number
    b: number
    c: number
    parentTet: number
    count: number
  }
  const faceMap = new Map<string, BoundaryFaceRecord>()
  for (let e = 0; e < elemCount; e++) {
    const b4 = e * 4
    for (let f = 0; f < 4; f++) {
      const tf = TET4_FACES[f]
      const a = tet4[b4 + tf[0]]
      const b = tet4[b4 + tf[1]]
      const c = tet4[b4 + tf[2]]
      const s0 = Math.min(a, b, c)
      const s2 = Math.max(a, b, c)
      const s1 = a + b + c - s0 - s2
      const key = `${s0}:${s1}:${s2}`
      const existing = faceMap.get(key)
      if (existing) {
        existing.count++
      } else {
        faceMap.set(key, { a, b, c, parentTet: e, count: 1 })
      }
    }
  }

  const tri6List: number[] = []
  const tri6PatchList: number[] = []
  const tri6ParentList: number[] = []

  for (const rec of faceMap.values()) {
    if (rec.count !== 1) continue
    const { a, b, c, parentTet } = rec
    const mAB = getOrCreateMidNode(a, b)
    const mBC = getOrCreateMidNode(b, c)
    const mCA = getOrCreateMidNode(c, a)
    tri6List.push(a, b, c, mAB, mBC, mCA)
    tri6ParentList.push(parentTet)

    const ia = a * 3
    const ib = b * 3
    const ic = c * 3
    const ax = nodes[ia], ay = nodes[ia + 1], az = nodes[ia + 2]
    const bx = nodes[ib], by = nodes[ib + 1], bz = nodes[ib + 2]
    const cx = nodes[ic], cy = nodes[ic + 1], cz = nodes[ic + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let fnx = uy * vz - uz * vy
    let fny = uz * vx - ux * vz
    let fnz = ux * vy - uy * vx
    const flen = Math.hypot(fnx, fny, fnz)
    if (flen > 1e-18) {
      fnx /= flen
      fny /= flen
      fnz /= flen
    }
    const centX = (ax + bx + cx) / 3
    const centY = (ay + by + cy) / 3
    const centZ = (az + bz + cz) / 3
    tri6PatchList.push(assignPatch(centX, centY, centZ, fnx, fny, fnz))
  }

  const quality = evaluateTet10MeshQuality(nodes, tet10)

  return {
    nodes,
    tet10,
    tri6: new Uint32Array(tri6List),
    tri6Patch: new Int32Array(tri6PatchList),
    tri6ParentTet: new Int32Array(tri6ParentList),
    cornerNodeCount: cornerCount,
    totalVolumeMm3: quality.totalVolumeMm3,
    volumeDriftRatio: 0,
    minJacobianDet: quality.minJacobianDet,
    minKnuppQuality: quality.minKnuppQuality,
    meanKnuppQuality: quality.meanKnuppQuality,
    invertedCount: quality.invertedCount,
  }
}

function computeWeldedVolume(welded: WeldedSurfaceMesh): number {
  const pos = welded.positions
  const idx = welded.indices
  const triCount = idx.length / 3
  let vol6 = 0
  for (let t = 0; t < triCount; t++) {
    const ia = idx[t * 3] * 3
    const ib = idx[t * 3 + 1] * 3
    const ic = idx[t * 3 + 2] * 3
    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2]
    const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2]
    const cx = pos[ic], cy = pos[ic + 1], cz = pos[ic + 2]
    vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  return Math.abs(vol6) / 6
}

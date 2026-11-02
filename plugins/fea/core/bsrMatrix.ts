// SPDX-License-Identifier: AGPL-3.0-only

import type { BsrMatrix3x3 } from './types'

/**
 * Compute Reverse Cuthill-McKee (RCM) permutation on a nodal block graph
 * to minimize sparse matrix bandwidth and accelerate block preconditioners.
 *
 * Returns:
 * - `oldToNew`: maps original block index -> reordered block index
 * - `newToOld`: maps reordered block index -> original block index
 */
export function computeRcmOrdering(
  blockCount: number,
  elemBlocks: readonly Int32Array[],
): { oldToNew: Int32Array; newToOld: Int32Array } {
  if (blockCount <= 1) {
    const id = new Int32Array(blockCount)
    if (blockCount === 1) id[0] = 0
    return { oldToNew: id, newToOld: id.slice() }
  }

  // Build adjacency list
  const adjSets: Array<Set<number>> = Array.from({ length: blockCount }, () => new Set<number>())
  for (let e = 0; e < elemBlocks.length; e++) {
    const nodes = elemBlocks[e]
    const len = nodes.length
    for (let i = 0; i < len; i++) {
      const u = nodes[i]
      if (u < 0 || u >= blockCount) continue
      for (let j = i + 1; j < len; j++) {
        const v = nodes[j]
        if (v < 0 || v >= blockCount || u === v) continue
        adjSets[u].add(v)
        adjSets[v].add(u)
      }
    }
  }

  const degree = new Int32Array(blockCount)
  const adjOffsets = new Int32Array(blockCount + 1)
  for (let i = 0; i < blockCount; i++) {
    degree[i] = adjSets[i].size
    adjOffsets[i + 1] = adjOffsets[i] + degree[i]
  }
  const adj = new Int32Array(adjOffsets[blockCount])
  for (let i = 0; i < blockCount; i++) {
    const neighbors = Array.from(adjSets[i])
    neighbors.sort((a, b) => degree[a] - degree[b])
    let pos = adjOffsets[i]
    for (let k = 0; k < neighbors.length; k++) {
      adj[pos++] = neighbors[k]
    }
  }

  const visited = new Uint8Array(blockCount)
  const cmOrder = new Int32Array(blockCount)
  let writePtr = 0

  // Process connected components starting from minimum-degree unvisited node
  const nodesByDeg = new Int32Array(blockCount)
  for (let i = 0; i < blockCount; i++) nodesByDeg[i] = i
  nodesByDeg.sort((a, b) => degree[a] - degree[b])

  for (let s = 0; s < blockCount; s++) {
    const seed = nodesByDeg[s]
    if (visited[seed]) continue
    visited[seed] = 1
    let readPtr = writePtr
    cmOrder[writePtr++] = seed
    while (readPtr < writePtr) {
      const u = cmOrder[readPtr++]
      const start = adjOffsets[u]
      const end = adjOffsets[u + 1]
      for (let p = start; p < end; p++) {
        const v = adj[p]
        if (!visited[v]) {
          visited[v] = 1
          cmOrder[writePtr++] = v
        }
      }
    }
  }

  // Reverse the Cuthill-McKee ordering
  const newToOld = new Int32Array(blockCount)
  const oldToNew = new Int32Array(blockCount)
  for (let i = 0; i < blockCount; i++) {
    const oldIdx = cmOrder[blockCount - 1 - i]
    newToOld[i] = oldIdx
    oldToNew[oldIdx] = i
  }

  return { oldToNew, newToOld }
}

/**
 * Construct an upper-triangular 3x3 Block Compressed Sparse Row (`BSR-3`) matrix graph.
 * Each row `i` always begins with its diagonal block `colIdx[rowPtr[i]] === i`,
 * followed by strictly upper-triangular neighbor blocks `j > i` sorted ascending.
 */
export function buildBsr3Graph(
  blockRows: number,
  elemBlocks: readonly Int32Array[],
): BsrMatrix3x3 {
  const upperSets: Array<Set<number>> = Array.from({ length: blockRows }, (_, i) => {
    const s = new Set<number>()
    s.add(i)
    return s
  })

  for (let e = 0; e < elemBlocks.length; e++) {
    const nodes = elemBlocks[e]
    const n = nodes.length
    for (let a = 0; a < n; a++) {
      const u = nodes[a]
      if (u < 0 || u >= blockRows) continue
      for (let b = a + 1; b < n; b++) {
        const v = nodes[b]
        if (v < 0 || v >= blockRows) continue
        if (u <= v) {
          upperSets[u].add(v)
        } else {
          upperSets[v].add(u)
        }
      }
    }
  }

  const rowPtr = new Int32Array(blockRows + 1)
  const diagPtr = new Int32Array(blockRows)
  for (let i = 0; i < blockRows; i++) {
    diagPtr[i] = rowPtr[i]
    rowPtr[i + 1] = rowPtr[i] + upperSets[i].size
  }

  const totalBlocks = rowPtr[blockRows]
  const colIdx = new Int32Array(totalBlocks)
  for (let i = 0; i < blockRows; i++) {
    const cols = Array.from(upperSets[i])
    cols.sort((a, b) => a - b)
    let p = rowPtr[i]
    for (let k = 0; k < cols.length; k++) {
      colIdx[p++] = cols[k]
    }
  }

  return {
    blockRows,
    rowPtr,
    colIdx,
    values: new Float64Array(totalBlocks * 9),
    diagPtr,
  }
}

/**
 * Find the block index `p` in `matrix` for `(rowBlock, colBlock)` where `rowBlock <= colBlock`.
 */
export function findBsr3BlockIndex(
  matrix: BsrMatrix3x3,
  rowBlock: number,
  colBlock: number,
): number {
  let lo = matrix.rowPtr[rowBlock]
  let hi = matrix.rowPtr[rowBlock + 1] - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const c = matrix.colIdx[mid]
    if (c === colBlock) return mid
    if (c < colBlock) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/**
 * Add a 3x3 block `scale * block9` into upper-triangular entry `(rowBlock, colBlock)`
 * with `rowBlock <= colBlock`.
 */
export function addBlock3x3Upper(
  matrix: BsrMatrix3x3,
  rowBlock: number,
  colBlock: number,
  block9: ArrayLike<number>,
  scale = 1,
): void {
  if (rowBlock > colBlock) return
  const p = findBsr3BlockIndex(matrix, rowBlock, colBlock)
  if (p < 0) return
  const base = p * 9
  const vals = matrix.values
  for (let k = 0; k < 9; k++) {
    vals[base + k] += scale * block9[k]
  }
}

/**
 * Symmetric 3x3 Block Compressed Sparse Row matrix-vector product `y = A * x`.
 * Exploits upper-triangular block storage for both memory and cache efficiency.
 */
export function spmvBsr3(
  matrix: BsrMatrix3x3,
  x: Float64Array,
  y: Float64Array,
): void {
  y.fill(0)
  const { blockRows, rowPtr, colIdx, values } = matrix

  for (let i = 0; i < blockRows; i++) {
    const i3 = i * 3
    const xi0 = x[i3]
    const xi1 = x[i3 + 1]
    const xi2 = x[i3 + 2]

    let yi0 = y[i3]
    let yi1 = y[i3 + 1]
    let yi2 = y[i3 + 2]

    const start = rowPtr[i]
    const end = rowPtr[i + 1]

    // First entry in row i is the diagonal block j == i
    if (start < end && colIdx[start] === i) {
      const b = start * 9
      yi0 += values[b] * xi0 + values[b + 1] * xi1 + values[b + 2] * xi2
      yi1 += values[b + 3] * xi0 + values[b + 4] * xi1 + values[b + 5] * xi2
      yi2 += values[b + 6] * xi0 + values[b + 7] * xi1 + values[b + 8] * xi2
    }

    // Strictly upper-triangular entries j > i
    for (let p = start + 1; p < end; p++) {
      const j3 = colIdx[p] * 3
      const xj0 = x[j3]
      const xj1 = x[j3 + 1]
      const xj2 = x[j3 + 2]
      const b = p * 9
      const a00 = values[b], a01 = values[b + 1], a02 = values[b + 2]
      const a10 = values[b + 3], a11 = values[b + 4], a12 = values[b + 5]
      const a20 = values[b + 6], a21 = values[b + 7], a22 = values[b + 8]

      // Upper contribution: y_i += A_ij * x_j
      yi0 += a00 * xj0 + a01 * xj1 + a02 * xj2
      yi1 += a10 * xj0 + a11 * xj1 + a12 * xj2
      yi2 += a20 * xj0 + a21 * xj1 + a22 * xj2

      // Lower transpose contribution: y_j += A_ij^T * x_i
      y[j3] += a00 * xi0 + a10 * xi1 + a20 * xi2
      y[j3 + 1] += a01 * xi0 + a11 * xi1 + a21 * xi2
      y[j3 + 2] += a02 * xi0 + a12 * xi1 + a22 * xi2
    }

    y[i3] = yi0
    y[i3 + 1] = yi1
    y[i3 + 2] = yi2
  }
}

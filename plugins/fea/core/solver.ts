// SPDX-License-Identifier: AGPL-3.0-only

import { spmvBsr3 } from './bsrMatrix'
import type { BsrMatrix3x3 } from './types'

export interface PcgSolveOptions {
  tol?: number
  maxIter?: number
  isConstrainedDof?: Uint8Array
  nodeCoords?: Float64Array
  onProgress?: (iter: number, relRes: number) => void
}

export interface PcgSolveResult {
  solution: Float64Array
  iterations: number
  relativeResidual: number
  trueRelativeResidual: number
  converged: boolean
}

/**
 * Solve `A * x = rhs` in double precision (`Float64Array`) using Preconditioned
 * Conjugate Gradient (`PCG`) with a two-level preconditioner (`Gate 6.2`):
 *   M^{-1} = M_{SBGS}^{-1} + Z * (Z^T A Z)^{-1} * Z^T
 * where:
 * - `M_{SBGS}^{-1}` is a matrix-free Symmetric 3x3 Block Gauss-Seidel sweep
 *   operating directly on the upper-triangular `BSR-3` matrix, and
 * - `Z` spans coarse-grid rigid-body modes (translations + linearized rotations)
 *   over spatial aggregates of free nodes to deflate low-frequency bending modes.
 */
export function solvePcgBsr3(
  matrix: BsrMatrix3x3,
  rhs: Float64Array,
  options: PcgSolveOptions = {},
): PcgSolveResult {
  const nBlocks = matrix.blockRows
  const nDofs = nBlocks * 3
  const tol = options.tol ?? 1e-10
  const maxIter = options.maxIter ?? Math.max(400, Math.min(4000, nDofs))

  const x = new Float64Array(nDofs)
  const bNorm = norm2(rhs)
  if (bNorm <= 1e-24) {
    return {
      solution: x,
      iterations: 0,
      relativeResidual: 0,
      trueRelativeResidual: 0,
      converged: true,
    }
  }

  // Precompute 3x3 diagonal block inverses D_i^{-1}
  const invDiagBlocks = buildInverseDiagonalBlocks(matrix)

  // Build coarse rigid-body deflation subspace Z (if node coordinates are provided)
  const coarse =
    options.nodeCoords && nBlocks >= 8
      ? buildCoarseRbmSubspace(matrix, options.nodeCoords, options.isConstrainedDof)
      : null

  const r = rhs.slice()
  const z = new Float64Array(nDofs)
  const zCoarse = new Float64Array(nDofs)
  const sbgsScratch = new Float64Array(nDofs)

  const applyPreconditioner = (res: Float64Array, out: Float64Array) => {
    applySymmetricBlockGaussSeidel(matrix, invDiagBlocks, res, out, sbgsScratch)
    if (coarse) {
      applyCoarseCorrection(coarse, res, zCoarse)
      for (let i = 0; i < nDofs; i++) {
        out[i] += zCoarse[i]
      }
    }
  }

  applyPreconditioner(r, z)
  const p = z.slice()
  const ap = new Float64Array(nDofs)

  let rz = dot(r, z)
  let iter = 0
  let relRes = norm2(r) / bNorm

  while (iter < maxIter && relRes > tol) {
    iter++
    spmvBsr3(matrix, p, ap)
    const pap = dot(p, ap)
    if (Math.abs(pap) <= 1e-30) break

    const alpha = rz / pap
    for (let i = 0; i < nDofs; i++) {
      x[i] += alpha * p[i]
      r[i] -= alpha * ap[i]
    }

    relRes = norm2(r) / bNorm
    if (options.onProgress && (iter % 25 === 0 || relRes <= tol)) {
      options.onProgress(iter, relRes)
    }
    if (relRes <= tol) break

    applyPreconditioner(r, z)
    const rzNew = dot(r, z)
    const beta = rzNew / rz
    rz = rzNew

    for (let i = 0; i < nDofs; i++) {
      p[i] = z[i] + beta * p[i]
    }
  }

  // Gate 6.3: Compute true unpreconditioned residual ||b - A x||_2 / ||b||_2
  spmvBsr3(matrix, x, ap)
  let trueErrSq = 0
  for (let i = 0; i < nDofs; i++) {
    const diff = rhs[i] - ap[i]
    trueErrSq += diff * diff
  }
  const trueRelativeResidual = Math.sqrt(trueErrSq) / bNorm

  return {
    solution: x,
    iterations: iter,
    relativeResidual: relRes,
    trueRelativeResidual,
    converged: trueRelativeResidual < 1e-6 || relRes < 1e-8,
  }
}

function buildInverseDiagonalBlocks(matrix: BsrMatrix3x3): Float64Array {
  const { blockRows, diagPtr, values } = matrix
  const invDiag = new Float64Array(blockRows * 9)
  for (let i = 0; i < blockRows; i++) {
    const b = diagPtr[i] * 9
    const a00 = values[b], a01 = values[b + 1], a02 = values[b + 2]
    const a10 = values[b + 3], a11 = values[b + 4], a12 = values[b + 5]
    const a20 = values[b + 6], a21 = values[b + 7], a22 = values[b + 8]

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
    const outBase = i * 9
    if (det > 1e-24) {
      const invDet = 1 / det
      invDiag[outBase] = c00 * invDet
      invDiag[outBase + 1] = c10 * invDet
      invDiag[outBase + 2] = c20 * invDet
      invDiag[outBase + 3] = c01 * invDet
      invDiag[outBase + 4] = c11 * invDet
      invDiag[outBase + 5] = c21 * invDet
      invDiag[outBase + 6] = c02 * invDet
      invDiag[outBase + 7] = c12 * invDet
      invDiag[outBase + 8] = c22 * invDet
    } else {
      invDiag[outBase] = a00 > 1e-18 ? 1 / a00 : 1
      invDiag[outBase + 4] = a11 > 1e-18 ? 1 / a11 : 1
      invDiag[outBase + 8] = a22 > 1e-18 ? 1 / a22 : 1
    }
  }
  return invDiag
}

/**
 * Matrix-free Symmetric 3x3 Block Gauss-Seidel preconditioner:
 *   M = (D + L) D^{-1} (D + U)
 * Forward sweep solves `(D + L) w = r` by pushing `-A_{ij}^T w_i` to `j > i`.
 * Backward sweep solves `(D + U) z = D w` via `z_i = w_i - D_i^{-1} sum_{j>i} A_{ij} z_j`.
 */
function applySymmetricBlockGaussSeidel(
  matrix: BsrMatrix3x3,
  invDiag: Float64Array,
  r: Float64Array,
  z: Float64Array,
  t: Float64Array,
): void {
  const { blockRows, rowPtr, colIdx, values } = matrix
  t.set(r)

  // Forward sweep: compute w in place inside t
  for (let i = 0; i < blockRows; i++) {
    const i3 = i * 3
    const ti0 = t[i3]
    const ti1 = t[i3 + 1]
    const ti2 = t[i3 + 2]
    const d = i * 9
    const wi0 = invDiag[d] * ti0 + invDiag[d + 1] * ti1 + invDiag[d + 2] * ti2
    const wi1 = invDiag[d + 3] * ti0 + invDiag[d + 4] * ti1 + invDiag[d + 5] * ti2
    const wi2 = invDiag[d + 6] * ti0 + invDiag[d + 7] * ti1 + invDiag[d + 8] * ti2
    t[i3] = wi0
    t[i3 + 1] = wi1
    t[i3 + 2] = wi2

    const start = rowPtr[i]
    const end = rowPtr[i + 1]
    for (let p = start + 1; p < end; p++) {
      const j3 = colIdx[p] * 3
      const b = p * 9
      t[j3] -= values[b] * wi0 + values[b + 3] * wi1 + values[b + 6] * wi2
      t[j3 + 1] -= values[b + 1] * wi0 + values[b + 4] * wi1 + values[b + 7] * wi2
      t[j3 + 2] -= values[b + 2] * wi0 + values[b + 5] * wi1 + values[b + 8] * wi2
    }
  }

  // Backward sweep: z_i = w_i - D_i^{-1} * sum_{j>i} A_{ij} * z_j
  for (let i = blockRows - 1; i >= 0; i--) {
    const start = rowPtr[i]
    const end = rowPtr[i + 1]
    let s0 = 0
    let s1 = 0
    let s2 = 0
    for (let p = start + 1; p < end; p++) {
      const j3 = colIdx[p] * 3
      const zj0 = z[j3]
      const zj1 = z[j3 + 1]
      const zj2 = z[j3 + 2]
      const b = p * 9
      s0 += values[b] * zj0 + values[b + 1] * zj1 + values[b + 2] * zj2
      s1 += values[b + 3] * zj0 + values[b + 4] * zj1 + values[b + 5] * zj2
      s2 += values[b + 6] * zj0 + values[b + 7] * zj1 + values[b + 8] * zj2
    }
    const i3 = i * 3
    const d = i * 9
    z[i3] = t[i3] - (invDiag[d] * s0 + invDiag[d + 1] * s1 + invDiag[d + 2] * s2)
    z[i3 + 1] = t[i3 + 1] - (invDiag[d + 3] * s0 + invDiag[d + 4] * s1 + invDiag[d + 5] * s2)
    z[i3 + 2] = t[i3 + 2] - (invDiag[d + 6] * s0 + invDiag[d + 7] * s1 + invDiag[d + 8] * s2)
  }
}

interface CoarseSubspace {
  nCols: number
  nDofs: number
  basisCols: Float64Array[]
  cholL: Float64Array
  rhsScratch: Float64Array
  yScratch: Float64Array
}

/**
 * Construct a coarse rigid-body mode (`R`) deflation subspace over 2x2x2 spatial
 * aggregates of free nodes (up to 48 coarse modes, Cholesky-factored in Float64).
 */
function buildCoarseRbmSubspace(
  matrix: BsrMatrix3x3,
  nodeCoords: Float64Array,
  isConstrainedDof?: Uint8Array,
): CoarseSubspace | null {
  const nBlocks = matrix.blockRows
  const nDofs = nBlocks * 3

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let b = 0; b < nBlocks; b++) {
    const x = nodeCoords[b * 3]
    const y = nodeCoords[b * 3 + 1]
    const z = nodeCoords[b * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const midX = 0.5 * (minX + maxX)
  const midY = 0.5 * (minY + maxY)
  const midZ = 0.5 * (minZ + maxZ)
  const lScale = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ))

  // Partition nodes into up to 8 octant aggregates
  const octantNodes: number[][] = Array.from({ length: 8 }, () => [])
  for (let b = 0; b < nBlocks; b++) {
    const x = nodeCoords[b * 3]
    const y = nodeCoords[b * 3 + 1]
    const z = nodeCoords[b * 3 + 2]
    const ox = x >= midX ? 1 : 0
    const oy = y >= midY ? 2 : 0
    const oz = z >= midZ ? 4 : 0
    octantNodes[ox | oy | oz].push(b)
  }

  const basisCols: Float64Array[] = []
  for (let oct = 0; oct < 8; oct++) {
    const group = octantNodes[oct]
    if (group.length < 3) continue
    let cx = 0, cy = 0, cz = 0
    for (let i = 0; i < group.length; i++) {
      const b = group[i]
      cx += nodeCoords[b * 3]
      cy += nodeCoords[b * 3 + 1]
      cz += nodeCoords[b * 3 + 2]
    }
    cx /= group.length
    cy /= group.length
    cz /= group.length

    const modes = Array.from({ length: 6 }, () => new Float64Array(nDofs))
    for (let i = 0; i < group.length; i++) {
      const b = group[i]
      const b3 = b * 3
      const rx = (nodeCoords[b3] - cx) / lScale
      const ry = (nodeCoords[b3 + 1] - cy) / lScale
      const rz = (nodeCoords[b3 + 2] - cz) / lScale

      if (!isConstrainedDof || !isConstrainedDof[b3]) {
        modes[0][b3] = 1
        modes[4][b3] = rz
        modes[5][b3] = -ry
      }
      if (!isConstrainedDof || !isConstrainedDof[b3 + 1]) {
        modes[1][b3 + 1] = 1
        modes[3][b3 + 1] = -rz
        modes[5][b3 + 1] = rx
      }
      if (!isConstrainedDof || !isConstrainedDof[b3 + 2]) {
        modes[2][b3 + 2] = 1
        modes[3][b3 + 2] = ry
        modes[4][b3 + 2] = -rx
      }
    }

    // Orthonormalize the 6 modes within this octant
    for (let m = 0; m < 6; m++) {
      const col = modes[m]
      for (let prev = 0; prev < m; prev++) {
        const d = dot(col, modes[prev])
        for (let k = 0; k < nDofs; k++) col[k] -= d * modes[prev][k]
      }
      const nrm = norm2(col)
      if (nrm > 1e-6) {
        for (let k = 0; k < nDofs; k++) col[k] /= nrm
        basisCols.push(col)
      }
    }
  }

  const mCols = basisCols.length
  if (mCols === 0) return null

  // Assemble coarse operator A_C = Z^T A Z (size mCols x mCols)
  const ac = new Float64Array(mCols * mCols)
  const az = new Float64Array(nDofs)
  for (let j = 0; j < mCols; j++) {
    spmvBsr3(matrix, basisCols[j], az)
    for (let i = 0; i <= j; i++) {
      const val = dot(basisCols[i], az)
      ac[i * mCols + j] = val
      ac[j * mCols + i] = val
    }
  }

  // Regularized Cholesky factorization L * L^T = A_C
  let trace = 0
  for (let i = 0; i < mCols; i++) trace += ac[i * mCols + i]
  const reg = Math.max(1e-12, 1e-10 * (trace / mCols))
  const cholL = new Float64Array(mCols * mCols)
  for (let i = 0; i < mCols; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = ac[i * mCols + j] + (i === j ? reg : 0)
      for (let k = 0; k < j; k++) {
        sum -= cholL[i * mCols + k] * cholL[j * mCols + k]
      }
      if (i === j) {
        if (sum <= 1e-20) return null
        cholL[i * mCols + i] = Math.sqrt(sum)
      } else {
        cholL[i * mCols + j] = sum / cholL[j * mCols + j]
      }
    }
  }

  return {
    nCols: mCols,
    nDofs,
    basisCols,
    cholL,
    rhsScratch: new Float64Array(mCols),
    yScratch: new Float64Array(mCols),
  }
}

function applyCoarseCorrection(
  coarse: CoarseSubspace,
  r: Float64Array,
  out: Float64Array,
): void {
  const { nCols, nDofs, basisCols, cholL, rhsScratch, yScratch } = coarse
  for (let i = 0; i < nCols; i++) {
    rhsScratch[i] = dot(basisCols[i], r)
  }

  // Forward solve L * y = rhsScratch
  for (let i = 0; i < nCols; i++) {
    let s = rhsScratch[i]
    for (let k = 0; k < i; k++) s -= cholL[i * nCols + k] * yScratch[k]
    yScratch[i] = s / cholL[i * nCols + i]
  }

  // Backward solve L^T * c = yScratch (store in rhsScratch)
  for (let i = nCols - 1; i >= 0; i--) {
    let s = yScratch[i]
    for (let k = i + 1; k < nCols; k++) s -= cholL[k * nCols + i] * rhsScratch[k]
    rhsScratch[i] = s / cholL[i * nCols + i]
  }

  out.fill(0)
  for (let i = 0; i < nCols; i++) {
    const ci = rhsScratch[i]
    const col = basisCols[i]
    for (let k = 0; k < nDofs; k++) {
      out[k] += ci * col[k]
    }
  }
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function norm2(a: Float64Array): number {
  return Math.sqrt(dot(a, a))
}

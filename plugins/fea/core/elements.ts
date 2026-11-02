// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keast 4-point degree-2 symmetric quadrature rule on the reference tetrahedron
 * $\{(\xi, \eta, \zeta) : \xi \ge 0, \eta \ge 0, \zeta \ge 0, \xi + \eta + \zeta \le 1\}$.
 * Weights sum to the reference tetrahedron volume $1/6$.
 */
const KEAST4_A = (5 - Math.sqrt(5)) / 20
const KEAST4_B = (5 + 3 * Math.sqrt(5)) / 20
const KEAST4_W = 1 / 24

export const TET10_QUAD4: ReadonlyArray<{
  l1: number
  l2: number
  l3: number
  l4: number
  w: number
}> = [
  { l1: KEAST4_A, l2: KEAST4_A, l3: KEAST4_A, l4: KEAST4_B, w: KEAST4_W },
  { l1: KEAST4_B, l2: KEAST4_A, l3: KEAST4_A, l4: KEAST4_A, w: KEAST4_W },
  { l1: KEAST4_A, l2: KEAST4_B, l3: KEAST4_A, l4: KEAST4_A, w: KEAST4_W },
  { l1: KEAST4_A, l2: KEAST4_A, l3: KEAST4_B, l4: KEAST4_A, w: KEAST4_W },
]

/**
 * 14-point degree-5 positive-weight symmetric tetrahedral quadrature rule
 * used for `Gate 5.2` curved-element Jacobian determinant sampling.
 * Weights sum to $1/6$.
 */
const Q14_A1 = 0.09273525031089123
const Q14_B1 = 1 - 3 * Q14_A1
const Q14_W1 = 0.07349304311636195 / 6

const Q14_A2 = 0.3108859192633006
const Q14_B2 = 1 - 3 * Q14_A2
const Q14_W2 = 0.11268792571801585 / 6

const Q14_C1 = 0.04550370412564965
const Q14_C2 = 0.5 - Q14_C1
const Q14_W3 = 0.04254602077708147 / 6

export const TET10_QUAD14: ReadonlyArray<{
  l1: number
  l2: number
  l3: number
  l4: number
  w: number
}> = [
  { l1: Q14_A1, l2: Q14_A1, l3: Q14_A1, l4: Q14_B1, w: Q14_W1 },
  { l1: Q14_B1, l2: Q14_A1, l3: Q14_A1, l4: Q14_A1, w: Q14_W1 },
  { l1: Q14_A1, l2: Q14_B1, l3: Q14_A1, l4: Q14_A1, w: Q14_W1 },
  { l1: Q14_A1, l2: Q14_A1, l3: Q14_B1, l4: Q14_A1, w: Q14_W1 },

  { l1: Q14_A2, l2: Q14_A2, l3: Q14_A2, l4: Q14_B2, w: Q14_W2 },
  { l1: Q14_B2, l2: Q14_A2, l3: Q14_A2, l4: Q14_A2, w: Q14_W2 },
  { l1: Q14_A2, l2: Q14_B2, l3: Q14_A2, l4: Q14_A2, w: Q14_W2 },
  { l1: Q14_A2, l2: Q14_A2, l3: Q14_B2, l4: Q14_A2, w: Q14_W2 },

  { l1: Q14_C1, l2: Q14_C1, l3: Q14_C2, l4: Q14_C2, w: Q14_W3 },
  { l1: Q14_C1, l2: Q14_C2, l3: Q14_C1, l4: Q14_C2, w: Q14_W3 },
  { l1: Q14_C1, l2: Q14_C2, l3: Q14_C2, l4: Q14_C1, w: Q14_W3 },
  { l1: Q14_C2, l2: Q14_C1, l3: Q14_C1, l4: Q14_C2, w: Q14_W3 },
  { l1: Q14_C2, l2: Q14_C1, l3: Q14_C2, l4: Q14_C1, w: Q14_W3 },
  { l1: Q14_C2, l2: Q14_C2, l3: Q14_C1, l4: Q14_C1, w: Q14_W3 },
]

/**
 * Dunavant 6-point degree-4 symmetric quadrature rule on the reference triangle
 * $\{(\xi, \eta) : \xi \ge 0, \eta \ge 0, \xi + \eta \le 1\}$.
 * Weights sum to the reference triangle area $1/2$.
 */
const TRI6_A1 = 0.445948490915965
const TRI6_B1 = 1 - 2 * TRI6_A1
const TRI6_W1 = 0.1116907948390055

const TRI6_A2 = 0.091576213509771
const TRI6_B2 = 1 - 2 * TRI6_A2
const TRI6_W2 = 0.05497587182766117

export const TRI6_QUAD6: ReadonlyArray<{ xi: number; eta: number; w: number }> = [
  { xi: TRI6_A1, eta: TRI6_A1, w: TRI6_W1 },
  { xi: TRI6_B1, eta: TRI6_A1, w: TRI6_W1 },
  { xi: TRI6_A1, eta: TRI6_B1, w: TRI6_W1 },
  { xi: TRI6_A2, eta: TRI6_A2, w: TRI6_W2 },
  { xi: TRI6_B2, eta: TRI6_A2, w: TRI6_W2 },
  { xi: TRI6_A2, eta: TRI6_B2, w: TRI6_W2 },
]

/**
 * Evaluate the 10 quadratic tetrahedral shape functions $N_0 \dots N_9$ at parent
 * coordinates $(\xi, \eta, \zeta) = (l_1, l_2, l_3)$ with $\lambda_0 = 1 - l_1 - l_2 - l_3$.
 *
 * Node ordering matches `mesher.ts`:
 * - Corners: `0:(0,0,0), 1:(1,0,0), 2:(0,1,0), 3:(0,0,1)`
 * - Mid-edges: `4:(0,1), 5:(1,2), 6:(0,2), 7:(0,3), 8:(1,3), 9:(2,3)`
 */
export function evalTet10Shape(
  l1: number,
  l2: number,
  l3: number,
  outN: Float64Array,
): void {
  const l0 = 1 - l1 - l2 - l3
  outN[0] = l0 * (2 * l0 - 1)
  outN[1] = l1 * (2 * l1 - 1)
  outN[2] = l2 * (2 * l2 - 1)
  outN[3] = l3 * (2 * l3 - 1)
  outN[4] = 4 * l0 * l1
  outN[5] = 4 * l1 * l2
  outN[6] = 4 * l0 * l2
  outN[7] = 4 * l0 * l3
  outN[8] = 4 * l1 * l3
  outN[9] = 4 * l2 * l3
}

/**
 * Evaluate parent-space derivatives $\left[\frac{\partial N_a}{\partial l_1}, \frac{\partial N_a}{\partial l_2}, \frac{\partial N_a}{\partial l_3}\right]$
 * for $a = 0 \dots 9$ into `outGrad30` (`length = 30`).
 */
export function evalTet10ParentGrad(
  l1: number,
  l2: number,
  l3: number,
  outGrad30: Float64Array,
): void {
  const l0 = 1 - l1 - l2 - l3
  const d0 = -(4 * l0 - 1)

  // Node 0: l0(2*l0 - 1)
  outGrad30[0] = d0
  outGrad30[1] = d0
  outGrad30[2] = d0

  // Node 1: l1(2*l1 - 1)
  outGrad30[3] = 4 * l1 - 1
  outGrad30[4] = 0
  outGrad30[5] = 0

  // Node 2: l2(2*l2 - 1)
  outGrad30[6] = 0
  outGrad30[7] = 4 * l2 - 1
  outGrad30[8] = 0

  // Node 3: l3(2*l3 - 1)
  outGrad30[9] = 0
  outGrad30[10] = 0
  outGrad30[11] = 4 * l3 - 1

  // Node 4: 4*l0*l1
  outGrad30[12] = 4 * (l0 - l1)
  outGrad30[13] = -4 * l1
  outGrad30[14] = -4 * l1

  // Node 5: 4*l1*l2
  outGrad30[15] = 4 * l2
  outGrad30[16] = 4 * l1
  outGrad30[17] = 0

  // Node 6: 4*l0*l2
  outGrad30[18] = -4 * l2
  outGrad30[19] = 4 * (l0 - l2)
  outGrad30[20] = -4 * l2

  // Node 7: 4*l0*l3
  outGrad30[21] = -4 * l3
  outGrad30[22] = -4 * l3
  outGrad30[23] = 4 * (l0 - l3)

  // Node 8: 4*l1*l3
  outGrad30[24] = 4 * l3
  outGrad30[25] = 0
  outGrad30[26] = 4 * l1

  // Node 9: 4*l2*l3
  outGrad30[27] = 0
  outGrad30[28] = 4 * l3
  outGrad30[29] = 4 * l2
}

/**
 * Evaluate 6-node quadratic triangle (`Tri6`) shape functions and parent gradients
 * at $(\xi, \eta)$ with $\lambda_0 = 1 - \xi - \eta, \lambda_1 = \xi, \lambda_2 = \eta$.
 *
 * Node ordering:
 * - Corners: `0:(0,0), 1:(1,0), 2:(0,1)`
 * - Mid-edges: `3:(0,1), 4:(1,2), 5:(2,0)`
 */
export function evalTri6ShapeAndGrad(
  xi: number,
  eta: number,
  outN6: Float64Array,
  outDndXi6: Float64Array,
  outDndEta6: Float64Array,
): void {
  const l0 = 1 - xi - eta
  const l1 = xi
  const l2 = eta

  outN6[0] = l0 * (2 * l0 - 1)
  outN6[1] = l1 * (2 * l1 - 1)
  outN6[2] = l2 * (2 * l2 - 1)
  outN6[3] = 4 * l0 * l1
  outN6[4] = 4 * l1 * l2
  outN6[5] = 4 * l2 * l0

  outDndXi6[0] = -(4 * l0 - 1)
  outDndXi6[1] = 4 * l1 - 1
  outDndXi6[2] = 0
  outDndXi6[3] = 4 * (l0 - l1)
  outDndXi6[4] = 4 * l2
  outDndXi6[5] = -4 * l2

  outDndEta6[0] = -(4 * l0 - 1)
  outDndEta6[1] = 0
  outDndEta6[2] = 4 * l2 - 1
  outDndEta6[3] = -4 * l1
  outDndEta6[4] = 4 * l1
  outDndEta6[5] = 4 * (l0 - l2)
}

/**
 * Compute the $3 \times 3$ isoparametric Jacobian matrix $J_{ij} = \frac{\partial x_i}{\partial \xi_j}$,
 * its inverse $\mathbf{J}^{-1}$ (`outInvJac9`), and return $\det(\mathbf{J})$.
 *
 * Physical shape gradients are then obtained via:
 * $\frac{\partial N_a}{\partial x_i} = \sum_{j=0}^2 (\mathbf{J}^{-1})_{ji} \frac{\partial N_a}{\partial \xi_j}$.
 */
export function computeTet10Jacobian(
  elemCoords30: Float64Array,
  dNdXi30: Float64Array,
  outJac9: Float64Array,
  outInvJac9: Float64Array,
): number {
  outJac9.fill(0)
  for (let a = 0; a < 10; a++) {
    const xa = elemCoords30[a * 3]
    const ya = elemCoords30[a * 3 + 1]
    const za = elemCoords30[a * 3 + 2]
    const g0 = dNdXi30[a * 3]
    const g1 = dNdXi30[a * 3 + 1]
    const g2 = dNdXi30[a * 3 + 2]

    outJac9[0] += xa * g0
    outJac9[1] += xa * g1
    outJac9[2] += xa * g2
    outJac9[3] += ya * g0
    outJac9[4] += ya * g1
    outJac9[5] += ya * g2
    outJac9[6] += za * g0
    outJac9[7] += za * g1
    outJac9[8] += za * g2
  }

  const j00 = outJac9[0], j01 = outJac9[1], j02 = outJac9[2]
  const j10 = outJac9[3], j11 = outJac9[4], j12 = outJac9[5]
  const j20 = outJac9[6], j21 = outJac9[7], j22 = outJac9[8]

  const c00 = j11 * j22 - j12 * j21
  const c01 = -(j10 * j22 - j12 * j20)
  const c02 = j10 * j21 - j11 * j20

  const c10 = -(j01 * j22 - j02 * j21)
  const c11 = j00 * j22 - j02 * j20
  const c12 = -(j00 * j21 - j01 * j20)

  const c20 = j01 * j12 - j02 * j11
  const c21 = -(j00 * j12 - j02 * j10)
  const c22 = j00 * j11 - j01 * j10

  const det = j00 * c00 + j01 * c01 + j02 * c02
  if (Math.abs(det) <= 1e-30) {
    outInvJac9.fill(0)
    return det
  }

  const invDet = 1 / det
  outInvJac9[0] = c00 * invDet
  outInvJac9[1] = c10 * invDet
  outInvJac9[2] = c20 * invDet
  outInvJac9[3] = c01 * invDet
  outInvJac9[4] = c11 * invDet
  outInvJac9[5] = c21 * invDet
  outInvJac9[6] = c02 * invDet
  outInvJac9[7] = c12 * invDet
  outInvJac9[8] = c22 * invDet

  return det
}

/**
 * Compute Knupp's dimensionless algebraic mean-ratio shape quality metric
 * $\eta_e \in (0, 1]$ for a 4-vertex tetrahedron (`Section 2.2`).
 * Returns `<= 0` if the tetrahedron is degenerate or inverted.
 */
export function computeKnuppMeanRatio(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  x3: number, y3: number, z3: number,
): number {
  const e01x = x1 - x0, e01y = y1 - y0, e01z = z1 - z0
  const e02x = x2 - x0, e02y = y2 - y0, e02z = z2 - z0
  const e03x = x3 - x0, e03y = y3 - y0, e03z = z3 - z0

  // 6 * V_signed = det([e01, e02, e03])
  const det6V =
    e01x * (e02y * e03z - e02z * e03y) -
    e01y * (e02x * e03z - e02z * e03x) +
    e01z * (e02x * e03y - e02y * e03x)
  if (det6V <= 0) return 0

  const e12x = x2 - x1, e12y = y2 - y1, e12z = z2 - z1
  const e13x = x3 - x1, e13y = y3 - y1, e13z = z3 - z1
  const e23x = x3 - x2, e23y = y3 - y2, e23z = z3 - z2

  const sumEdgeSq =
    e01x * e01x + e01y * e01y + e01z * e01z +
    e02x * e02x + e02y * e02y + e02z * e02z +
    e03x * e03x + e03y * e03y + e03z * e03z +
    e12x * e12x + e12y * e12y + e12z * e12z +
    e13x * e13x + e13y * e13y + e13z * e13z +
    e23x * e23x + e23y * e23y + e23z * e23z

  if (sumEdgeSq <= 1e-30) return 0
  // For a regular tetrahedron of edge length a: 6*V = a^3 / sqrt(2), sumEdgeSq = 6*a^2
  // 12 * (3*V)^(2/3) / sumEdgeSq = 12 * (a^3 / (2*sqrt(2)))^(2/3) / (6*a^2) = 1.0
  const vol = det6V / 6
  return (12 * Math.pow(3 * vol, 2 / 3)) / sumEdgeSq
}

/**
 * Evaluate `Gate 5.2` and `Gate 5.3` quality metrics across all `Tet10` elements:
 * - Total integrated volume (`mm^3`)
 * - Minimum Jacobian determinant across the 14-point rule
 * - Minimum and mean Knupp shape quality
 * - Count of inverted elements (`det(J) <= 0`)
 */
export function evaluateTet10MeshQuality(
  nodes: Float64Array,
  tet10: Uint32Array,
): {
  totalVolumeMm3: number
  minJacobianDet: number
  minKnuppQuality: number
  meanKnuppQuality: number
  invertedCount: number
} {
  const elemCount = tet10.length / 10
  if (elemCount === 0) {
    return {
      totalVolumeMm3: 0,
      minJacobianDet: 0,
      minKnuppQuality: 0,
      meanKnuppQuality: 0,
      invertedCount: 0,
    }
  }

  const elemCoords = new Float64Array(30)
  const dNdXi = new Float64Array(30)
  const jac = new Float64Array(9)
  const invJac = new Float64Array(9)

  let totalVolumeMm3 = 0
  let minJacobianDet = Infinity
  let minKnuppQuality = Infinity
  let sumKnupp = 0
  let invertedCount = 0

  for (let e = 0; e < elemCount; e++) {
    const base = e * 10
    for (let a = 0; a < 10; a++) {
      const ni = tet10[base + a] * 3
      elemCoords[a * 3] = nodes[ni]
      elemCoords[a * 3 + 1] = nodes[ni + 1]
      elemCoords[a * 3 + 2] = nodes[ni + 2]
    }

    const eta = computeKnuppMeanRatio(
      elemCoords[0], elemCoords[1], elemCoords[2],
      elemCoords[3], elemCoords[4], elemCoords[5],
      elemCoords[6], elemCoords[7], elemCoords[8],
      elemCoords[9], elemCoords[10], elemCoords[11],
    )
    if (eta < minKnuppQuality) minKnuppQuality = eta
    sumKnupp += eta

    let elemInverted = false
    for (let q = 0; q < TET10_QUAD14.length; q++) {
      const qp = TET10_QUAD14[q]
      evalTet10ParentGrad(qp.l1, qp.l2, qp.l3, dNdXi)
      const detJ = computeTet10Jacobian(elemCoords, dNdXi, jac, invJac)
      if (detJ < minJacobianDet) minJacobianDet = detJ
      if (detJ <= 0) elemInverted = true
      totalVolumeMm3 += qp.w * detJ
    }
    if (elemInverted) invertedCount++
  }

  return {
    totalVolumeMm3,
    minJacobianDet,
    minKnuppQuality,
    meanKnuppQuality: sumKnupp / elemCount,
    invertedCount,
  }
}

/**
 * Integrate the $30 \times 30$ element stiffness matrix $\mathbf{K}_e = \int_{\Omega_e} \mathbf{B}^T \mathbf{C} \mathbf{B} \, d\Omega$
 * for a 10-node quadratic tetrahedron (`Tet10`) using the 4-point Keast quadrature rule.
 * Voigt ordering: `[xx, yy, zz, xy, yz, xz]`.
 */
export function computeTet10ElementStiffness(
  elemCoords30: Float64Array,
  cVoigt36: Float64Array,
  outKe900: Float64Array,
): void {
  outKe900.fill(0)
  const dNdXi = new Float64Array(30)
  const dNdX = new Float64Array(30)
  const jac = new Float64Array(9)
  const invJac = new Float64Array(9)
  const cb = new Float64Array(6 * 30)

  for (let q = 0; q < 4; q++) {
    const qp = TET10_QUAD4[q]
    evalTet10ParentGrad(qp.l1, qp.l2, qp.l3, dNdXi)
    const detJ = computeTet10Jacobian(elemCoords30, dNdXi, jac, invJac)
    const w = qp.w * detJ

    for (let a = 0; a < 10; a++) {
      const g0 = dNdXi[a * 3]
      const g1 = dNdXi[a * 3 + 1]
      const g2 = dNdXi[a * 3 + 2]
      dNdX[a * 3] = invJac[0] * g0 + invJac[3] * g1 + invJac[6] * g2
      dNdX[a * 3 + 1] = invJac[1] * g0 + invJac[4] * g1 + invJac[7] * g2
      dNdX[a * 3 + 2] = invJac[2] * g0 + invJac[5] * g1 + invJac[8] * g2
    }

    // Compute C * B (6 x 30) exploiting isotropic block sparsity of B_a (6 x 3)
    // Column a*3 + 0 (ux): non-zero rows 0 (gx), 3 (gy), 5 (gz)
    // Column a*3 + 1 (uy): non-zero rows 1 (gy), 3 (gx), 4 (gz)
    // Column a*3 + 2 (uz): non-zero rows 2 (gz), 4 (gy), 5 (gx)
    for (let b = 0; b < 10; b++) {
      const gx = dNdX[b * 3]
      const gy = dNdX[b * 3 + 1]
      const gz = dNdX[b * 3 + 2]
      const col0 = b * 3
      const col1 = col0 + 1
      const col2 = col0 + 2

      for (let r = 0; r < 6; r++) {
        const rOff = r * 6
        const cbRow = r * 30
        cb[cbRow + col0] = cVoigt36[rOff + 0] * gx + cVoigt36[rOff + 3] * gy + cVoigt36[rOff + 5] * gz
        cb[cbRow + col1] = cVoigt36[rOff + 1] * gy + cVoigt36[rOff + 3] * gx + cVoigt36[rOff + 4] * gz
        cb[cbRow + col2] = cVoigt36[rOff + 2] * gz + cVoigt36[rOff + 4] * gy + cVoigt36[rOff + 5] * gx
      }
    }

    // Accumulate w * B^T * (C * B) into upper triangle and mirror
    for (let a = 0; a < 10; a++) {
      const gx = dNdX[a * 3]
      const gy = dNdX[a * 3 + 1]
      const gz = dNdX[a * 3 + 2]
      const r0 = (a * 3) * 30
      const r1 = (a * 3 + 1) * 30
      const r2 = (a * 3 + 2) * 30

      for (let j = a * 3; j < 30; j++) {
        const cb0 = cb[0 * 30 + j]
        const cb1 = cb[1 * 30 + j]
        const cb2 = cb[2 * 30 + j]
        const cb3 = cb[3 * 30 + j]
        const cb4 = cb[4 * 30 + j]
        const cb5 = cb[5 * 30 + j]

        outKe900[r0 + j] += w * (gx * cb0 + gy * cb3 + gz * cb5)
        if (j >= a * 3 + 1) {
          outKe900[r1 + j] += w * (gy * cb1 + gx * cb3 + gz * cb4)
        }
        if (j >= a * 3 + 2) {
          outKe900[r2 + j] += w * (gz * cb2 + gy * cb4 + gx * cb5)
        }
      }
    }
  }

  // Mirror upper triangle to lower triangle
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < i; j++) {
      outKe900[i * 30 + j] = outKe900[j * 30 + i]
    }
  }
}

/**
 * Integrate a surface traction field $\mathbf{t}(\mathbf{x}, \mathbf{n})$ over a 6-node
 * quadratic triangle (`Tri6`) using the 6-point Dunavant quadrature rule.
 * Writes the 18-component consistent nodal force vector into `outF18` and returns the face area.
 */
export function integrateTri6Traction(
  triCoords18: Float64Array,
  tractionFn: (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ) => [number, number, number],
  outF18: Float64Array,
): { area: number } {
  outF18.fill(0)
  const n6 = new Float64Array(6)
  const dXi6 = new Float64Array(6)
  const dEta6 = new Float64Array(6)
  let area = 0

  for (let q = 0; q < TRI6_QUAD6.length; q++) {
    const qp = TRI6_QUAD6[q]
    evalTri6ShapeAndGrad(qp.xi, qp.eta, n6, dXi6, dEta6)

    let x = 0, y = 0, z = 0
    let dxXi = 0, dyXi = 0, dzXi = 0
    let dxEta = 0, dyEta = 0, dzEta = 0
    for (let a = 0; a < 6; a++) {
      const na = n6[a]
      const dxi = dXi6[a]
      const deta = dEta6[a]
      const px = triCoords18[a * 3]
      const py = triCoords18[a * 3 + 1]
      const pz = triCoords18[a * 3 + 2]
      x += na * px; y += na * py; z += na * pz
      dxXi += dxi * px; dyXi += dxi * py; dzXi += dxi * pz
      dxEta += deta * px; dyEta += deta * py; dzEta += deta * pz
    }

    const jx = dyXi * dzEta - dzXi * dyEta
    const jy = dzXi * dxEta - dxXi * dzEta
    const jz = dxXi * dyEta - dyXi * dxEta
    const jNorm = Math.hypot(jx, jy, jz)
    if (jNorm <= 1e-24) continue

    const dA = qp.w * jNorm
    area += dA
    const nx = jx / jNorm
    const ny = jy / jNorm
    const nz = jz / jNorm
    const [tx, ty, tz] = tractionFn(x, y, z, nx, ny, nz)

    for (let a = 0; a < 6; a++) {
      const wNa = dA * n6[a]
      outF18[a * 3] += wNa * tx
      outF18[a * 3 + 1] += wNa * ty
      outF18[a * 3 + 2] += wNa * tz
    }
  }

  return { area }
}

/**
 * Integrate the $18 \times 18$ consistent Robin elastic foundation stiffness matrix
 * $\mathbf{K}_{\text{Robin},f} = \int_{\Gamma_f} k_r \mathbf{N}^T \mathbf{N} \, d\Gamma$
 * over a 6-node quadratic triangle (`Tri6`) using the 6-point Dunavant rule.
 */
export function integrateTri6RobinStiffness(
  triCoords18: Float64Array,
  stiffnessNPerMm3: number,
  outKr324: Float64Array,
): void {
  outKr324.fill(0)
  const n6 = new Float64Array(6)
  const dXi6 = new Float64Array(6)
  const dEta6 = new Float64Array(6)

  for (let q = 0; q < TRI6_QUAD6.length; q++) {
    const qp = TRI6_QUAD6[q]
    evalTri6ShapeAndGrad(qp.xi, qp.eta, n6, dXi6, dEta6)

    let dxXi = 0, dyXi = 0, dzXi = 0
    let dxEta = 0, dyEta = 0, dzEta = 0
    for (let a = 0; a < 6; a++) {
      const dxi = dXi6[a]
      const deta = dEta6[a]
      const px = triCoords18[a * 3]
      const py = triCoords18[a * 3 + 1]
      const pz = triCoords18[a * 3 + 2]
      dxXi += dxi * px; dyXi += dxi * py; dzXi += dxi * pz
      dxEta += deta * px; dyEta += deta * py; dzEta += deta * pz
    }

    const jx = dyXi * dzEta - dzXi * dyEta
    const jy = dzXi * dxEta - dxXi * dzEta
    const jz = dxXi * dyEta - dyXi * dxEta
    const dA = qp.w * Math.hypot(jx, jy, jz)
    const wk = dA * stiffnessNPerMm3

    for (let a = 0; a < 6; a++) {
      const na = n6[a]
      for (let b = 0; b < 6; b++) {
        const val = wk * na * n6[b]
        const rBase = a * 3
        const cBase = b * 3
        outKr324[(rBase + 0) * 18 + (cBase + 0)] += val
        outKr324[(rBase + 1) * 18 + (cBase + 1)] += val
        outKr324[(rBase + 2) * 18 + (cBase + 2)] += val
      }
    }
  }
}

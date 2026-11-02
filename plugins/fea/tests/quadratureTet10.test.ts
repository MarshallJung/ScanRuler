// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest'
import {
  TET10_QUAD4,
  TET10_QUAD14,
  TRI6_QUAD6,
  computeTet10ElementStiffness,
  evalTet10ParentGrad,
  evalTet10Shape,
  evalTri6ShapeAndGrad,
  evaluateTet10MeshQuality,
} from '../core/elements'
import { buildIsotropicVoigt6x6 } from '../core/materials'
import { buildStructuredBoxTet10Mesh } from '../core/mesher'

describe('Tet10 & Tri6 Quadrature, Shape Functions & Element Stiffness (Gate 5)', () => {
  it('Keast 4-point and 14-point tetrahedral quadrature weights sum to 1/6', () => {
    const sum4 = TET10_QUAD4.reduce((acc, q) => acc + q.w, 0)
    const sum14 = TET10_QUAD14.reduce((acc, q) => acc + q.w, 0)
    expect(sum4).toBeCloseTo(1 / 6, 12)
    expect(sum14).toBeCloseTo(1 / 6, 12)

    const sumTri6 = TRI6_QUAD6.reduce((acc, q) => acc + q.w, 0)
    expect(sumTri6).toBeCloseTo(0.5, 12)
  })

  it('Tet10 shape functions satisfy partition of unity and zero gradient sum', () => {
    const n = new Float64Array(10)
    const dNdXi = new Float64Array(30)
    for (const qp of TET10_QUAD4) {
      evalTet10Shape(qp.l1, qp.l2, qp.l3, n)
      evalTet10ParentGrad(qp.l1, qp.l2, qp.l3, dNdXi)
      const sumN = n.reduce((a, b) => a + b, 0)
      expect(sumN).toBeCloseTo(1.0, 12)

      let gx = 0, gy = 0, gz = 0
      for (let a = 0; a < 10; a++) {
        gx += dNdXi[a * 3]
        gy += dNdXi[a * 3 + 1]
        gz += dNdXi[a * 3 + 2]
      }
      expect(gx).toBeCloseTo(0, 12)
      expect(gy).toBeCloseTo(0, 12)
      expect(gz).toBeCloseTo(0, 12)
    }
  })

  it('Tri6 shape functions satisfy partition of unity and zero gradient sum', () => {
    const n = new Float64Array(6)
    const dXi = new Float64Array(6)
    const dEta = new Float64Array(6)
    for (const qp of TRI6_QUAD6) {
      evalTri6ShapeAndGrad(qp.xi, qp.eta, n, dXi, dEta)
      expect(n.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 12)
      expect(dXi.reduce((a, b) => a + b, 0)).toBeCloseTo(0.0, 12)
      expect(dEta.reduce((a, b) => a + b, 0)).toBeCloseTo(0.0, 12)
    }
  })

  it('Tet10 element stiffness matrix is symmetric and has exact 6-RBM nullspace', () => {
    const mesh = buildStructuredBoxTet10Mesh(10, 8, 6, 1, 1, 1)
    const quality = evaluateTet10MeshQuality(mesh.nodes, mesh.tet10)
    expect(quality.invertedCount).toBe(0)
    expect(quality.minJacobianDet).toBeGreaterThan(0)
    expect(quality.minKnuppQuality).toBeGreaterThan(0.5)
    expect(quality.totalVolumeMm3).toBeCloseTo(10 * 8 * 6, 8)

    const cVoigt = buildIsotropicVoigt6x6(200000, 0.3)
    const elemCoords = new Float64Array(30)
    for (let a = 0; a < 10; a++) {
      const nid = mesh.tet10[a] * 3
      elemCoords[a * 3] = mesh.nodes[nid]
      elemCoords[a * 3 + 1] = mesh.nodes[nid + 1]
      elemCoords[a * 3 + 2] = mesh.nodes[nid + 2]
    }
    const ke = new Float64Array(900)
    computeTet10ElementStiffness(elemCoords, cVoigt, ke)

    // Verify symmetry K_ij == K_ji
    for (let i = 0; i < 30; i++) {
      for (let j = i + 1; j < 30; j++) {
        expect(Math.abs(ke[i * 30 + j] - ke[j * 30 + i])).toBeLessThan(1e-8)
      }
    }

    // Verify all 6 rigid-body modes (3 translations + 3 infinitesimal rotations) give K_e * u_rbm = 0
    for (let mode = 0; mode < 6; mode++) {
      const uRbm = new Float64Array(30)
      for (let a = 0; a < 10; a++) {
        const x = elemCoords[a * 3]
        const y = elemCoords[a * 3 + 1]
        const z = elemCoords[a * 3 + 2]
        if (mode === 0) uRbm[a * 3] = 1
        if (mode === 1) uRbm[a * 3 + 1] = 1
        if (mode === 2) uRbm[a * 3 + 2] = 1
        if (mode === 3) { uRbm[a * 3 + 1] = -z; uRbm[a * 3 + 2] = y }
        if (mode === 4) { uRbm[a * 3] = z; uRbm[a * 3 + 2] = -x }
        if (mode === 5) { uRbm[a * 3] = -y; uRbm[a * 3 + 1] = x }
      }
      for (let i = 0; i < 30; i++) {
        let f = 0
        for (let j = 0; j < 30; j++) f += ke[i * 30 + j] * uRbm[j]
        expect(Math.abs(f)).toBeLessThan(1e-6)
      }
    }
  })
})

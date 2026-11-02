// SPDX-License-Identifier: AGPL-3.0-only

import {
  TET10_QUAD4,
  computeTet10Jacobian,
  evalTet10ParentGrad,
  evalTet10Shape,
} from './elements'
import {
  buildIsotropicComplianceVoigt6x6,
  buildIsotropicVoigt6x6,
} from './materials'
import type {
  BoundaryCondition,
  EquilibriumReport,
  FeaMetrics,
  IsotropicMaterial,
  ReentrantEdge,
  Tet10VolumeMesh,
} from './types'

/**
 * Compute von Mises equivalent stress (MPa) from a 6-component Voigt stress
 * vector `[sxx, syy, szz, txy, tyz, txz]`.
 */
export function computeVonMises(sigma6: ArrayLike<number>): number {
  const sxx = sigma6[0]
  const syy = sigma6[1]
  const szz = sigma6[2]
  const txy = sigma6[3]
  const tyz = sigma6[4]
  const txz = sigma6[5]
  const d0 = sxx - syy
  const d1 = syy - szz
  const d2 = szz - sxx
  const vmSq = 0.5 * (d0 * d0 + d1 * d1 + d2 * d2) + 3 * (txy * txy + tyz * tyz + txz * txz)
  return Math.sqrt(Math.max(0, vmSq))
}

/**
 * Exact closed-form Cardano principal stresses `[sigma1, sigma2, sigma3]`
 * with `sigma1 >= sigma2 >= sigma3` (`Section 6.3`).
 */
export function computePrincipalStressesCardano(
  sigma6: ArrayLike<number>,
): [number, number, number] {
  const sxx = sigma6[0]
  const syy = sigma6[1]
  const szz = sigma6[2]
  const txy = sigma6[3]
  const tyz = sigma6[4]
  const txz = sigma6[5]

  const i1 = sxx + syy + szz
  const p = i1 / 3
  const sx = sxx - p
  const sy = syy - p
  const sz = szz - p

  const j2 = 0.5 * (sx * sx + sy * sy + sz * sz) + txy * txy + tyz * tyz + txz * txz
  if (j2 <= 1e-24) {
    return [p, p, p]
  }

  const j3 =
    sx * (sy * sz - tyz * tyz) -
    txy * (txy * sz - tyz * txz) +
    txz * (txy * tyz - sy * txz)

  const cos3Theta = Math.max(-1, Math.min(1, (1.5 * Math.sqrt(3) * j3) / Math.pow(j2, 1.5)))
  const theta = Math.acos(cos3Theta) / 3
  const amp = 2 * Math.sqrt(j2 / 3)

  const p1 = p + amp * Math.cos(theta)
  const p2 = p + amp * Math.cos(theta - (2 * Math.PI) / 3)
  const p3 = p + amp * Math.cos(theta + (2 * Math.PI) / 3)

  // Sort descending cleanly against floating-point ties
  const a = Math.max(p1, p2, p3)
  const c = Math.min(p1, p2, p3)
  const b = p1 + p2 + p3 - a - c
  return [a, b, c]
}

export interface PostprocessResult {
  vonMises: Float32Array
  sigma1: Float32Array
  sigma3: Float32Array
  safetyFactor: Float32Array
  nodalEtaZz: Float32Array
  singularFaceMask: Uint8Array
  metrics: FeaMetrics
}

/**
 * Perform Zienkiewicz-Zhu Superconvergent Patch Recovery (`ZZ-SPR`), evaluate
 * principal stresses and failure indices, check small-strain (`Gate 7.1`) and
 * small-rotation (`Gate 7.2`) kinematics, compute global energy-norm error
 * `eta_ZZ%` (`Gate 7.6`), and mask geometric/BC stress singularities (`Gate 7.4`).
 */
export function recoverStressesAndDiagnostics(
  mesh: Tet10VolumeMesh,
  material: IsotropicMaterial,
  bcs: readonly BoundaryCondition[],
  displacements: Float64Array,
  equilibrium: EquilibriumReport,
  solverStats: {
    iterations: number
    relativeResidual: number
    solveTimeMs: number
  },
  reentrantEdges: readonly ReentrantEdge[] = [],
   welPositions?: Float32Array,
): PostprocessResult {
  const nodeCount = mesh.nodes.length / 3
  const cornerCount = mesh.cornerNodeCount
  const elemCount = mesh.tet10.length / 10
  const triCount = mesh.tri6.length / 6

  const cVoigt = buildIsotropicVoigt6x6(material.youngsModulusMPa, material.poissonsRatio)
  const cInvVoigt = buildIsotropicComplianceVoigt6x6(material.youngsModulusMPa, material.poissonsRatio)

  // Step 1: Evaluate Gauss-point strains, rotations, raw stresses, and quadrature coordinates
  const gpCoords = new Float64Array(elemCount * 4 * 3)
  const gpWeights = new Float64Array(elemCount * 4)
  const gpStress = new Float64Array(elemCount * 4 * 6)

  const elemCoords = new Float64Array(30)
  const elemDisp = new Float64Array(30)
  const nShape = new Float64Array(10)
  const dNdXi = new Float64Array(30)
  const dNdX = new Float64Array(30)
  const jac = new Float64Array(9)
  const invJac = new Float64Array(9)
  const eps6 = new Float64Array(6)
  const sig6 = new Float64Array(6)

  let maxStrain = 0
  let maxRotationRad = 0
  let minNodeJump = new Float64Array(nodeCount).fill(Infinity)
  let maxNodeJump = new Float64Array(nodeCount).fill(-Infinity)

  for (let e = 0; e < elemCount; e++) {
    const base = e * 10
    for (let a = 0; a < 10; a++) {
      const nid = mesh.tet10[base + a]
      const ni = nid * 3
      elemCoords[a * 3] = mesh.nodes[ni]
      elemCoords[a * 3 + 1] = mesh.nodes[ni + 1]
      elemCoords[a * 3 + 2] = mesh.nodes[ni + 2]
      elemDisp[a * 3] = displacements[ni]
      elemDisp[a * 3 + 1] = displacements[ni + 1]
      elemDisp[a * 3 + 2] = displacements[ni + 2]
    }

    let elemVmMean = 0
    for (let q = 0; q < 4; q++) {
      const qp = TET10_QUAD4[q]
      evalTet10Shape(qp.l1, qp.l2, qp.l3, nShape)
      evalTet10ParentGrad(qp.l1, qp.l2, qp.l3, dNdXi)
      const detJ = computeTet10Jacobian(elemCoords, dNdXi, jac, invJac)
      const w = qp.w * Math.max(1e-18, detJ)

      let gx = 0, gy = 0, gz = 0
      for (let a = 0; a < 10; a++) {
        const na = nShape[a]
        gx += na * elemCoords[a * 3]
        gy += na * elemCoords[a * 3 + 1]
        gz += na * elemCoords[a * 3 + 2]

        const g0 = dNdXi[a * 3]
        const g1 = dNdXi[a * 3 + 1]
        const g2 = dNdXi[a * 3 + 2]
        dNdX[a * 3] = invJac[0] * g0 + invJac[3] * g1 + invJac[6] * g2
        dNdX[a * 3 + 1] = invJac[1] * g0 + invJac[4] * g1 + invJac[7] * g2
        dNdX[a * 3 + 2] = invJac[2] * g0 + invJac[5] * g1 + invJac[8] * g2
      }

      // Displacement gradient H_{ij} = du_i / dx_j
      let h00 = 0, h01 = 0, h02 = 0
      let h10 = 0, h11 = 0, h12 = 0
      let h20 = 0, h21 = 0, h22 = 0
      for (let a = 0; a < 10; a++) {
        const ux = elemDisp[a * 3]
        const uy = elemDisp[a * 3 + 1]
        const uz = elemDisp[a * 3 + 2]
        const gxA = dNdX[a * 3]
        const gyA = dNdX[a * 3 + 1]
        const gzA = dNdX[a * 3 + 2]
        h00 += ux * gxA; h01 += ux * gyA; h02 += ux * gzA
        h10 += uy * gxA; h11 += uy * gyA; h12 += uy * gzA
        h20 += uz * gxA; h21 += uz * gyA; h22 += uz * gzA
      }

      eps6[0] = h00
      eps6[1] = h11
      eps6[2] = h22
      eps6[3] = h01 + h10
      eps6[4] = h12 + h21
      eps6[5] = h02 + h20

      // Gate 7.1: Principal tensorial strain magnitude
      const [e1, e2, e3] = computePrincipalStressesCardano([
        eps6[0],
        eps6[1],
        eps6[2],
        0.5 * eps6[3],
        0.5 * eps6[4],
        0.5 * eps6[5],
      ])
      maxStrain = Math.max(maxStrain, Math.abs(e1), Math.abs(e2), Math.abs(e3))

      // Gate 7.2: Infinitesimal rotation tensor Frobenius norm ||omega||_F
      const w21 = 0.5 * (h21 - h12)
      const w02 = 0.5 * (h02 - h20)
      const w10 = 0.5 * (h10 - h01)
      const omegaFrob = Math.sqrt(2 * (w21 * w21 + w02 * w02 + w10 * w10))
      if (omegaFrob > maxRotationRad) maxRotationRad = omegaFrob

      // Cauchy stress sigma = C * eps
      for (let r = 0; r < 6; r++) {
        let s = 0
        for (let c = 0; c < 6; c++) {
          s += cVoigt[r * 6 + c] * eps6[c]
        }
        sig6[r] = s
      }

      const gpIdx = e * 4 + q
      gpCoords[gpIdx * 3] = gx
      gpCoords[gpIdx * 3 + 1] = gy
      gpCoords[gpIdx * 3 + 2] = gz
      gpWeights[gpIdx] = w
      for (let k = 0; k < 6; k++) {
        gpStress[gpIdx * 6 + k] = sig6[k]
      }
      elemVmMean += 0.25 * computeVonMises(sig6)
    }

    for (let a = 0; a < 10; a++) {
      const nid = mesh.tet10[base + a]
      if (elemVmMean < minNodeJump[nid]) minNodeJump[nid] = elemVmMean
      if (elemVmMean > maxNodeJump[nid]) maxNodeJump[nid] = elemVmMean
    }
  }

  // Step 2: Zienkiewicz-Zhu Superconvergent Patch Recovery (ZZ-SPR)
  // Build corner vertex -> incident elements & 1-ring corner neighbors
  const cornerElems: number[][] = Array.from({ length: cornerCount }, () => [])
  const cornerNeighbors: Array<Set<number>> = Array.from({ length: cornerCount }, () => new Set<number>())
  for (let e = 0; e < elemCount; e++) {
    const base = e * 10
    for (let i = 0; i < 4; i++) {
      const u = mesh.tet10[base + i]
      if (u < cornerCount) {
        cornerElems[u].push(e)
        for (let j = i + 1; j < 4; j++) {
          const v = mesh.tet10[base + j]
          if (v < cornerCount) {
            cornerNeighbors[u].add(v)
            cornerNeighbors[v].add(u)
          }
        }
      }
    }
  }

  // Fit 4-term linear polynomial [1, xHat, yHat, zHat] at each corner node v
  // Store polynomial coefficients a_v[k * 4 + 0..3] and characteristic radius h_v
  const cornerPolyCoeffs = new Float64Array(cornerCount * 24)
  const cornerScaleH = new Float64Array(cornerCount)
  const recoveredStress = new Float64Array(nodeCount * 6)

  const ata = new Float64Array(16)
  const atb = new Float64Array(24) // 6 stress components x 4 basis terms

  for (let v = 0; v < cornerCount; v++) {
    const xv = mesh.nodes[v * 3]
    const yv = mesh.nodes[v * 3 + 1]
    const zv = mesh.nodes[v * 3 + 2]

    // Collect patch elements; expand to 1-ring if fewer than 3 elements
    let patchElems = cornerElems[v]
    if (patchElems.length < 3) {
      const elemSet = new Set<number>(patchElems)
      for (const nb of cornerNeighbors[v]) {
        for (const e of cornerElems[nb]) elemSet.add(e)
      }
      patchElems = Array.from(elemSet)
    }

    let hv = 0
    for (let idx = 0; idx < patchElems.length; idx++) {
      const e = patchElems[idx]
      for (let q = 0; q < 4; q++) {
        const gp = (e * 4 + q) * 3
        const d = Math.hypot(gpCoords[gp] - xv, gpCoords[gp + 1] - yv, gpCoords[gp + 2] - zv)
        if (d > hv) hv = d
      }
    }
    hv = Math.max(hv, 1e-6)
    cornerScaleH[v] = hv

    ata.fill(0)
    atb.fill(0)

    for (let idx = 0; idx < patchElems.length; idx++) {
      const e = patchElems[idx]
      for (let q = 0; q < 4; q++) {
        const gpIdx = e * 4 + q
        const w = gpWeights[gpIdx]
        const p0 = 1
        const p1 = (gpCoords[gpIdx * 3] - xv) / hv
        const p2 = (gpCoords[gpIdx * 3 + 1] - yv) / hv
        const p3 = (gpCoords[gpIdx * 3 + 2] - zv) / hv
        const p = [p0, p1, p2, p3]

        for (let i = 0; i < 4; i++) {
          const wi = w * p[i]
          for (let j = 0; j < 4; j++) {
            ata[i * 4 + j] += wi * p[j]
          }
          for (let k = 0; k < 6; k++) {
            atb[k * 4 + i] += wi * gpStress[gpIdx * 6 + k]
          }
        }
      }
    }

    const coeffs24 = solve4x4MultiRhsRegularized(ata, atb)
    cornerPolyCoeffs.set(coeffs24, v * 24)
    for (let k = 0; k < 6; k++) {
      recoveredStress[v * 6 + k] = coeffs24[k * 4]
    }
  }

  // Evaluate mid-edge nodes by averaging the polynomial fits of their two endpoint corners
  const TET_EDGE_PAIRS: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [1, 2],
    [0, 2],
    [0, 3],
    [1, 3],
    [2, 3],
  ]
  const midVisited = new Uint8Array(nodeCount)
  for (let e = 0; e < elemCount; e++) {
    const base = e * 10
    for (let k = 0; k < 6; k++) {
      const midNode = mesh.tet10[base + 4 + k]
      if (midVisited[midNode]) continue
      midVisited[midNode] = 1
      const pair = TET_EDGE_PAIRS[k]
      const cA = mesh.tet10[base + pair[0]]
      const cB = mesh.tet10[base + pair[1]]
      const xm = mesh.nodes[midNode * 3]
      const ym = mesh.nodes[midNode * 3 + 1]
      const zm = mesh.nodes[midNode * 3 + 2]

      const hA = cornerScaleH[cA]
      const pA1 = (xm - mesh.nodes[cA * 3]) / hA
      const pA2 = (ym - mesh.nodes[cA * 3 + 1]) / hA
      const pA3 = (zm - mesh.nodes[cA * 3 + 2]) / hA

      const hB = cornerScaleH[cB]
      const pB1 = (xm - mesh.nodes[cB * 3]) / hB
      const pB2 = (ym - mesh.nodes[cB * 3 + 1]) / hB
      const pB3 = (zm - mesh.nodes[cB * 3 + 2]) / hB

      for (let comp = 0; comp < 6; comp++) {
        const offA = cA * 24 + comp * 4
        const valA =
          cornerPolyCoeffs[offA] +
          cornerPolyCoeffs[offA + 1] * pA1 +
          cornerPolyCoeffs[offA + 2] * pA2 +
          cornerPolyCoeffs[offA + 3] * pA3

        const offB = cB * 24 + comp * 4
        const valB =
          cornerPolyCoeffs[offB] +
          cornerPolyCoeffs[offB + 1] * pB1 +
          cornerPolyCoeffs[offB + 2] * pB2 +
          cornerPolyCoeffs[offB + 3] * pB3

        recoveredStress[midNode * 6 + comp] = 0.5 * (valA + valB)
      }
    }
  }

  // Step 3: Gate 7.6 — Zienkiewicz-Zhu Energy-Norm Error Estimator eta_ZZ%
  let totalErrorEnergySq = 0
  let totalStrainEnergySq = 0
  const elemErrorEnergySq = new Float64Array(elemCount)
  const elemStrainEnergySq = new Float64Array(elemCount)
  const sigStar = new Float64Array(6)
  const errSig = new Float64Array(6)

  for (let e = 0; e < elemCount; e++) {
    const base = e * 10
    let eErrSq = 0
    let eStrSq = 0
    for (let q = 0; q < 4; q++) {
      const qp = TET10_QUAD4[q]
      evalTet10Shape(qp.l1, qp.l2, qp.l3, nShape)
      const gpIdx = e * 4 + q
      const w = gpWeights[gpIdx]

      sigStar.fill(0)
      for (let a = 0; a < 10; a++) {
        const na = nShape[a]
        const nid = mesh.tet10[base + a] * 6
        for (let k = 0; k < 6; k++) {
          sigStar[k] += na * recoveredStress[nid + k]
        }
      }

      for (let k = 0; k < 6; k++) {
        errSig[k] = sigStar[k] - gpStress[gpIdx * 6 + k]
      }

      let eQuad = 0
      let uQuad = 0
      for (let r = 0; r < 6; r++) {
        const rawR = gpStress[gpIdx * 6 + r]
        const errR = errSig[r]
        for (let c = 0; c < 6; c++) {
          const sInv = cInvVoigt[r * 6 + c]
          eQuad += errR * sInv * errSig[c]
          uQuad += rawR * sInv * gpStress[gpIdx * 6 + c]
        }
      }
      eErrSq += w * Math.max(0, eQuad)
      eStrSq += w * Math.max(0, uQuad)
    }
    elemErrorEnergySq[e] = eErrSq
    elemStrainEnergySq[e] = eStrSq
    totalErrorEnergySq += eErrSq
    totalStrainEnergySq += eStrSq
  }

  const etaZzPercent =
    totalStrainEnergySq + totalErrorEnergySq > 1e-30
      ? 100 * Math.sqrt(totalErrorEnergySq / (totalStrainEnergySq + totalErrorEnergySq))
      : 0

  // Map elemental ZZ error percentage to nodes for visualization
  const nodalEtaZz = new Float32Array(nodeCount)
  const nodalEtaCount = new Uint16Array(nodeCount)
  const meanElemEnergy = Math.max(1e-24, totalStrainEnergySq / Math.max(1, elemCount))
  for (let e = 0; e < elemCount; e++) {
    const pct =
      100 *
      Math.sqrt(elemErrorEnergySq[e] / (meanElemEnergy + elemStrainEnergySq[e] + elemErrorEnergySq[e]))
    const base = e * 10
    for (let a = 0; a < 10; a++) {
      const nid = mesh.tet10[base + a]
      nodalEtaZz[nid] += pct
      nodalEtaCount[nid]++
    }
  }
  for (let i = 0; i < nodeCount; i++) {
    if (nodalEtaCount[i] > 0) nodalEtaZz[i] /= nodalEtaCount[i]
  }

  // Step 4: Detect 2*h_e singularity zone near re-entrant concave edges & Dirichlet transition edges (Gate 7.4)
  const { singularNodeMask, singularFaceMask } = detectSingularityMasks(
    mesh,
    bcs,
    reentrantEdges,
    welPositions,
  )

  // Step 5: Compute nodal von Mises, Principal stresses (sigma1, sigma3), and Safety Factor
  const vonMises = new Float32Array(nodeCount)
  const sigma1 = new Float32Array(nodeCount)
  const sigma3 = new Float32Array(nodeCount)
  const safetyFactor = new Float32Array(nodeCount)

  let maxDisplacementMm = 0
  let maxVonMisesRawMPa = 0
  let maxVonMisesMaskedMPa = 0
  let minSafetyFactorRaw = 15
  let minSafetyFactorMasked = 15
  let maxStressJump = 0

  const sy = Math.max(1e-3, material.yieldStrengthMPa ?? 250)
  const sut = Math.max(1e-3, material.ultimateTensileMPa ?? 150)
  const suc = Math.max(1e-3, material.ultimateCompressiveMPa ?? 500)

  for (let i = 0; i < nodeCount; i++) {
    const uMag = Math.hypot(
      displacements[i * 3],
      displacements[i * 3 + 1],
      displacements[i * 3 + 2],
    )
    if (uMag > maxDisplacementMm) maxDisplacementMm = uMag

    const sOff = i * 6
    const sVec = recoveredStress.subarray(sOff, sOff + 6)
    const vm = computeVonMises(sVec)
    const [p1, , p3] = computePrincipalStressesCardano(sVec)

    vonMises[i] = vm
    sigma1[i] = p1
    sigma3[i] = p3

    let fos: number
    if (material.failureCriterion === 'brittle') {
      const rankine = Math.max(0, p1) / sut
      const mohrCoulomb = Math.max(0, p1) / sut - Math.min(0, p3) / suc
      const idx = Math.max(rankine, mohrCoulomb, 1e-6)
      fos = Math.min(15, 1 / idx)
    } else {
      fos = Math.min(15, sy / Math.max(vm, 1e-6))
    }
    safetyFactor[i] = fos

    if (vm > maxVonMisesRawMPa) maxVonMisesRawMPa = vm
    if (fos < minSafetyFactorRaw) minSafetyFactorRaw = fos

    if (!singularNodeMask[i]) {
      if (vm > maxVonMisesMaskedMPa) maxVonMisesMaskedMPa = vm
      if (fos < minSafetyFactorMasked) minSafetyFactorMasked = fos
    }

    if (maxNodeJump[i] >= minNodeJump[i]) {
      const jump = maxNodeJump[i] - minNodeJump[i]
      if (jump > maxStressJump) maxStressJump = jump
    }
  }

  // Fallback if all nodes happened to be masked
  if (maxVonMisesMaskedMPa === 0 && maxVonMisesRawMPa > 0) {
    maxVonMisesMaskedMPa = maxVonMisesRawMPa
    minSafetyFactorMasked = minSafetyFactorRaw
  }

  let singularFaceCount = 0
  for (let f = 0; f < triCount; f++) {
    if (singularFaceMask[f]) singularFaceCount++
  }

  const maxRotationDeg = (maxRotationRad * 180) / Math.PI
  const maxStressJumpRatio = maxStressJump / Math.max(maxVonMisesRawMPa, 1e-6)

  const metrics: FeaMetrics = {
    nodeCount,
    elementCount: elemCount,
    dofCount: nodeCount * 3,
    solverIterations: solverStats.iterations,
    solverResidual: solverStats.relativeResidual,
    solveTimeMs: solverStats.solveTimeMs,
    maxDisplacementMm,
    maxVonMisesRawMPa,
    maxVonMisesMaskedMPa,
    minSafetyFactorRaw,
    minSafetyFactorMasked,
    etaZzPercent,
    maxStressJumpRatio,
    maxStrain,
    maxRotationDeg,
    smallStrainValid: maxStrain <= 0.02,
    smallRotationValid: maxRotationDeg <= 5.0,
    equilibrium,
    singularFaceCount,
  }

  return {
    vonMises,
    sigma1,
    sigma3,
    safetyFactor,
    nodalEtaZz,
    singularFaceMask,
    metrics,
  }
}

function solve4x4MultiRhsRegularized(ata: Float64Array, atb: Float64Array): Float64Array {
  const tr = Math.max(1e-18, ata[0] + ata[5] + ata[10] + ata[15])
  const reg = 1e-12 * tr
  const m = ata.slice()
  m[5] += reg
  m[10] += reg
  m[15] += reg

  // Cholesky factorization L * L^T = m (4x4)
  const chol = new Float64Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i * 4 + j]
      for (let k = 0; k < j; k++) s -= chol[i * 4 + k] * chol[j * 4 + k]
      if (i === j) {
        chol[i * 4 + i] = Math.sqrt(Math.max(1e-24, s))
      } else {
        chol[i * 4 + j] = s / chol[j * 4 + j]
      }
    }
  }

  const out = new Float64Array(24)
  const y = new Float64Array(4)
  for (let rhs = 0; rhs < 6; rhs++) {
    const bOff = rhs * 4
    for (let i = 0; i < 4; i++) {
      let s = atb[bOff + i]
      for (let k = 0; k < i; k++) s -= chol[i * 4 + k] * y[k]
      y[i] = s / chol[i * 4 + i]
    }
    for (let i = 3; i >= 0; i--) {
      let s = y[i]
      for (let k = i + 1; k < 4; k++) s -= chol[k * 4 + i] * out[bOff + k]
      out[bOff + i] = s / chol[i * 4 + i]
    }
  }
  return out
}

/**
 * Identify nodes and boundary `Tri6` faces lying within `2 * h_e` of:
 * 1) Re-entrant sharp concave edges (`theta_int > 195 deg`), or
 * 2) Dirichlet restraint boundary transition edges.
 */
function detectSingularityMasks(
  mesh: Tet10VolumeMesh,
  bcs: readonly BoundaryCondition[],
  reentrantEdges: readonly ReentrantEdge[],
  welPositions?: Float32Array,
): { singularNodeMask: Uint8Array; singularFaceMask: Uint8Array } {
  const nodeCount = mesh.nodes.length / 3
  const triCount = mesh.tri6.length / 6
  const singularNodeMask = new Uint8Array(nodeCount)
  const singularFaceMask = new Uint8Array(triCount)

  // Collect singular 3D line segments [ax, ay, az, bx, by, bz, hLocal]
  const singularSegments: Array<[number, number, number, number, number, number, number]> = []

  // 1) Re-entrant concave edges from welded surface mesh
  if (welPositions && reentrantEdges.length > 0) {
    for (let i = 0; i < reentrantEdges.length; i++) {
      const e = reentrantEdges[i]
      const ia = e.vA * 3
      const ib = e.vB * 3
      const ax = welPositions[ia], ay = welPositions[ia + 1], az = welPositions[ia + 2]
      const bx = welPositions[ib], by = welPositions[ib + 1], bz = welPositions[ib + 2]
      const len = Math.hypot(bx - ax, by - ay, bz - az)
      singularSegments.push([ax, ay, az, bx, by, bz, Math.max(1e-3, len)])
    }
  }

  // 2) Dirichlet restraint transition edges on the Tri6 boundary mesh
  const dirichletPatches = new Set<number>()
  for (let i = 0; i < bcs.length; i++) {
    if (bcs[i].type === 'dirichlet') dirichletPatches.add(bcs[i].patchId)
  }

  if (dirichletPatches.size > 0) {
    const edgeDirichletCount = new Map<string, { u: number; v: number; dCount: number; fCount: number }>()
    const cornerPairs: ReadonlyArray<readonly [number, number]> = [
      [0, 1],
      [1, 2],
      [2, 0],
    ]
    for (let f = 0; f < triCount; f++) {
      const isDir = dirichletPatches.has(mesh.tri6Patch[f]) ? 1 : 0
      const b6 = f * 6
      for (let k = 0; k < 3; k++) {
        const u = mesh.tri6[b6 + cornerPairs[k][0]]
        const v = mesh.tri6[b6 + cornerPairs[k][1]]
        const a = u < v ? u : v
        const b = u < v ? v : u
        const key = `${a}:${b}`
        const rec = edgeDirichletCount.get(key)
        if (rec) {
          rec.dCount += isDir
          rec.fCount += 1
        } else {
          edgeDirichletCount.set(key, { u: a, v: b, dCount: isDir, fCount: 1 })
        }
      }
    }

    for (const rec of edgeDirichletCount.values()) {
      if (rec.dCount === 1 && rec.fCount === 2) {
        const ia = rec.u * 3
        const ib = rec.v * 3
        const ax = mesh.nodes[ia], ay = mesh.nodes[ia + 1], az = mesh.nodes[ia + 2]
        const bx = mesh.nodes[ib], by = mesh.nodes[ib + 1], bz = mesh.nodes[ib + 2]
        const len = Math.hypot(bx - ax, by - ay, bz - az)
        singularSegments.push([ax, ay, az, bx, by, bz, Math.max(1e-3, len)])
      }
    }
  }

  if (singularSegments.length === 0) {
    return { singularNodeMask, singularFaceMask }
  }

  // Compute local element edge length h_e for each Tri6 face
  for (let f = 0; f < triCount; f++) {
    const b6 = f * 6
    const i0 = mesh.tri6[b6] * 3
    const i1 = mesh.tri6[b6 + 1] * 3
    const i2 = mesh.tri6[b6 + 2] * 3
    const x0 = mesh.nodes[i0], y0 = mesh.nodes[i0 + 1], z0 = mesh.nodes[i0 + 2]
    const x1 = mesh.nodes[i1], y1 = mesh.nodes[i1 + 1], z1 = mesh.nodes[i1 + 2]
    const x2 = mesh.nodes[i2], y2 = mesh.nodes[i2 + 1], z2 = mesh.nodes[i2 + 2]
    const e01 = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
    const e12 = Math.hypot(x2 - x1, y2 - y1, z2 - z1)
    const e20 = Math.hypot(x0 - x2, y0 - y2, z0 - z2)
    const he = (e01 + e12 + e20) / 3
    const cx = (x0 + x1 + x2) / 3
    const cy = (y0 + y1 + y2) / 3
    const cz = (z0 + z1 + z2) / 3

    for (let s = 0; s < singularSegments.length; s++) {
      const seg = singularSegments[s]
      const dist = pointToSegmentDistance(cx, cy, cz, seg[0], seg[1], seg[2], seg[3], seg[4], seg[5])
      if (dist <= 2.0 * he) {
        singularFaceMask[f] = 1
        for (let a = 0; a < 6; a++) {
          singularNodeMask[mesh.tri6[b6 + a]] = 1
        }
        break
      }
    }
  }

  return { singularNodeMask, singularFaceMask }
}

function pointToSegmentDistance(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const vx = bx - ax
  const vy = by - ay
  const vz = bz - az
  const lenSq = vx * vx + vy * vy + vz * vz
  if (lenSq <= 1e-20) return Math.hypot(px - ax, py - ay, pz - az)
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy + (pz - az) * vz) / lenSq))
  const qx = ax + t * vx
  const qy = ay + t * vy
  const qz = az + t * vz
  return Math.hypot(px - qx, py - qy, pz - qz)
}

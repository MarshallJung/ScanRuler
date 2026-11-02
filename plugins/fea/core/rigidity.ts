// SPDX-License-Identifier: AGPL-3.0-only

import type { BoundaryCondition, PatchDescriptor, RigidityReport, WeldedSurfaceMesh } from './types'

/**
 * Verify `Stage 4` Boundary Condition and Rigid-Body Restraint Gates (`Gate 4.1–4.3`):
 * - `Gate 4.1`: Dirichlet/Neumann disjointness per surface patch.
 * - `Gate 4.2`: Finite non-zero area (`A_p > 0`) for every referenced patch.
 * - `Gate 4.3`: 6-DOF Rigid-Body Mode (RBM) constraint Gram matrix SVD / eigendecomposition
 *   verifying $\operatorname{rank}(\mathbf{R}_{\mathcal{C}}) = 6$.
 */
export function verifyBoundaryConditions(
  welded: WeldedSurfaceMesh,
  bcs: readonly BoundaryCondition[],
): RigidityReport {
  const blockingErrors: string[] = []

  const patchById = new Map<number, PatchDescriptor>()
  for (let i = 0; i < welded.patches.length; i++) {
    const p = welded.patches[i]
    patchById.set(p.id, p)
  }

  // Gate 4.1 & 4.2: Check patch existence, finite area, and Dirichlet/Neumann disjointness
  const dirichletPatches = new Set<number>()
  const neumannPatches = new Set<number>()

  for (let i = 0; i < bcs.length; i++) {
    const bc = bcs[i]
    const patch = patchById.get(bc.patchId)
    if (!patch || !(patch.area > 0)) {
      blockingErrors.push(
        `Gate 4.2: Boundary condition "${bc.id}" references patch #${bc.patchId} with zero or missing surface area.`,
      )
      continue
    }

    if (bc.type === 'dirichlet') {
      dirichletPatches.add(bc.patchId)
      if (neumannPatches.has(bc.patchId)) {
        blockingErrors.push(
          `Gate 4.1: Patch #${bc.patchId} has both a Dirichlet restraint and a Neumann load assigned simultaneously.`,
        )
      }
    } else if (bc.type === 'pressure' || bc.type === 'traction' || bc.type === 'rbe3') {
      neumannPatches.add(bc.patchId)
      if (dirichletPatches.has(bc.patchId)) {
        blockingErrors.push(
          `Gate 4.1: Patch #${bc.patchId} has both a Dirichlet restraint and a Neumann load assigned simultaneously.`,
        )
      }
    } else if (bc.type === 'robin') {
      if (!(bc.stiffnessNPerMm3 > 0)) {
        blockingErrors.push(
          `Gate 4.2: Robin foundation spring "${bc.id}" on patch #${bc.patchId} must have stiffness k_r > 0.`,
        )
      }
    }
  }

  // Compute centroid and characteristic length rMax of welded surface vertices
  const pos = welded.positions
  const idx = welded.indices
  const vCount = pos.length / 3
  const triCount = idx.length / 3

  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < vCount; i++) {
    cx += pos[i * 3]
    cy += pos[i * 3 + 1]
    cz += pos[i * 3 + 2]
  }
  if (vCount > 0) {
    cx /= vCount
    cy /= vCount
    cz /= vCount
  }
  const centroid: [number, number, number] = [cx, cy, cz]

  let rMax = 0
  for (let i = 0; i < vCount; i++) {
    const d = Math.hypot(pos[i * 3] - cx, pos[i * 3 + 1] - cy, pos[i * 3 + 2] - cz)
    if (d > rMax) rMax = d
  }
  rMax = Math.max(1, rMax)

  // Build 6x6 Gram matrix G = R_C^T * R_C over all restrained surface patches
  const gram6x6 = new Float64Array(36)
  const row6 = new Float64Array(6)

  const accumulateConstraintRow = (vx: number, vy: number, vz: number, dx: number, dy: number, dz: number) => {
    const rx = (vx - cx) / rMax
    const ry = (vy - cy) / rMax
    const rz = (vz - cz) / rMax
    // Translation columns: d . e_k
    row6[0] = dx
    row6[1] = dy
    row6[2] = dz
    // Rotation columns: d . (e_k x r) = r x d
    row6[3] = ry * dz - rz * dy
    row6[4] = rz * dx - rx * dz
    row6[5] = rx * dy - ry * dx

    for (let r = 0; r < 6; r++) {
      const vr = row6[r]
      for (let c = 0; c < 6; c++) {
        gram6x6[r * 6 + c] += vr * row6[c]
      }
    }
  }

  // Group restraint BCs by patchId
  const restraintsByPatch = new Map<number, BoundaryCondition[]>()
  for (let i = 0; i < bcs.length; i++) {
    const bc = bcs[i]
    if (bc.type === 'dirichlet' || bc.type === 'robin') {
      const list = restraintsByPatch.get(bc.patchId)
      if (list) list.push(bc)
      else restraintsByPatch.set(bc.patchId, [bc])
    }
  }

  if (restraintsByPatch.size > 0) {
    for (let t = 0; t < triCount; t++) {
      const pid = welded.trianglePatch[t]
      const patchRestraints = restraintsByPatch.get(pid)
      if (!patchRestraints) continue

      const ia = idx[t * 3] * 3
      const ib = idx[t * 3 + 1] * 3
      const ic = idx[t * 3 + 2] * 3
      const verts = [ia, ib, ic]

      // Triangle outward unit normal for sliding_normal
      const ux = pos[ib] - pos[ia]
      const uy = pos[ib + 1] - pos[ia + 1]
      const uz = pos[ib + 2] - pos[ia + 2]
      const vx = pos[ic] - pos[ia]
      const vy = pos[ic + 1] - pos[ia + 1]
      const vz = pos[ic + 2] - pos[ia + 2]
      let nx = uy * vz - uz * vy
      let ny = uz * vx - ux * vz
      let nz = ux * vy - uy * vx
      const nLen = Math.hypot(nx, ny, nz)
      if (nLen > 1e-15) {
        nx /= nLen
        ny /= nLen
        nz /= nLen
      }

      for (let b = 0; b < patchRestraints.length; b++) {
        const bc = patchRestraints[b]
        for (let k = 0; k < 3; k++) {
          const vi = verts[k]
          const px = pos[vi]
          const py = pos[vi + 1]
          const pz = pos[vi + 2]

          if (bc.type === 'robin' || (bc.type === 'dirichlet' && bc.subtype === 'fixed')) {
            accumulateConstraintRow(px, py, pz, 1, 0, 0)
            accumulateConstraintRow(px, py, pz, 0, 1, 0)
            accumulateConstraintRow(px, py, pz, 0, 0, 1)
          } else if (bc.type === 'dirichlet' && bc.subtype === 'sliding_normal') {
            if (nLen > 1e-15) {
              accumulateConstraintRow(px, py, pz, nx, ny, nz)
            }
          } else if (bc.type === 'dirichlet' && bc.subtype === 'prescribed') {
            const d = bc.displacementMm ?? {}
            if (d.ux !== undefined) accumulateConstraintRow(px, py, pz, 1, 0, 0)
            if (d.uy !== undefined) accumulateConstraintRow(px, py, pz, 0, 1, 0)
            if (d.uz !== undefined) accumulateConstraintRow(px, py, pz, 0, 0, 1)
          }
        }
      }
    }
  }

  // Normalize Gram matrix by maximum diagonal or trace so singular value threshold is scale-invariant
  let maxDiag = 0
  for (let i = 0; i < 6; i++) {
    if (gram6x6[i * 6 + i] > maxDiag) maxDiag = gram6x6[i * 6 + i]
  }
  if (maxDiag > 0) {
    for (let i = 0; i < 36; i++) gram6x6[i] /= maxDiag
  }

  const { eigenvalues, eigenvectors } = jacobiEigen6x6(gram6x6)

  const singularValues: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0]
  const freeModes: Array<[number, number, number, number, number, number]> = []
  let rank = 0

  for (let k = 0; k < 6; k++) {
    const sigma = Math.sqrt(Math.max(0, eigenvalues[k]))
    singularValues[k] = sigma
    if (sigma >= 1e-4) {
      rank++
    } else {
      const tx = eigenvectors[0 * 6 + k]
      const ty = eigenvectors[1 * 6 + k]
      const tz = eigenvectors[2 * 6 + k]
      const wx = eigenvectors[3 * 6 + k] / rMax
      const wy = eigenvectors[4 * 6 + k] / rMax
      const wz = eigenvectors[5 * 6 + k] / rMax
      freeModes.push([tx, ty, tz, wx, wy, wz])
    }
  }

  if (rank < 6) {
    blockingErrors.push(
      `Gate 4.3: Insufficient rigid-body restraint (rank ${rank}/6; ${6 - rank} unconstrained rigid-body mode(s) detected).`,
    )
  }

  return {
    passed: blockingErrors.length === 0 && rank === 6,
    rank,
    singularValues,
    freeModes,
    centroid,
    characteristicLength: rMax,
    blockingErrors,
  }
}

/**
 * Evaluate the 3D nodal displacement vector field $\mathbf{u}(\mathbf{x}) = \mathbf{t} + \boldsymbol{\omega} \times (\mathbf{x} - \mathbf{x}_c)$
 * for an unconstrained rigid-body mode, scaled so the peak component amplitude equals `maxAmplitudeMm`.
 */
export function evaluateRbmModeDisplacements(
  positions: Float32Array,
  centroid: readonly [number, number, number],
  mode6: readonly [number, number, number, number, number, number],
  maxAmplitudeMm = 10,
): Float32Array {
  const vCount = positions.length / 3
  const out = new Float32Array(vCount * 3)
  const [tx, ty, tz, wx, wy, wz] = mode6
  const [cx, cy, cz] = centroid

  let maxAbs = 0
  for (let i = 0; i < vCount; i++) {
    const i3 = i * 3
    const rx = positions[i3] - cx
    const ry = positions[i3 + 1] - cy
    const rz = positions[i3 + 2] - cz
    const ux = tx + (wy * rz - wz * ry)
    const uy = ty + (wz * rx - wx * rz)
    const uz = tz + (wx * ry - wy * rx)
    out[i3] = ux
    out[i3 + 1] = uy
    out[i3 + 2] = uz
    const m = Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz))
    if (m > maxAbs) maxAbs = m
  }

  if (maxAbs > 1e-15) {
    const scale = maxAmplitudeMm / maxAbs
    for (let i = 0; i < out.length; i++) {
      out[i] *= scale
    }
  }

  return out
}

/**
 * Exact cyclic Jacobi eigensolver for a symmetric $6 \times 6$ matrix.
 * Returns eigenvalues sorted in descending order and column-stored eigenvectors.
 */
export function jacobiEigen6x6(matrix6x6: Float64Array): {
  eigenvalues: Float64Array
  eigenvectors: Float64Array
} {
  const a = matrix6x6.slice()
  const v = new Float64Array(36)
  for (let i = 0; i < 6; i++) v[i * 6 + i] = 1

  for (let sweep = 0; sweep < 50; sweep++) {
    let offDiagSq = 0
    for (let p = 0; p < 5; p++) {
      for (let q = p + 1; q < 6; q++) {
        const apq = a[p * 6 + q]
        offDiagSq += apq * apq
      }
    }
    if (offDiagSq < 1e-30) break

    for (let p = 0; p < 5; p++) {
      for (let q = p + 1; q < 6; q++) {
        const apq = a[p * 6 + q]
        if (Math.abs(apq) < 1e-18) continue
        const app = a[p * 6 + p]
        const aqq = a[q * 6 + q]
        const tau = (aqq - app) / (2 * apq)
        const t =
          tau >= 0
            ? 1 / (tau + Math.sqrt(1 + tau * tau))
            : -1 / (-tau + Math.sqrt(1 + tau * tau))
        const c = 1 / Math.sqrt(1 + t * t)
        const s = t * c

        a[p * 6 + p] = app - t * apq
        a[q * 6 + q] = aqq + t * apq
        a[p * 6 + q] = 0
        a[q * 6 + p] = 0

        for (let r = 0; r < 6; r++) {
          if (r === p || r === q) continue
          const arp = a[r * 6 + p]
          const arq = a[r * 6 + q]
          a[r * 6 + p] = c * arp - s * arq
          a[p * 6 + r] = a[r * 6 + p]
          a[r * 6 + q] = s * arp + c * arq
          a[q * 6 + r] = a[r * 6 + q]
        }

        for (let r = 0; r < 6; r++) {
          const vrp = v[r * 6 + p]
          const vrq = v[r * 6 + q]
          v[r * 6 + p] = c * vrp - s * vrq
          v[r * 6 + q] = s * vrp + c * vrq
        }
      }
    }
  }

  const eigenvalues = new Float64Array(6)
  for (let i = 0; i < 6; i++) eigenvalues[i] = a[i * 6 + i]

  // Sort eigenvalues descending and permute eigenvector columns accordingly
  for (let i = 0; i < 5; i++) {
    let maxIdx = i
    for (let j = i + 1; j < 6; j++) {
      if (eigenvalues[j] > eigenvalues[maxIdx]) maxIdx = j
    }
    if (maxIdx !== i) {
      const tmpVal = eigenvalues[i]
      eigenvalues[i] = eigenvalues[maxIdx]
      eigenvalues[maxIdx] = tmpVal
      for (let r = 0; r < 6; r++) {
        const tmpVec = v[r * 6 + i]
        v[r * 6 + i] = v[r * 6 + maxIdx]
        v[r * 6 + maxIdx] = tmpVec
      }
    }
  }

  return { eigenvalues, eigenvectors: v }
}

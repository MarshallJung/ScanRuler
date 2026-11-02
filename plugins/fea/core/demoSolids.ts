// SPDX-License-Identifier: AGPL-3.0-only

import { offerSolids } from '../../../src/app/solids'
import { syncFeaPreflightForCurrentSolid } from '../app/feaCommands'
import { useFeaStore } from '../state/feaStore'
import { runFeaRigidityCheck } from '../worker/feaClient'

export const CANTILEVER_BAR_KEY = 'fea-demo:cantilever-bar'

/**
 * Build a watertight, outward-oriented 12-triangle rectangular bar mesh
 * spanning `[0, 100] x [0, 10] x [0, 10]`.
 */
export function buildCantileverBarSolidMesh(
  xMin = 0,
  xMax = 100,
  yMin = 0,
  yMax = 10,
  zMin = 0,
  zMax = 10,
): { positions: Float32Array; indices: Uint32Array } {
  const c: ReadonlyArray<readonly [number, number, number]> = [
    [xMin, yMin, zMin], // 0
    [xMax, yMin, zMin], // 1
    [xMax, yMax, zMin], // 2
    [xMin, yMax, zMin], // 3
    [xMin, yMin, zMax], // 4
    [xMax, yMin, zMax], // 5
    [xMax, yMax, zMax], // 6
    [xMin, yMax, zMax], // 7
  ]

  const quads: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [2, 3, 7, 6], // +Y
    [0, 4, 7, 3], // -X (Fixed root)
    [1, 2, 6, 5], // +X (Loaded tip)
  ]

  const positions = new Float32Array(24 * 3)
  const indices = new Uint32Array(12 * 3)

  for (let f = 0; f < 6; f++) {
    const q = quads[f]
    const vBase = f * 4
    for (let k = 0; k < 4; k++) {
      const pt = c[q[k]]
      positions[(vBase + k) * 3] = pt[0]
      positions[(vBase + k) * 3 + 1] = pt[1]
      positions[(vBase + k) * 3 + 2] = pt[2]
    }
    const iBase = f * 6
    indices[iBase] = vBase
    indices[iBase + 1] = vBase + 1
    indices[iBase + 2] = vBase + 2
    indices[iBase + 3] = vBase
    indices[iBase + 4] = vBase + 2
    indices[iBase + 5] = vBase + 3
  }

  return { positions, indices }
}

/**
 * Register the built-in 100x10x10 cantilever bar solid on the neutral solid bus.
 */
export function ensureDemoCantileverBarOffered(): void {
  const bar = buildCantileverBarSolidMesh(0, 100, 0, 10, 0, 10)
  offerSolids('fea-demo', [
    {
      key: CANTILEVER_BAR_KEY,
      name: 'Cantilever Bar (100×10×10)',
      source: 'Benchmark',
      version: 1,
      mesh: async () => ({
        positions: bar.positions.slice(),
        indices: bar.indices.slice(),
      }),
    },
  ])
}

/**
 * Load the built-in 3D bar solid, run pre-flight segmentation, assign Structural Steel (`A36`),
 * fix the `-X` end face, and apply either:
 * - `'cantilever_bending'`: $F_y = -1{,}000\text{ N}$ downward shear load on the `+X` tip face, or
 * - `'axial_tension'`: $F_x = +10{,}000\text{ N}$ axial pulling load on the `+X` tip face.
 */
export async function loadFeaBenchmarkPreset(
  preset: 'cantilever_bending' | 'axial_tension',
): Promise<void> {
  ensureDemoCantileverBarOffered()
  const store = useFeaStore.getState()
  store.setSourceKey(CANTILEVER_BAR_KEY)
  store.setMaterialId('A36')
  store.setMeshPreset('medium')

  await syncFeaPreflightForCurrentSolid()
  const welded = useFeaStore.getState().welded
  if (!welded) return
  const pLeft = welded.patches.find((p) => p.normal[0] < -0.9)
  const pRight = welded.patches.find((p) => p.normal[0] > 0.9)
  if (!pLeft || !pRight) return

  store.clearBoundaryConditions()
  store.addBoundaryCondition({
    id: 'bc-fixed-root',
    patchId: pLeft.id,
    type: 'dirichlet',
    subtype: 'fixed',
  })

  if (preset === 'cantilever_bending') {
    store.addBoundaryCondition({
      id: 'bc-tip-bending',
      patchId: pRight.id,
      type: 'traction',
      totalForceN: [0, -1000, 0],
    })
  } else {
    store.addBoundaryCondition({
      id: 'bc-tip-tension',
      patchId: pRight.id,
      type: 'traction',
      totalForceN: [10000, 0, 0],
    })
  }

  const rig = await runFeaRigidityCheck({
    welded,
    bcs: useFeaStore.getState().boundaryConditions,
  })
  useFeaStore.getState().setRigidityReport(rig)
}

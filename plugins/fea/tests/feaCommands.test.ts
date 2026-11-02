// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest'
import { offerSolids, useSolids } from '../../../src/app/solids'
import { feaCommands } from '../app/feaCommands'
import { feaSection } from '../app/projectSection'
import { CANTILEVER_BAR_KEY, loadFeaBenchmarkPreset } from '../core/demoSolids'
import { useFeaStore } from '../state/feaStore'
import { makeBoxSurfaceMesh } from './preflight.test'

function findCmd(name: string) {
  const cmd = feaCommands.find((c) => c.name === name)
  if (!cmd) throw new Error(`Missing FEA command ${name}`)
  return cmd as unknown as { run: (args: Record<string, unknown>) => Promise<unknown> }
}

describe('FEA Commands, Project Serialization & Patch Rebinding', () => {
  beforeEach(() => {
    useSolids.setState({ bySource: {} })
    useFeaStore.getState().reset()

    const box = makeBoxSurfaceMesh(0, 40, 0, 10, 0, 10)
    offerSolids('reverse', [
      {
        key: 'reverse:bracket-1',
        name: 'Test Bracket',
        source: 'reverse',
        version: 1,
        mesh: async () => ({
          positions: box.positions.slice(),
          indices: box.indices.slice(),
        }),
      },
    ])
  })

  it('executes full headless agent workflow: source -> material -> bc.add -> solve -> report', async () => {
    const resSource = (await findCmd('source').run({ key: 'reverse:bracket-1' })) as {
      preflight: { passed: boolean; signedVolumeMm3: number }
      patches: Array<{ id: number; normal: [number, number, number] }>
    }
    expect(resSource.preflight.passed).toBe(true)
    expect(resSource.preflight.signedVolumeMm3).toBeCloseTo(4000, 1)
    expect(resSource.patches.length).toBe(6)

    // Set material to 7075-T6
    await findCmd('material').run({ id: '7075-T6' })
    expect(useFeaStore.getState().materialId).toBe('7075-T6')

    // Fix -X face and apply RBE3 remote load on +X face
    const pLeft = resSource.patches.find((p) => p.normal[0] < -0.9)!
    const pRight = resSource.patches.find((p) => p.normal[0] > 0.9)!

    await findCmd('bc.add').run({
      patchId: pLeft.id,
      type: 'dirichlet',
      subtype: 'fixed',
    })
    const resBc = (await findCmd('bc.add').run({
      patchId: pRight.id,
      type: 'rbe3',
      refPointMm: [25, 0, 0],
      totalForceN: [0, -500, 0],
      momentNmm: [0, 0, -2500],
    })) as { rigidity: { passed: boolean; rank: number } }

    expect(resBc.rigidity.passed).toBe(true)
    expect(resBc.rigidity.rank).toBe(6)

    const resSolve = (await findCmd('solve').run({ preset: 'coarse' })) as {
      solution: {
        metrics: {
          maxDisplacementMm: number
          maxVonMisesRawMPa: number
          equilibrium: { passed: boolean }
        }
      }
    }

    expect(resSolve.solution.metrics.equilibrium.passed).toBe(true)
    expect(resSolve.solution.metrics.maxDisplacementMm).toBeGreaterThan(0)
    expect(resSolve.solution.metrics.maxVonMisesRawMPa).toBeGreaterThan(0)

    // Verify projectSection round-trip
    const saved = feaSection.collect({
      sources: { scan: null, reference: null, image: null },
      scanSaved: false,
      addMember: () => {},
    })
    useFeaStore.getState().reset()
    expect(useFeaStore.getState().boundaryConditions.length).toBe(0)

    const applyRestore = feaSection.prepare(saved, {
      manifest: {} as never,
      members: new Map(),
    })
    applyRestore()
    expect(useFeaStore.getState().sourceKey).toBe('reverse:bracket-1')
    expect(useFeaStore.getState().materialId).toBe('7075-T6')
    expect(useFeaStore.getState().boundaryConditions.length).toBe(2)
  })

  it('loads and solves the built-in 100x10x10 cantilever bar benchmark preset', async () => {
    await loadFeaBenchmarkPreset('cantilever_bending')
    const st = useFeaStore.getState()
    expect(st.sourceKey).toBe(CANTILEVER_BAR_KEY)
    expect(st.preflight?.passed).toBe(true)
    expect(st.rigidity?.passed).toBe(true)
    expect(st.rigidity?.rank).toBe(6)
    expect(st.boundaryConditions.length).toBe(2)

    const resSolve = (await findCmd('solve').run({ preset: 'coarse' })) as {
      solution: {
        metrics: {
          maxDisplacementMm: number
          maxVonMisesMaskedMPa: number
          equilibrium: { passed: boolean }
        }
      }
    }
    expect(resSolve.solution.metrics.equilibrium.passed).toBe(true)
    expect(resSolve.solution.metrics.maxDisplacementMm).toBeGreaterThan(1.5)
    expect(resSolve.solution.metrics.maxVonMisesMaskedMPa).toBeGreaterThan(400)
  })
})

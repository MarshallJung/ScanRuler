// SPDX-License-Identifier: AGPL-3.0-only

import { offeredSolids } from '../../../src/app/solids'
import { enumOf, int, num, obj, str, vec3 } from '../../../src/commands/schema'
import { CommandError, type Command } from '../../../src/plugins/api'
import { CURATED_MATERIALS, getMaterialPreset, validateIsotropicMaterial } from '../core/materials'
import type { BoundaryCondition, FeaMeshPreset, IsotropicMaterial } from '../core/types'
import { useFeaStore } from '../state/feaStore'
import {
  runFeaPreflight,
  runFeaRigidityCheck,
  runFeaSolvePipeline,
} from '../worker/feaClient'
import { describeFea } from './feaReadout'

/**
 * Re-extract the active solid's mesh from `offeredSolids()`, run `Gate 1-2`
 * preflight, rebind existing boundary conditions by patch fingerprint, and
 * update `Gate 4` rigidity report.
 */
export async function syncFeaPreflightForCurrentSolid(): Promise<void> {
  const s = useFeaStore.getState()
  if (!s.sourceKey) return

  const solid = offeredSolids().find((item) => item.key === s.sourceKey)
  if (!solid) {
    throw new CommandError('not_found', `Solid body "${s.sourceKey}" was not found.`)
  }

  const rawMesh = await solid.mesh(0.1)
  const { welded, preflight } = await runFeaPreflight({
    positions: rawMesh.positions.slice(),
    indices: rawMesh.indices.slice(),
    faceHash: rawMesh.faceHash,
    faces: rawMesh.faces,
    mergedPairs: s.mergedPairs,
  })

  useFeaStore.getState().setPreflightOutput(welded, preflight)
  useFeaStore.getState().rebindAllBoundaryConditions(welded)

  const updatedBcs = useFeaStore.getState().boundaryConditions
  const rigidity = await runFeaRigidityCheck({
    welded,
    bcs: updatedBcs,
  })
  useFeaStore.getState().setRigidityReport(rigidity)
}

const sourceCmd: Command<{ key: string }> = {
  name: 'source',
  title: 'Select solid body for FEA',
  description: 'Select an offered watertight solid body by key and run Gate 1-2 preflight checks.',
  input: obj({ key: str('Solid key from session.state.plugins.fea.availableSolids.') }, ['key']),
  headless: true,
  run: async ({ key }) => {
    const solid = offeredSolids().find((item) => item.key === key || item.name === key)
    if (!solid) {
      throw new CommandError('not_found', `Solid "${key}" is not available.`)
    }
    useFeaStore.getState().setSourceKey(solid.key)
    await syncFeaPreflightForCurrentSolid()
    return describeFea()
  },
}

const preflightCmd: Command<Record<string, never>> = {
  name: 'preflight',
  title: 'Run FEA topology and thickness preflight',
  description: 'Run Gate 1-2 watertightness, seam welding, and minimum wall thickness verification.',
  input: obj({}),
  readOnly: true,
  headless: true,
  run: async () => {
    if (!useFeaStore.getState().sourceKey) {
      throw new CommandError('invalid_state', 'Select a solid body first with fea.source.')
    }
    await syncFeaPreflightForCurrentSolid()
    return describeFea()
  },
}

const materialCmd: Command<{
  id?: string
  youngsModulusMPa?: number
  poissonsRatio?: number
  failureCriterion?: 'ductile' | 'brittle'
  yieldStrengthMPa?: number
  ultimateTensileMPa?: number
  ultimateCompressiveMPa?: number
}> = {
  name: 'material',
  title: 'Set isotropic material properties',
  description: 'Choose a curated material preset by id or define custom isotropic elastic parameters (Gate 3).',
  input: obj({
    id: enumOf(CURATED_MATERIALS.map((m) => m.id), 'Curated material preset ID.'),
    youngsModulusMPa: num('Youngs modulus E in MPa.'),
    poissonsRatio: num('Poissons ratio nu in (0, 0.45].'),
    failureCriterion: enumOf(['ductile', 'brittle'], 'Failure theory.'),
    yieldStrengthMPa: num('Tensile yield strength in MPa (ductile).'),
    ultimateTensileMPa: num('Ultimate tensile strength in MPa (brittle).'),
    ultimateCompressiveMPa: num('Ultimate compressive strength in MPa (brittle).'),
  }),
  headless: true,
  run: async (args) => {
    if (args.id && args.youngsModulusMPa === undefined) {
      const preset = getMaterialPreset(args.id)
      if (!preset) {
        throw new CommandError('invalid_input', `Unknown material preset "${args.id}".`)
      }
      useFeaStore.getState().setMaterialId(preset.id)
      return describeFea()
    }

    const base = args.id ? getMaterialPreset(args.id) : useFeaStore.getState().getEffectiveMaterial()
    const custom: IsotropicMaterial = {
      id: args.id ?? 'custom',
      name: args.id ?? 'Custom Isotropic',
      youngsModulusMPa: args.youngsModulusMPa ?? base?.youngsModulusMPa ?? 69000,
      poissonsRatio: args.poissonsRatio ?? base?.poissonsRatio ?? 0.33,
      densityKgM3: base?.densityKgM3 ?? 2700,
      failureCriterion: args.failureCriterion ?? base?.failureCriterion ?? 'ductile',
      yieldStrengthMPa: args.yieldStrengthMPa ?? base?.yieldStrengthMPa ?? 276,
      ultimateTensileMPa: args.ultimateTensileMPa ?? base?.ultimateTensileMPa,
      ultimateCompressiveMPa: args.ultimateCompressiveMPa ?? base?.ultimateCompressiveMPa,
    }
    const check = validateIsotropicMaterial(custom)
    if (!check.passed) {
      throw new CommandError('invalid_input', check.errors.join(' '))
    }
    useFeaStore.getState().setCustomMaterial(custom)
    return describeFea()
  },
}

const bcAddCmd: Command<{
  patchId: number
  type: 'dirichlet' | 'robin' | 'pressure' | 'traction' | 'rbe3'
  subtype?: 'fixed' | 'sliding_normal' | 'prescribed'
  displacementMm?: [number, number, number]
  stiffnessNPerMm3?: number
  pressureMPa?: number
  totalForceN?: [number, number, number]
  tractionMPa?: [number, number, number]
  refPointMm?: [number, number, number]
  momentNmm?: [number, number, number]
}> = {
  name: 'bc.add',
  title: 'Add a boundary condition to a surface patch',
  description: 'Assign a Dirichlet restraint, Robin foundation, normal pressure, traction, or RBE3 remote load to a surface patch.',
  input: obj(
    {
      patchId: int('Target surface patch ID.'),
      type: enumOf(['dirichlet', 'robin', 'pressure', 'traction', 'rbe3'], 'Boundary condition kind.'),
      subtype: enumOf(['fixed', 'sliding_normal', 'prescribed'], 'Dirichlet restraint mode.'),
      displacementMm: vec3('Prescribed displacement [ux, uy, uz] in mm.'),
      stiffnessNPerMm3: num('Robin foundation stiffness in N/mm^3.'),
      pressureMPa: num('Normal pressure in MPa (+ into surface).'),
      totalForceN: vec3('Total distributed force [Fx, Fy, Fz] in N.'),
      tractionMPa: vec3('Uniform surface traction [tx, ty, tz] in MPa.'),
      refPointMm: vec3('RBE3 reference point [x, y, z] in mm.'),
      momentNmm: vec3('RBE3 remote moment [Mx, My, Mz] in N*mm.'),
    },
    ['patchId', 'type'],
  ),
  headless: true,
  run: async (args) => {
    const s = useFeaStore.getState()
    if (!s.welded) {
      throw new CommandError('invalid_state', 'Select a solid body first with fea.source.')
    }
    const patch = s.welded.patches.find((p) => p.id === args.patchId)
    if (!patch) {
      throw new CommandError('not_found', `Patch #${args.patchId} does not exist on the active solid.`)
    }

    const id = `bc-p${args.patchId}-${args.type}`
    let bc: BoundaryCondition
    if (args.type === 'dirichlet') {
      const subtype = args.subtype ?? 'fixed'
      bc = {
        id,
        patchId: args.patchId,
        type: 'dirichlet',
        subtype,
        displacementMm:
          subtype === 'prescribed' && args.displacementMm
            ? {
                ux: args.displacementMm[0],
                uy: args.displacementMm[1],
                uz: args.displacementMm[2],
              }
            : undefined,
      }
    } else if (args.type === 'robin') {
      bc = {
        id,
        patchId: args.patchId,
        type: 'robin',
        stiffnessNPerMm3: args.stiffnessNPerMm3 ?? 500,
      }
    } else if (args.type === 'pressure') {
      bc = {
        id,
        patchId: args.patchId,
        type: 'pressure',
        pressureMPa: args.pressureMPa ?? 1,
      }
    } else if (args.type === 'traction') {
      bc = {
        id,
        patchId: args.patchId,
        type: 'traction',
        totalForceN: args.totalForceN,
        tractionMPa: args.tractionMPa ?? (args.totalForceN ? undefined : [0, -1, 0]),
      }
    } else {
      bc = {
        id,
        patchId: args.patchId,
        type: 'rbe3',
        refPointMm: args.refPointMm ?? patch.centroid,
        forceN: args.totalForceN ?? [0, 0, 0],
        momentNmm: args.momentNmm ?? [0, 0, 0],
      }
    }

    useFeaStore.getState().addBoundaryCondition(bc)
    const rigidity = await runFeaRigidityCheck({
      welded: s.welded,
      bcs: useFeaStore.getState().boundaryConditions,
    })
    useFeaStore.getState().setRigidityReport(rigidity)
    return describeFea()
  },
}

const bcRemoveCmd: Command<{ id: string }> = {
  name: 'bc.remove',
  title: 'Remove a boundary condition',
  description: 'Remove a boundary condition by ID.',
  input: obj({ id: str('Boundary condition ID.') }, ['id']),
  headless: true,
  run: async ({ id }) => {
    useFeaStore.getState().removeBoundaryCondition(id)
    const s = useFeaStore.getState()
    if (s.welded) {
      const rigidity = await runFeaRigidityCheck({
        welded: s.welded,
        bcs: s.boundaryConditions,
      })
      useFeaStore.getState().setRigidityReport(rigidity)
    }
    return describeFea()
  },
}

const bcClearCmd: Command<Record<string, never>> = {
  name: 'bc.clear',
  title: 'Clear all boundary conditions',
  description: 'Remove all boundary conditions from the FEA setup.',
  input: obj({}),
  headless: true,
  run: async () => {
    useFeaStore.getState().clearBoundaryConditions()
    return describeFea()
  },
}

const mergePatchesCmd: Command<{ patchA: number; patchB: number }> = {
  name: 'merge_patches',
  title: 'Merge two surface patches',
  description: 'Virtually merge two surface patches into one combined patch.',
  input: obj(
    {
      patchA: int('First patch ID.'),
      patchB: int('Second patch ID.'),
    },
    ['patchA', 'patchB'],
  ),
  headless: true,
  run: async ({ patchA, patchB }) => {
    useFeaStore.getState().mergePatchPair(patchA, patchB)
    if (useFeaStore.getState().sourceKey) {
      await syncFeaPreflightForCurrentSolid()
    }
    return describeFea()
  },
}

const solveCmd: Command<{ preset?: FeaMeshPreset; targetEdgeMm?: number }> = {
  name: 'solve',
  title: 'Run Tet10 FEA solver',
  description: 'Mesh the solid with 10-node quadratic tetrahedra, solve via PCG, and recover ZZ-SPR stresses.',
  input: obj({
    preset: enumOf(['coarse', 'medium', 'fine'], 'Mesh density preset.'),
    targetEdgeMm: num('Optional target element edge length in mm.'),
  }),
  headless: true,
  run: async (args) => {
    if (args.preset) useFeaStore.getState().setMeshPreset(args.preset)
    if (args.targetEdgeMm !== undefined) useFeaStore.getState().setTargetEdgeMm(args.targetEdgeMm)

    const s = useFeaStore.getState()
    if (!s.welded || !s.preflight) {
      throw new CommandError('invalid_state', 'Select a solid body first with fea.source.')
    }
    if (!s.preflight.passed) {
      throw new CommandError('invalid_state', `Gate 2 preflight failed: ${s.preflight.blockingErrors.join(' ')}`)
    }

    useFeaStore.getState().setBusy(true, 'Starting FEA solve pipeline...')
    try {
      const { rigidity, solution } = await runFeaSolvePipeline(
        {
          welded: s.welded,
          material: s.getEffectiveMaterial(),
          bcs: s.boundaryConditions,
          meshSettings: useFeaStore.getState().meshSettings,
        },
        (stage) => useFeaStore.getState().setBusy(true, stage),
      )
      useFeaStore.getState().setSolutionOutput(rigidity, solution)
      return describeFea()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useFeaStore.getState().setError(msg)
      throw new CommandError('failed', msg)
    }
  },
}

const reportCmd: Command<Record<string, never>> = {
  name: 'report',
  title: 'Read out FEA status and solution metrics',
  description: 'Return the current FEA preflight, rigidity, and solved stress/displacement/safety metrics.',
  input: obj({}),
  readOnly: true,
  headless: true,
  run: async () => describeFea(),
}

export const feaCommands = [
  sourceCmd,
  preflightCmd,
  materialCmd,
  bcAddCmd,
  bcRemoveCmd,
  bcClearCmd,
  mergePatchesCmd,
  solveCmd,
  reportCmd,
] as Command<never>[]

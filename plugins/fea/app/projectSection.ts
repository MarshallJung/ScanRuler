// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectSection } from '../../../src/app/projectSections'
import { array, fields, invalid, object } from '../../../src/core/project/validation'
import type {
  BoundaryCondition,
  FeaFieldKind,
  FeaMeshSettings,
  IsotropicMaterial,
} from '../core/types'
import { FEA_HISTORY_KEYS, useFeaStore } from '../state/feaStore'

export interface FeaProjectPart {
  sourceKey: string | null
  materialId: string
  customMaterial: IsotropicMaterial | null
  boundaryConditions: BoundaryCondition[]
  mergedPairs: Array<[number, number]>
  meshSettings: FeaMeshSettings
  activeField: FeaFieldKind
  deformScale: number
  excludeSingularities: boolean
}

const VALID_FIELDS: readonly FeaFieldKind[] = [
  'vonMises',
  'sigma1',
  'sigma3',
  'displacement',
  'safetyFactor',
  'etaZz',
]

const VALID_PRESETS = ['coarse', 'medium', 'fine'] as const

function validateFeaPart(raw: unknown): FeaProjectPart {
  const x = object(raw, 'fea')
  if (x.sourceKey !== null && typeof x.sourceKey !== 'string') invalid('fea.sourceKey')
  fields(x, 'materialId activeField', 'string', 'fea')
  fields(x, 'deformScale', 'number', 'fea')
  fields(x, 'excludeSingularities', 'boolean', 'fea')
  if (!VALID_FIELDS.includes(x.activeField as FeaFieldKind)) invalid('fea.activeField')

  const ms = object(x.meshSettings, 'fea.meshSettings')
  fields(ms, 'targetEdgeMm', 'number', 'fea.meshSettings')
  if (!VALID_PRESETS.includes(ms.preset as (typeof VALID_PRESETS)[number])) {
    invalid('fea.meshSettings.preset')
  }

  array(x.boundaryConditions, 'fea.boundaryConditions')
  array(x.mergedPairs, 'fea.mergedPairs')
  return raw as FeaProjectPart
}

export const feaSection: ProjectSection<FeaProjectPart> = {
  key: 'fea',
  collect() {
    const s = useFeaStore.getState()
    return {
      sourceKey: s.sourceKey,
      materialId: s.materialId,
      customMaterial: s.customMaterial,
      boundaryConditions: s.boundaryConditions,
      mergedPairs: s.mergedPairs,
      meshSettings: s.meshSettings,
      activeField: s.activeField,
      deformScale: s.deformScale,
      excludeSingularities: s.excludeSingularities,
    }
  },
  prepare(value) {
    if (value === undefined) return () => {}
    const part = validateFeaPart(value)
    return () => {
      useFeaStore.setState({
        sourceKey: part.sourceKey,
        materialId: part.materialId,
        customMaterial: part.customMaterial,
        boundaryConditions: part.boundaryConditions,
        mergedPairs: part.mergedPairs,
        meshSettings: part.meshSettings,
        activeField: part.activeField,
        deformScale: part.deformScale,
        excludeSingularities: part.excludeSingularities,
        welded: null,
        preflight: null,
        rigidity: null,
        solution: null,
      })
    }
  },
  hasContent: () => {
    const s = useFeaStore.getState()
    return s.sourceKey !== null || s.boundaryConditions.length > 0
  },
  holdsWork: () => useFeaStore.getState().boundaryConditions.length > 0,
  holds: () => ({ boundaryConditions: useFeaStore.getState().boundaryConditions.length }),
  watch(changed) {
    return useFeaStore.subscribe((s, prev) => {
      if (FEA_HISTORY_KEYS.some((k) => s[k] !== prev[k])) changed()
    })
  },
}

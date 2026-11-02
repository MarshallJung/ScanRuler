// SPDX-License-Identifier: AGPL-3.0-only

import { create } from 'zustand'
import { DEFAULT_MATERIAL_ID, getMaterialPreset } from '../core/materials'
import { fingerprintOfPatch, rebindBoundaryConditions } from '../core/patches'
import type {
  BoundaryCondition,
  FeaFieldKind,
  FeaMeshPreset,
  FeaMeshSettings,
  FeaSolutionPayload,
  IsotropicMaterial,
  PreflightReport,
  RigidityReport,
  WeldedSurfaceMesh,
} from '../core/types'

export interface FeaHoverReadout {
  label: string
  value: number
  unit: 'MPa' | 'len' | 'pct' | 'fos'
  singular: boolean
}

export interface FeaState {
  // History-tracked & project-serialized state
  sourceKey: string | null
  materialId: string
  customMaterial: IsotropicMaterial | null
  boundaryConditions: BoundaryCondition[]
  mergedPairs: Array<[number, number]>
  meshSettings: FeaMeshSettings
  activeField: FeaFieldKind
  deformScale: number
  excludeSingularities: boolean

  // Ephemeral / computed session state
  selectedPatchId: number | null
  hoveredPatchId: number | null
  mergeMode: boolean
  welded: WeldedSurfaceMesh | null
  preflight: PreflightReport | null
  rigidity: RigidityReport | null
  solution: FeaSolutionPayload | null
  busy: boolean
  progressStage: string | null
  error: string | null
  activeRbmModeIndex: number | null
  oscillateDeformed: boolean
  hoveredReadout: FeaHoverReadout | null

  // Actions
  setSourceKey: (key: string | null) => void
  setMaterialId: (id: string) => void
  setCustomMaterial: (mat: IsotropicMaterial | null) => void
  getEffectiveMaterial: () => IsotropicMaterial
  setSelectedPatchId: (id: number | null) => void
  setHoveredPatchId: (id: number | null) => void
  setMergeMode: (active: boolean) => void
  mergePatchPair: (patchA: number, patchB: number) => void
  clearMergedPatches: () => void
  addBoundaryCondition: (bc: BoundaryCondition) => void
  updateBoundaryCondition: (id: string, bc: BoundaryCondition) => void
  removeBoundaryCondition: (id: string) => void
  clearBoundaryConditions: () => void
  rebindAllBoundaryConditions: (welded: WeldedSurfaceMesh) => void
  setMeshPreset: (preset: FeaMeshPreset) => void
  setTargetEdgeMm: (edgeMm: number) => void
  setActiveField: (field: FeaFieldKind) => void
  setDeformScale: (scale: number) => void
  setExcludeSingularities: (exclude: boolean) => void
  setActiveRbmModeIndex: (idx: number | null) => void
  setOscillateDeformed: (osc: boolean) => void
  setHoveredReadout: (readout: FeaHoverReadout | null) => void
  setPreflightOutput: (welded: WeldedSurfaceMesh, preflight: PreflightReport) => void
  setRigidityReport: (rigidity: RigidityReport | null) => void
  setSolutionOutput: (rigidity: RigidityReport, solution: FeaSolutionPayload) => void
  clearSolution: () => void
  setBusy: (busy: boolean, stage?: string | null) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const FEA_HISTORY_KEYS = [
  'sourceKey',
  'materialId',
  'customMaterial',
  'boundaryConditions',
  'mergedPairs',
  'meshSettings',
  'activeField',
  'deformScale',
  'excludeSingularities',
] as const satisfies readonly (keyof FeaState)[]

const INITIAL_MESH_SETTINGS: FeaMeshSettings = {
  preset: 'medium',
  targetEdgeMm: 0,
}

export const useFeaStore = create<FeaState>((set, get) => ({
  sourceKey: null,
  materialId: DEFAULT_MATERIAL_ID,
  customMaterial: null,
  boundaryConditions: [],
  mergedPairs: [],
  meshSettings: { ...INITIAL_MESH_SETTINGS },
  activeField: 'vonMises',
  deformScale: 10,
  excludeSingularities: true,

  selectedPatchId: null,
  hoveredPatchId: null,
  mergeMode: false,
  welded: null,
  preflight: null,
  rigidity: null,
  solution: null,
  busy: false,
  progressStage: null,
  error: null,
  activeRbmModeIndex: null,
  oscillateDeformed: false,
  hoveredReadout: null,

  setSourceKey: (sourceKey) =>
    set({
      sourceKey,
      selectedPatchId: null,
      hoveredPatchId: null,
      welded: null,
      preflight: null,
      rigidity: null,
      solution: null,
      error: null,
      activeRbmModeIndex: null,
    }),

  setMaterialId: (materialId) =>
    set({
      materialId,
      customMaterial: null,
      solution: null,
      error: null,
    }),

  setCustomMaterial: (customMaterial) =>
    set({
      materialId: customMaterial ? customMaterial.id : DEFAULT_MATERIAL_ID,
      customMaterial,
      solution: null,
      error: null,
    }),

  getEffectiveMaterial: () => {
    const s = get()
    if (s.customMaterial) return s.customMaterial
    return getMaterialPreset(s.materialId) ?? getMaterialPreset(DEFAULT_MATERIAL_ID)!
  },

  setSelectedPatchId: (selectedPatchId) => set({ selectedPatchId }),
  setHoveredPatchId: (hoveredPatchId) => set({ hoveredPatchId }),
  setMergeMode: (mergeMode) => set({ mergeMode }),

  mergePatchPair: (patchA, patchB) => {
    if (patchA === patchB) return
    const lo = Math.min(patchA, patchB)
    const hi = Math.max(patchA, patchB)
    const current = get().mergedPairs
    if (current.some(([a, b]) => a === lo && b === hi)) return
    set({
      mergedPairs: [...current, [lo, hi]],
      selectedPatchId: lo,
      mergeMode: false,
      solution: null,
    })
  },

  clearMergedPatches: () =>
    set({
      mergedPairs: [],
      mergeMode: false,
      solution: null,
    }),

  addBoundaryCondition: (bc) => {
    const s = get()
    let enriched = bc
    if (s.welded) {
      const patch = s.welded.patches.find((p) => p.id === bc.patchId)
      if (patch) {
        enriched = { ...bc, fingerprint: fingerprintOfPatch(patch) }
      }
    }
    // Replace any existing BC of the same family or on the same patch if conflicting
    const filtered = s.boundaryConditions.filter((existing) => existing.id !== enriched.id)
    set({
      boundaryConditions: [...filtered, enriched],
      solution: null,
      error: null,
      activeRbmModeIndex: null,
    })
  },

  updateBoundaryCondition: (id, bc) => {
    const s = get()
    let enriched = bc
    if (s.welded) {
      const patch = s.welded.patches.find((p) => p.id === bc.patchId)
      if (patch) {
        enriched = { ...bc, fingerprint: fingerprintOfPatch(patch) }
      }
    }
    set({
      boundaryConditions: s.boundaryConditions.map((item) => (item.id === id ? enriched : item)),
      solution: null,
      error: null,
      activeRbmModeIndex: null,
    })
  },

  removeBoundaryCondition: (id) =>
    set((s) => ({
      boundaryConditions: s.boundaryConditions.filter((b) => b.id !== id),
      solution: null,
      error: null,
      activeRbmModeIndex: null,
    })),

  clearBoundaryConditions: () =>
    set({
      boundaryConditions: [],
      rigidity: null,
      solution: null,
      error: null,
      activeRbmModeIndex: null,
    }),

  rebindAllBoundaryConditions: (welded) => {
    const current = get().boundaryConditions
    if (current.length === 0) return
    const rebound = rebindBoundaryConditions(current, welded.patches)
    set({ boundaryConditions: rebound })
  },

  setMeshPreset: (preset) =>
    set((s) => ({
      meshSettings: { ...s.meshSettings, preset },
      solution: null,
    })),

  setTargetEdgeMm: (targetEdgeMm) =>
    set((s) => ({
      meshSettings: { ...s.meshSettings, targetEdgeMm: Math.max(0, targetEdgeMm) },
      solution: null,
    })),

  setActiveField: (activeField) => set({ activeField }),
  setDeformScale: (deformScale) => set({ deformScale }),
  setExcludeSingularities: (excludeSingularities) => set({ excludeSingularities }),
  setActiveRbmModeIndex: (activeRbmModeIndex) => set({ activeRbmModeIndex }),
  setOscillateDeformed: (oscillateDeformed) => set({ oscillateDeformed }),
  setHoveredReadout: (hoveredReadout) => set({ hoveredReadout }),

  setPreflightOutput: (welded, preflight) =>
    set({
      welded,
      preflight,
      error: null,
    }),

  setRigidityReport: (rigidity) => set({ rigidity }),

  setSolutionOutput: (rigidity, solution) =>
    set({
      rigidity,
      solution,
      busy: false,
      progressStage: null,
      error: null,
      activeRbmModeIndex: null,
    }),

  clearSolution: () => set({ solution: null }),

  setBusy: (busy, progressStage = null) => set({ busy, progressStage }),
  setError: (error) => set({ error, busy: false, progressStage: null }),

  reset: () =>
    set({
      sourceKey: null,
      materialId: DEFAULT_MATERIAL_ID,
      customMaterial: null,
      boundaryConditions: [],
      mergedPairs: [],
      meshSettings: { ...INITIAL_MESH_SETTINGS },
      activeField: 'vonMises',
      deformScale: 10,
      excludeSingularities: true,
      selectedPatchId: null,
      hoveredPatchId: null,
      mergeMode: false,
      welded: null,
      preflight: null,
      rigidity: null,
      solution: null,
      busy: false,
      progressStage: null,
      error: null,
      activeRbmModeIndex: null,
      oscillateDeformed: false,
      hoveredReadout: null,
    }),
}))

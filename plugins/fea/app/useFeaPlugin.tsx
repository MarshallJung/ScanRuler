// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo } from 'react'
import { offerSolids, offeredSolids, useSolids } from '../../../src/app/solids'
import { useLength } from '../../../src/app/useUnits'
import type { PluginHost, PluginRuntime } from '../../../src/plugins/api'
import { usePrefs } from '../../../src/state/prefsStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { type LegendMark, type LegendStat, MapLegend } from '../../../src/ui/MapLegend'
import { loadFeaBenchmarkPreset } from '../core/demoSolids'
import type { FeaFieldKind } from '../core/types'
import { useFeaStore } from '../state/feaStore'
import { FeaPanel } from '../ui/FeaPanel'
import { computeFieldScaleForFea, feaSceneOf } from '../viewer/feaScene'
import { runFeaRigidityCheck, runFeaSolvePipeline } from '../worker/feaClient'
import { syncFeaPreflightForCurrentSolid } from './feaCommands'

export function useFeaPlugin(host: PluginHost): PluginRuntime {
  const isFeaWorkspace = useShell((s) => s.workspace === 'fea')
  const fileName = useStore((s) => s.fileName)
  const triangleCount = useStore((s) => s.triangleCount)
  const bySource = useSolids((s) => s.bySource)
  const solids = useMemo(() => offeredSolids(bySource), [bySource])
  const len = useLength()
  const colormapId = usePrefs((s) => s.colormap)

  // Offer the active scan mesh as a candidate solid body when a triangle mesh is loaded
  useEffect(() => {
    if (!fileName || triangleCount <= 0) {
      offerSolids('fea-scan', [])
      return
    }
    offerSolids('fea-scan', [
      {
        key: 'scan:mesh',
        name: fileName,
        source: 'Scan Mesh',
        version: triangleCount,
        mesh: async () => {
          const geom = host.sceneRef.current?.scanGeometry()
          const pos = geom?.getAttribute('position')?.array as Float32Array | undefined
          const idx = geom?.getIndex()?.array as Uint32Array | Uint16Array | undefined
          if (!pos || !idx) {
            throw new Error('Active scan has no triangle geometry.')
          }
          const ownCount = (host.sceneRef.current?.scanVertexCount() ?? pos.length / 3) * 3
          return {
            positions: pos.subarray(0, ownCount).slice(),
            indices: idx instanceof Uint32Array ? idx.slice() : Uint32Array.from(idx),
          }
        },
      },
    ])
  }, [fileName, triangleCount, host.sceneRef])

  const sourceKey = useFeaStore((s) => s.sourceKey)
  const boundaryConditions = useFeaStore((s) => s.boundaryConditions)
  const mergedPairs = useFeaStore((s) => s.mergedPairs)
  const selectedPatchId = useFeaStore((s) => s.selectedPatchId)
  const hoveredPatchId = useFeaStore((s) => s.hoveredPatchId)
  const mergeMode = useFeaStore((s) => s.mergeMode)
  const welded = useFeaStore((s) => s.welded)
  const rigidity = useFeaStore((s) => s.rigidity)
  const solution = useFeaStore((s) => s.solution)
  const activeField = useFeaStore((s) => s.activeField)
  const deformScale = useFeaStore((s) => s.deformScale)
  const excludeSingularities = useFeaStore((s) => s.excludeSingularities)
  const activeRbmModeIndex = useFeaStore((s) => s.activeRbmModeIndex)
  const oscillateDeformed = useFeaStore((s) => s.oscillateDeformed)
  const hoveredReadout = useFeaStore((s) => s.hoveredReadout)
  const getEffectiveMaterial = useFeaStore((s) => s.getEffectiveMaterial)

  // Auto-select the first available solid when entering the FEA workspace
  useEffect(() => {
    if (!isFeaWorkspace) return
    if (!sourceKey && solids.length > 0) {
      useFeaStore.getState().setSourceKey(solids[0].key)
    }
  }, [isFeaWorkspace, sourceKey, solids])

  // Run Gate 1-2 preflight whenever the selected solid or patch merges change
  useEffect(() => {
    if (!sourceKey) return
    const hasSolid = solids.some((s) => s.key === sourceKey)
    if (!hasSolid) return
    void syncFeaPreflightForCurrentSolid().catch((err) => {
      useFeaStore.getState().setError(err instanceof Error ? err.message : String(err))
    })
  }, [sourceKey, mergedPairs, solids])

  // Run Gate 4 rigidity check whenever boundary conditions change on a welded solid
  useEffect(() => {
    if (!welded) return
    void runFeaRigidityCheck({ welded, bcs: boundaryConditions }).then((rep) => {
      useFeaStore.getState().setRigidityReport(rep)
    })
  }, [welded, boundaryConditions])

  // Synchronize 3D FeaScene with store state
  useEffect(() => {
    const scene = feaSceneOf(host.sceneRef.current)
    if (!scene) return

    if (!isFeaWorkspace) {
      scene.clear()
      scene.onPatchPick = null
      scene.onPatchHover = null
      scene.onSolutionHover = null
      return
    }

    scene.onPatchPick = (patchId) => {
      const st = useFeaStore.getState()
      if (st.mergeMode && st.selectedPatchId !== null && st.selectedPatchId !== patchId) {
        st.mergePatchPair(st.selectedPatchId, patchId)
      } else {
        st.setSelectedPatchId(patchId)
      }
    }
    scene.onPatchHover = (patchId) => {
      useFeaStore.getState().setHoveredPatchId(patchId)
    }
    scene.onSolutionHover = (readout) => {
      useFeaStore.getState().setHoveredReadout(readout)
    }

    scene.update({
      welded,
      bcs: boundaryConditions,
      selectedPatchId,
      hoveredPatchId,
      rigidity,
      activeRbmModeIndex,
      solution,
      activeField,
      deformScale,
      excludeSingularities,
      oscillateDeformed,
      colormapId,
    })
  }, [
    host.sceneRef,
    isFeaWorkspace,
    welded,
    boundaryConditions,
    selectedPatchId,
    hoveredPatchId,
     mergeMode,
    rigidity,
    activeRbmModeIndex,
    solution,
    activeField,
    deformScale,
    excludeSingularities,
    oscillateDeformed,
    colormapId,
  ])

  const handleRunSolve = useCallback(() => {
    const st = useFeaStore.getState()
    if (!st.welded || !st.preflight?.passed) return
    st.setBusy(true, 'Starting FEA solve pipeline...')
    void runFeaSolvePipeline(
      {
        welded: st.welded,
        material: st.getEffectiveMaterial(),
        bcs: st.boundaryConditions,
        meshSettings: st.meshSettings,
      },
      (stage) => useFeaStore.getState().setBusy(true, stage),
    )
      .then(({ rigidity: rig, solution: sol }) => {
        useFeaStore.getState().setSolutionOutput(rig, sol)
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('was restarted')) {
          useFeaStore.getState().setError(msg)
        }
      })
  }, [])

  if (!isFeaWorkspace) {
    return {
      canSave: boundaryConditions.length > 0,
    }
  }

  const material = getEffectiveMaterial()
  const scale = solution
    ? computeFieldScaleForFea(solution, activeField, excludeSingularities)
    : null

  const marks: LegendMark[] = []
  if (solution && activeField === 'vonMises' && material.yieldStrengthMPa) {
    marks.push({
      value: material.yieldStrengthMPa,
      label: 'σ_y',
      title: `Yield strength (${material.yieldStrengthMPa} MPa)`,
    })
  } else if (solution && activeField === 'safetyFactor') {
    marks.push({
      value: 1.0,
      label: 'FoS=1',
      title: 'Safety factor limit (1.0)',
    })
  }

  const stats: LegendStat[] | null = solution
    ? [
        {
          label: 'Peak σ_vM',
          value: `${(excludeSingularities ? solution.metrics.maxVonMisesMaskedMPa : solution.metrics.maxVonMisesRawMPa).toFixed(1)} MPa`,
        },
        {
          label: 'Min FoS',
          value: (excludeSingularities
            ? solution.metrics.minSafetyFactorMasked
            : solution.metrics.minSafetyFactorRaw
          ).toFixed(2),
        },
        {
          label: 'Max |u|',
          value: len.fmt(solution.metrics.maxDisplacementMm, 3),
        },
        {
          label: 'ZZ Error η',
          value: `${solution.metrics.etaZzPercent.toFixed(1)}%`,
        },
      ]
    : null

  const overlay = solution && scale ? (
    <>
      <MapLegend
        id="fea"
        scale={scale}
        kind={activeField === 'displacement' ? 'length' : undefined}
        unit={fieldUnitText(activeField)}
        format={(v) =>
          activeField === 'displacement'
            ? len.fmt(v, 3, { bare: true })
            : v.toFixed(2)
        }
        histogram={null}
        stats={stats}
        showHistogram={false}
        marks={marks}
      />
      {hoveredReadout && (
        <div className="fea-hover-pill" data-test="fea-hover-readout">
          <span>{hoveredReadout.label}:</span>
          <b>
            {hoveredReadout.unit === 'len'
              ? len.fmt(hoveredReadout.value, 4)
              : hoveredReadout.unit === 'MPa'
                ? `${hoveredReadout.value.toFixed(2)} MPa`
                : hoveredReadout.unit === 'pct'
                  ? `${hoveredReadout.value.toFixed(2)}%`
                  : hoveredReadout.value.toFixed(2)}
          </b>
          {hoveredReadout.singular && (
            <span className="fea-badge warn">2h_e Singularity Zone</span>
          )}
        </div>
      )}
    </>
  ) : null

  return {
    panel: <FeaPanel onRunSolve={handleRunSolve} />,
    overlay,
    startPane: solids.length > 0 || Boolean(welded) ? null : {
      title: 'Structural FEA',
      blurb: 'Open a watertight 3D mesh (STL, 3MF, PLY), build a CAD solid in Reverse Engineer, or load the built-in 3D Cantilever Bar benchmark below to run 3D linear elastostatic finite element analysis.',
      skip: {
        label: 'Load 3D Cantilever Bar Benchmark →',
        title: 'Load a 100×10×10 bar with one end fixed and a 1,000 N tip force',
        onClick: () => void loadFeaBenchmarkPreset('cantilever_bending'),
      },
    },
    hideScan: Boolean(welded),
    canSave: boundaryConditions.length > 0,
  }
}

function fieldUnitText(field: FeaFieldKind): string {
  switch (field) {
    case 'vonMises':
    case 'sigma1':
    case 'sigma3':
      return 'MPa'
    case 'displacement':
      return '|u|'
    case 'safetyFactor':
      return 'FoS'
    case 'etaZz':
      return '% η_ZZ'
  }
}

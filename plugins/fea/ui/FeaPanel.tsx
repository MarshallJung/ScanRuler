// SPDX-License-Identifier: AGPL-3.0-only

import './fea.css'
import { offeredSolids, useSolids } from '../../../src/app/solids'
import { useLength } from '../../../src/app/useUnits'
import { loadFeaBenchmarkPreset } from '../core/demoSolids'
import { CURATED_MATERIALS } from '../core/materials'
import type { BoundaryCondition, FeaFieldKind, FeaMeshPreset } from '../core/types'
import { useFeaStore } from '../state/feaStore'
import { stopFeaWorker } from '../worker/feaClient'
import { BcEditorModal } from './BcEditorModal'
import { FeaTrustBanner } from './FeaTrustBanner'

export function FeaPanel({
  onRunSolve,
}: {
  onRunSolve: () => void
}) {
  const len = useLength()
  const bySource = useSolids((s) => s.bySource)
  const solids = offeredSolids(bySource)
  const sourceKey = useFeaStore((s) => s.sourceKey)
  const materialId = useFeaStore((s) => s.materialId)
  const customMaterial = useFeaStore((s) => s.customMaterial)
  const getEffectiveMaterial = useFeaStore((s) => s.getEffectiveMaterial)
  const boundaryConditions = useFeaStore((s) => s.boundaryConditions)
  const mergedPairs = useFeaStore((s) => s.mergedPairs)
  const meshSettings = useFeaStore((s) => s.meshSettings)
  const activeField = useFeaStore((s) => s.activeField)
  const deformScale = useFeaStore((s) => s.deformScale)
  const excludeSingularities = useFeaStore((s) => s.excludeSingularities)
  const selectedPatchId = useFeaStore((s) => s.selectedPatchId)
  const mergeMode = useFeaStore((s) => s.mergeMode)
  const welded = useFeaStore((s) => s.welded)
  const preflight = useFeaStore((s) => s.preflight)
  const rigidity = useFeaStore((s) => s.rigidity)
  const solution = useFeaStore((s) => s.solution)
  const busy = useFeaStore((s) => s.busy)
  const progressStage = useFeaStore((s) => s.progressStage)
  const error = useFeaStore((s) => s.error)
  const activeRbmModeIndex = useFeaStore((s) => s.activeRbmModeIndex)
  const oscillateDeformed = useFeaStore((s) => s.oscillateDeformed)

  const setSourceKey = useFeaStore((s) => s.setSourceKey)
  const setMaterialId = useFeaStore((s) => s.setMaterialId)
  const setSelectedPatchId = useFeaStore((s) => s.setSelectedPatchId)
  const setMergeMode = useFeaStore((s) => s.setMergeMode)
  const clearMergedPatches = useFeaStore((s) => s.clearMergedPatches)
  const addBoundaryCondition = useFeaStore((s) => s.addBoundaryCondition)
  const removeBoundaryCondition = useFeaStore((s) => s.removeBoundaryCondition)
  const clearBoundaryConditions = useFeaStore((s) => s.clearBoundaryConditions)
  const setMeshPreset = useFeaStore((s) => s.setMeshPreset)
  const setTargetEdgeMm = useFeaStore((s) => s.setTargetEdgeMm)
  const setActiveField = useFeaStore((s) => s.setActiveField)
  const setDeformScale = useFeaStore((s) => s.setDeformScale)
  const setExcludeSingularities = useFeaStore((s) => s.setExcludeSingularities)
  const setActiveRbmModeIndex = useFeaStore((s) => s.setActiveRbmModeIndex)
  const setOscillateDeformed = useFeaStore((s) => s.setOscillateDeformed)
  const setBusy = useFeaStore((s) => s.setBusy)

  const material = customMaterial ?? getEffectiveMaterial()
  const selectedPatch = welded?.patches.find((p) => p.id === selectedPatchId) ?? null
  const canSolve = Boolean(welded && preflight?.passed && rigidity?.passed && !busy)

  const handleStopSolve = () => {
    stopFeaWorker()
    setBusy(false, null)
  }

  return (
    <div className="fea-panel" data-test="fea-panel">
      {/* Stage 1: Body & Pre-Flight (Gates 1-2) */}
      <section className="fea-stage" data-test="fea-stage-preflight">
        <div className="fea-stage-header">
          <span>1. Body &amp; Pre-Flight</span>
          {preflight && (
            <span
              className={`fea-badge ${preflight.passed ? 'ok' : 'err'}`}
              data-test="fea-preflight-badge"
            >
              {preflight.passed ? 'Watertight' : 'Failed'}
            </span>
          )}
        </div>

        <div className="fea-row">
          <label htmlFor="fea-solid-select">Solid Body</label>
          <select
            id="fea-solid-select"
            data-test="fea-solid-select"
            value={sourceKey ?? ''}
            onChange={(e) => setSourceKey(e.target.value || null)}
          >
            <option value="">Select solid body...</option>
            {solids.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name} ({s.source})
              </option>
            ))}
          </select>
        </div>

        <div className="fea-row">
          <button
            type="button"
            data-test="fea-preset-cantilever"
            title="Load a 100×10×10 bar with -X fixed and a 1,000 N downward tip load on +X"
            onClick={() => void loadFeaBenchmarkPreset('cantilever_bending')}
          >
            Demo: Cantilever Bar
          </button>
          <button
            type="button"
            data-test="fea-preset-tension"
            title="Load a 100×10×10 bar with -X fixed and a 10,000 N axial tension load on +X"
            onClick={() => void loadFeaBenchmarkPreset('axial_tension')}
          >
            Demo: Axial Tension Bar
          </button>
        </div>

        {preflight && (
          <div className="fea-trust-grid" data-test="fea-preflight-stats">
            <div className="fea-stat-pair">
              <span>Volume</span>
              <b>{len.vol(preflight.signedVolumeMm3, 1)}</b>
            </div>
            <div className="fea-stat-pair">
              <span>Area</span>
              <b>{len.area(preflight.surfaceAreaMm2, 1)}</b>
            </div>
            <div className="fea-stat-pair">
              <span>Patches</span>
              <b>{welded?.patches.length ?? 0}</b>
            </div>
            <div className="fea-stat-pair">
              <span>Min Wall</span>
              <b>{len.fmt(preflight.minWallThicknessMm, 2)}</b>
            </div>
          </div>
        )}

        {preflight?.blockingErrors.map((err, i) => (
          <div key={i} className="fea-alert err" data-test="fea-preflight-error">
            {err}
          </div>
        ))}
        {preflight?.warnings.map((warn, i) => (
          <div key={i} className="fea-alert warn" data-test="fea-preflight-warning">
            {warn}
          </div>
        ))}
      </section>

      {/* Stage 2: Material & Boundary Conditions (Gates 3-4) */}
      <section className="fea-stage" data-test="fea-stage-bcs">
        <div className="fea-stage-header">
          <span>2. Material &amp; Loads</span>
          {rigidity && (
            <span
              className={`fea-badge ${rigidity.passed ? 'ok' : 'err'}`}
              data-test="fea-rigidity-badge"
            >
              {rigidity.passed ? `Restrained (6/6)` : `Rank ${rigidity.rank}/6`}
            </span>
          )}
        </div>

        <div className="fea-row">
          <label htmlFor="fea-material-select">Material</label>
          <select
            id="fea-material-select"
            data-test="fea-material-select"
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
          >
            {CURATED_MATERIALS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div className="fea-trust-grid">
          <div className="fea-stat-pair">
            <span>Young&apos;s E</span>
            <b>{(material.youngsModulusMPa / 1000).toFixed(1)} GPa</b>
          </div>
          <div className="fea-stat-pair">
            <span>Poisson ν</span>
            <b>{material.poissonsRatio.toFixed(2)}</b>
          </div>
          <div className="fea-stat-pair">
            <span>Model</span>
            <b>{material.failureCriterion === 'ductile' ? 'von Mises' : 'Mohr-Coulomb'}</b>
          </div>
          <div className="fea-stat-pair">
            <span>Limit</span>
            <b>
              {material.failureCriterion === 'ductile'
                ? `${material.yieldStrengthMPa ?? 0} MPa`
                : `${material.ultimateTensileMPa ?? 0}/${material.ultimateCompressiveMPa ?? 0} MPa`}
            </b>
          </div>
        </div>

        {welded && (
          <div className="fea-row">
            <label htmlFor="fea-patch-select">Target Patch</label>
            <select
              id="fea-patch-select"
              data-test="fea-patch-select"
              value={selectedPatchId ?? ''}
              onChange={(e) =>
                setSelectedPatchId(e.target.value === '' ? null : Number(e.target.value))
              }
            >
              <option value="">Click face or select patch...</option>
              {welded.patches.map((p) => (
                <option key={p.id} value={p.id}>
                  Patch #{p.id} ({p.kind}, {len.area(p.area, 1)})
                </option>
              ))}
            </select>
          </div>
        )}

        {welded && selectedPatchId !== null && (
          <div className="fea-row">
            <button
              type="button"
              data-test="fea-merge-patch-btn"
              onClick={() => setMergeMode(!mergeMode)}
            >
              {mergeMode ? 'Click 2nd Patch in 3D...' : 'Merge with Adjacent Patch'}
            </button>
            {mergedPairs.length > 0 && (
              <button type="button" onClick={clearMergedPatches}>
                Reset Merges ({mergedPairs.length})
              </button>
            )}
          </div>
        )}

        {selectedPatch && (
          <BcEditorModal
            patch={selectedPatch}
            onSave={(bc) => {
              addBoundaryCondition(bc)
              setSelectedPatchId(null)
            }}
            onCancel={() => setSelectedPatchId(null)}
          />
        )}

        {boundaryConditions.length > 0 && (
          <div className="fea-bc-list" data-test="fea-bc-list">
            {boundaryConditions.map((bc) => (
              <div key={bc.id} className="fea-bc-item" data-test="fea-bc-item">
                <span>{formatBcSummary(bc)}</span>
                <button
                  type="button"
                  data-test={`fea-bc-remove-${bc.id}`}
                  onClick={() => removeBoundaryCondition(bc.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="fea-row">
              <button
                type="button"
                data-test="fea-bc-clear"
                onClick={() => clearBoundaryConditions()}
              >
                Clear All Conditions
              </button>
            </div>
          </div>
        )}

        {rigidity && !rigidity.passed && (
          <>
            {rigidity.blockingErrors.map((err, i) => (
              <div key={i} className="fea-alert err" data-test="fea-rigidity-error">
                {err}
              </div>
            ))}
            {rigidity.freeModes.length > 0 && (
              <div className="fea-row">
                <button
                  type="button"
                  data-test="fea-animate-rbm-btn"
                  onClick={() =>
                    setActiveRbmModeIndex(activeRbmModeIndex === null ? 0 : null)
                  }
                >
                  {activeRbmModeIndex !== null
                    ? 'Stop Free Mode Preview'
                    : `Animate Unconstrained Mode (1/${rigidity.freeModes.length})`}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Stage 3: Mesh & Solve (Gates 5-6) */}
      <section className="fea-stage" data-test="fea-stage-solve">
        <div className="fea-stage-header">
          <span>3. Mesh &amp; Solve (Tet10)</span>
          {solution && (
            <span className="fea-badge ok" data-test="fea-mesh-badge">
              {solution.mesh.tet10.length / 10} Tet10 / η_K{' '}
              {solution.mesh.minKnuppQuality.toFixed(2)}
            </span>
          )}
        </div>

        <div className="fea-row">
          <label htmlFor="fea-mesh-preset">Mesh Density</label>
          <select
            id="fea-mesh-preset"
            data-test="fea-mesh-preset"
            value={meshSettings.preset}
            onChange={(e) => setMeshPreset(e.target.value as FeaMeshPreset)}
          >
            <option value="coarse">Coarse (Fast Preview)</option>
            <option value="medium">Medium (Balanced)</option>
            <option value="fine">Fine (High Accuracy)</option>
          </select>
        </div>

        <div className="fea-row">
          <label htmlFor="fea-target-edge">Target Edge (0 = Auto, {len.word(1)})</label>
          <input
            id="fea-target-edge"
            data-test="fea-target-edge"
            type="number"
            step="any"
            min={0}
            value={meshSettings.targetEdgeMm}
            onChange={(e) => setTargetEdgeMm(Number(e.target.value))}
          />
        </div>

        <div className="fea-row">
          {!busy ? (
            <button
              type="button"
              className="primary"
              data-test="fea-solve-btn"
              disabled={!canSolve}
              onClick={onRunSolve}
            >
              Solve Linear Elastostatics
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              data-test="fea-stop-btn"
              onClick={handleStopSolve}
            >
              Stop Solver
            </button>
          )}
        </div>

        {busy && progressStage && (
          <div className="fea-alert warn" data-test="fea-progress-stage">
            {progressStage}
          </div>
        )}

        {error && (
          <div className="fea-alert err" data-test="fea-solve-error">
            {error}
          </div>
        )}
      </section>

      {/* Stage 4: Results & Safety Check (Gate 7) */}
      {solution && (
        <section className="fea-stage" data-test="fea-stage-results">
          <div className="fea-stage-header">
            <span>4. Results &amp; Safety Check</span>
          </div>

          <div className="fea-row">
            <label htmlFor="fea-field-select">Contour Field</label>
            <select
              id="fea-field-select"
              data-test="fea-field-select"
              value={activeField}
              onChange={(e) => setActiveField(e.target.value as FeaFieldKind)}
            >
              <option value="vonMises">von Mises Stress (MPa)</option>
              <option value="safetyFactor">Safety Factor (FoS)</option>
              <option value="displacement">Displacement Magnitude ({len.word(1)})</option>
              <option value="sigma1">Max Principal Stress σ₁ (MPa)</option>
              <option value="sigma3">Min Principal Stress σ₃ (MPa)</option>
              <option value="etaZz">Discretization Error η_ZZ (%)</option>
            </select>
          </div>

          <div className="fea-row">
            <label htmlFor="fea-deform-scale">Deformation Scale ({deformScale}×)</label>
            <input
              id="fea-deform-scale"
              data-test="fea-deform-scale"
              type="range"
              min={0}
              max={100}
              step={1}
              value={deformScale}
              onChange={(e) => setDeformScale(Number(e.target.value))}
            />
          </div>

          <div className="fea-row">
            <label>
              <input
                type="checkbox"
                data-test="fea-oscillate-toggle"
                checked={oscillateDeformed}
                onChange={(e) => setOscillateDeformed(e.target.checked)}
              />{' '}
              Animate Deformed Shape
            </label>
          </div>

          <FeaTrustBanner
            metrics={solution.metrics}
            excludeSingularities={excludeSingularities}
            onToggleExcludeSingularities={setExcludeSingularities}
          />
        </section>
      )}
    </div>
  )
}

function formatBcSummary(bc: BoundaryCondition): string {
  switch (bc.type) {
    case 'dirichlet':
      return `Patch #${bc.patchId}: ${bc.subtype.toUpperCase()}`
    case 'robin':
      return `Patch #${bc.patchId}: Robin (k=${bc.stiffnessNPerMm3})`
    case 'pressure':
      return `Patch #${bc.patchId}: Pressure (${bc.pressureMPa} MPa)`
    case 'traction': {
      const f = bc.totalForceN ?? bc.tractionMPa ?? [0, 0, 0]
      return `Patch #${bc.patchId}: Load (${f[0]}, ${f[1]}, ${f[2]})`
    }
    case 'rbe3':
      return `Patch #${bc.patchId}: RBE3 Remote Load`
  }
}

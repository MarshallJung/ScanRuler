// SPDX-License-Identifier: AGPL-3.0-only

import { useLength } from '../../../src/app/useUnits'
import type { FeaMetrics } from '../core/types'

export function FeaTrustBanner({
  metrics,
  excludeSingularities,
  onToggleExcludeSingularities,
}: {
  metrics: FeaMetrics
  excludeSingularities: boolean
  onToggleExcludeSingularities: (exclude: boolean) => void
}) {
  const len = useLength()
  const etaBadgeClass =
    metrics.etaZzPercent < 5 ? 'ok' : metrics.etaZzPercent <= 15 ? 'warn' : 'err'
  const eqBadgeClass = metrics.equilibrium.passed ? 'ok' : 'err'
  const linPassed = metrics.smallStrainValid && metrics.smallRotationValid

  const shownVonMises = excludeSingularities
    ? metrics.maxVonMisesMaskedMPa
    : metrics.maxVonMisesRawMPa
  const shownFos = excludeSingularities
    ? metrics.minSafetyFactorMasked
    : metrics.minSafetyFactorRaw

  return (
    <div className="fea-trust-banner" data-test="fea-trust-banner">
      <div className="fea-row">
        <span className={`fea-badge ${etaBadgeClass}`} data-test="fea-eta-badge">
          ZZ Error η: {metrics.etaZzPercent.toFixed(2)}%
        </span>
        <span className={`fea-badge ${eqBadgeClass}`} data-test="fea-eq-badge">
          Equilibrium: {(metrics.equilibrium.forceImbalanceRatio * 100).toFixed(3)}%
        </span>
        <span className={`fea-badge ${linPassed ? 'ok' : 'warn'}`} data-test="fea-lin-badge">
          {linPassed ? 'Linear Valid' : 'Large Defl.'}
        </span>
      </div>

      <div className="fea-trust-grid">
        <div className="fea-stat-pair">
          <span>Max |u|</span>
          <b data-test="fea-max-disp">{len.fmt(metrics.maxDisplacementMm, 4)}</b>
        </div>
        <div className="fea-stat-pair">
          <span>Peak σ_vM</span>
          <b data-test="fea-max-vm">{shownVonMises.toFixed(2)} MPa</b>
        </div>
        <div className="fea-stat-pair">
          <span>Min FoS</span>
          <b data-test="fea-min-fos">{shownFos.toFixed(2)}</b>
        </div>
        <div className="fea-stat-pair">
          <span>DOFs / Time</span>
          <b>
            {metrics.dofCount.toLocaleString()} / {Math.round(metrics.solveTimeMs)} ms
          </b>
        </div>
        <div className="fea-stat-pair">
          <span>PCG Iters</span>
          <b>
            {metrics.solverIterations} ({metrics.solverResidual.toExponential(1)})
          </b>
        </div>
        <div className="fea-stat-pair">
          <span>Max ε / θ</span>
          <b>
            {(metrics.maxStrain * 100).toFixed(2)}% / {metrics.maxRotationDeg.toFixed(2)}°
          </b>
        </div>
      </div>

      {metrics.singularFaceCount > 0 && (
        <div className="fea-row">
          <label>
            <input
              type="checkbox"
              data-test="fea-exclude-singularities"
              checked={excludeSingularities}
              onChange={(e) => onToggleExcludeSingularities(e.target.checked)}
            />{' '}
            Mask 2h_e singular corners ({metrics.singularFaceCount} faces, raw{' '}
            {metrics.maxVonMisesRawMPa.toFixed(1)} MPa)
          </label>
        </div>
      )}

      {!metrics.smallStrainValid && (
        <div className="fea-alert warn">
          Gate 7.1 warning: Peak strain ({(metrics.maxStrain * 100).toFixed(2)}%) exceeds 2%
          small-strain threshold.
        </div>
      )}
      {!metrics.smallRotationValid && (
        <div className="fea-alert warn">
          Gate 7.2 warning: Peak rotation ({metrics.maxRotationDeg.toFixed(2)}°) exceeds 5°
          small-rotation threshold.
        </div>
      )}
      {metrics.etaZzPercent > 15 && (
        <div className="fea-alert warn">
          Gate 7.6 warning: Zienkiewicz-Zhu discretization error ({metrics.etaZzPercent.toFixed(1)}
          %) exceeds 15%. Consider refining the mesh.
        </div>
      )}
    </div>
  )
}

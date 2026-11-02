// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from 'react'
import { useLength } from '../../../src/app/useUnits'
import type { BoundaryCondition, PatchDescriptor } from '../core/types'

export function BcEditorModal({
  patch,
  onSave,
  onCancel,
}: {
  patch: PatchDescriptor
  onSave: (bc: BoundaryCondition) => void
  onCancel: () => void
}) {
  const len = useLength()
  const [bcType, setBcType] = useState<BoundaryCondition['type']>('dirichlet')
  const [dirSubtype, setDirSubtype] = useState<'fixed' | 'sliding_normal' | 'prescribed'>('fixed')

  const [uxEnabled, setUxEnabled] = useState(true)
  const [uyEnabled, setUyEnabled] = useState(true)
  const [uzEnabled, setUzEnabled] = useState(true)
  const [uxVal, setUxVal] = useState(0)
  const [uyVal, setUyVal] = useState(0)
  const [uzVal, setUzVal] = useState(0)

  const [stiffnessVal, setStiffnessVal] = useState(500)
  const [pressureVal, setPressureVal] = useState(10)

  const [fxVal, setFxVal] = useState(0)
  const [fyVal, setFyVal] = useState(-1000)
  const [fzVal, setFzVal] = useState(0)

  const [refX, setRefX] = useState(Number(patch.centroid[0].toFixed(2)))
  const [refY, setRefY] = useState(Number(patch.centroid[1].toFixed(2)))
  const [refZ, setRefZ] = useState(Number(patch.centroid[2].toFixed(2)))
  const [mxVal, setMxVal] = useState(0)
  const [myVal, setMyVal] = useState(0)
  const [mzVal, setMzVal] = useState(0)

  const handleSave = () => {
    const id = `bc-p${patch.id}-${bcType}`
    if (bcType === 'dirichlet') {
      onSave({
        id,
        patchId: patch.id,
        type: 'dirichlet',
        subtype: dirSubtype,
        displacementMm:
          dirSubtype === 'prescribed'
            ? {
                ...(uxEnabled ? { ux: uxVal } : {}),
                ...(uyEnabled ? { uy: uyVal } : {}),
                ...(uzEnabled ? { uz: uzVal } : {}),
              }
            : undefined,
      })
    } else if (bcType === 'robin') {
      onSave({
        id,
        patchId: patch.id,
        type: 'robin',
        stiffnessNPerMm3: Math.max(1e-6, stiffnessVal),
      })
    } else if (bcType === 'pressure') {
      onSave({
        id,
        patchId: patch.id,
        type: 'pressure',
        pressureMPa: pressureVal,
      })
    } else if (bcType === 'traction') {
      onSave({
        id,
        patchId: patch.id,
        type: 'traction',
        totalForceN: [fxVal, fyVal, fzVal],
      })
    } else if (bcType === 'rbe3') {
      onSave({
        id,
        patchId: patch.id,
        type: 'rbe3',
        refPointMm: [refX, refY, refZ],
        forceN: [fxVal, fyVal, fzVal],
        momentNmm: [mxVal, myVal, mzVal],
      })
    }
  }

  return (
    <div className="fea-bc-editor" data-test="fea-bc-editor">
      <div className="fea-stage-header">
        <span>
          Patch #{patch.id} ({patch.kind}, {len.area(patch.area, 1)})
        </span>
      </div>

      <div className="fea-row">
        <label htmlFor="fea-bc-kind">Condition Type</label>
        <select
          id="fea-bc-kind"
          data-test="fea-bc-kind"
          value={bcType}
          onChange={(e) => setBcType(e.target.value as BoundaryCondition['type'])}
        >
          <option value="dirichlet">Restraint (Dirichlet)</option>
          <option value="robin">Elastic Foundation (Robin)</option>
          <option value="pressure">Normal Pressure (MPa)</option>
          <option value="traction">Distributed Force (N)</option>
          <option value="rbe3">Remote Load (RBE3 Coupling)</option>
        </select>
      </div>

      {bcType === 'dirichlet' && (
        <>
          <div className="fea-row">
            <label htmlFor="fea-dir-subtype">Restraint Mode</label>
            <select
              id="fea-dir-subtype"
              data-test="fea-dir-subtype"
              value={dirSubtype}
              onChange={(e) =>
                setDirSubtype(e.target.value as 'fixed' | 'sliding_normal' | 'prescribed')
              }
            >
              <option value="fixed">Fixed (u = 0)</option>
              <option value="sliding_normal">Roller / Symmetry (u·n = 0)</option>
              <option value="prescribed">Prescribed Displacement</option>
            </select>
          </div>
          {dirSubtype === 'prescribed' && (
            <div className="fea-grid-3">
              <label>
                <input
                  type="checkbox"
                  checked={uxEnabled}
                  onChange={(e) => setUxEnabled(e.target.checked)}
                />{' '}
                ux ({len.word(1)})
                <input
                  type="number"
                  step="any"
                  disabled={!uxEnabled}
                  value={uxVal}
                  onChange={(e) => setUxVal(Number(e.target.value))}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={uyEnabled}
                  onChange={(e) => setUyEnabled(e.target.checked)}
                />{' '}
                uy ({len.word(1)})
                <input
                  type="number"
                  step="any"
                  disabled={!uyEnabled}
                  value={uyVal}
                  onChange={(e) => setUyVal(Number(e.target.value))}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={uzEnabled}
                  onChange={(e) => setUzEnabled(e.target.checked)}
                />{' '}
                uz ({len.word(1)})
                <input
                  type="number"
                  step="any"
                  disabled={!uzEnabled}
                  value={uzVal}
                  onChange={(e) => setUzVal(Number(e.target.value))}
                />
              </label>
            </div>
          )}
        </>
      )}

      {bcType === 'robin' && (
        <div className="fea-row">
          <label htmlFor="fea-robin-k">Stiffness k (N/{len.word(3)})</label>
          <input
            id="fea-robin-k"
            data-test="fea-robin-k"
            type="number"
            step="any"
            min={0.001}
            value={stiffnessVal}
            onChange={(e) => setStiffnessVal(Number(e.target.value))}
          />
        </div>
      )}

      {bcType === 'pressure' && (
        <div className="fea-row">
          <label htmlFor="fea-pressure-val">Pressure p (MPa, +inward)</label>
          <input
            id="fea-pressure-val"
            data-test="fea-pressure-val"
            type="number"
            step="any"
            value={pressureVal}
            onChange={(e) => setPressureVal(Number(e.target.value))}
          />
        </div>
      )}

      {(bcType === 'traction' || bcType === 'rbe3') && (
        <div className="fea-grid-3">
          <label>
            Fx (N)
            <input
              data-test="fea-force-x"
              type="number"
              step="any"
              value={fxVal}
              onChange={(e) => setFxVal(Number(e.target.value))}
            />
          </label>
          <label>
            Fy (N)
            <input
              data-test="fea-force-y"
              type="number"
              step="any"
              value={fyVal}
              onChange={(e) => setFyVal(Number(e.target.value))}
            />
          </label>
          <label>
            Fz (N)
            <input
              data-test="fea-force-z"
              type="number"
              step="any"
              value={fzVal}
              onChange={(e) => setFzVal(Number(e.target.value))}
            />
          </label>
        </div>
      )}

      {bcType === 'rbe3' && (
        <>
          <div className="fea-grid-3">
            <label>
              Ref X ({len.word(1)})
              <input
                type="number"
                step="any"
                value={refX}
                onChange={(e) => setRefX(Number(e.target.value))}
              />
            </label>
            <label>
              Ref Y ({len.word(1)})
              <input
                type="number"
                step="any"
                value={refY}
                onChange={(e) => setRefY(Number(e.target.value))}
              />
            </label>
            <label>
              Ref Z ({len.word(1)})
              <input
                type="number"
                step="any"
                value={refZ}
                onChange={(e) => setRefZ(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="fea-grid-3">
            <label>
              Mx (N·{len.word(1)})
              <input
                type="number"
                step="any"
                value={mxVal}
                onChange={(e) => setMxVal(Number(e.target.value))}
              />
            </label>
            <label>
              My (N·{len.word(1)})
              <input
                type="number"
                step="any"
                value={myVal}
                onChange={(e) => setMyVal(Number(e.target.value))}
              />
            </label>
            <label>
              Mz (N·{len.word(1)})
              <input
                type="number"
                step="any"
                value={mzVal}
                onChange={(e) => setMzVal(Number(e.target.value))}
              />
            </label>
          </div>
        </>
      )}

      <div className="fea-row">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" data-test="fea-bc-save" onClick={handleSave}>
          Apply to Patch #{patch.id}
        </button>
      </div>
    </div>
  )
}

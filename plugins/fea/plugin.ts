// SPDX-License-Identifier: AGPL-3.0-only

import { registerProjectSection } from '../../src/app/projectSections'
import {
  type ScanRulerPlugin,
  registerBusy,
  registerCommands,
  registerStateSection,
} from '../../src/plugins/api'
import { pick, registerHistory } from '../../src/state/historyStore'
import { feaCommands } from './app/feaCommands'
import { describeFea } from './app/feaReadout'
import { feaSection } from './app/projectSection'
import { useFeaPlugin } from './app/useFeaPlugin'
import { FEA_HISTORY_KEYS, useFeaStore } from './state/feaStore'
import './ui/fea.css'

const plugin: ScanRulerPlugin = {
  id: 'fea',
  name: 'Structural FEA',
  workspace: {
    id: 'fea',
    label: 'Structural FEA',
    title:
      'Run 3D linear elastostatic finite element analysis (Tet10, PCG, ZZ-SPR) on watertight CAD or mesh solids',
    icon: 'wsFea',
    order: 40,
  },
  keyboard: {
    keydown(e) {
      const s = useFeaStore.getState()
      if (e.key === 'Escape') {
        if (s.mergeMode) {
          s.setMergeMode(false)
          return true
        }
        if (s.selectedPatchId !== null) {
          s.setSelectedPatchId(null)
          return true
        }
      }
      return false
    },
  },
  usePlugin: useFeaPlugin,
  install() {
    registerProjectSection(feaSection)
    registerCommands('fea', feaCommands)
    registerStateSection('fea', describeFea)
    registerBusy(
      'fea',
      () => (useFeaStore.getState().busy ? 'running finite element analysis' : null),
      [useFeaStore],
    )
    registerHistory({
      sections: [
        {
          key: 'fea',
          capture: () => pick(useFeaStore.getState(), [...FEA_HISTORY_KEYS]),
          apply: (value) => {
            useFeaStore.setState({
              ...(value as Partial<ReturnType<typeof useFeaStore.getState>>),
              solution: null,
            })
          },
        },
      ],
      actions: [
        {
          store: useFeaStore,
          label: 'Structural FEA',
          names: [
            'setSourceKey',
            'setMaterialId',
            'setCustomMaterial',
            'addBoundaryCondition',
            'updateBoundaryCondition',
            'removeBoundaryCondition',
            'clearBoundaryConditions',
            'mergePatchPair',
            'clearMergedPatches',
            'setMeshPreset',
            'setTargetEdgeMm',
            'setActiveField',
            'setDeformScale',
            'setExcludeSingularities',
          ],
        },
      ],
      blocked: () => useFeaStore.getState().busy,
    })
  },
}

export default plugin

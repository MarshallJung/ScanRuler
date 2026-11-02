// SPDX-License-Identifier: AGPL-3.0-only

import { offeredSolids, useSolids } from '../../../src/app/solids'
import { useFeaStore } from '../state/feaStore'

/**
 * Plain JSON readout of the FEA workspace state (`session.state.plugins.fea`)
 * and structured summary returned by `fea.*` MCP commands.
 */
export function describeFea() {
  const s = useFeaStore.getState()
  const solids = offeredSolids(useSolids.getState().bySource)
  const material = s.getEffectiveMaterial()

  return {
    sourceKey: s.sourceKey,
    availableSolids: solids.map((item) => ({
      key: item.key,
      name: item.name,
      source: item.source,
    })),
    material: {
      id: material.id,
      name: material.name,
      youngsModulusMPa: material.youngsModulusMPa,
      poissonsRatio: material.poissonsRatio,
      failureCriterion: material.failureCriterion,
      yieldStrengthMPa: material.yieldStrengthMPa ?? null,
      ultimateTensileMPa: material.ultimateTensileMPa ?? null,
      ultimateCompressiveMPa: material.ultimateCompressiveMPa ?? null,
    },
    patches: s.welded
      ? s.welded.patches.map((p) => ({
          id: p.id,
          kind: p.kind,
          areaMm2: Number(p.area.toFixed(3)),
          centroid: [
            Number(p.centroid[0].toFixed(3)),
            Number(p.centroid[1].toFixed(3)),
            Number(p.centroid[2].toFixed(3)),
          ],
          normal: [
            Number(p.normal[0].toFixed(4)),
            Number(p.normal[1].toFixed(4)),
            Number(p.normal[2].toFixed(4)),
          ],
        }))
      : [],
    mergedPairs: s.mergedPairs,
    boundaryConditions: s.boundaryConditions,
    meshSettings: s.meshSettings,
    activeField: s.activeField,
    deformScale: s.deformScale,
    excludeSingularities: s.excludeSingularities,
    preflight: s.preflight,
    rigidity: s.rigidity
      ? {
          passed: s.rigidity.passed,
          rank: s.rigidity.rank,
          singularValues: s.rigidity.singularValues,
          freeModeCount: s.rigidity.freeModes.length,
          blockingErrors: s.rigidity.blockingErrors,
        }
      : null,
    solution: s.solution
      ? {
          metrics: s.solution.metrics,
          mesh: {
            nodeCount: s.solution.mesh.nodes.length / 3,
            tet10Count: s.solution.mesh.tet10.length / 10,
            tri6Count: s.solution.mesh.tri6.length / 6,
            volumeMm3: s.solution.mesh.totalVolumeMm3,
            volumeDriftRatio: s.solution.mesh.volumeDriftRatio,
            minJacobianDet: s.solution.mesh.minJacobianDet,
            minKnuppQuality: s.solution.mesh.minKnuppQuality,
            meanKnuppQuality: s.solution.mesh.meanKnuppQuality,
            invertedCount: s.solution.mesh.invertedCount,
          },
        }
      : null,
    busy: s.busy,
    error: s.error,
  }
}

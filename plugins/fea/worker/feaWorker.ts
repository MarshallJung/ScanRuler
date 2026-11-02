// SPDX-License-Identifier: AGPL-3.0-only

import { reply } from '../../../src/core/workerRpc'
import {
  type FeaWorkerReq,
  type FeaWorkerRes,
  executePreflightPipeline,
  executeRigidityCheck,
  executeSolvePipeline,
} from './protocol'

self.onmessage = (event: MessageEvent<FeaWorkerReq>) => {
  const msg = event.data
  const { requestId } = msg

  const sendProgress = (stage: string) => {
    const prog: FeaWorkerRes = { requestId, type: 'progress', stage }
    reply(prog)
  }

  try {
    if (msg.type === 'preflight') {
      const result = executePreflightPipeline(msg.payload, sendProgress)
      const res: FeaWorkerRes = { requestId, type: 'preflightResult', result }
      reply(res, [
        result.welded.positions.buffer,
        result.welded.indices.buffer,
        result.welded.trianglePatch.buffer,
      ])
    } else if (msg.type === 'checkRigidity') {
      const result = executeRigidityCheck(msg.payload)
      const res: FeaWorkerRes = { requestId, type: 'rigidityResult', result }
      reply(res)
    } else if (msg.type === 'solvePipeline') {
      const result = executeSolvePipeline(msg.payload, sendProgress)
      const s = result.solution
      const res: FeaWorkerRes = { requestId, type: 'solveResult', result }
      reply(res, [
        s.mesh.nodes.buffer,
        s.mesh.tet10.buffer,
        s.mesh.tri6.buffer,
        s.mesh.tri6Patch.buffer,
        s.mesh.tri6ParentTet.buffer,
        s.displacements.buffer,
        s.reactions.buffer,
        s.vonMises.buffer,
        s.sigma1.buffer,
        s.sigma3.buffer,
        s.safetyFactor.buffer,
        s.nodalEtaZz.buffer,
        s.singularFaceMask.buffer,
      ])
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const res: FeaWorkerRes = { requestId, type: 'error', message }
    reply(res)
  }
}

// SPDX-License-Identifier: AGPL-3.0-only

import { WorkerRpc } from '../../../src/core/workerRpc'
import type { RigidityReport } from '../core/types'
import {
  type FeaPreflightInput,
  type FeaPreflightOutput,
  type FeaRigidityInput,
  type FeaSolveInput,
  type FeaSolveOutput,
  type FeaWorkerReq,
  type FeaWorkerRes,
  executePreflightPipeline,
  executeRigidityCheck,
  executeSolvePipeline,
} from './protocol'

let nextRequestId = 1
let rpcInstance: WorkerRpc | null = null
let progressListeners = new Map<number, (stage: string) => void>()

function getOrCreateRpc(): WorkerRpc | null {
  if (typeof Worker === 'undefined') return null
  if (!rpcInstance) {
    rpcInstance = new WorkerRpc(
      () => new Worker(new URL('./feaWorker.ts', import.meta.url), { type: 'module' }),
      'FEA Worker',
      (data) => {
        const msg = data as FeaWorkerRes
        if (msg && msg.type === 'progress') {
          progressListeners.get(msg.requestId)?.(msg.stage)
          return true
        }
        return false
      },
    )
  } else if (rpcInstance.dead) {
    rpcInstance.restart()
  }
  return rpcInstance
}

/**
 * Immediately terminate any active FEA worker computation (< 50 ms abort)
 * and respawn a clean worker instance.
 */
export function stopFeaWorker(): void {
  progressListeners.clear()
  if (rpcInstance) {
    rpcInstance.restart()
  }
}

export async function runFeaPreflight(
  input: FeaPreflightInput,
  onProgress?: (stage: string) => void,
): Promise<FeaPreflightOutput> {
  const rpc = getOrCreateRpc()
  if (!rpc) {
    return executePreflightPipeline(input, onProgress)
  }
  const requestId = nextRequestId++
  if (onProgress) progressListeners.set(requestId, onProgress)
  try {
    const req: FeaWorkerReq = { requestId, type: 'preflight', payload: input }
    const res = await rpc.request<{ result: FeaPreflightOutput }>(req)
    return res.result
  } finally {
    progressListeners.delete(requestId)
  }
}

export async function runFeaRigidityCheck(
  input: FeaRigidityInput,
): Promise<RigidityReport> {
  const rpc = getOrCreateRpc()
  if (!rpc) {
    return executeRigidityCheck(input)
  }
  const requestId = nextRequestId++
  const req: FeaWorkerReq = { requestId, type: 'checkRigidity', payload: input }
  const res = await rpc.request<{ result: RigidityReport }>(req)
  return res.result
}

export async function runFeaSolvePipeline(
  input: FeaSolveInput,
  onProgress?: (stage: string) => void,
): Promise<FeaSolveOutput> {
  const rpc = getOrCreateRpc()
  if (!rpc) {
    return executeSolvePipeline(input, onProgress)
  }
  const requestId = nextRequestId++
  if (onProgress) progressListeners.set(requestId, onProgress)
  try {
    const req: FeaWorkerReq = { requestId, type: 'solvePipeline', payload: input }
    const res = await rpc.request<{ result: FeaSolveOutput }>(req)
    return res.result
  } finally {
    progressListeners.delete(requestId)
  }
}

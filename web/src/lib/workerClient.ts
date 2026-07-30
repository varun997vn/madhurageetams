/** Main-thread half of the worker RPC. */

import DataWorker from '../worker/data.worker?worker'
import type { RpcReply, WorkerEvent, WorkerMethod, WorkerRequests, WorkerResponses } from '../worker/rpc'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class WorkerClient {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(event: WorkerEvent) => void>()

  constructor() {
    this.worker = new DataWorker()
    this.worker.onmessage = (event: MessageEvent<RpcReply>) => {
      const data = event.data
      if ('event' in data) {
        for (const listener of this.listeners) listener(data.event)
        return
      }
      const entry = this.pending.get(data.rpc)
      if (!entry) return
      this.pending.delete(data.rpc)
      if (data.ok) entry.resolve(data.result)
      else {
        const error = new Error(data.error)
        error.name = data.name
        entry.reject(error)
      }
    }
  }

  on(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  call<M extends WorkerMethod>(method: M, params: WorkerRequests[M]): Promise<WorkerResponses[M]> {
    const rpc = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(rpc, { resolve: resolve as (value: unknown) => void, reject })
      this.worker.postMessage({ rpc, method, params })
    })
  }

  /** Drop the worker entirely, so the key and plaintext are unreachable. */
  terminate(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}

let singleton: WorkerClient | null = null

export function getWorker(): WorkerClient {
  if (!singleton) singleton = new WorkerClient()
  return singleton
}

export function resetWorker(): void {
  singleton?.terminate()
  singleton = null
}

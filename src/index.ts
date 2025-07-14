import type { Axios } from 'axios'
import { PriorityQueue } from '@datastructures-js/priority-queue'

declare module 'axios' {
  interface Axios {
    _queues: Map<string, RequestQueue>
    _counter: number
  }

  interface AxiosRequestConfig {
    priority?: number
  }

  interface InternalAxiosRequestConfig {
    _queueID: number
  }
}

interface Entry {
  id: number
  cb: () => void
  priority?: number
  order: number
}

export interface QueueOptions {
  /**
   * Max number of concurrent requests allowed per host
   * @default 2
   */
  maxConcurrent?: number
  /**
   * The delay between requests per host
   * @default 300
   */
  delayMs?: number
}

/**
 * A managed network request queue
 */
export class RequestQueue {
  active = new Set<number>()
  queue = new PriorityQueue<Entry>((a, b) =>
    a.priority === undefined
      ? b.priority === undefined
        ? a.order - b.order
        : -1
      : b.priority === undefined
        ? 1
        : a.priority - b.priority
  )

  options: Required<QueueOptions>

  /**
   * Construct a request queue
   * @param options               Additional options
   * @param options.maxConcurrent Max concurrent network requests that can be active for a single host
   * @param options.delayMs       Delay between consecutive network requests
   */
  constructor ({ maxConcurrent = 2, delayMs = 300 }: QueueOptions = {}) {
    this.options = {
      maxConcurrent,
      delayMs
    }
  }

  /**
   * Queue a request
   * @param id       The request ID
   * @param priority Its priority
   */
  enqueue (id: number, priority?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.active.size >= this.options.maxConcurrent) {
        this.queue.enqueue({
          id,
          cb: resolve,
          priority,
          order: this.queue.size()
        })
      } else {
        this.active.add(id)
        resolve()
      }
    })
  }

  /**
   * Mark a request as finished
   * @param id The request ID
   */
  finish (id: number): void {
    setTimeout(() => {
      this.active.delete(id)
      if (this.active.size < this.options.maxConcurrent) {
        const entry = this.queue.dequeue()
        if (entry) {
          this.active.add(entry.id)
          entry.cb()
        }
      }
    }, this.options.delayMs)
  }
}

/**
 * Initialize the queue interceptors for Axios
 * @param instance The Axios instance
 * @param options  Additional options
 * @returns        An ejector function. Call to remove queue interceptors from instance. Will immediately run all queued operations
 */
export function setupQueue (instance: Axios, options?: QueueOptions): () => void {
  instance._queues = new Map()
  instance._counter = 0

  const reqInterceptor = instance.interceptors.request.use(async (config) => {
    const url = new URL(config.url ?? 'UNKNOWN', config.baseURL)
    const host = url.host

    let queue = instance._queues.get(host)
    if (!queue) {
      queue = new RequestQueue(options)
      instance._queues.set(host, queue)
    }

    const id = instance._counter++
    config._queueID = id
    await queue.enqueue(id, config.priority)

    return config
  })

  const resInterceptor = instance.interceptors.response.use((response) => {
    const url = new URL(response.config.url ?? 'UNKNOWN', response.config.baseURL)
    const host = url.host

    const queue = instance._queues.get(host)
    if (queue) queue.finish(response.config._queueID)

    return response
  })

  return () => {
    for (const queue of instance._queues.values()) {
      while (!queue.queue.isEmpty()) {
        const entry = queue.queue.dequeue()
        entry?.cb()
      }
    }

    instance.interceptors.request.eject(reqInterceptor)
    instance.interceptors.response.eject(resInterceptor)
  }
}

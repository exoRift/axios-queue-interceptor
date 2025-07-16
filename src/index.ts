import type { Axios, AxiosRequestConfig } from 'axios'
import { PriorityQueue } from '@datastructures-js/priority-queue'

declare module 'axios' {
  interface Axios {
    _queues: Map<string, RequestQueue>
    _counter: number
  }

  interface AxiosRequestConfig {
    /**
     * Queue priority (left blank will use insertion order. Any provided number will take priority over undefined)
     */
    queuePriority?: number

    /**
     * Any override to the configured queue delay time in milliseconds
     */
    queueDelayMs?: number

    /**
     * A grouping identifier \
     * By default, this is the request URL host
     */
    queueGroup?: string
  }

  interface InternalAxiosRequestConfig {
    _queueID: number
  }
}

interface Entry {
  id: number
  cb: () => void
  delayMs: number
  order: number
  priority?: number
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

  /**
   * Override queue options per-request
   * @warn `maxConcurrent` will only act on the first request of a group/host
   * @param config The request config
   * @returns      The queue config
   */
  onRequest?: (config: AxiosRequestConfig) => Omit<QueueOptions, 'onRequest' | 'debug'>

  /**
   * Log queue activity
   */
  debug?: boolean
}

/**
 * A managed network request queue
 */
export class RequestQueue {
  name: string
  active = new Map<number, number>()
  queue = new PriorityQueue<Entry>((a, b) =>
    a.priority === undefined
      ? b.priority === undefined
        ? a.order - b.order
        : -1
      : b.priority === undefined
        ? 1
        : a.priority - b.priority
  )

  debug: boolean
  maxConcurrent: number

  /**
   * Construct a request queue
   * @param name          The name of the queue for debug logging
   * @param maxConcurrent Max concurrent network requests that can be active for a single host
   * @param debug         Log queue activity
   */
  constructor (name: string, maxConcurrent = 2, debug = false) {
    this.maxConcurrent = maxConcurrent
    this.debug = debug
    this.name = name
  }

  /**
   * Queue a request
   * @param id       The request ID
   * @param delayMs  An override to the delay set in the constructor
   * @param priority Its priority
   */
  enqueue (id: number, delayMs = 300, priority?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.active.size >= this.maxConcurrent) {
        // eslint-disable-next-line no-console
        if (this.debug) console.debug(`AQI [${this.name}]: Too many concurrent; Enqueuing ${id} with priority ${priority ?? 'null'}`)

        this.queue.enqueue({
          id,
          cb: resolve,
          priority,
          order: this.queue.size(),
          delayMs
        })
      } else {
        // eslint-disable-next-line no-console
        if (this.debug) console.debug(`AQI [${this.name}]: Slot available; Skipping queue and running ${id}`)

        this.active.set(id, delayMs)
        resolve()
      }
    })
  }

  /**
   * Mark a request as finished
   * @param id The request ID
   */
  finish (id: number): void {
    const delayMs = this.active.get(id)
    // eslint-disable-next-line no-console
    if (this.debug) console.debug(`AQI [${this.name}]: Request ${id} finished; cooldown ${delayMs ?? 'UNKNOWN'}ms`)
    setTimeout(() => {
      this.active.delete(id)
      if (this.active.size < this.maxConcurrent) {
        const entry = this.queue.dequeue()
        if (entry) {
          // eslint-disable-next-line no-console
          if (this.debug) console.debug(`AQI [${this.name}]: Request ${id} pre-empting ${entry.id} with priority ${entry.priority ?? 'null'}`)

          this.active.set(entry.id, entry.delayMs)
          entry.cb()
        }
      }
    }, delayMs)
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
    const group = config.queueGroup || new URL(config.url ?? 'UNKNOWN', config.baseURL).host

    const reqOptions = options?.onRequest?.(config) ?? options

    let queue = instance._queues.get(group)
    if (!queue) {
      queue = new RequestQueue(group, reqOptions?.maxConcurrent, options?.debug)
      instance._queues.set(group, queue)
    }

    const id = instance._counter++
    config._queueID = id
    await queue.enqueue(id, config.queueDelayMs ?? reqOptions?.delayMs, config.queuePriority)

    return config
  })

  const resInterceptor = instance.interceptors.response.use(
    (response) => {
      const group = response.config.queueGroup || new URL(response.config.url ?? 'UNKNOWN', response.config.baseURL).host

      const queue = instance._queues.get(group)
      if (queue) queue.finish(response.config._queueID)

      return response
    },
    (err) => {
      const url = new URL(err.config.url ?? 'UNKNOWN', err.config.baseURL)
      const host = url.host

      const queue = instance._queues.get(host)
      if (queue) queue.finish(err.config._queueID)

      return Promise.reject(err)
    }
  )

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

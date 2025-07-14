import { test, expect } from 'bun:test'
import { styleText } from 'util'

import axios from 'axios'
import { setupQueue } from '../src/index'

test('basic queue', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => new Response(req.params.id)
    }
  })
  const address = `http://localhost:${server.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, {
    delayMs: 100,
    maxConcurrent: 1
  })

  const ids = Array.from({ length: 10 }, () => Math.round(Math.random() * 100))
  const responses: number[] = []
  const promises = []

  const start = performance.now()
  for (const id of ids) {
    promises.push(fetcher.get(address + '/' + id)
      .then((res) => responses.push(res.data)))
  }

  await Promise.all(promises)
  const elapsed = performance.now() - start
  expect(elapsed, 'interval').toBeWithin(100 * 9, 100 * 10)

  expect(responses, 'order matches').toEqual(ids)

  await server.stop()
  eject()
})

test('multiple concurrent', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => Bun.sleep(Math.random() * 100).then<Response>(() => new Response(req.params.id))
    }
  })
  const address = `http://localhost:${server.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, {
    maxConcurrent: 4
  })

  // Preload queue
  await fetcher.get(address + '/' + '0')

  const ids = Array.from({ length: 10 }, () => Math.round(Math.random() * 100))
  const responses: number[] = []
  const promises = []

  let maxActive = 0
  const queue = fetcher._queues.get(address.replace('http://', ''))
  const original = queue!.active.delete.bind(queue!.active)
  queue!.active.delete = function spy (v) {
    maxActive = Math.max(maxActive, queue!.active.size)
    return original(v)
  }

  for (const id of ids) {
    promises.push(fetcher.get(address + '/' + id)
      .then((res) => responses.push(res.data)))
  }

  await Promise.all(promises)

  expect(fetcher._queues.keys().toArray(), 'not unknown').not.toEqual(['UNKNOWN'])
  expect(responses, 'all successful').toContainAllValues(ids)
  expect(maxActive, 'max active').toBe(4)

  await server.stop()
  eject()
})

test('separate hosts', async () => {
  const server1 = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => Bun.sleep(Math.random() * 100).then<Response>(() => new Response(req.params.id))
    }
  })
  const address1 = `http://0.0.0.0:${server1.port}`

  const server2 = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => Bun.sleep(Math.random() * 100).then<Response>(() => new Response(req.params.id))
    }
  })
  const address2 = `http://localhost:${server2.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, { maxConcurrent: 1 })

  const ids = Array.from({ length: 20 }, (v, k) => k)

  const responses: number[] = []
  const promises = []

  for (const id of ids) {
    promises.push(fetcher.get((id & 1 ? address2 : address1) + '/' + id)
      .then((res) => responses.push(res.data)))
  }

  await Promise.all(promises)

  expect(responses, 'all successful').toContainAllValues(ids)
  expect(responses.filter((v) => v & 1).every((v, i, a) => i === a.length - 1 || v < a[i + 1]!), 'odd is in order')
  expect(responses.filter((v) => !(v & 1)).every((v, i, a) => i === a.length - 1 || v < a[i + 1]!), 'even is in order')
  expect(fetcher._queues.size, '2 queues').toBe(2)
  if (responses.every((v, i, a) => i === a.length - 1 || v < a[i + 1]!)) console.warn(styleText('yellow', 'All responses are in order'))

  await server1.stop()
  await server2.stop()
  eject()
})

test('premature ejection', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => new Response(req.params.id)
    }
  })
  const address = `http://localhost:${server.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, { maxConcurrent: 1, delayMs: 1000 })

  // Preload queue
  await fetcher.get(address + '/' + '0')

  const ids = Array.from({ length: 3 }, () => Math.round(Math.random() * 100))
  const responses: number[] = []
  const promises = []

  for (const id of ids) {
    promises.push(fetcher.get(address + '/' + id)
      .then((res) => responses.push(res.data)))
  }

  await Bun.sleep(1000)
  eject()

  await Promise.all(promises)

  expect(responses, 'all successful').toContainAllValues(ids)

  await server.stop()
})

test('failure', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => new Response(req.params.id, { status: 500 })
    }
  })
  const address = `http://localhost:${server.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, {
    delayMs: 100,
    maxConcurrent: 1
  })

  const ids = Array.from({ length: 10 }, () => Math.round(Math.random() * 100))
  const promises = []

  for (const id of ids) {
    promises.push(fetcher.get(address + '/' + id)
      .catch(() => {}))
  }
  await Promise.all(promises)

  expect(true, 'reached').toBeTrue()
  await server.stop()
  eject()
})

test('priority', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => new Response(req.params.id)
    }
  })
  const address = `http://localhost:${server.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, {
    delayMs: 500,
    maxConcurrent: 1
  })

  const ids = Array.from({ length: 4 }, (v, k) => k)
  const responses: number[] = []
  const promises = []

  for (const id of ids) {
    promises.push(fetcher.get(address + '/' + id, { queuePriority: 4 - id })
      .then((res) => responses.push(res.data)))
  }

  await Promise.all(promises)

  expect(responses, 'order matches').toEqual([0, 3, 2, 1])

  await server.stop()
  eject()
})

test('overrides', async () => {
  const server = Bun.serve({
    port: 0,
    routes: {
      '/:id': (req) => new Response(req.params.id)
    }
  })
  const address = `http://localhost:${server.port}`

  const fetcher = axios.create()
  const eject = setupQueue(fetcher, {
    delayMs: 500,
    maxConcurrent: 1
  })

  const ids = Array.from({ length: 10 }, (v, k) => k)
  const responses: number[] = []
  const promises = []

  const start = performance.now()
  for (const id of ids) {
    promises.push(fetcher.get(address + '/' + id, { queueDelayMs: 100 })
      .then((res) => responses.push(res.data)))
  }

  await Promise.all(promises)
  const elapsed = performance.now() - start
  expect(elapsed, 'interval').toBeWithin(100 * 9, 100 * 10)

  expect(responses, 'order matches').toEqual(ids)

  await server.stop()
  eject()
})

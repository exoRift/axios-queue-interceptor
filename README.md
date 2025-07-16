# Axios Queue Interceptor
### The solution that prevents ratelimiting and pain.

Prevent your application from incurring 429s by queuing your requests to your APIs.

This package maintains a separate queue for each host encountered.

## Usage
```ts
import axios from 'axios'
import { setupQueue } from 'axios-cache-interceptor'

const instance = axios.create()
const eject = setupQueue(instance, {
  // Max number of requests that can run simultaneously per-host
  maxConcurrent: 4,
  // Delay between requests per-host (how long the queue will wait after this request before freeing the slot)
  delayMs: 300,

  // Runs on every request to determine per-request config (optional)
  onRequest: (config) => ({ delayMs: config.url.contains('foo') ? 1000 : undefined }),

  debug: false
})

// ...

eject()
```

## Config Options
```ts
// Queue priority (left blank will use insertion order. Any provided number will take priority over undefined)
axios.get(URL, { queuePriority: 4 })

// An override to delayMs (how long the queue will wait after this request before freeing the slot)
axios.get(URL, { queueDelayMs: 300 })
```

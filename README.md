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
  maxConcurrent: 4,
  delayMs: 300
})

// ...

eject()
```

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ToolRegistry } from '../registry/tool-registry.js'
import { ExecutorPool } from './executor-pool.js'
import { registerFunctionHandler, clearFunctionHandlers } from './function-executor.js'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// ── Helper: tiny HTTP server for real HTTP tests ────────────────────────────

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const url = `http://127.0.0.1:${addr.port}`
      resolve({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ExecutorPool', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
    clearFunctionHandlers()
  })

  afterEach(() => {
    clearFunctionHandlers()
  })

  // ── Function Executor ─────────────────────────────────────────────────

  describe('FunctionExecutor', () => {
    it('executes a sync function', async () => {
      registry.register({
        tool_id: 'add',
        executor: { type: 'ts_fn' },
        execution_mode: 'sync',
      })
      registerFunctionHandler('add', (input) => {
        const { a, b } = input as { a: number; b: number }
        return a + b
      })

      const pool = new ExecutorPool(registry)
      const result = await pool.execute('add', 'call_1', { a: 3, b: 4 })

      expect(result.status).toBe('completed')
      expect(result.result).toBe(7)
      expect(result.tool_id).toBe('add')
      expect(result.tool_call_id).toBe('call_1')
      expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    })

    it('executes an async function', async () => {
      registry.register({
        tool_id: 'async_calc',
        executor: { type: 'ts_fn' },
        execution_mode: 'async',
      })
      registerFunctionHandler('async_calc', async (input) => {
        await new Promise((r) => setTimeout(r, 10))
        return (input as { x: number }).x * 2
      })

      const pool = new ExecutorPool(registry)
      const result = await pool.execute('async_calc', 'call_2', { x: 5 })

      expect(result.status).toBe('completed')
      expect(result.result).toBe(10)
    })

    it('returns failed status when function throws', async () => {
      registry.register({
        tool_id: 'failing_fn',
        executor: { type: 'ts_fn' },
      })
      registerFunctionHandler('failing_fn', () => {
        throw new Error('Something broke')
      })

      const pool = new ExecutorPool(registry)
      const result = await pool.execute('failing_fn', 'call_3', {})

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Something broke')
    })
  })

  // ── HTTP Executor ─────────────────────────────────────────────────────

  describe('HttpExecutor', () => {
    it('executes a successful POST request', async () => {
      const server = await createTestServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const parsed = JSON.parse(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ result: parsed.query + '_found' }))
        })
      })

      try {
        registry.register({
          tool_id: 'http_search',
          executor: { type: 'http', url: `${server.url}/search`, method: 'POST' },
        })

        const pool = new ExecutorPool(registry)
        const result = await pool.execute('http_search', 'call_http_1', { query: 'nike' })

        expect(result.status).toBe('completed')
        expect(result.result).toEqual({ result: 'nike_found' })
      } finally {
        await server.close()
      }
    })

    it('fails with HttpExecutorError on 500', async () => {
      const server = await createTestServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      })

      try {
        registry.register({
          tool_id: 'http_fail',
          executor: { type: 'http', url: `${server.url}/fail`, method: 'POST' },
        })

        const pool = new ExecutorPool(registry)
        const result = await pool.execute('http_fail', 'call_http_2', {})

        expect(result.status).toBe('failed')
        expect(result.error).toContain('500')
      } finally {
        await server.close()
      }
    })

    it('handles timeout via AbortController', async () => {
      const server = await createTestServer((_req, res) => {
        // Intentionally slow — takes 5 seconds
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        }, 5000)
      })

      try {
        registry.register({
          tool_id: 'http_slow',
          executor: { type: 'http', url: `${server.url}/slow`, method: 'POST' },
          timeout_ms: 200, // 200ms timeout
        })

        const pool = new ExecutorPool(registry)
        const result = await pool.execute('http_slow', 'call_http_3', {})

        expect(result.status).toBe('failed')
        expect(result.error).toContain('timed out')
      } finally {
        await server.close()
      }
    })
  })

  // ── Concurrency ───────────────────────────────────────────────────────

  describe('Concurrency control', () => {
    it('limits concurrent executions per tool', async () => {
      let concurrentCount = 0
      let maxConcurrent = 0

      registry.register({
        tool_id: 'slow_fn',
        executor: { type: 'ts_fn' },
        max_concurrent: 2,
      })

      registerFunctionHandler('slow_fn', async () => {
        concurrentCount++
        maxConcurrent = Math.max(maxConcurrent, concurrentCount)
        await new Promise((r) => setTimeout(r, 50))
        concurrentCount--
        return 'done'
      })

      const pool = new ExecutorPool(registry)

      // Launch 5 concurrent executions
      const results = await Promise.all([
        pool.execute('slow_fn', 'c1', {}),
        pool.execute('slow_fn', 'c2', {}),
        pool.execute('slow_fn', 'c3', {}),
        pool.execute('slow_fn', 'c4', {}),
        pool.execute('slow_fn', 'c5', {}),
      ])

      // All should complete
      expect(results).toHaveLength(5)
      for (const r of results) {
        expect(r.status).toBe('completed')
      }

      // Never exceeded max_concurrent=2
      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })
  })

  // ── Retry ─────────────────────────────────────────────────────────────

  describe('Retry with backoff', () => {
    it('retries on failure and succeeds on 3rd attempt', async () => {
      let attempts = 0

      registry.register({
        tool_id: 'flaky_fn',
        executor: { type: 'ts_fn' },
        retry: { max_attempts: 3, backoff_ms: 10 },
      })

      registerFunctionHandler('flaky_fn', () => {
        attempts++
        if (attempts < 3) {
          throw new Error(`Attempt ${attempts} failed`)
        }
        return 'success'
      })

      const pool = new ExecutorPool(registry)
      const result = await pool.execute('flaky_fn', 'r1', {})

      expect(result.status).toBe('completed')
      expect(result.result).toBe('success')
      expect(attempts).toBe(3)
    })

    it('fails after exhausting all retry attempts', async () => {
      registry.register({
        tool_id: 'always_fails',
        executor: { type: 'ts_fn' },
        retry: { max_attempts: 2, backoff_ms: 10 },
      })

      registerFunctionHandler('always_fails', () => {
        throw new Error('permanent failure')
      })

      const pool = new ExecutorPool(registry)
      const result = await pool.execute('always_fails', 'r2', {})

      expect(result.status).toBe('failed')
      expect(result.error).toContain('permanent failure')
      expect(result.error).toContain('2 attempt(s)')
    })
  })

  // ── Stats ──────────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('tracks completed and failed counts', async () => {
      registry.register({
        tool_id: 'tracked',
        executor: { type: 'ts_fn' },
      })

      let shouldFail = false
      registerFunctionHandler('tracked', () => {
        if (shouldFail) throw new Error('fail')
        return 'ok'
      })

      const pool = new ExecutorPool(registry)

      await pool.execute('tracked', 't1', {})
      await pool.execute('tracked', 't2', {})
      shouldFail = true
      await pool.execute('tracked', 't3', {})

      const stats = pool.getStats('tracked')
      expect(stats.completed).toBe(2)
      expect(stats.failed).toBe(1)
      expect(stats.executing).toBe(0)
    })

    it('returns zeroed stats for unknown tool', () => {
      const pool = new ExecutorPool(registry)
      const stats = pool.getStats('unknown')
      expect(stats).toEqual({ executing: 0, queued: 0, completed: 0, failed: 0 })
    })
  })
})

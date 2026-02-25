import { describe, it, expect, vi } from 'vitest'
import { AgentBundle } from './agent-bundle.js'
import type { NexusAgent } from './nexus-agent.js'

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeAgent(_id: string): NexusAgent & { startCalled: boolean; shutdownCalled: boolean } {
  return {
    startCalled: false,
    shutdownCalled: false,
    async start() {
      this.startCalled = true
    },
    async shutdown() {
      this.shutdownCalled = true
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeDisposable() {
  return { dispose: vi.fn() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentBundle', () => {
  // ── start ────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('starts all agents', async () => {
      const a1 = makeAgent('a1')
      const a2 = makeAgent('a2')
      const bundle = new AgentBundle({ agents: [a1, a2] })

      await bundle.start()

      expect(a1.startCalled).toBe(true)
      expect(a2.startCalled).toBe(true)
    })

    it('starts agents in order', async () => {
      const order: string[] = []
      const a1 = {
        async start() {
          order.push('a1')
        },
        async shutdown() {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as NexusAgent
      const a2 = {
        async start() {
          order.push('a2')
        },
        async shutdown() {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as NexusAgent

      const bundle = new AgentBundle({ agents: [a1, a2] })
      await bundle.start()

      expect(order).toEqual(['a1', 'a2'])
    })

    it('works with empty agents array', async () => {
      const bundle = new AgentBundle({ agents: [] })
      await expect(bundle.start()).resolves.toBeUndefined()
    })
  })

  // ── shutdown ─────────────────────────────────────────────────────────

  describe('shutdown()', () => {
    it('shuts down all agents', async () => {
      const a1 = makeAgent('a1')
      const a2 = makeAgent('a2')
      const bundle = new AgentBundle({ agents: [a1, a2] })

      await bundle.shutdown()

      expect(a1.shutdownCalled).toBe(true)
      expect(a2.shutdownCalled).toBe(true)
    })

    it('shuts down agents in REVERSE order', async () => {
      const order: string[] = []
      const a1 = {
        async start() {},
        async shutdown() {
          order.push('a1')
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as NexusAgent
      const a2 = {
        async start() {},
        async shutdown() {
          order.push('a2')
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as NexusAgent

      const bundle = new AgentBundle({ agents: [a1, a2] })
      await bundle.shutdown()

      expect(order).toEqual(['a2', 'a1'])
    })
  })

  // ── dispose ──────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('calls dispose on all disposables', () => {
      const d1 = makeDisposable()
      const d2 = makeDisposable()
      const bundle = new AgentBundle({ agents: [], disposables: [d1, d2] })

      bundle.dispose()

      expect(d1.dispose).toHaveBeenCalledOnce()
      expect(d2.dispose).toHaveBeenCalledOnce()
    })

    it('works with no disposables', () => {
      const bundle = new AgentBundle({ agents: [] })
      expect(() => bundle.dispose()).not.toThrow()
    })

    it('does NOT shutdown agents — only disposes resources', async () => {
      const a1 = makeAgent('a1')
      const bundle = new AgentBundle({ agents: [a1] })

      bundle.dispose()

      expect(a1.shutdownCalled).toBe(false)
    })
  })

  // ── full lifecycle ────────────────────────────────────────────────────

  describe('full lifecycle: start → shutdown → dispose', () => {
    it('executes complete lifecycle without errors', async () => {
      const agent = makeAgent('main')
      const resource = makeDisposable()
      const bundle = new AgentBundle({
        agents: [agent],
        disposables: [resource],
      })

      await bundle.start()
      expect(agent.startCalled).toBe(true)

      await bundle.shutdown()
      expect(agent.shutdownCalled).toBe(true)

      bundle.dispose()
      expect(resource.dispose).toHaveBeenCalledOnce()
    })
  })
})

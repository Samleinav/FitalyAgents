import { describe, it, expect, vi } from 'vitest'
import { AgentBundle } from './agent-bundle.js'
import type { IAgent } from './agent-bundle.js'

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeAgent(_id: string): IAgent & { startCalled: boolean; stopCalled: boolean } {
  return {
    startCalled: false,
    stopCalled: false,
    async start() {
      this.startCalled = true
    },
    async stop() {
      this.stopCalled = true
    },
  }
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
      const a1: IAgent = {
        async start() {
          order.push('a1')
        },
        async stop() {},
      }
      const a2: IAgent = {
        async start() {
          order.push('a2')
        },
        async stop() {},
      }

      const bundle = new AgentBundle({ agents: [a1, a2] })
      await bundle.start()

      expect(order).toEqual(['a1', 'a2'])
    })

    it('works with empty agents array', async () => {
      const bundle = new AgentBundle({ agents: [] })
      await expect(bundle.start()).resolves.toBeUndefined()
    })
  })

  // ── stop ─────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('stops all agents', async () => {
      const a1 = makeAgent('a1')
      const a2 = makeAgent('a2')
      const bundle = new AgentBundle({ agents: [a1, a2] })

      await bundle.stop()

      expect(a1.stopCalled).toBe(true)
      expect(a2.stopCalled).toBe(true)
    })

    it('stops agents in REVERSE order', async () => {
      const order: string[] = []
      const a1: IAgent = {
        async start() {},
        async stop() {
          order.push('a1')
        },
      }
      const a2: IAgent = {
        async start() {},
        async stop() {
          order.push('a2')
        },
      }

      const bundle = new AgentBundle({ agents: [a1, a2] })
      await bundle.stop()

      expect(order).toEqual(['a2', 'a1'])
    })
  })

  // ── shutdown (deprecated alias) ─────────────────────────────────────

  describe('shutdown() (deprecated)', () => {
    it('delegates to stop()', async () => {
      const a1 = makeAgent('a1')
      const bundle = new AgentBundle({ agents: [a1] })

      await bundle.shutdown()

      expect(a1.stopCalled).toBe(true)
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

    it('does NOT stop agents — only disposes resources', async () => {
      const a1 = makeAgent('a1')
      const bundle = new AgentBundle({ agents: [a1] })

      bundle.dispose()

      expect(a1.stopCalled).toBe(false)
    })
  })

  // ── full lifecycle ────────────────────────────────────────────────────

  describe('full lifecycle: start → stop → dispose', () => {
    it('executes complete lifecycle without errors', async () => {
      const agent = makeAgent('main')
      const resource = makeDisposable()
      const bundle = new AgentBundle({
        agents: [agent],
        disposables: [resource],
      })

      await bundle.start()
      expect(agent.startCalled).toBe(true)

      await bundle.stop()
      expect(agent.stopCalled).toBe(true)

      bundle.dispose()
      expect(resource.dispose).toHaveBeenCalledOnce()
    })
  })
})

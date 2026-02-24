import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryContextStore } from './in-memory-context-store.js'
import { enforceAccess, AccessDeniedError } from './types.js'
import type { AgentManifest } from '../types/index.js'

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    agent_id: 'agent_test',
    description: 'Test agent',
    version: '1.0.0',
    domain: 'customer_facing',
    scope: 'ecommerce',
    capabilities: ['SEARCH'],
    context_mode: 'stateful',
    context_access: {
      read: ['cart', 'user_name', 'preferences'],
      write: ['cart'],
      forbidden: ['payment_token', 'ssn'],
    },
    async_tools: [],
    input_channel: 'tasks:agent_test',
    output_channel: 'results:agent_test',
    priority: 5,
    max_concurrent: 3,
    timeout_ms: 10000,
    heartbeat_interval_ms: 3000,
    role: null,
    accepts_from: [],
    requires_human_approval: false,
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InMemoryContextStore', () => {
  let store: InMemoryContextStore

  beforeEach(() => {
    store = new InMemoryContextStore()
  })

  afterEach(() => {
    store.dispose()
  })

  // ── Basic CRUD ──────────────────────────────────────────────────────────

  describe('get / set', () => {
    it('returns null for non-existent session', async () => {
      const value = await store.get('sess_1', 'cart')
      expect(value).toBeNull()
    })

    it('returns null for non-existent field', async () => {
      await store.set('sess_1', 'cart', { items: [] })
      const value = await store.get('sess_1', 'nonexistent')
      expect(value).toBeNull()
    })

    it('sets and retrieves a value', async () => {
      await store.set('sess_1', 'cart', { items: ['shirt', 'pants'] })
      const cart = await store.get<{ items: string[] }>('sess_1', 'cart')
      expect(cart).toEqual({ items: ['shirt', 'pants'] })
    })

    it('overwrites an existing field', async () => {
      await store.set('sess_1', 'cart', { items: ['shirt'] })
      await store.set('sess_1', 'cart', { items: ['shirt', 'pants'] })
      const cart = await store.get<{ items: string[] }>('sess_1', 'cart')
      expect(cart).toEqual({ items: ['shirt', 'pants'] })
    })

    it('handles multiple fields per session', async () => {
      await store.set('sess_1', 'cart', { items: ['shirt'] })
      await store.set('sess_1', 'user_name', 'Ana')
      await store.set('sess_1', 'locale', 'es-MX')

      expect(await store.get('sess_1', 'cart')).toEqual({ items: ['shirt'] })
      expect(await store.get('sess_1', 'user_name')).toBe('Ana')
      expect(await store.get('sess_1', 'locale')).toBe('es-MX')
    })
  })

  // ── Isolation ───────────────────────────────────────────────────────────

  describe('session isolation', () => {
    it('patch on sess_ana does NOT affect sess_pedro', async () => {
      await store.patch('sess_ana', { cart: ['shirt'], locale: 'es-MX' })
      await store.patch('sess_pedro', { cart: ['pants'], locale: 'en-US' })

      // Modify sess_ana
      await store.patch('sess_ana', { cart: ['shirt', 'hat'] })

      // sess_pedro is untouched
      expect(await store.get('sess_pedro', 'cart')).toEqual(['pants'])
      expect(await store.get('sess_pedro', 'locale')).toBe('en-US')

      // sess_ana reflects the update
      expect(await store.get('sess_ana', 'cart')).toEqual(['shirt', 'hat'])
    })

    it('deleting sess_ana does NOT affect sess_pedro', async () => {
      await store.set('sess_ana', 'data', 'ana')
      await store.set('sess_pedro', 'data', 'pedro')

      await store.delete('sess_ana')

      expect(await store.exists('sess_ana')).toBe(false)
      expect(await store.exists('sess_pedro')).toBe(true)
      expect(await store.get('sess_pedro', 'data')).toBe('pedro')
    })
  })

  // ── patch ───────────────────────────────────────────────────────────────

  describe('patch (atomic merge)', () => {
    it('merges multiple fields atomically', async () => {
      await store.set('sess_1', 'existing', 'keep_me')

      await store.patch('sess_1', {
        cart: ['new_item'],
        user_name: 'Ana',
        preferences: { theme: 'dark' },
      })

      expect(await store.get('sess_1', 'existing')).toBe('keep_me')
      expect(await store.get('sess_1', 'cart')).toEqual(['new_item'])
      expect(await store.get('sess_1', 'user_name')).toBe('Ana')
      expect(await store.get('sess_1', 'preferences')).toEqual({ theme: 'dark' })
    })

    it('creates session if it does not exist', async () => {
      await store.patch('new_sess', { a: 1, b: 2 })
      expect(await store.exists('new_sess')).toBe(true)
      expect(await store.get('new_sess', 'a')).toBe(1)
      expect(await store.get('new_sess', 'b')).toBe(2)
    })

    it('overwrites existing fields in patch', async () => {
      await store.set('sess_1', 'count', 5)
      await store.patch('sess_1', { count: 10 })
      expect(await store.get('sess_1', 'count')).toBe(10)
    })
  })

  // ── getMany ─────────────────────────────────────────────────────────────

  describe('getMany', () => {
    it('returns only requested fields that exist', async () => {
      await store.patch('sess_1', { a: 1, b: 2, c: 3 })
      const result = await store.getMany('sess_1', ['a', 'c', 'z'])
      expect(result).toEqual({ a: 1, c: 3 })
    })

    it('returns empty object for non-existent session', async () => {
      const result = await store.getMany('ghost', ['a', 'b'])
      expect(result).toEqual({})
    })
  })

  // ── getSnapshot ─────────────────────────────────────────────────────────

  describe('getSnapshot', () => {
    beforeEach(async () => {
      await store.patch('sess_1', {
        cart: ['item_1'],
        user_name: 'Ana',
        preferences: { theme: 'dark' },
        payment_token: 'tok_secret_123',
        ssn: '123-45-6789',
        locale: 'es-MX',
      })
    })

    it('returns only allowed fields (explicit list)', async () => {
      const snapshot = await store.getSnapshot('sess_1', ['cart', 'user_name'])
      expect(snapshot).toEqual({
        cart: ['item_1'],
        user_name: 'Ana',
      })
      expect(snapshot).not.toHaveProperty('payment_token')
      expect(snapshot).not.toHaveProperty('ssn')
      expect(snapshot).not.toHaveProperty('locale')
    })

    it('handles "*" as all fields', async () => {
      const snapshot = await store.getSnapshot('sess_1', ['*'])
      expect(snapshot).toHaveProperty('cart')
      expect(snapshot).toHaveProperty('user_name')
      expect(snapshot).toHaveProperty('payment_token')
      expect(snapshot).toHaveProperty('ssn')
      expect(snapshot).toHaveProperty('locale')
    })

    it('"*" with excludeFields removes forbidden fields', async () => {
      const snapshot = await store.getSnapshot('sess_1', ['*'], ['payment_token', 'ssn'])
      expect(snapshot).toHaveProperty('cart')
      expect(snapshot).toHaveProperty('user_name')
      expect(snapshot).toHaveProperty('preferences')
      expect(snapshot).toHaveProperty('locale')
      expect(snapshot).not.toHaveProperty('payment_token')
      expect(snapshot).not.toHaveProperty('ssn')
    })

    it('respects context_access: read + excludes forbidden', async () => {
      const manifest = makeManifest()
      const snapshot = await store.getSnapshot(
        'sess_1',
        manifest.context_access.read,
        manifest.context_access.forbidden,
      )

      // read fields that exist
      expect(snapshot).toHaveProperty('cart')
      expect(snapshot).toHaveProperty('user_name')
      expect(snapshot).toHaveProperty('preferences')

      // forbidden fields excluded even though they exist
      expect(snapshot).not.toHaveProperty('payment_token')
      expect(snapshot).not.toHaveProperty('ssn')

      // fields not in read list excluded
      expect(snapshot).not.toHaveProperty('locale')
    })

    it('returns empty for non-existent session', async () => {
      const snapshot = await store.getSnapshot('ghost', ['*'])
      expect(snapshot).toEqual({})
    })

    it('excludeFields overrides allowedFields', async () => {
      // Even if 'cart' is in allowed, if it's in exclude it should be removed
      const snapshot = await store.getSnapshot('sess_1', ['cart', 'user_name'], ['cart'])
      expect(snapshot).not.toHaveProperty('cart')
      expect(snapshot).toHaveProperty('user_name')
    })
  })

  // ── delete ──────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes a specific field', async () => {
      await store.patch('sess_1', { a: 1, b: 2 })
      await store.delete('sess_1', 'a')

      expect(await store.get('sess_1', 'a')).toBeNull()
      expect(await store.get('sess_1', 'b')).toBe(2)
    })

    it('deletes an entire session', async () => {
      await store.patch('sess_1', { a: 1, b: 2 })
      await store.delete('sess_1')

      expect(await store.exists('sess_1')).toBe(false)
      expect(await store.get('sess_1', 'a')).toBeNull()
    })

    it('no-op on non-existent session field', async () => {
      // Should not throw
      await store.delete('ghost', 'field')
    })

    it('no-op on non-existent session', async () => {
      // Should not throw
      await store.delete('ghost')
    })
  })

  // ── exists ──────────────────────────────────────────────────────────────

  describe('exists', () => {
    it('returns false for non-existent session', async () => {
      expect(await store.exists('ghost')).toBe(false)
    })

    it('returns true after setting a field', async () => {
      await store.set('sess_1', 'key', 'value')
      expect(await store.exists('sess_1')).toBe(true)
    })

    it('returns false after deleting entire session', async () => {
      await store.set('sess_1', 'key', 'value')
      await store.delete('sess_1')
      expect(await store.exists('sess_1')).toBe(false)
    })
  })

  // ── setTTL ──────────────────────────────────────────────────────────────

  describe('setTTL', () => {
    it('auto-deletes session after TTL expires', async () => {
      await store.set('sess_1', 'data', 'temporary')
      await store.setTTL('sess_1', 0.1) // 100ms

      expect(await store.exists('sess_1')).toBe(true)

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 200))

      expect(await store.exists('sess_1')).toBe(false)
      expect(await store.get('sess_1', 'data')).toBeNull()
    })

    it('replaces previous TTL timer', async () => {
      await store.set('sess_1', 'data', 'temporary')
      await store.setTTL('sess_1', 0.05) // 50ms — would expire quickly
      await store.setTTL('sess_1', 1) // 1 second — extend

      await new Promise((r) => setTimeout(r, 100))

      // Should still exist because the TTL was extended to 1 second
      expect(await store.exists('sess_1')).toBe(true)
    })
  })
})

// ── enforceAccess ─────────────────────────────────────────────────────────

describe('enforceAccess', () => {
  const manifest = makeManifest()

  it('does NOT throw for allowed fields', () => {
    expect(() => enforceAccess(manifest, { cart: ['new_item'] })).not.toThrow()
  })

  it('throws AccessDeniedError for forbidden field', () => {
    expect(() => enforceAccess(manifest, { cart: ['item'], payment_token: 'tok_stolen' })).toThrow(
      AccessDeniedError,
    )
  })

  it('throws with correct agent_id and field in error', () => {
    try {
      enforceAccess(manifest, { ssn: '000-00-0000' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AccessDeniedError)
      const accessErr = err as AccessDeniedError
      expect(accessErr.agentId).toBe('agent_test')
      expect(accessErr.field).toBe('ssn')
    }
  })

  it('allows empty patch', () => {
    expect(() => enforceAccess(manifest, {})).not.toThrow()
  })

  it('allows fields not explicitly in read/write if not forbidden', () => {
    // Fields not in any list are not forbidden
    expect(() => enforceAccess(manifest, { some_new_field: 42 })).not.toThrow()
  })
})

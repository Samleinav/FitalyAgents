import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry } from './tool-registry.js'
import { DuplicateToolError, ToolNotFoundError, ToolValidationError } from '../errors.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

const validHttpTool = {
  tool_id: 'product_search',
  description: 'Search products by brand, size, color',
  executor: {
    type: 'http' as const,
    url: 'https://api.store.com/search',
    method: 'POST' as const,
  },
  execution_mode: 'async' as const,
  timeout_ms: 5000,
  max_concurrent: 3,
  retry: { max_attempts: 2, backoff_ms: 300 },
}

const validFnTool = {
  tool_id: 'calculate',
  description: 'Simple calculator',
  executor: { type: 'ts_fn' as const },
  execution_mode: 'sync' as const,
}

const validSubprocessTool = {
  tool_id: 'python_runner',
  executor: {
    type: 'subprocess' as const,
    command: 'python',
    args: ['script.py'],
  },
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  // ── register() ──────────────────────────────────────────────────────────

  describe('register()', () => {
    it('registers a valid HTTP tool', () => {
      const result = registry.register(validHttpTool)
      expect(result.tool_id).toBe('product_search')
      expect(result.executor.type).toBe('http')
      expect(registry.size).toBe(1)
    })

    it('registers a valid function tool with defaults applied', () => {
      const result = registry.register(validFnTool)
      expect(result.tool_id).toBe('calculate')
      expect(result.timeout_ms).toBe(10_000) // default
      expect(result.max_concurrent).toBe(5) // default
      expect(result.retry.max_attempts).toBe(1) // default
    })

    it('registers a subprocess tool', () => {
      const result = registry.register(validSubprocessTool)
      expect(result.executor.type).toBe('subprocess')
      if (result.executor.type === 'subprocess') {
        expect(result.executor.command).toBe('python')
      }
    })

    it('throws ToolValidationError for invalid tool definition', () => {
      expect(() => registry.register({ tool_id: '', executor: { type: 'http' } })).toThrow(
        ToolValidationError,
      )
    })

    it('throws ToolValidationError for completely invalid input', () => {
      expect(() => registry.register('not-a-tool')).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError for missing executor', () => {
      expect(() => registry.register({ tool_id: 'test' })).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError with detailed issues', () => {
      try {
        registry.register({ tool_id: '', executor: { type: 'invalid' } })
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ToolValidationError)
        const err = e as ToolValidationError
        expect(err.code).toBe('TOOL_VALIDATION_ERROR')
        expect(err.issues.length).toBeGreaterThan(0)
      }
    })

    it('throws DuplicateToolError when registering the same tool_id twice', () => {
      registry.register(validHttpTool)
      expect(() => registry.register(validHttpTool)).toThrow(DuplicateToolError)
    })

    it('DuplicateToolError includes the tool_id', () => {
      registry.register(validHttpTool)
      try {
        registry.register(validHttpTool)
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(DuplicateToolError)
        expect((e as DuplicateToolError).toolId).toBe('product_search')
        expect((e as DuplicateToolError).code).toBe('DUPLICATE_TOOL')
      }
    })
  })

  // ── registerMany() ─────────────────────────────────────────────────────

  describe('registerMany()', () => {
    it('registers multiple valid tools', () => {
      const results = registry.registerMany([validHttpTool, validFnTool, validSubprocessTool])
      expect(results).toHaveLength(3)
      expect(registry.size).toBe(3)
    })

    it('rejects batch with invalid tool (no partial registration)', () => {
      expect(() =>
        registry.registerMany([validHttpTool, { tool_id: '', executor: { type: 'http' } }]),
      ).toThrow(ToolValidationError)

      // Nothing should have been registered
      expect(registry.size).toBe(0)
    })

    it('rejects batch with duplicate tool_ids within the batch', () => {
      expect(() => registry.registerMany([validHttpTool, validHttpTool])).toThrow(
        DuplicateToolError,
      )
      expect(registry.size).toBe(0)
    })

    it('rejects batch if any tool_id conflicts with existing registration', () => {
      registry.register(validHttpTool)
      expect(() => registry.registerMany([validFnTool, validHttpTool])).toThrow(DuplicateToolError)
      // Only the original should remain
      expect(registry.size).toBe(1)
    })
  })

  // ── get() ───────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns the tool definition for a registered tool', () => {
      registry.register(validHttpTool)
      const tool = registry.get('product_search')
      expect(tool).toBeDefined()
      expect(tool!.tool_id).toBe('product_search')
    })

    it('returns undefined for an unregistered tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  // ── getOrThrow() ────────────────────────────────────────────────────────

  describe('getOrThrow()', () => {
    it('returns the tool for a registered tool', () => {
      registry.register(validFnTool)
      const tool = registry.getOrThrow('calculate')
      expect(tool.tool_id).toBe('calculate')
    })

    it('throws ToolNotFoundError for missing tool', () => {
      expect(() => registry.getOrThrow('nonexistent')).toThrow(ToolNotFoundError)
    })

    it('ToolNotFoundError includes the tool_id', () => {
      try {
        registry.getOrThrow('missing_tool')
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ToolNotFoundError)
        expect((e as ToolNotFoundError).toolId).toBe('missing_tool')
        expect((e as ToolNotFoundError).code).toBe('TOOL_NOT_FOUND')
      }
    })
  })

  // ── list() ──────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns empty array when no tools registered', () => {
      expect(registry.list()).toEqual([])
    })

    it('returns all registered tools', () => {
      registry.registerMany([validHttpTool, validFnTool])
      const tools = registry.list()
      expect(tools).toHaveLength(2)
      const ids = tools.map((t) => t.tool_id)
      expect(ids).toContain('product_search')
      expect(ids).toContain('calculate')
    })
  })

  // ── has() ───────────────────────────────────────────────────────────────

  describe('has()', () => {
    it('returns true for registered tool', () => {
      registry.register(validFnTool)
      expect(registry.has('calculate')).toBe(true)
    })

    it('returns false for unregistered tool', () => {
      expect(registry.has('nope')).toBe(false)
    })
  })

  // ── unregister() ────────────────────────────────────────────────────────

  describe('unregister()', () => {
    it('removes a registered tool', () => {
      registry.register(validFnTool)
      expect(registry.has('calculate')).toBe(true)

      registry.unregister('calculate')
      expect(registry.has('calculate')).toBe(false)
      expect(registry.size).toBe(0)
    })

    it('throws ToolNotFoundError when unregistering a missing tool', () => {
      expect(() => registry.unregister('missing')).toThrow(ToolNotFoundError)
    })
  })

  // ── fromFile() ──────────────────────────────────────────────────────────

  describe('fromFile()', () => {
    const tmpPath = join(tmpdir(), `fitalyagents-test-${Date.now()}`)
    const filePath = join(tmpPath, 'tools.json')

    beforeEach(async () => {
      await mkdir(tmpPath, { recursive: true })
    })

    afterEach(async () => {
      try {
        await unlink(filePath)
      } catch {
        // file may not exist
      }
    })

    it('loads tools from a valid JSON file', async () => {
      await writeFile(filePath, JSON.stringify([validHttpTool, validFnTool]))
      const reg = await ToolRegistry.fromFile(filePath)
      expect(reg.size).toBe(2)
      expect(reg.has('product_search')).toBe(true)
      expect(reg.has('calculate')).toBe(true)
    })

    it('throws on malformed JSON file', async () => {
      await writeFile(filePath, 'not json at all {{{')
      await expect(ToolRegistry.fromFile(filePath)).rejects.toThrow()
    })

    it('throws on file with invalid tool definitions', async () => {
      await writeFile(filePath, JSON.stringify([{ tool_id: '' }]))
      await expect(ToolRegistry.fromFile(filePath)).rejects.toThrow(ToolValidationError)
    })
  })

  // ── fromObject() ────────────────────────────────────────────────────────

  describe('fromObject()', () => {
    it('creates registry from a plain array', () => {
      const reg = ToolRegistry.fromObject([validHttpTool, validFnTool])
      expect(reg.size).toBe(2)
    })

    it('creates registry from an object with tools key', () => {
      const reg = ToolRegistry.fromObject({ tools: [validHttpTool] })
      expect(reg.size).toBe(1)
    })

    it('throws ToolValidationError for invalid shape (string)', () => {
      expect(() => ToolRegistry.fromObject('not-valid')).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError for invalid shape (number)', () => {
      expect(() => ToolRegistry.fromObject(42)).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError for invalid shape (null)', () => {
      expect(() => ToolRegistry.fromObject(null)).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError for object without tools key', () => {
      expect(() => ToolRegistry.fromObject({ items: [validHttpTool] })).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError for invalid tools inside array', () => {
      expect(() =>
        ToolRegistry.fromObject([{ tool_id: 'ok', executor: { type: 'ts_fn' } }, 'not-a-tool']),
      ).toThrow(ToolValidationError)
    })
  })

  // ── size ─────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('reflects registration and unregistration', () => {
      expect(registry.size).toBe(0)
      registry.register(validHttpTool)
      expect(registry.size).toBe(1)
      registry.register(validFnTool)
      expect(registry.size).toBe(2)
      registry.unregister('product_search')
      expect(registry.size).toBe(1)
    })
  })
})

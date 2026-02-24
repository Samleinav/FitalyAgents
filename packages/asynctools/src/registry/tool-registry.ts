import { readFile } from 'node:fs/promises'
import { ToolDefinitionSchema } from '../types/index.js'
import type { ToolDefinition } from '../types/index.js'
import { DuplicateToolError, ToolNotFoundError, ToolValidationError } from '../errors.js'

/**
 * In-memory registry for async tool definitions.
 *
 * Validates every tool against the Zod schema at registration time,
 * ensuring only well-formed definitions can be stored. Supports
 * loading from files, objects, or programmatic registration.
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry()
 *
 * registry.register({
 *   tool_id: 'product_search',
 *   executor: { type: 'http', url: 'https://api.store.com/search', method: 'POST' },
 *   execution_mode: 'async',
 *   timeout_ms: 5000,
 * })
 *
 * const tool = registry.getOrThrow('product_search')
 * console.log(tool.executor.type) // 'http'
 * ```
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  /**
   * Register a single tool definition.
   * Validates the definition against `ToolDefinitionSchema` and throws
   * `ToolValidationError` if invalid, or `DuplicateToolError` if the
   * tool_id already exists.
   *
   * @param tool - The tool definition to register
   * @throws {ToolValidationError} If the definition fails schema validation
   * @throws {DuplicateToolError} If a tool with the same tool_id is already registered
   */
  register(tool: unknown): ToolDefinition {
    const parsed = this.validate(tool)

    if (this.tools.has(parsed.tool_id)) {
      throw new DuplicateToolError(parsed.tool_id)
    }

    this.tools.set(parsed.tool_id, parsed)
    return parsed
  }

  /**
   * Register multiple tool definitions at once.
   * Each tool is validated individually. If any tool fails validation,
   * the entire batch is rejected (no partial registration).
   *
   * @param tools - Array of tool definitions to register
   * @throws {ToolValidationError} If any definition fails schema validation
   * @throws {DuplicateToolError} If any tool_id conflicts with an existing or sibling registration
   */
  registerMany(tools: unknown[]): ToolDefinition[] {
    // Validate all first before committing any
    const parsed = tools.map((t) => this.validate(t))

    // Check for duplicates within the batch
    const seen = new Set<string>()
    for (const tool of parsed) {
      if (seen.has(tool.tool_id)) {
        throw new DuplicateToolError(tool.tool_id)
      }
      if (this.tools.has(tool.tool_id)) {
        throw new DuplicateToolError(tool.tool_id)
      }
      seen.add(tool.tool_id)
    }

    // Commit all
    for (const tool of parsed) {
      this.tools.set(tool.tool_id, tool)
    }

    return parsed
  }

  /**
   * Create a `ToolRegistry` from a JSON file.
   * The file must contain a JSON array of tool definitions.
   *
   * @param path - Absolute or relative path to the JSON file
   * @returns A new `ToolRegistry` populated with the tools from the file
   *
   * @example
   * ```typescript
   * const registry = await ToolRegistry.fromFile('./tools.json')
   * ```
   */
  static async fromFile(path: string): Promise<ToolRegistry> {
    const content = await readFile(path, 'utf-8')
    const data: unknown = JSON.parse(content)
    return ToolRegistry.fromObject(data)
  }

  /**
   * Create a `ToolRegistry` from a raw JavaScript object.
   * Expects either an array of tool definitions or an object with a `tools` key.
   *
   * @param data - Raw data: `ToolDefinition[]` or `{ tools: ToolDefinition[] }`
   * @returns A new `ToolRegistry` populated with the parsed tools
   *
   * @example
   * ```typescript
   * const registry = ToolRegistry.fromObject([
   *   { tool_id: 'calc', executor: { type: 'ts_fn' } },
   * ])
   * ```
   */
  static fromObject(data: unknown): ToolRegistry {
    const registry = new ToolRegistry()

    let tools: unknown[]
    if (Array.isArray(data)) {
      tools = data
    } else if (
      data !== null &&
      typeof data === 'object' &&
      'tools' in data &&
      Array.isArray((data as Record<string, unknown>).tools)
    ) {
      tools = (data as Record<string, unknown>).tools as unknown[]
    } else {
      throw new ToolValidationError('Expected an array of tool definitions or { tools: [...] }', [
        { path: [], message: 'Input must be an array or an object with a "tools" key' },
      ])
    }

    registry.registerMany(tools)
    return registry
  }

  /**
   * Get a tool definition by its ID, or `undefined` if not found.
   *
   * @param toolId - The tool ID to look up
   */
  get(toolId: string): ToolDefinition | undefined {
    return this.tools.get(toolId)
  }

  /**
   * Get a tool definition by its ID, throwing if not found.
   *
   * @param toolId - The tool ID to look up
   * @throws {ToolNotFoundError} If no tool with the given ID exists
   */
  getOrThrow(toolId: string): ToolDefinition {
    const tool = this.tools.get(toolId)
    if (!tool) {
      throw new ToolNotFoundError(toolId)
    }
    return tool
  }

  /**
   * Return all registered tool definitions as an array.
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /**
   * Check whether a tool with the given ID is registered.
   *
   * @param toolId - The tool ID to check
   */
  has(toolId: string): boolean {
    return this.tools.has(toolId)
  }

  /**
   * Remove a tool from the registry.
   *
   * @param toolId - The tool ID to remove
   * @throws {ToolNotFoundError} If no tool with the given ID exists
   */
  unregister(toolId: string): void {
    if (!this.tools.has(toolId)) {
      throw new ToolNotFoundError(toolId)
    }
    this.tools.delete(toolId)
  }

  /**
   * Return the number of registered tools.
   */
  get size(): number {
    return this.tools.size
  }

  // ── Private ───────────────────────────────────────────────────────────

  private validate(tool: unknown): ToolDefinition {
    const result = ToolDefinitionSchema.safeParse(tool)

    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      }))
      throw new ToolValidationError(
        `Invalid tool definition: ${result.error.issues.map((i) => i.message).join(', ')}`,
        issues,
      )
    }

    return result.data
  }
}

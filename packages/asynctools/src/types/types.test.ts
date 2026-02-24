import { describe, it, expect } from 'vitest'
import {
    ToolDefinitionSchema,
    ExecutionModeSchema,
    InjectionStrategySchema,
    ToolStatusSchema,
    ExecutorTypeSchema,
    RetryConfigSchema,
} from './index.js'

describe('Types — Zod Schemas', () => {
    describe('ExecutionModeSchema', () => {
        it('accepts valid execution modes', () => {
            expect(ExecutionModeSchema.parse('sync')).toBe('sync')
            expect(ExecutionModeSchema.parse('async')).toBe('async')
            expect(ExecutionModeSchema.parse('fire_forget')).toBe('fire_forget')
            expect(ExecutionModeSchema.parse('deferred')).toBe('deferred')
        })

        it('rejects invalid execution mode', () => {
            expect(() => ExecutionModeSchema.parse('invalid')).toThrow()
        })
    })

    describe('InjectionStrategySchema', () => {
        it('accepts valid strategies', () => {
            expect(InjectionStrategySchema.parse('inject_when_all')).toBe('inject_when_all')
            expect(InjectionStrategySchema.parse('inject_when_ready')).toBe('inject_when_ready')
            expect(InjectionStrategySchema.parse('inject_on_timeout')).toBe('inject_on_timeout')
        })

        it('rejects invalid strategy', () => {
            expect(() => InjectionStrategySchema.parse('inject_whenever')).toThrow()
        })
    })

    describe('ToolStatusSchema', () => {
        it('accepts all valid statuses', () => {
            const statuses = ['pending', 'running', 'completed', 'failed', 'timed_out']
            for (const status of statuses) {
                expect(ToolStatusSchema.parse(status)).toBe(status)
            }
        })
    })

    describe('ExecutorTypeSchema', () => {
        it('accepts all valid executor types', () => {
            expect(ExecutorTypeSchema.parse('http')).toBe('http')
            expect(ExecutorTypeSchema.parse('ts_fn')).toBe('ts_fn')
            expect(ExecutorTypeSchema.parse('subprocess')).toBe('subprocess')
        })
    })

    describe('RetryConfigSchema', () => {
        it('applies defaults when empty', () => {
            const config = RetryConfigSchema.parse({})
            expect(config.max_attempts).toBe(1)
            expect(config.backoff_ms).toBe(200)
        })

        it('accepts explicit values', () => {
            const config = RetryConfigSchema.parse({ max_attempts: 3, backoff_ms: 500 })
            expect(config.max_attempts).toBe(3)
            expect(config.backoff_ms).toBe(500)
        })

        it('rejects max_attempts < 1', () => {
            expect(() => RetryConfigSchema.parse({ max_attempts: 0 })).toThrow()
        })
    })

    describe('ToolDefinitionSchema', () => {
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

        it('parses a valid HTTP tool definition', () => {
            const tool = ToolDefinitionSchema.parse(validHttpTool)
            expect(tool.tool_id).toBe('product_search')
            expect(tool.executor.type).toBe('http')
            if (tool.executor.type === 'http') {
                expect(tool.executor.url).toBe('https://api.store.com/search')
                expect(tool.executor.method).toBe('POST')
            }
            expect(tool.execution_mode).toBe('async')
            expect(tool.timeout_ms).toBe(5000)
            expect(tool.max_concurrent).toBe(3)
        })

        it('applies defaults for optional fields', () => {
            const minimal = {
                tool_id: 'calc',
                executor: { type: 'ts_fn' as const },
            }
            const tool = ToolDefinitionSchema.parse(minimal)
            expect(tool.execution_mode).toBe('async')
            expect(tool.timeout_ms).toBe(10_000)
            expect(tool.max_concurrent).toBe(5)
            expect(tool.retry.max_attempts).toBe(1)
            expect(tool.retry.backoff_ms).toBe(200)
        })

        it('rejects empty tool_id', () => {
            expect(() =>
                ToolDefinitionSchema.parse({
                    tool_id: '',
                    executor: { type: 'ts_fn' },
                }),
            ).toThrow()
        })

        it('rejects invalid executor type', () => {
            expect(() =>
                ToolDefinitionSchema.parse({
                    tool_id: 'test',
                    executor: { type: 'invalid' },
                }),
            ).toThrow()
        })

        it('parses subprocess executor config', () => {
            const tool = ToolDefinitionSchema.parse({
                tool_id: 'python_runner',
                executor: {
                    type: 'subprocess',
                    command: 'python',
                    args: ['script.py'],
                    cwd: '/opt/scripts',
                },
            })
            expect(tool.executor.type).toBe('subprocess')
            if (tool.executor.type === 'subprocess') {
                expect(tool.executor.command).toBe('python')
                expect(tool.executor.args).toEqual(['script.py'])
                expect(tool.executor.cwd).toBe('/opt/scripts')
            }
        })

        it('rejects timeout_ms < 100', () => {
            expect(() =>
                ToolDefinitionSchema.parse({
                    tool_id: 'fast',
                    executor: { type: 'ts_fn' },
                    timeout_ms: 50,
                }),
            ).toThrow()
        })
    })
})

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMemoryStore, MemoryEntry, MemoryHit, MemoryQueryOptions } from './types.js'

export interface MemPalaceSearchInput {
  text: string
  wing?: string
  room?: string
  n: number
}

export interface MemPalaceWriteInput {
  text: string
  wing: string
  room: string
}

export interface MemPalaceTransportHit {
  text: string
  wing?: string
  room?: string
  similarity?: number
  metadata?: Record<string, unknown>
}

export interface MemPalaceTransport {
  search(input: MemPalaceSearchInput): Promise<MemPalaceTransportHit[]>
  write(input: MemPalaceWriteInput): Promise<void>
  dispose?(): void
}

export interface MemPalaceMemoryStoreOptions {
  transport: MemPalaceTransport
}

export class MemPalaceMemoryStore implements IMemoryStore {
  constructor(private readonly options: MemPalaceMemoryStoreOptions) {}

  async write(entry: MemoryEntry): Promise<void> {
    await this.options.transport.write({
      text: entry.text,
      wing: entry.wing,
      room: entry.room,
    })
  }

  async query(text: string, opts: MemoryQueryOptions = {}): Promise<MemoryHit[]> {
    const limit = opts.n ?? 3
    const hits = await this.options.transport.search({
      text,
      wing: opts.wing,
      room: opts.room,
      n: limit,
    })

    return hits
      .map((hit, index) => normalizeTransportHit(hit, opts, index))
      .filter((hit) => (opts.wing ? hit.wing === opts.wing : true))
      .filter((hit) => (opts.room ? hit.room === opts.room : true))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  dispose(): void {
    this.options.transport.dispose?.()
  }
}

export interface MemPalaceCommandResult {
  stdout: string
  stderr: string
}

export interface MemPalaceCommandRunnerOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

export type MemPalaceCommandRunner = (
  command: string,
  args: string[],
  options: MemPalaceCommandRunnerOptions,
) => Promise<MemPalaceCommandResult>

export interface MemPalaceCliTransportOptions {
  command?: string
  palacePath?: string
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  runner?: MemPalaceCommandRunner
  searchArgs?: (input: MemPalaceSearchInput) => string[]
  writeArgs?: (input: MemPalaceWriteInput, tempDir: string) => string[]
  parseSearchOutput?: (
    stdout: string,
    input: MemPalaceSearchInput,
  ) => MemPalaceTransportHit[] | Promise<MemPalaceTransportHit[]>
}

export class MemPalaceCliTransport implements MemPalaceTransport {
  private readonly command: string
  private readonly runner: MemPalaceCommandRunner

  constructor(private readonly options: MemPalaceCliTransportOptions = {}) {
    this.command = options.command ?? 'mempalace'
    this.runner = options.runner ?? runCommand
  }

  async search(input: MemPalaceSearchInput): Promise<MemPalaceTransportHit[]> {
    const result = await this.runner(this.command, this.buildSearchArgs(input), {
      cwd: this.options.cwd,
      env: this.options.env,
      timeoutMs: this.options.timeoutMs,
    })

    if (this.options.parseSearchOutput) {
      return await this.options.parseSearchOutput(result.stdout, input)
    }

    return parseMemPalaceHits(result.stdout)
  }

  async write(input: MemPalaceWriteInput): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), 'fitaly-mempalace-'))

    try {
      const filePath = join(tempDir, `${safeFilePart(input.wing)}__${safeFilePart(input.room)}.txt`)
      await writeFile(filePath, createMineFile(input), 'utf8')

      await this.runner(this.command, this.buildWriteArgs(input, tempDir), {
        cwd: this.options.cwd,
        env: this.options.env,
        timeoutMs: this.options.timeoutMs,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  private buildSearchArgs(input: MemPalaceSearchInput): string[] {
    if (this.options.searchArgs) return this.options.searchArgs(input)

    const args = ['search', input.text]
    if (input.wing) args.push('--wing', input.wing)
    if (input.room) args.push('--room', input.room)
    if (this.options.palacePath) args.push('--palace', this.options.palacePath)
    return args
  }

  private buildWriteArgs(input: MemPalaceWriteInput, tempDir: string): string[] {
    if (this.options.writeArgs) return this.options.writeArgs(input, tempDir)

    const args = ['mine', tempDir, '--mode', 'convos', '--wing', input.wing]
    if (this.options.palacePath) args.push('--palace', this.options.palacePath)
    return args
  }
}

export interface MemPalaceMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

export interface MemPalaceMcpTransportOptions {
  client: MemPalaceMcpClient
  searchToolName?: string
  writeToolName?: string
  toSearchArgs?: (input: MemPalaceSearchInput) => Record<string, unknown>
  toWriteArgs?: (input: MemPalaceWriteInput) => Record<string, unknown>
  parseSearchResponse?: (
    response: unknown,
    input: MemPalaceSearchInput,
  ) => MemPalaceTransportHit[] | Promise<MemPalaceTransportHit[]>
}

export class MemPalaceMcpTransport implements MemPalaceTransport {
  private readonly searchToolName: string
  private readonly writeToolName: string

  constructor(private readonly options: MemPalaceMcpTransportOptions) {
    this.searchToolName = options.searchToolName ?? 'mempalace_search'
    this.writeToolName = options.writeToolName ?? 'mempalace_add_drawer'
  }

  async search(input: MemPalaceSearchInput): Promise<MemPalaceTransportHit[]> {
    const response = await this.options.client.callTool(
      this.searchToolName,
      this.options.toSearchArgs?.(input) ?? defaultMcpSearchArgs(input),
    )

    if (this.options.parseSearchResponse) {
      return await this.options.parseSearchResponse(response, input)
    }

    return parseMemPalaceHits(response)
  }

  async write(input: MemPalaceWriteInput): Promise<void> {
    await this.options.client.callTool(
      this.writeToolName,
      this.options.toWriteArgs?.(input) ?? defaultMcpWriteArgs(input),
    )
  }
}

function normalizeTransportHit(
  hit: MemPalaceTransportHit,
  opts: MemoryQueryOptions,
  index: number,
): MemoryHit {
  return {
    text: hit.text,
    wing: hit.wing ?? opts.wing ?? 'mempalace',
    room: hit.room ?? opts.room ?? 'default',
    similarity: normalizeSimilarity(hit.similarity, index),
  }
}

function normalizeSimilarity(value: number | undefined, index: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 1 / (index + 1)
  }

  return Math.max(0, Math.min(1, value))
}

async function runCommand(
  command: string,
  args: string[],
  options: MemPalaceCommandRunnerOptions,
): Promise<MemPalaceCommandResult> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
        },
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }

        resolve({
          stdout,
          stderr,
        })
      },
    )
  })
}

function defaultMcpSearchArgs(input: MemPalaceSearchInput): Record<string, unknown> {
  return {
    query: input.text,
    wing: input.wing,
    room: input.room,
    limit: input.n,
  }
}

function defaultMcpWriteArgs(input: MemPalaceWriteInput): Record<string, unknown> {
  return {
    content: input.text,
    text: input.text,
    wing: input.wing,
    room: input.room,
    metadata: {
      source: 'fitalyagents',
      wing: input.wing,
      room: input.room,
    },
  }
}

function parseMemPalaceHits(value: unknown): MemPalaceTransportHit[] {
  if (typeof value === 'string') {
    const parsed = tryParseJson(value)
    if (parsed !== null) return parseMemPalaceHits(parsed)
    return parsePlainTextHits(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => toTransportHit(item)).filter(isTransportHit)
  }

  if (!isRecord(value)) return []

  const contentHits = parseMcpContent(value)
  if (contentHits.length > 0) return contentHits

  for (const key of ['results', 'hits', 'memories', 'drawers', 'items']) {
    const child = value[key]
    if (Array.isArray(child)) return parseMemPalaceHits(child)
  }

  const hit = toTransportHit(value)
  return hit ? [hit] : []
}

function parseMcpContent(value: Record<string, unknown>): MemPalaceTransportHit[] {
  const content = value.content
  if (!Array.isArray(content)) return []

  return content.flatMap((item) => {
    if (!isRecord(item)) return []
    const text = item.text
    if (typeof text !== 'string') return []
    return parseMemPalaceHits(text)
  })
}

function parsePlainTextHits(stdout: string): MemPalaceTransportHit[] {
  return stdout
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      text: block.replace(/\s+/g, ' '),
    }))
}

function toTransportHit(value: unknown): MemPalaceTransportHit | null {
  if (typeof value === 'string') return { text: value }
  if (!isRecord(value)) return null

  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const text = firstString(value, metadata, [
    'text',
    'content',
    'memory',
    'document',
    'quote',
    'snippet',
    'raw_text',
  ])

  if (!text) return null

  return {
    text,
    wing: firstString(value, metadata, ['wing']),
    room: firstString(value, metadata, ['room']),
    similarity: firstNumber(value, metadata, ['similarity', 'score', 'relevance']),
    metadata,
  }
}

function firstString(
  record: Record<string, unknown>,
  metadata: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key] ?? metadata[key]
    if (typeof value === 'string' && value.length > 0) return value
  }

  return undefined
}

function firstNumber(
  record: Record<string, unknown>,
  metadata: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key] ?? metadata[key]
    if (typeof value === 'number') return value
  }

  const distance = record.distance ?? metadata.distance
  if (typeof distance === 'number') return 1 - distance

  return undefined
}

function isTransportHit(value: MemPalaceTransportHit | null): value is MemPalaceTransportHit {
  return value !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function createMineFile(input: MemPalaceWriteInput): string {
  return [
    '# FitalyAgents memory',
    `wing: ${input.wing}`,
    `room: ${input.room}`,
    '',
    input.text,
    '',
  ].join('\n')
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'memory'
}

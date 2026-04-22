import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface DeployEnvEntry {
  key: string
  value: string
  secret: boolean
  source: 'file' | 'example'
}

interface EnvDocument {
  lines: EnvLine[]
  source: 'file' | 'example'
}

type EnvLine =
  | { type: 'blank'; raw: string }
  | { type: 'comment'; raw: string }
  | { type: 'entry'; key: string; value: string }

export async function readEnvEntries(args: {
  envFilePath: string
  envExamplePath: string
}): Promise<{
  path: string
  source: 'file' | 'example'
  entries: DeployEnvEntry[]
}> {
  const document = await readEnvDocument(args)
  return {
    path: document.source === 'file' ? args.envFilePath : args.envExamplePath,
    source: document.source,
    entries: document.lines
      .filter((line): line is Extract<EnvLine, { type: 'entry' }> => line.type === 'entry')
      .map((line) => ({
        key: line.key,
        value: line.value,
        secret: isSecretEnvKey(line.key),
        source: document.source,
      })),
  }
}

export async function patchEnvEntries(args: {
  envFilePath: string
  envExamplePath: string
  values: Record<string, string>
}): Promise<{
  path: string
  source: 'file' | 'example'
  entries: DeployEnvEntry[]
}> {
  const document = await readEnvDocument({
    envFilePath: args.envFilePath,
    envExamplePath: args.envExamplePath,
  })
  const lines = [...document.lines]

  for (const [key, value] of Object.entries(args.values)) {
    const line = lines.find(
      (entry): entry is Extract<EnvLine, { type: 'entry' }> =>
        entry.type === 'entry' && entry.key === key,
    )

    if (line) {
      line.value = value
      continue
    }

    lines.push({ type: 'entry', key, value })
  }

  await mkdir(path.dirname(args.envFilePath), { recursive: true })
  await writeFile(args.envFilePath, serializeEnvDocument(lines), 'utf8')

  return readEnvEntries(args)
}

async function readEnvDocument(args: {
  envFilePath: string
  envExamplePath: string
}): Promise<EnvDocument> {
  const fileText = await readOptionalText(args.envFilePath)
  if (fileText != null) {
    return {
      lines: parseEnvDocument(fileText),
      source: 'file',
    }
  }

  const exampleText = await readOptionalText(args.envExamplePath)
  return {
    lines: parseEnvDocument(exampleText ?? ''),
    source: 'example',
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function parseEnvDocument(text: string): EnvLine[] {
  if (!text) {
    return []
  }

  return text.split(/\r?\n/).map((line) => {
    if (line.trim().length === 0) {
      return { type: 'blank', raw: line }
    }

    if (line.trimStart().startsWith('#')) {
      return { type: 'comment', raw: line }
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex < 0) {
      return { type: 'comment', raw: `# ${line}` }
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1)
    return { type: 'entry', key, value }
  })
}

function serializeEnvDocument(lines: EnvLine[]): string {
  return `${lines
    .map((line) => {
      switch (line.type) {
        case 'blank':
          return line.raw
        case 'comment':
          return line.raw
        case 'entry':
          return `${line.key}=${line.value}`
      }
    })
    .join('\n')}\n`
}

function isSecretEnvKey(key: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)
}

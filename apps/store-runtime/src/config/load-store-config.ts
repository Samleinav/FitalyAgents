import { readFile } from 'node:fs/promises'
import path from 'node:path'
import dotenv from 'dotenv'
import { ZodError } from 'zod'
import { StoreConfigSchema, type StoreConfig } from './schema.js'
import { resolveRetailEmployees } from '../retail/staffing.js'
import { assertSupportedRetailConnectorDrivers } from '../retail/connector-support.js'

export async function loadStoreConfig(configPath: string): Promise<StoreConfig> {
  dotenv.config()

  const resolvedPath = path.resolve(configPath)
  const raw = await readFile(resolvedPath, 'utf8')

  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Could not parse store config JSON at "${resolvedPath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  try {
    const parsed = StoreConfigSchema.parse(parsedJson)
    assertSupportedRetailConnectorDrivers(parsed.connectors)
    return {
      ...parsed,
      employees: resolveRetailEmployees(parsed),
      capture:
        'pipe_path' in parsed.capture && parsed.capture.pipe_path
          ? {
              ...parsed.capture,
              pipe_path: path.resolve(path.dirname(resolvedPath), parsed.capture.pipe_path),
            }
          : parsed.capture,
      connectors: resolveConnectorPaths(path.dirname(resolvedPath), parsed.connectors),
      storage: {
        ...parsed.storage,
        sqlite_path: path.resolve(path.dirname(resolvedPath), parsed.storage.sqlite_path),
      },
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `- ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')
      throw new Error(`Invalid store config:\n${details}`)
    }

    throw error
  }
}

function resolveConnectorPaths(
  baseDir: string,
  connectors: StoreConfig['connectors'],
): StoreConfig['connectors'] {
  return Object.fromEntries(
    Object.entries(connectors).map(([key, connector]) => {
      if (connector.driver !== 'sqlite') {
        return [key, connector]
      }

      return [
        key,
        {
          ...connector,
          database: connector.database
            ? path.resolve(baseDir, connector.database)
            : connector.database,
          connection_string: connector.connection_string
            ? path.resolve(baseDir, connector.connection_string)
            : connector.connection_string,
        },
      ]
    }),
  ) as StoreConfig['connectors']
}

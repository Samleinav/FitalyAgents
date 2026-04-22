import { readFile } from 'node:fs/promises'
import path from 'node:path'
import dotenv from 'dotenv'
import { ZodError } from 'zod'
import {
  DeployCenterConfigSchema,
  type DeployCenterConfig,
  type DeployScreenConfig,
  type DeployServiceConfig,
} from './schema.js'

export async function loadDeployCenterConfig(configPath: string): Promise<DeployCenterConfig> {
  dotenv.config()

  const resolvedPath = path.resolve(configPath)
  const raw = await readFile(resolvedPath, 'utf8')
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Could not parse deploy center config JSON at "${resolvedPath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  try {
    const parsed = DeployCenterConfigSchema.parse(parsedJson)
    const baseDir = path.dirname(resolvedPath)
    return withDefaults({
      ...parsed,
      project: {
        ...parsed.project,
        store_config_path: path.resolve(baseDir, parsed.project.store_config_path),
        compose_file_path: path.resolve(baseDir, parsed.project.compose_file_path),
        working_directory: path.resolve(baseDir, parsed.project.working_directory),
        env_file_path: path.resolve(baseDir, parsed.project.env_file_path),
        env_example_path: path.resolve(baseDir, parsed.project.env_example_path),
      },
    })
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `- ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')
      throw new Error(`Invalid deploy center config:\n${details}`)
    }

    throw error
  }
}

function withDefaults(config: DeployCenterConfig): DeployCenterConfig {
  return {
    ...config,
    services: config.services.length > 0 ? config.services : buildDefaultServices(),
    screens: config.screens.length > 0 ? config.screens : buildDefaultScreens(),
  }
}

function buildDefaultServices(): DeployServiceConfig[] {
  return [
    {
      id: 'redis',
      label: 'Redis',
      service_name: 'redis',
      kind: 'infra',
      enabled: true,
    },
    {
      id: 'store-runtime',
      label: 'Store Runtime',
      service_name: 'store-runtime',
      kind: 'runtime',
      health_url: 'http://127.0.0.1:3000/health',
      enabled: true,
    },
    {
      id: 'store-ui-bridge',
      label: 'Staff UI',
      service_name: 'store-ui-bridge',
      kind: 'ui',
      health_url: 'http://127.0.0.1:3010/health',
      enabled: true,
    },
    {
      id: 'customer-display',
      label: 'Customer Display',
      service_name: 'customer-display',
      kind: 'customer-display',
      health_url: 'http://127.0.0.1:3020/health',
      enabled: true,
    },
  ]
}

function buildDefaultScreens(): DeployScreenConfig[] {
  return [
    {
      id: 'staff-ui',
      label: 'Staff UI',
      kind: 'staff-ui',
      url: 'http://127.0.0.1:3010/',
      health_url: 'http://127.0.0.1:3010/health',
      enabled: true,
    },
    {
      id: 'customer-display',
      label: 'Customer Display',
      kind: 'customer-display',
      url: 'http://127.0.0.1:3020/',
      health_url: 'http://127.0.0.1:3020/health',
      enabled: true,
    },
    {
      id: 'avatar',
      label: 'Avatar Screen',
      kind: 'avatar',
      enabled: false,
    },
  ]
}

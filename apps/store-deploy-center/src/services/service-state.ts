import type { DeployServiceConfig } from '../config/schema.js'

export interface DeployServiceStatus extends DeployServiceConfig {
  status: 'running' | 'down' | 'unverified' | 'disabled'
  health: unknown | null
  error: string | null
}

export async function resolveServiceStatuses(
  services: DeployServiceConfig[],
): Promise<DeployServiceStatus[]> {
  return Promise.all(services.map((service) => resolveSingleServiceStatus(service)))
}

async function resolveSingleServiceStatus(
  service: DeployServiceConfig,
): Promise<DeployServiceStatus> {
  if (!service.enabled) {
    return {
      ...service,
      status: 'disabled',
      health: null,
      error: null,
    }
  }

  if (!service.health_url) {
    return {
      ...service,
      status: 'unverified',
      health: null,
      error: null,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)

  try {
    const response = await fetch(service.health_url, {
      method: 'GET',
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') ?? ''
    const health = contentType.includes('application/json')
      ? await response.json()
      : await response.text()

    return {
      ...service,
      status: response.ok ? 'running' : 'down',
      health,
      error: response.ok ? null : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ...service,
      status: 'down',
      health: null,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

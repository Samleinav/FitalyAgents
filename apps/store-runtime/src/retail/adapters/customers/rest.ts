import type { RetailAdapterCatalogDeps } from '../catalog.js'
import type {
  AdapterHealth,
  CustomerAdapter,
  CustomerLookupResult,
  CustomerRegisterResult,
  RetailAdapterErrorShape,
} from '../catalog.js'
import { RetailAdapterError } from '../catalog.js'

interface CustomerRestOptions {
  healthUrl?: string
  lookupUrl?: string
  registerUrl?: string
  lookupMethod: 'GET' | 'POST'
  registerMethod: 'POST' | 'PUT'
}

export function createRestCustomerAdapter(deps: RetailAdapterCatalogDeps): CustomerAdapter {
  const connector = deps.config.connectors.customers
  const options = readRestOptions(connector.options)

  return {
    driver: 'rest',
    capabilities() {
      return ['lookup', 'register']
    },
    async health(): Promise<AdapterHealth> {
      const healthUrl = resolveUrl(connector.url, options.healthUrl) ?? connector.url
      const response = await requestJson({
        url: healthUrl,
        headers: connector.headers,
        timeoutMs: connector.health_timeout_ms,
        method: 'GET',
      })

      return {
        ok: true,
        driver: 'rest',
        details: {
          connector: 'customers',
          status: response.status,
          url: healthUrl,
        },
      }
    },
    async execute(action, input, context) {
      if (action === 'lookup') {
        const lookupInput = input as {
          customer_id?: string
          query?: string
          limit?: number
        }
        const method = options.lookupMethod
        const url = resolveUrl(connector.url, options.lookupUrl)

        const response =
          method === 'GET'
            ? await requestJson({
                url: appendSearchParams(url, {
                  customer_id: lookupInput.customer_id?.trim(),
                  query: lookupInput.query?.trim(),
                  limit: String(clampLimit(lookupInput.limit)),
                }),
                headers: connector.headers,
                timeoutMs: connector.health_timeout_ms,
                method,
              })
            : await requestJson({
                url,
                headers: connector.headers,
                timeoutMs: connector.health_timeout_ms,
                method,
                body: {
                  ...lookupInput,
                  limit: clampLimit(lookupInput.limit),
                  context,
                },
              })

        return normalizeLookupResponse(
          response.payload,
          lookupInput.query ?? lookupInput.customer_id,
        )
      }

      const registerInput = input as {
        name: string
        locale?: string
        metadata?: Record<string, unknown>
      }
      const response = await requestJson({
        url: resolveUrl(connector.url, options.registerUrl),
        headers: connector.headers,
        timeoutMs: connector.health_timeout_ms,
        method: options.registerMethod,
        body: {
          ...registerInput,
          context,
        },
      })

      return normalizeRegisterResponse(response.payload, registerInput.name.trim())
    },
  }
}

function readRestOptions(options: Record<string, unknown>): CustomerRestOptions {
  return {
    healthUrl: readOptionalString(options.health_url),
    lookupUrl: readOptionalString(options.lookup_url),
    registerUrl: readOptionalString(options.register_url),
    lookupMethod: readMethod(options.lookup_method, ['GET', 'POST'], 'GET'),
    registerMethod: readMethod(options.register_method, ['POST', 'PUT'], 'POST'),
  }
}

function normalizeLookupResponse(
  payload: unknown,
  query: string | undefined,
): CustomerLookupResult {
  const record = toRecord(payload)
  const customers = readCustomers(record.customers ?? record.items ?? record.results ?? payload)

  return {
    customers,
    text:
      readOptionalString(record.text) ??
      (customers.length > 0
        ? `Encontré ${customers.length} cliente(s) coincidente(s).`
        : query
          ? `No encontré clientes para "${query}".`
          : 'No encontré clientes con esos datos.'),
  }
}

function normalizeRegisterResponse(payload: unknown, name: string): CustomerRegisterResult {
  const record = toRecord(payload)
  const customer = toRecord(record.customer)
  const customerId =
    readOptionalString(record.customer_id) ??
    readOptionalString(record.id) ??
    readOptionalString(customer.id)

  if (!customerId) {
    throw new RetailAdapterError({
      code: 'invalid_rest_response',
      message: 'REST customer register response must include customer_id or id',
      retryable: false,
    })
  }

  return {
    customer_id: customerId,
    text: readOptionalString(record.text) ?? `Registré a ${name} correctamente.`,
  }
}

function readCustomers(value: unknown): Array<{
  id: string
  name: string
  locale: string
  metadata: Record<string, unknown>
}> {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const record = toRecord(entry)
      const id = readOptionalString(record.id)
      const name = readOptionalString(record.name)
      if (!id || !name) {
        return null
      }

      return {
        id,
        name,
        locale: readOptionalString(record.locale) ?? 'es',
        metadata: parseMetadata(record.metadata),
      }
    })
    .filter((entry) => entry !== null)
}

async function requestJson(args: {
  url: string | undefined
  headers: Record<string, string>
  timeoutMs: number
  method: 'GET' | 'POST' | 'PUT'
  body?: unknown
}): Promise<{
  status: number
  payload: unknown
}> {
  if (!args.url) {
    throw new RetailAdapterError({
      code: 'missing_rest_url',
      message: 'REST connector requires a url',
      retryable: false,
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs)

  try {
    const response = await fetch(args.url, {
      method: args.method,
      headers: {
        accept: 'application/json',
        ...(args.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...args.headers,
      },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new RetailAdapterError({
        code: 'rest_connector_http_error',
        message: `REST connector returned HTTP ${response.status}`,
        retryable: response.status >= 500,
        details: {
          status: response.status,
          url: args.url,
        },
      })
    }

    return {
      status: response.status,
      payload: await response.json(),
    }
  } catch (error) {
    if (error instanceof RetailAdapterError) {
      throw error
    }

    const shape: RetailAdapterErrorShape = {
      code:
        error instanceof Error && error.name === 'AbortError'
          ? 'rest_timeout'
          : 'rest_request_failed',
      message:
        error instanceof Error
          ? error.message
          : 'REST connector request failed for an unknown reason',
      retryable: true,
      details: {
        url: args.url,
      },
    }
    throw new RetailAdapterError(shape, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

function appendSearchParams(
  rawUrl: string | undefined,
  params: Record<string, string | undefined>,
): string | undefined {
  if (!rawUrl) {
    return undefined
  }

  const url = new URL(rawUrl)
  for (const [key, value] of Object.entries(params)) {
    if (!value) {
      continue
    }

    url.searchParams.set(key, value)
  }

  return url.toString()
}

function resolveUrl(baseUrl: string | undefined, override: string | undefined): string | undefined {
  if (!override) {
    return baseUrl
  }

  if (/^https?:\/\//.test(override)) {
    return override
  }

  if (!baseUrl) {
    return override
  }

  return appendPath(baseUrl, override)
}

function appendPath(baseUrl: string, suffix: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedSuffix = suffix.replace(/^\/+/, '')
  return `${normalizedBase}/${normalizedSuffix}`
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) {
    return 5
  }

  return Math.max(1, Math.min(20, value))
}

function readMethod<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim().toUpperCase()
  return allowed.includes(normalized) ? (normalized as T[number]) : fallback
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) {
    return {}
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  return typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

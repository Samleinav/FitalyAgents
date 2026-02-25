# Add a New Agent in 10 Minutes

> Step-by-step guide to adding a new specialist agent to your FitalyAgents application.

## What you'll build

A `CatalogAgent` that handles product catalog queries — search, details, and availability checks.

---

## Step 1 — Define the Manifest

The manifest declares what the agent can do and how it interacts with the system.

```typescript
// src/agents/catalog/catalog-agent.ts
import type { AgentManifest } from 'fitalyagents'

export function createCatalogManifest(): AgentManifest {
  return {
    agent_id: 'catalog-agent',
    role: 'worker',
    scope: 'catalog',
    capabilities: ['CATALOG_SEARCH', 'CATALOG_DETAIL', 'CATALOG_AVAILABILITY'],
    context_access: 'read_own',
    domain: 'retail',
    requires_human_approval: false,
  }
}
```

Key fields:

| Field | Description |
|---|---|
| `agent_id` | Unique identifier — used for inbox routing |
| `role` | `'worker'` (processes tasks) or `'interaction'` (talks to user) |
| `scope` | Logical grouping for this agent |
| `capabilities` | Intent IDs this agent can handle |
| `context_access` | `'read_own'` (default), `'read_all'`, `'write_own'`, `'write_all'` |
| `requires_human_approval` | Set `true` for actions like orders/refunds |

---

## Step 2 — Define the Service Interface

Always inject dependencies via interface — this makes the agent testable with mocks.

```typescript
// src/agents/catalog/types.ts

export interface Product {
  product_id: string
  name: string
  price: number
  available: boolean
}

export interface ICatalogService {
  search(query: string): Promise<Product[]>
  getDetail(productId: string): Promise<Product | null>
  checkAvailability(productId: string): Promise<{ available: boolean; stock: number }>
}
```

---

## Step 3 — Implement the Agent

```typescript
// src/agents/catalog/catalog-agent.ts
import { NexusAgent } from 'fitalyagents'
import type { IEventBus, TaskPayloadEvent, TaskResultEvent, AgentManifest } from 'fitalyagents'
import type { ICatalogService } from './types.js'

interface CatalogAgentDeps {
  bus: IEventBus
  catalogService: ICatalogService
}

export class CatalogAgent extends NexusAgent {
  private catalogService: ICatalogService

  constructor({ bus, catalogService }: CatalogAgentDeps) {
    super({ bus, manifest: createCatalogManifest() })
    this.catalogService = catalogService
  }

  async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    switch (task.intent_id) {
      case 'CATALOG_SEARCH':
        return this.handleSearch(task)
      case 'CATALOG_DETAIL':
        return this.handleDetail(task)
      case 'CATALOG_AVAILABILITY':
        return this.handleAvailability(task)
      default:
        return {
          event: 'TASK_RESULT',
          task_id: task.task_id,
          session_id: task.session_id,
          intent_id: task.intent_id,
          status: 'failed',
          result: { error: `Unknown intent: ${task.intent_id}` },
          context_patch: {},
        }
    }
  }

  private async handleSearch(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    const query = task.slots.query as string
    const products = await this.catalogService.search(query)

    await this.bus.publish('bus:ACTION_COMPLETED', {
      event: 'ACTION_COMPLETED',
      session_id: task.session_id,
      intent_id: task.intent_id,
      result: { products, text: `Found ${products.length} products for "${query}"` },
      timestamp: Date.now(),
    })

    return {
      event: 'TASK_RESULT',
      task_id: task.task_id,
      session_id: task.session_id,
      intent_id: task.intent_id,
      status: 'completed',
      result: { products },
      context_patch: { last_search: { query, result_count: products.length } },
    }
  }

  private async handleDetail(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    const productId = task.slots.product_id as string
    const product = await this.catalogService.getDetail(productId)

    if (!product) {
      return {
        event: 'TASK_RESULT',
        task_id: task.task_id,
        session_id: task.session_id,
        intent_id: task.intent_id,
        status: 'failed',
        result: { error: `Product not found: ${productId}` },
        context_patch: {},
      }
    }

    await this.bus.publish('bus:ACTION_COMPLETED', {
      event: 'ACTION_COMPLETED',
      session_id: task.session_id,
      intent_id: task.intent_id,
      result: { product, text: `${product.name} — $${product.price}` },
      timestamp: Date.now(),
    })

    return {
      event: 'TASK_RESULT',
      task_id: task.task_id,
      session_id: task.session_id,
      intent_id: task.intent_id,
      status: 'completed',
      result: { product },
      context_patch: { last_viewed_product: productId },
    }
  }

  private async handleAvailability(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    const productId = task.slots.product_id as string
    const availability = await this.catalogService.checkAvailability(productId)

    const text = availability.available
      ? `In stock — ${availability.stock} units available`
      : `Out of stock`

    await this.bus.publish('bus:ACTION_COMPLETED', {
      event: 'ACTION_COMPLETED',
      session_id: task.session_id,
      intent_id: task.intent_id,
      result: { ...availability, text },
      timestamp: Date.now(),
    })

    return {
      event: 'TASK_RESULT',
      task_id: task.task_id,
      session_id: task.session_id,
      intent_id: task.intent_id,
      status: 'completed',
      result: availability,
      context_patch: { last_availability_check: { product_id: productId, ...availability } },
    }
  }
}
```

---

## Step 4 — Create a Mock Service for Tests

```typescript
// src/agents/catalog/mock-catalog-service.ts
import type { ICatalogService, Product } from './types.js'

interface MockCatalogServiceOptions {
  latencyMs?: number
  products?: Product[]
}

export class MockCatalogService implements ICatalogService {
  private latencyMs: number
  private products: Product[]

  constructor({ latencyMs = 0, products = [] }: MockCatalogServiceOptions = {}) {
    this.latencyMs = latencyMs
    this.products = products.length > 0 ? products : [
      { product_id: 'PROD_001', name: 'Nike Air Max', price: 129.99, available: true },
      { product_id: 'PROD_002', name: 'Adidas Stan Smith', price: 89.99, available: true },
      { product_id: 'PROD_003', name: 'Vans Old Skool', price: 74.99, available: false },
    ]
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs))
    }
  }

  async search(query: string): Promise<Product[]> {
    await this.delay()
    const q = query.toLowerCase()
    return this.products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.product_id.toLowerCase().includes(q),
    )
  }

  async getDetail(productId: string): Promise<Product | null> {
    await this.delay()
    return this.products.find((p) => p.product_id === productId) ?? null
  }

  async checkAvailability(productId: string): Promise<{ available: boolean; stock: number }> {
    await this.delay()
    const product = this.products.find((p) => p.product_id === productId)
    if (!product) return { available: false, stock: 0 }
    return { available: product.available, stock: product.available ? 42 : 0 }
  }
}
```

---

## Step 5 — Write Tests

```typescript
// src/agents/catalog/catalog-agent.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { CatalogAgent } from './catalog-agent.js'
import { MockCatalogService } from './mock-catalog-service.js'

describe('CatalogAgent', () => {
  let bus: InMemoryBus
  let agent: CatalogAgent
  let service: MockCatalogService

  beforeEach(async () => {
    bus = new InMemoryBus()
    service = new MockCatalogService()
    agent = new CatalogAgent({ bus, catalogService: service })
    await agent.start()
  })

  afterEach(async () => {
    await agent.shutdown()
  })

  it('CATALOG_SEARCH returns matching products', async () => {
    const result = await agent.process({
      event: 'TASK_PAYLOAD',
      task_id: 'task_001',
      session_id: 'sess_001',
      intent_id: 'CATALOG_SEARCH',
      slots: { query: 'nike' },
      context_snapshot: {},
      cancel_token: null,
      timeout_ms: 5000,
      reply_to: 'queue:catalog:outbox',
    })

    expect(result.status).toBe('completed')
    const products = (result.result as Record<string, unknown>).products as unknown[]
    expect(products).toHaveLength(1)
  })

  it('CATALOG_DETAIL returns product or fails gracefully', async () => {
    const result = await agent.process({
      event: 'TASK_PAYLOAD',
      task_id: 'task_002',
      session_id: 'sess_001',
      intent_id: 'CATALOG_DETAIL',
      slots: { product_id: 'NOT_FOUND' },
      context_snapshot: {},
      cancel_token: null,
      timeout_ms: 5000,
      reply_to: 'queue:catalog:outbox',
    })

    expect(result.status).toBe('failed')
  })
})
```

Run:
```bash
npx vitest run --root src/agents/catalog
```

---

## Step 6 — Register with the Router

```typescript
import { CapabilityRouter } from 'fitalyagents'
import { AgentRegistry } from 'fitalyagents'

const registry = new AgentRegistry({ bus })
const router = new CapabilityRouter({ bus, registry, ... })

// Register the agent's manifest
registry.register(createCatalogManifest())

// Now tasks with intent CATALOG_SEARCH/DETAIL/AVAILABILITY will route to catalog-agent
```

---

## Checklist

- [ ] Manifest defined with unique `agent_id` and correct `capabilities`
- [ ] Service interface defined and injected
- [ ] All intent IDs handled (including `default` case returning `failed`)
- [ ] `bus:ACTION_COMPLETED` published for completed intents
- [ ] `context_patch` populated with relevant data
- [ ] Mock service created for tests
- [ ] Tests written and passing
- [ ] Agent registered in router

import type { IEventBus, Unsubscribe } from '../types/index.js'
import type { ApprovalLimits, HumanProfile, HumanRole } from '../safety/channels/types.js'
import type { HumanPresenceStatus, IPresenceManager, PresenceEntry } from './types.js'

export interface InMemoryPresenceManagerDeps {
  bus?: IEventBus
}

type HumanPresenceChangedPayload = {
  human_id?: string
  name?: string
  role?: HumanRole
  status?: HumanPresenceStatus
  org_id?: string
  store_id?: string
  approval_limits?: ApprovalLimits
  timestamp?: number
}

const ROLE_RANK: Record<HumanRole, number> = {
  customer: 0,
  user: 0,
  staff: 1,
  agent: 1,
  cashier: 2,
  operator: 2,
  manager: 3,
  supervisor: 3,
  owner: 4,
}

export class InMemoryPresenceManager implements IPresenceManager {
  private readonly bus: IEventBus | undefined
  private readonly entries = new Map<string, PresenceEntry>()
  private unsub: Unsubscribe | null = null

  constructor(deps: InMemoryPresenceManagerDeps = {}) {
    this.bus = deps.bus
  }

  start(): Unsubscribe {
    if (!this.bus) return () => {}
    if (!this.unsub) {
      this.unsub = this.bus.subscribe('bus:HUMAN_PRESENCE_CHANGED', (payload) => {
        const event = payload as HumanPresenceChangedPayload
        if (!event.human_id || !event.role || !event.status) return

        this.update(
          {
            id: event.human_id,
            name: event.name ?? event.human_id,
            role: event.role,
            org_id: event.org_id,
            store_id: event.store_id,
            approval_limits: event.approval_limits ?? {},
            is_present: event.status !== 'offline',
          },
          event.status,
          event.store_id,
        )
      })
    }

    return () => this.dispose()
  }

  update(human: HumanProfile, status: HumanPresenceStatus, store_id?: string): void {
    this.entries.set(human.id, {
      human: {
        ...human,
        is_present: status !== 'offline',
      },
      status,
      last_seen: Date.now(),
      store_id: store_id ?? human.store_id,
    })
  }

  getAvailable(role: HumanRole, store_id?: string): HumanProfile[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status === 'available')
      .filter((entry) => roleSatisfies(entry.human.role, role))
      .filter(
        (entry) => !store_id || entry.store_id === store_id || entry.human.store_id === store_id,
      )
      .map((entry) => entry.human)
  }

  markBusy(human_id: string): void {
    this.updateStatus(human_id, 'busy')
  }

  markFree(human_id: string): void {
    this.updateStatus(human_id, 'available')
  }

  getStatus(human_id: string): HumanPresenceStatus | null {
    return this.entries.get(human_id)?.status ?? null
  }

  listPresent(store_id?: string): PresenceEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status !== 'offline')
      .filter(
        (entry) => !store_id || entry.store_id === store_id || entry.human.store_id === store_id,
      )
      .map((entry) => ({
        ...entry,
        human: { ...entry.human },
      }))
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
  }

  private updateStatus(humanId: string, status: HumanPresenceStatus): void {
    const entry = this.entries.get(humanId)
    if (!entry) return

    this.entries.set(humanId, {
      ...entry,
      human: {
        ...entry.human,
        is_present: status !== 'offline',
      },
      status,
      last_seen: Date.now(),
    })
  }
}

function roleSatisfies(actual: HumanRole, required: HumanRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

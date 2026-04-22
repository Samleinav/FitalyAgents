import type { MemoryScopeResolver } from '@fitalyagents/dispatcher'
import type { StoreConfig } from '../config/schema.js'

const STAFF_ROLES = new Set([
  'staff',
  'agent',
  'cashier',
  'operator',
  'manager',
  'supervisor',
  'owner',
])

export function buildMemoryScopeResolver(config: StoreConfig): MemoryScopeResolver {
  return ({ session_id, speaker_id, role, actor_type, store_id, group_id }) => {
    const resolvedRole = actor_type ?? role ?? null

    if ((resolvedRole === 'customer' || resolvedRole === 'user') && speaker_id) {
      return {
        wing: 'customer',
        room: speaker_id,
      }
    }

    if (resolvedRole && STAFF_ROLES.has(resolvedRole)) {
      return {
        wing: 'employee',
        room: speaker_id ?? `${session_id}:employee`,
      }
    }

    if (group_id) {
      return {
        wing: 'group',
        room: group_id,
      }
    }

    return {
      wing: 'store',
      room: store_id ?? config.store.store_id,
    }
  }
}

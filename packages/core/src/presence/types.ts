import type { HumanProfile, HumanRole } from '../safety/channels/types.js'

export type HumanPresenceStatus = 'available' | 'busy' | 'offline' | 'on_break'

export interface PresenceEntry {
  human: HumanProfile
  status: HumanPresenceStatus
  last_seen: number
  store_id?: string
}

export interface IPresenceManager {
  /** Register or update a human's presence state. */
  update(human: HumanProfile, status: HumanPresenceStatus, store_id?: string): void

  /** Get all available humans whose role satisfies the required role. */
  getAvailable(role: HumanRole, store_id?: string): HumanProfile[]

  /** Mark a human as busy while they handle an approval. */
  markBusy(human_id: string): void

  /** Mark a human as available after an approval resolves or times out. */
  markFree(human_id: string): void

  /** Get current status for a specific human. */
  getStatus(human_id: string): HumanPresenceStatus | null

  /** List all humans that are not offline. */
  listPresent(store_id?: string): PresenceEntry[]
}

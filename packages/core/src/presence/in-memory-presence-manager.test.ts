import { describe, expect, it } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import type { HumanProfile } from '../safety/channels/types.js'
import { InMemoryPresenceManager } from './in-memory-presence-manager.js'

function makeHuman(
  overrides: Partial<HumanProfile> & Pick<HumanProfile, 'id' | 'role'>,
): HumanProfile {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    role: overrides.role,
    org_id: 'org_1',
    store_id: 'store_1',
    approval_limits: {},
    ...overrides,
  }
}

describe('InMemoryPresenceManager', () => {
  it('tracks available humans by role and store', () => {
    const manager = new InMemoryPresenceManager()
    manager.update(makeHuman({ id: 'manager_1', role: 'manager' }), 'available', 'store_1')
    manager.update(
      makeHuman({ id: 'manager_2', role: 'manager', store_id: 'store_2' }),
      'available',
    )
    manager.update(makeHuman({ id: 'cashier_1', role: 'cashier' }), 'available', 'store_1')

    expect(manager.getAvailable('manager', 'store_1').map((human) => human.id)).toEqual([
      'manager_1',
    ])
    expect(manager.getAvailable('cashier', 'store_1').map((human) => human.id)).toEqual([
      'manager_1',
      'cashier_1',
    ])
  })

  it('allows higher roles to satisfy lower approval roles', () => {
    const manager = new InMemoryPresenceManager()
    manager.update(makeHuman({ id: 'owner_1', role: 'owner' }), 'available', 'store_1')
    manager.update(makeHuman({ id: 'supervisor_1', role: 'supervisor' }), 'available', 'store_1')
    manager.update(makeHuman({ id: 'cashier_1', role: 'cashier' }), 'available', 'store_1')

    expect(manager.getAvailable('manager', 'store_1').map((human) => human.id)).toEqual([
      'owner_1',
      'supervisor_1',
    ])
  })

  it('marks humans busy and free', () => {
    const manager = new InMemoryPresenceManager()
    manager.update(makeHuman({ id: 'manager_1', role: 'manager' }), 'available', 'store_1')

    manager.markBusy('manager_1')
    expect(manager.getStatus('manager_1')).toBe('busy')
    expect(manager.getAvailable('manager')).toHaveLength(0)

    manager.markFree('manager_1')
    expect(manager.getStatus('manager_1')).toBe('available')
    expect(manager.getAvailable('manager')).toHaveLength(1)
  })

  it('lists present humans and excludes offline entries', () => {
    const manager = new InMemoryPresenceManager()
    manager.update(makeHuman({ id: 'manager_1', role: 'manager' }), 'available', 'store_1')
    manager.update(makeHuman({ id: 'manager_2', role: 'manager' }), 'offline', 'store_1')
    manager.update(makeHuman({ id: 'cashier_1', role: 'cashier' }), 'on_break', 'store_1')

    expect(manager.listPresent('store_1').map((entry) => entry.human.id)).toEqual([
      'manager_1',
      'cashier_1',
    ])
  })

  it('can subscribe to HUMAN_PRESENCE_CHANGED events', async () => {
    const bus = new InMemoryBus()
    const manager = new InMemoryPresenceManager({ bus })
    const stop = manager.start()

    await bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
      event: 'HUMAN_PRESENCE_CHANGED',
      human_id: 'manager_1',
      name: 'Ana',
      role: 'manager',
      status: 'available',
      store_id: 'store_1',
      approval_limits: { refund_max: 100_000 },
      timestamp: Date.now(),
    })

    expect(manager.getAvailable('manager', 'store_1')[0]).toMatchObject({
      id: 'manager_1',
      name: 'Ana',
      role: 'manager',
      is_present: true,
    })

    stop()
  })

  it('can stop and start the bus subscription again', async () => {
    const bus = new InMemoryBus()
    const manager = new InMemoryPresenceManager({ bus })

    const stop = manager.start()
    stop()
    manager.start()

    await bus.publish('bus:HUMAN_PRESENCE_CHANGED', {
      event: 'HUMAN_PRESENCE_CHANGED',
      human_id: 'manager_1',
      role: 'manager',
      status: 'available',
      store_id: 'store_1',
      timestamp: Date.now(),
    })

    expect(manager.getAvailable('manager', 'store_1')).toHaveLength(1)

    manager.dispose()
  })
})

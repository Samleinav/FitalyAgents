import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryBus, MockAvatarRenderer } from 'fitalyagents'
import { startAvatarService } from './avatar-service.js'
import {
  cleanupTempDir,
  createBaseConfig,
  createTempDir,
  writeJsonFile,
} from '../../test/helpers.js'

describe('avatar-service', () => {
  it('starts an external avatar agent and reacts to bus events', async () => {
    const dir = await createTempDir()
    const configPath = path.join(dir, 'store.config.json')
    const bus = new InMemoryBus()
    const renderer = new MockAvatarRenderer()

    await writeJsonFile(
      configPath,
      createBaseConfig({
        avatar: {
          enabled: true,
          mode: 'external',
          airi_url: 'ws://avatar:6006',
        },
      }),
    )

    const service = await startAvatarService({
      configPath,
      bus,
      renderer,
    })

    try {
      await bus.publish('bus:TARGET_GROUP_CHANGED', {
        event: 'TARGET_GROUP_CHANGED',
        store_id: 'store-test',
        primary: 'customer-1',
        queued: [],
        ambient: [],
        speakers: [{ speakerId: 'customer-1', state: 'targeted' }],
        timestamp: Date.now(),
      })

      expect(renderer.commands.some((command) => command.type === 'look_at')).toBe(true)
    } finally {
      await service.shutdown()
      await cleanupTempDir(dir)
    }
  })

  it('rejects configs that keep avatar mode internal', async () => {
    const dir = await createTempDir()
    const configPath = path.join(dir, 'store.config.json')

    await writeJsonFile(
      configPath,
      createBaseConfig({
        avatar: {
          enabled: true,
          mode: 'internal',
          airi_url: 'ws://avatar:6006',
        },
      }),
    )

    await expect(startAvatarService({ configPath, bus: new InMemoryBus() })).rejects.toThrow(
      /avatar\.mode="external"/,
    )

    await cleanupTempDir(dir)
  })
})

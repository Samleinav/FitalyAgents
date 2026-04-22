import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { UIEventStreamHub, startUiBridgeService } from './ui-bridge.js'
import {
  cleanupTempDir,
  createBaseConfig,
  createTempDir,
  writeJsonFile,
} from '../../test/helpers.js'

describe('ui-bridge', () => {
  it('replays the last UI update to late subscribers', () => {
    const hub = new UIEventStreamHub()
    const writes: string[] = []

    hub.publish({ event: 'UI_UPDATE', component: 'queue_status' })
    const unsubscribe = hub.subscribe({
      send(chunk) {
        writes.push(chunk)
      },
    })

    expect(writes[0]).toContain('retry: 3000')
    expect(writes[1]).toContain('event: ui_update')
    expect(writes[1]).toContain('"component":"queue_status"')

    unsubscribe()
    expect(hub.getClientCount()).toBe(0)
  })

  it('forwards bus:UI_UPDATE events into the SSE hub and health endpoint', async () => {
    const dir = await createTempDir()
    const configPath = path.join(dir, 'store.config.json')
    const bus = new InMemoryBus()

    await writeJsonFile(configPath, createBaseConfig())

    const service = await startUiBridgeService({
      configPath,
      bus,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      await bus.publish('bus:TARGET_GROUP_CHANGED', {
        event: 'TARGET_GROUP_CHANGED',
        store_id: 'store-test',
        primary: 'speaker-a',
        queued: ['speaker-b'],
        ambient: [],
        speakers: [
          { speakerId: 'speaker-a', state: 'targeted' },
          { speakerId: 'speaker-b', state: 'queued' },
        ],
        timestamp: 1,
      })
      await bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-a',
        speaker_id: 'speaker-a',
        text: 'Quiero unas zapatillas blancas.',
        timestamp: 2,
      })
      await bus.publish('bus:RESPONSE_START', {
        event: 'RESPONSE_START',
        session_id: 'session-a',
        speaker_id: 'speaker-a',
        turn_id: 'turn-a',
        timestamp: 3,
      })
      await bus.publish('bus:AVATAR_SPEAK', {
        event: 'AVATAR_SPEAK',
        session_id: 'session-a',
        speaker_id: 'speaker-a',
        turn_id: 'turn-a',
        text: 'Te muestro dos opciones.',
        is_final: true,
        timestamp: 4,
      })
      await bus.publish('bus:RESPONSE_END', {
        event: 'RESPONSE_END',
        session_id: 'session-a',
        speaker_id: 'speaker-a',
        turn_id: 'turn-a',
        reason: 'end_turn',
        timestamp: 5,
      })
      await bus.publish('bus:UI_UPDATE', {
        event: 'UI_UPDATE',
        component: 'approval_bar',
        action: 'update',
        data: { approved: true },
        timestamp: 6,
      })
      await bus.publish('bus:ORDER_QUEUED_NO_APPROVER', {
        event: 'ORDER_QUEUED_NO_APPROVER',
        request_id: 'approval-1',
        draft_id: 'draft-1',
        session_id: 'session-a',
        required_role: 'manager',
        queued_at: 7,
        timestamp: 7,
      })
      await bus.publish('bus:APPROVAL_RESOLVED', {
        event: 'APPROVAL_RESOLVED',
        request_id: 'approval-1',
        draft_id: 'draft-1',
        session_id: 'session-a',
        approved: true,
        approver_id: 'mgr-1',
        channel_used: 'webhook',
        timestamp: 8,
      })

      expect(service.hub.getLastUpdate()).toEqual({
        event: 'UI_UPDATE',
        component: 'approval_bar',
        action: 'update',
        data: { approved: true },
        timestamp: 6,
      })
      expect(service.hub.getLastState()?.queue.primary).toBe('speaker-a')
      expect(service.hub.getLastState()?.approvals.lastResolved).toMatchObject({
        requestId: 'approval-1',
        approved: true,
        approverId: 'mgr-1',
      })
      expect(service.stateStore.getState().transcript.turns[0]).toMatchObject({
        sessionId: 'session-a',
        userText: 'Quiero unas zapatillas blancas.',
        assistantText: 'Te muestro dos opciones.',
        status: 'completed',
      })

      const response = await service.server.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: 'ok',
        store_id: 'store-test',
        subscribers: 0,
        has_last_update: true,
      })

      const stateResponse = await service.server.inject({
        method: 'GET',
        url: '/state',
      })

      expect(stateResponse.statusCode).toBe(200)
      expect(stateResponse.json()).toMatchObject({
        storeId: 'store-test',
        queue: {
          primary: 'speaker-a',
          queued: ['speaker-b'],
        },
        approvals: {
          pending: [],
        },
      })

      const pageResponse = await service.server.inject({
        method: 'GET',
        url: '/',
      })

      expect(pageResponse.statusCode).toBe(200)
      expect(pageResponse.headers['content-type']).toContain('text/html')
      expect(pageResponse.body).toContain('Store Runtime Console')
      expect(pageResponse.body).toContain('Aprobaciones')
    } finally {
      await service.shutdown()
      await cleanupTempDir(dir)
    }
  })
})

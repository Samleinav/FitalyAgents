import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { InMemoryBus, InMemorySessionManager, TargetGroupBridge } from 'fitalyagents'
import { MockSTTProvider } from '../providers/stt/mock.js'
import { createBaseConfig } from '../../test/helpers.js'
import { buildSpeakerSessionId } from './speaker-session.js'
import { parseVoiceEventLine, startSttBridge } from './stt-bridge.js'

describe('stt-bridge', () => {
  it('publishes speaker detection before speech events in local STT mode', async () => {
    const bus = new InMemoryBus()
    const input = new PassThrough()
    const events: string[] = []

    bus.subscribe('bus:SPEAKER_DETECTED', () => {
      events.push('detected')
    })
    bus.subscribe('bus:SPEECH_PARTIAL', () => {
      events.push('partial')
    })
    bus.subscribe('bus:SPEECH_FINAL', () => {
      events.push('final')
    })

    const handle = await startSttBridge(
      createBaseConfig(),
      new MockSTTProvider(),
      bus,
      { isSessionBusy: () => false } as never,
      { input },
    )

    input.write('customer-2|customer|hola equipo\n')
    await waitFor(() => events.length === 3)

    expect(events).toEqual(['detected', 'partial', 'final'])

    handle.close()
  })

  it('normalizes voice-sidecar stdout events into bus payloads', () => {
    const event = parseVoiceEventLine(
      JSON.stringify({
        channel: 'bus:SPEECH_FINAL',
        event: 'SPEECH_FINAL',
        speaker_id: 'trk:store:001',
        text: 'hola mundo',
        confidence: 0.91,
      }),
      'store-test',
      'es',
    )

    expect(event).toEqual({
      channel: 'bus:SPEECH_FINAL',
      payload: {
        event: 'SPEECH_FINAL',
        session_id: buildSpeakerSessionId('store-test', 'trk:store:001'),
        text: 'hola mundo',
        confidence: 0.91,
        speaker_id: 'trk:store:001',
        role: undefined,
        actor_type: undefined,
        store_id: 'store-test',
        locale: 'es',
        timestamp: expect.any(Number),
      },
    })
  })

  it('uses the store locale as fallback when voice events omit locale', () => {
    const event = parseVoiceEventLine(
      JSON.stringify({
        channel: 'bus:SPEECH_FINAL',
        event: 'SPEECH_FINAL',
        speaker_id: 'trk:store:002',
        text: 'bonjour',
      }),
      'store-test',
      'fr',
    )

    expect(event).toEqual({
      channel: 'bus:SPEECH_FINAL',
      payload: {
        event: 'SPEECH_FINAL',
        session_id: buildSpeakerSessionId('store-test', 'trk:store:002'),
        text: 'bonjour',
        confidence: undefined,
        speaker_id: 'trk:store:002',
        role: undefined,
        actor_type: undefined,
        store_id: 'store-test',
        locale: 'fr',
        timestamp: expect.any(Number),
      },
    })
  })

  it('feeds voice-sidecar speaker events into TargetGroupBridge with stable session ids', async () => {
    const bus = new InMemoryBus()
    const input = new PassThrough()
    const sessionManager = new InMemorySessionManager()
    const bridge = new TargetGroupBridge({
      bus,
      sessionManager,
      storeId: 'store-test',
    })
    await bridge.start()

    const config = createBaseConfig({
      capture: {
        driver: 'voice-events',
        input: 'stdin',
        format: 'ndjson',
      },
    })

    const handle = await startSttBridge(
      config,
      null,
      bus,
      { isSessionBusy: () => false } as never,
      { input },
    )

    input.write(
      `${JSON.stringify({
        channel: 'bus:SPEAKER_DETECTED',
        event: 'SPEAKER_DETECTED',
        speaker_id: 'trk:voice:001',
        store_id: 'store-test',
      })}\n`,
    )

    await waitFor(() => bridge.getSessionForSpeaker('trk:voice:001') != null)

    expect(bridge.getSessionForSpeaker('trk:voice:001')).toBe(
      buildSpeakerSessionId('store-test', 'trk:voice:001'),
    )
    expect(
      await sessionManager.getSession(buildSpeakerSessionId('store-test', 'trk:voice:001')),
    ).not.toBeNull()

    handle.close()
    await bridge.stop()
  })

  it('returns a no-op bridge in external-bus mode', async () => {
    const bus = new InMemoryBus()
    const input = new PassThrough()
    const events: string[] = []

    bus.subscribe('bus:SPEAKER_DETECTED', () => {
      events.push('detected')
    })

    const handle = await startSttBridge(
      createBaseConfig({
        capture: {
          driver: 'external-bus',
        },
      }),
      null,
      bus,
      { isSessionBusy: () => false } as never,
      { input },
    )

    input.write('customer-1|customer|hola\n')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(events).toEqual([])
    handle.close()
  })

  it('does not duplicate ambient transitions in voice-events mode', async () => {
    const bus = new InMemoryBus()
    const input = new PassThrough()
    const sessionManager = new InMemorySessionManager()
    const bridge = new TargetGroupBridge({
      bus,
      sessionManager,
      storeId: 'store-test',
    })
    const snapshots: Array<{ ambient: string[] }> = []

    bus.subscribe('bus:TARGET_GROUP_CHANGED', (payload) => {
      const snapshot = payload as { ambient: string[] }
      snapshots.push({ ambient: snapshot.ambient })
    })

    await bridge.start()

    const handle = await startSttBridge(
      createBaseConfig({
        capture: {
          driver: 'voice-events',
          input: 'stdin',
          format: 'ndjson',
        },
      }),
      null,
      bus,
      { isSessionBusy: () => false } as never,
      { input },
    )

    input.write(
      `${JSON.stringify({
        channel: 'bus:AMBIENT_CONTEXT',
        event: 'AMBIENT_CONTEXT',
        speaker_id: 'ambient-1',
        text: 'conversacion de fondo',
      })}\n`,
    )

    await waitFor(() => snapshots.length === 1)
    expect(snapshots).toEqual([{ ambient: ['ambient-1'] }])

    handle.close()
    await bridge.stop()
  })
})

async function waitFor(assertion: () => boolean, timeoutMs = 250): Promise<void> {
  const startedAt = Date.now()

  while (!assertion()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for async assertion')
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

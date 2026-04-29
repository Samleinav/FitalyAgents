import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { createBaseConfig } from '../../test/helpers.js'
import {
  LiveKitVoiceBridgeManager,
  NoopLiveKitBridgeTransport,
  type LiveKitBridgeOutboundEvent,
} from './livekit-voice-bridge.js'

describe('livekit-voice-bridge', () => {
  it('maps LiveKit participant transcripts into Fitaly speech events', async () => {
    const bus = new InMemoryBus()
    const config = createBaseConfig({
      capture: { driver: 'external-bus' },
      livekit_voice_bridge: {
        ...createBaseConfig().livekit_voice_bridge,
        enabled: true,
      },
    })
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = []

    for (const channel of ['bus:SPEAKER_DETECTED', 'bus:SPEECH_PARTIAL', 'bus:SPEECH_FINAL']) {
      bus.subscribe(channel, (payload) => {
        events.push({ channel, payload: payload as Record<string, unknown> })
      })
    }

    const manager = new LiveKitVoiceBridgeManager({
      bus,
      config,
      transport: new NoopLiveKitBridgeTransport(),
    })

    await manager.ingestTranscript({
      participantIdentity: 'lk-customer-1',
      text: 'quiero unos tenis',
      final: false,
      timestamp: 100,
    })

    await manager.ingestTranscript({
      participantIdentity: 'lk-customer-1',
      text: 'quiero unos tenis talla 42',
      final: true,
      timestamp: 200,
    })

    expect(events.map((event) => event.channel)).toEqual([
      'bus:SPEAKER_DETECTED',
      'bus:SPEECH_PARTIAL',
      'bus:SPEECH_FINAL',
    ])
    expect(events[0]?.payload).toMatchObject({
      session_id: 'session_store-test_lk-customer-1',
      speaker_id: 'lk-customer-1',
      participant_identity: 'lk-customer-1',
      source: 'livekit',
    })
    expect(events[2]?.payload).toMatchObject({
      text: 'quiero unos tenis talla 42',
      role: 'customer',
      locale: 'es',
    })
  })

  it('publishes barge-in when a participant speaks during an active response', async () => {
    const bus = new InMemoryBus()
    const config = createBaseConfig({
      capture: { driver: 'external-bus' },
      livekit_voice_bridge: {
        ...createBaseConfig().livekit_voice_bridge,
        enabled: true,
      },
    })
    const bargeIns: Record<string, unknown>[] = []

    bus.subscribe('bus:BARGE_IN', (payload) => {
      bargeIns.push(payload as Record<string, unknown>)
    })

    const manager = new LiveKitVoiceBridgeManager({
      bus,
      config,
      transport: new NoopLiveKitBridgeTransport(),
    })

    await manager.ingestTranscript({
      participantIdentity: 'lk-customer-1',
      text: 'hola',
      final: true,
    })

    await manager.handleBusEvent('bus:RESPONSE_START', {
      session_id: 'session_store-test_lk-customer-1',
      speaker_id: 'lk-customer-1',
    })

    await manager.ingestTranscript({
      participantIdentity: 'lk-customer-1',
      text: 'espera',
      final: false,
      timestamp: 300,
    })

    expect(bargeIns).toHaveLength(1)
    expect(bargeIns[0]).toMatchObject({
      session_id: 'session_store-test_lk-customer-1',
      speaker_id: 'lk-customer-1',
      timestamp: 300,
    })
  })

  it('forwards runtime response and TTS events to the bridge transport', async () => {
    const bus = new InMemoryBus()
    const transport = new NoopLiveKitBridgeTransport()
    const manager = new LiveKitVoiceBridgeManager({
      bus,
      config: createBaseConfig({
        livekit_voice_bridge: {
          ...createBaseConfig().livekit_voice_bridge,
          enabled: true,
        },
      }),
      transport,
    })

    const payload = {
      session_id: 'session_store-test_lk-customer-1',
      segment_id: 'seg-1',
      chunk_base64: 'YWJj',
    }

    await manager.handleBusEvent('bus:TTS_AUDIO_CHUNK', payload)

    expect(transport.sent).toEqual([
      expect.objectContaining<Partial<LiveKitBridgeOutboundEvent>>({
        type: 'runtime_event',
        channel: 'bus:TTS_AUDIO_CHUNK',
        payload,
      }),
    ])
  })
})

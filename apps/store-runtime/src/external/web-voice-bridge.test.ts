import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import WebSocket from 'ws'
import { startWebVoiceBridgeService } from './web-voice-bridge.js'
import {
  cleanupTempDir,
  createBaseConfig,
  createTempDir,
  writeJsonFile,
} from '../../test/helpers.js'

describe('web-voice-bridge', () => {
  const sockets = new Set<WebSocket>()
  const dirs = new Set<string>()

  afterEach(async () => {
    for (const socket of sockets) {
      socket.close()
    }
    sockets.clear()

    for (const dir of dirs) {
      await cleanupTempDir(dir)
    }
    dirs.clear()
  })

  it('accepts a websocket session, publishes transcript events, and forwards runtime turn updates', async () => {
    const dir = await createTempDir('web-voice-bridge-')
    dirs.add(dir)

    const configPath = path.join(dir, 'store.config.json')
    const bus = new InMemoryBus()
    const speechFinals: Array<Record<string, unknown>> = []

    bus.subscribe('bus:SPEECH_FINAL', (payload) => {
      speechFinals.push(payload as Record<string, unknown>)
    })

    await writeJsonFile(configPath, {
      ...createBaseConfig(),
      capture: { driver: 'external-bus' },
      web_voice_bridge: {
        ...createBaseConfig().web_voice_bridge,
        enabled: true,
        publish_mode: 'local',
      },
    })

    const service = await startWebVoiceBridgeService({
      configPath,
      bus,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      const address = service.server.server.address() as AddressInfo
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice`)
      sockets.add(socket)

      const messages: Array<Record<string, unknown>> = []

      socket.on('message', (raw) => {
        const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw)
        messages.push(JSON.parse(text) as Record<string, unknown>)
      })

      await onceOpen(socket)

      socket.send(
        JSON.stringify({
          type: 'hello',
          surface: 'avatar',
          speaker_id: 'browser_customer',
        }),
      )

      const ready = await waitForMessage(messages, (message) => message.type === 'ready')
      expect(ready).toMatchObject({
        type: 'ready',
        speaker_id: 'browser_customer',
        surface: 'avatar',
      })

      socket.send(JSON.stringify({ type: 'vad_start' }))
      socket.send(
        JSON.stringify({
          type: 'audio_chunk',
          data: Buffer.from('hola desde web\n', 'utf8').toString('base64'),
        }),
      )
      socket.send(JSON.stringify({ type: 'vad_stop' }))

      const partial = await waitForMessage(
        messages,
        (message) => message.type === 'partial_transcript' && message.text === 'hola desde web',
      )
      expect(partial.session_id).toBe(ready.session_id)

      const final = await waitForMessage(
        messages,
        (message) => message.type === 'final_transcript' && message.text === 'hola desde web',
      )
      expect(final.session_id).toBe(ready.session_id)

      await waitForCondition(() => speechFinals.length > 0)
      expect(speechFinals[0]).toMatchObject({
        event: 'SPEECH_FINAL',
        session_id: ready.session_id,
        speaker_id: 'browser_customer',
        text: 'hola desde web',
      })

      await bus.publish('bus:RESPONSE_START', {
        event: 'RESPONSE_START',
        session_id: ready.session_id,
        speaker_id: 'browser_customer',
        turn_id: 'turn-1',
        timestamp: 1,
      })
      await bus.publish('bus:AVATAR_SPEAK', {
        event: 'AVATAR_SPEAK',
        session_id: ready.session_id,
        speaker_id: 'browser_customer',
        turn_id: 'turn-1',
        text: 'Claro, te ayudo con eso.',
        is_final: true,
        timestamp: 2,
      })
      await bus.publish('bus:TTS_SEGMENT_START', {
        event: 'TTS_SEGMENT_START',
        session_id: ready.session_id,
        segment_id: 'segment-1',
        encoding: 'pcm_s16le',
        mime_type: 'audio/raw',
        sample_rate: 16000,
        channels: 1,
        browser_playable: true,
        timestamp: 2,
      })
      await bus.publish('bus:TTS_AUDIO_CHUNK', {
        event: 'TTS_AUDIO_CHUNK',
        session_id: ready.session_id,
        segment_id: 'segment-1',
        chunk_index: 1,
        chunk_base64: Buffer.from([1, 2, 3]).toString('base64'),
        encoding: 'pcm_s16le',
        mime_type: 'audio/raw',
        sample_rate: 16000,
        channels: 1,
        browser_playable: true,
        timestamp: 2,
      })
      await bus.publish('bus:RESPONSE_END', {
        event: 'RESPONSE_END',
        session_id: ready.session_id,
        speaker_id: 'browser_customer',
        turn_id: 'turn-1',
        reason: 'end_turn',
        timestamp: 3,
      })

      expect(
        await waitForMessage(
          messages,
          (message) => message.type === 'turn_state' && message.state === 'thinking',
        ),
      ).toBeTruthy()

      expect(
        await waitForMessage(
          messages,
          (message) =>
            message.type === 'assistant_text' && message.text === 'Claro, te ayudo con eso.',
        ),
      ).toBeTruthy()

      expect(
        await waitForMessage(
          messages,
          (message) =>
            message.type === 'assistant_audio_start' && message.segment_id === 'segment-1',
        ),
      ).toMatchObject({
        encoding: 'pcm_s16le',
        browser_playable: true,
      })

      expect(
        await waitForMessage(
          messages,
          (message) =>
            message.type === 'assistant_audio_chunk' && message.segment_id === 'segment-1',
        ),
      ).toMatchObject({
        chunk_index: 1,
        chunk_base64: Buffer.from([1, 2, 3]).toString('base64'),
      })

      expect(countTurnStates(messages, 'idle')).toBe(1)

      await bus.publish('bus:TTS_SEGMENT_END', {
        event: 'TTS_SEGMENT_END',
        session_id: ready.session_id,
        segment_id: 'segment-1',
        reason: 'completed',
        chunk_count: 1,
        total_bytes: 3,
        encoding: 'pcm_s16le',
        mime_type: 'audio/raw',
        sample_rate: 16000,
        channels: 1,
        browser_playable: true,
        timestamp: 2,
      })

      expect(
        await waitForMessage(
          messages,
          (message) => message.type === 'assistant_audio_end' && message.segment_id === 'segment-1',
        ),
      ).toMatchObject({
        reason: 'completed',
        total_bytes: 3,
      })

      expect(
        await waitForMessage(
          messages,
          (message) => message.type === 'turn_state' && message.state === 'idle',
        ),
      ).toBeTruthy()

      const health = await service.server.inject({
        method: 'GET',
        url: '/health',
      })

      expect(health.statusCode).toBe(200)
      expect(health.json()).toMatchObject({
        status: 'ok',
        store_id: 'store-test',
        websocket_path: '/ws/voice',
        stt_driver: 'mock',
      })

      const page = await service.server.inject({
        method: 'GET',
        url: '/',
      })

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('Store Runtime Voice Bridge')
      expect(page.body).toContain('Debug / Mock transcript')
    } finally {
      await service.shutdown()
    }
  })

  it('keeps speaker presence until the last client with the same speaker disconnects', async () => {
    const dir = await createTempDir('web-voice-bridge-shared-speaker-')
    dirs.add(dir)

    const configPath = path.join(dir, 'store.config.json')
    const bus = new InMemoryBus()
    const detected: Array<Record<string, unknown>> = []
    const lost: Array<Record<string, unknown>> = []

    bus.subscribe('bus:SPEAKER_DETECTED', (payload) => {
      detected.push(payload as Record<string, unknown>)
    })
    bus.subscribe('bus:SPEAKER_LOST', (payload) => {
      lost.push(payload as Record<string, unknown>)
    })

    await writeJsonFile(configPath, {
      ...createBaseConfig(),
      capture: { driver: 'external-bus' },
      web_voice_bridge: {
        ...createBaseConfig().web_voice_bridge,
        enabled: true,
        publish_mode: 'local',
      },
    })

    const service = await startWebVoiceBridgeService({
      configPath,
      bus,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      const address = service.server.server.address() as AddressInfo
      const socketA = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice`)
      const socketB = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice`)
      sockets.add(socketA)
      sockets.add(socketB)

      const messagesA: Array<Record<string, unknown>> = []
      const messagesB: Array<Record<string, unknown>> = []

      socketA.on('message', (raw) => {
        const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw)
        messagesA.push(JSON.parse(text) as Record<string, unknown>)
      })
      socketB.on('message', (raw) => {
        const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw)
        messagesB.push(JSON.parse(text) as Record<string, unknown>)
      })

      await Promise.all([onceOpen(socketA), onceOpen(socketB)])

      const hello = JSON.stringify({
        type: 'hello',
        session_id: 'shared-session',
        speaker_id: 'shared-customer',
        surface: 'avatar',
      })

      socketA.send(hello)
      socketB.send(hello)

      await Promise.all([
        waitForMessage(messagesA, (message) => message.type === 'ready'),
        waitForMessage(messagesB, (message) => message.type === 'ready'),
      ])

      socketA.send(JSON.stringify({ type: 'text_input', text: 'hola desde cliente A' }))

      await waitForCondition(() => detected.length === 1)
      expect(detected[0]).toMatchObject({
        event: 'SPEAKER_DETECTED',
        session_id: 'shared-session',
        speaker_id: 'shared-customer',
      })

      socketA.close()
      await onceClosed(socketA)
      await pause(100)
      expect(lost).toHaveLength(0)

      socketB.close()
      await onceClosed(socketB)
      await waitForCondition(() => lost.length === 1)
      expect(lost[0]).toMatchObject({
        event: 'SPEAKER_LOST',
        session_id: 'shared-session',
        speaker_id: 'shared-customer',
      })
    } finally {
      await service.shutdown()
    }
  })

  it('releases old speaker presence and detects the new speaker after hello changes identity', async () => {
    const dir = await createTempDir('web-voice-bridge-identity-change-')
    dirs.add(dir)

    const configPath = path.join(dir, 'store.config.json')
    const bus = new InMemoryBus()
    const detected: Array<Record<string, unknown>> = []
    const lost: Array<Record<string, unknown>> = []

    bus.subscribe('bus:SPEAKER_DETECTED', (payload) => {
      detected.push(payload as Record<string, unknown>)
    })
    bus.subscribe('bus:SPEAKER_LOST', (payload) => {
      lost.push(payload as Record<string, unknown>)
    })

    await writeJsonFile(configPath, {
      ...createBaseConfig(),
      capture: { driver: 'external-bus' },
      web_voice_bridge: {
        ...createBaseConfig().web_voice_bridge,
        enabled: true,
        publish_mode: 'local',
      },
    })

    const service = await startWebVoiceBridgeService({
      configPath,
      bus,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      const address = service.server.server.address() as AddressInfo
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice`)
      sockets.add(socket)

      const messages: Array<Record<string, unknown>> = []
      socket.on('message', (raw) => {
        const text = raw instanceof Buffer ? raw.toString('utf8') : String(raw)
        messages.push(JSON.parse(text) as Record<string, unknown>)
      })

      await onceOpen(socket)

      socket.send(
        JSON.stringify({
          type: 'hello',
          session_id: 'session-a',
          speaker_id: 'speaker-a',
          surface: 'avatar',
        }),
      )
      await waitForMessage(
        messages,
        (message) => message.type === 'ready' && message.speaker_id === 'speaker-a',
      )

      socket.send(JSON.stringify({ type: 'text_input', text: 'primero A' }))
      await waitForCondition(() => detected.length === 1)
      expect(detected[0]).toMatchObject({
        event: 'SPEAKER_DETECTED',
        session_id: 'session-a',
        speaker_id: 'speaker-a',
      })

      socket.send(
        JSON.stringify({
          type: 'hello',
          session_id: 'session-b',
          speaker_id: 'speaker-b',
          surface: 'avatar',
        }),
      )
      await waitForMessage(
        messages,
        (message) => message.type === 'ready' && message.speaker_id === 'speaker-b',
      )
      await waitForCondition(() => lost.length === 1)
      expect(lost[0]).toMatchObject({
        event: 'SPEAKER_LOST',
        session_id: 'session-a',
        speaker_id: 'speaker-a',
      })

      socket.send(JSON.stringify({ type: 'text_input', text: 'ahora B' }))
      await waitForCondition(() => detected.length === 2)
      expect(detected[1]).toMatchObject({
        event: 'SPEAKER_DETECTED',
        session_id: 'session-b',
        speaker_id: 'speaker-b',
      })
    } finally {
      await service.shutdown()
    }
  })
})

async function onceOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', (error) => reject(error))
  })
}

async function onceClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return
  }

  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
  })
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  await waitForCondition(() => messages.some((message) => predicate(message)))
  return messages.find((message) => predicate(message))!
}

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()

  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function pause(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

function countTurnStates(messages: Array<Record<string, unknown>>, state: string): number {
  return messages.filter((message) => message.type === 'turn_state' && message.state === state)
    .length
}

interface RenderWebVoiceBridgeHtmlOptions {
  storeId: string
  mountPath: string
  browserVad: boolean
  sampleRate: number
  sttDriver: string
  defaultSurface: string
}

export function renderWebVoiceBridgeHtml(options: RenderWebVoiceBridgeHtmlOptions): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fitaly Web Voice Bridge</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5efe3;
        --panel: #fffaf2;
        --panel-strong: #f0e6d7;
        --ink: #241a12;
        --ink-soft: #6c5a49;
        --line: #d8c7b2;
        --accent: #ba7327;
        --accent-soft: rgba(186, 115, 39, 0.14);
        --ok: #4f7c59;
        --warn: #ab6a1e;
        --err: #ad3f33;
        --radius: 18px;
        --radius-sm: 12px;
        --shadow: 0 16px 48px rgba(36, 26, 18, 0.1);
        --mono: 'SFMono-Regular', 'SF Mono', Consolas, monospace;
        --sans: 'Segoe UI', ui-sans-serif, system-ui, sans-serif;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: var(--sans);
        background:
          radial-gradient(circle at top right, rgba(186, 115, 39, 0.12), transparent 28rem),
          linear-gradient(180deg, #fbf7f0 0%, var(--bg) 100%);
        color: var(--ink);
      }

      main {
        width: min(1080px, calc(100vw - 32px));
        margin: 32px auto;
        display: grid;
        gap: 18px;
      }

      .hero,
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }

      .hero {
        padding: 26px;
        display: grid;
        gap: 18px;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(28px, 5vw, 44px);
        line-height: 1.05;
      }

      .hero-copy {
        color: var(--ink-soft);
        font-size: 15px;
        line-height: 1.6;
        max-width: 70ch;
      }

      .grid {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 18px;
      }

      .panel {
        padding: 20px;
      }

      .panel h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }

      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }

      .meta-card {
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 12px 14px;
        background: linear-gradient(180deg, rgba(255,255,255,0.6), rgba(240,230,215,0.55));
      }

      .meta-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ink-soft);
        margin-bottom: 6px;
      }

      .meta-value {
        font-family: var(--mono);
        font-size: 12px;
        word-break: break-word;
      }

      .controls {
        display: grid;
        gap: 12px;
      }

      .control-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--ink-soft);
      }

      select,
      input,
      textarea,
      button {
        font: inherit;
      }

      select,
      input,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: #fffdf9;
        color: var(--ink);
        border-radius: 12px;
        padding: 11px 12px;
      }

      textarea {
        min-height: 96px;
        resize: vertical;
      }

      button {
        border: none;
        border-radius: 999px;
        padding: 11px 18px;
        font-weight: 700;
        cursor: pointer;
        transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
      }

      button:hover { transform: translateY(-1px); }
      button:disabled { cursor: not-allowed; opacity: 0.45; transform: none; }

      .btn-primary {
        background: var(--ink);
        color: #fff8f0;
      }

      .btn-secondary {
        background: var(--panel-strong);
        color: var(--ink);
      }

      .btn-accent {
        background: var(--accent);
        color: #fffaf4;
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .chip {
        border-radius: 999px;
        padding: 8px 12px;
        background: var(--panel-strong);
        color: var(--ink-soft);
        font-size: 12px;
        font-weight: 600;
      }

      .chip strong {
        color: var(--ink);
      }

      .status {
        display: grid;
        gap: 10px;
      }

      .status-line {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 14px;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--warn);
      }

      .dot.ok { background: var(--ok); }
      .dot.err { background: var(--err); }

      .transcript,
      .events {
        display: grid;
        gap: 10px;
      }

      .bubble {
        border-radius: 16px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        background: #fffdf9;
      }

      .bubble small,
      .events pre small {
        display: block;
        color: var(--ink-soft);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-size: 10px;
      }

      .bubble.assistant {
        background: rgba(186, 115, 39, 0.08);
      }

      .bubble.partial {
        border-style: dashed;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.55;
      }

      .hint {
        color: var(--ink-soft);
        font-size: 12px;
        line-height: 1.5;
      }

      @media (max-width: 860px) {
        main { width: min(100vw - 20px, 100%); margin: 10px auto 24px; }
        .grid { grid-template-columns: 1fr; }
        .hero { padding: 18px; }
        .panel { padding: 16px; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">Store Runtime Voice Bridge</div>
        <div>
          <h1>Prueba de voz web para <span id="store-id">${escapeHtml(options.storeId)}</span></h1>
          <p class="hero-copy">
            Esta página abre una sesión WebSocket con el <code>web-voice-bridge</code>, captura
            micrófono desde el navegador y manda audio cuando detecta voz. Ahora también puede
            recibir audio del asistente por stream cuando el formato TTS sea reproducible en
            navegador. Si el provider no expone un formato compatible todavía, al menos verás los
            eventos, el transcript y el estado del turno en vivo.
          </p>
        </div>
        <div class="meta">
          <div class="meta-card">
            <div class="meta-label">WebSocket</div>
            <div class="meta-value" id="meta-ws-path">${escapeHtml(options.mountPath)}</div>
          </div>
          <div class="meta-card">
            <div class="meta-label">STT</div>
            <div class="meta-value">${escapeHtml(options.sttDriver)}</div>
          </div>
          <div class="meta-card">
            <div class="meta-label">Sample Rate</div>
            <div class="meta-value">${options.sampleRate} Hz</div>
          </div>
          <div class="meta-card">
            <div class="meta-label">VAD Navegador</div>
            <div class="meta-value">${options.browserVad ? 'activo' : 'manual'}</div>
          </div>
        </div>
      </section>

      <section class="grid">
        <section class="panel">
          <h2>Control</h2>
          <div class="controls">
            <div class="control-row">
              <label style="flex:1 1 220px">
                Surface
                <select id="surface">
                  <option value="avatar"${options.defaultSurface === 'avatar' ? ' selected' : ''}>avatar</option>
                  <option value="customer-display"${options.defaultSurface === 'customer-display' ? ' selected' : ''}>customer-display</option>
                  <option value="staff-ui"${options.defaultSurface === 'staff-ui' ? ' selected' : ''}>staff-ui</option>
                  <option value="voice-only"${options.defaultSurface === 'voice-only' ? ' selected' : ''}>voice-only</option>
                </select>
              </label>
              <label style="flex:1 1 220px">
                Speaker ID
                <input id="speaker-id" placeholder="web_customer_1" />
              </label>
            </div>

            <div class="control-row">
              <button class="btn-primary" id="connect-btn">Conectar</button>
              <button class="btn-accent" id="voice-btn" disabled>Activar Micrófono</button>
              <button class="btn-secondary" id="stop-btn" disabled>Detener Micrófono</button>
              <button class="btn-secondary" id="interrupt-btn" disabled>Interrumpir</button>
            </div>

            <div class="chips">
              <div class="chip"><strong>Conexión:</strong> <span id="connection-state">desconectado</span></div>
              <div class="chip"><strong>Turno:</strong> <span id="turn-state">idle</span></div>
              <div class="chip"><strong>Sesión:</strong> <span id="session-id">pendiente</span></div>
              <div class="chip"><strong>Audio salida:</strong> <span id="audio-state">inactivo</span></div>
            </div>

            <div class="status">
              <div class="status-line">
                <span class="dot" id="status-dot"></span>
                <span id="status-line">Todavía no hay conexión con el bridge.</span>
              </div>
              <div class="hint" id="status-hint">
                ${
                  options.sttDriver === 'mock'
                    ? 'El runtime está usando STT mock. Para una prueba de voz real configura Vosk o un provider equivalente. Mientras tanto puedes usar el panel de texto debug.'
                    : 'Con Vosk u otro STT real, el navegador enviará PCM 16 kHz al bridge solo cuando detecte voz.'
                }
              </div>
            </div>

            <label>
              Debug / Mock transcript
              <textarea id="debug-text" placeholder="Escribe una frase para publicarla como SPEECH_FINAL cuando quieras probar el runtime sin STT real."></textarea>
            </label>

            <div class="control-row">
              <button class="btn-secondary" id="debug-send-btn" disabled>Enviar Texto Debug</button>
              <button class="btn-secondary" id="ping-btn" disabled>Ping</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>Transcript</h2>
          <div class="transcript">
            <div class="bubble partial">
              <small>Parcial</small>
              <pre id="partial-text">Todavía no llega transcript parcial.</pre>
            </div>
            <div class="bubble">
              <small>Usuario final</small>
              <pre id="final-text">Todavía no llega transcript final.</pre>
            </div>
            <div class="bubble assistant">
              <small>Asistente</small>
              <pre id="assistant-text">Todavía no llegó texto del asistente.</pre>
            </div>
          </div>
        </section>
      </section>

      <section class="panel">
        <h2>Eventos</h2>
        <div class="events">
          <pre id="event-log">Esperando actividad…</pre>
        </div>
      </section>
    </main>

    <script>
      const config = {
        storeId: ${JSON.stringify(options.storeId)},
        mountPath: ${JSON.stringify(options.mountPath)},
        browserVad: ${options.browserVad ? 'true' : 'false'},
        targetSampleRate: ${options.sampleRate},
      }

      const els = {
        connectBtn: document.getElementById('connect-btn'),
        voiceBtn: document.getElementById('voice-btn'),
        stopBtn: document.getElementById('stop-btn'),
        interruptBtn: document.getElementById('interrupt-btn'),
        debugSendBtn: document.getElementById('debug-send-btn'),
        pingBtn: document.getElementById('ping-btn'),
        surface: document.getElementById('surface'),
        speakerId: document.getElementById('speaker-id'),
        debugText: document.getElementById('debug-text'),
        connectionState: document.getElementById('connection-state'),
        turnState: document.getElementById('turn-state'),
        sessionId: document.getElementById('session-id'),
        audioState: document.getElementById('audio-state'),
        statusDot: document.getElementById('status-dot'),
        statusLine: document.getElementById('status-line'),
        partialText: document.getElementById('partial-text'),
        finalText: document.getElementById('final-text'),
        assistantText: document.getElementById('assistant-text'),
        eventLog: document.getElementById('event-log'),
      }

      let socket = null
      let mediaStream = null
      let audioContext = null
      let sourceNode = null
      let processorNode = null
      let muteGain = null
      let isMicActive = false
      let isSpeechActive = false
      let silentFrames = 0
      let currentSessionId = null
      let assistantAudioContext = null
      let assistantPlaybackCursor = 0
      let assistantScheduledSources = new Set()
      let assistantAudioFormat = null
      let assistantSegmentBuffers = new Map()
      let assistantBlobPlaybackQueue = Promise.resolve()
      let assistantPlaybackVersion = 0
      let assistantActiveAudioElement = null

      els.connectBtn.addEventListener('click', () => connect())
      els.voiceBtn.addEventListener('click', () => startMic())
      els.stopBtn.addEventListener('click', () => stopMic())
      els.interruptBtn.addEventListener('click', () => sendMessage({ type: 'interrupt' }))
      els.debugSendBtn.addEventListener('click', () => {
        const text = els.debugText.value.trim()
        if (!text) {
          setStatus('Escribe un texto para enviarlo como debug.', 'warn')
          return
        }
        sendMessage({ type: 'text_input', text })
        els.debugText.value = ''
      })
      els.pingBtn.addEventListener('click', () => sendMessage({ type: 'ping', timestamp: Date.now() }))

      function connect() {
        if (socket && socket.readyState === WebSocket.OPEN) {
          return
        }

        void prepareAssistantAudio()

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = protocol + '//' + window.location.host + config.mountPath
        socket = new WebSocket(url)

        socket.addEventListener('open', () => {
          setConnectionState('conectado', true)
          sendMessage({
            type: 'hello',
            store_id: config.storeId,
            surface: els.surface.value,
            speaker_id: els.speakerId.value.trim() || undefined,
          })
        })

        socket.addEventListener('message', (event) => {
          const payload = JSON.parse(typeof event.data === 'string' ? event.data : '')
          handleServerMessage(payload)
        })

        socket.addEventListener('close', () => {
          setConnectionState('desconectado', false)
          currentSessionId = null
          els.sessionId.textContent = 'pendiente'
          stopAssistantAudioPlayback()
          stopMic().catch(() => {})
        })

        socket.addEventListener('error', () => {
          setStatus('La conexión WebSocket falló.', 'err')
        })
      }

      async function startMic() {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          setStatus('Conecta primero el bridge antes de activar el micrófono.', 'warn')
          return
        }

        if (isMicActive) {
          return
        }

        await prepareAssistantAudio()

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })

        const context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4096, 1, 1)
        const mute = context.createGain()
        mute.gain.value = 0

        source.connect(processor)
        processor.connect(mute)
        mute.connect(context.destination)

        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          const rms = calculateRms(input)
          const shouldSpeak = rms >= 0.018

          if (config.browserVad) {
            if (shouldSpeak && !isSpeechActive) {
              isSpeechActive = true
              silentFrames = 0
              sendMessage({ type: 'vad_start' })
            } else if (!shouldSpeak && isSpeechActive) {
              silentFrames += 1
              if (silentFrames >= 4) {
                isSpeechActive = false
                silentFrames = 0
                sendMessage({ type: 'vad_stop' })
              }
            } else if (shouldSpeak) {
              silentFrames = 0
            }
          } else if (!isSpeechActive) {
            isSpeechActive = true
            sendMessage({ type: 'vad_start' })
          }

          if (!isSpeechActive) {
            return
          }

          const pcm = downsampleToPcm16(input, context.sampleRate, config.targetSampleRate)
          if (!pcm.length) {
            return
          }

          sendMessage({
            type: 'audio_chunk',
            data: toBase64(new Uint8Array(pcm.buffer)),
          })
        }

        mediaStream = stream
        audioContext = context
        sourceNode = source
        processorNode = processor
        muteGain = mute
        isMicActive = true
        els.voiceBtn.disabled = true
        els.stopBtn.disabled = false
        setStatus('Micrófono activo. El bridge recibirá audio cuando detecte voz.', 'ok')
      }

      async function stopMic() {
        if (isSpeechActive) {
          sendMessage({ type: 'vad_stop' })
        }
        isSpeechActive = false
        silentFrames = 0

        if (processorNode) {
          processorNode.disconnect()
          processorNode.onaudioprocess = null
          processorNode = null
        }
        if (sourceNode) {
          sourceNode.disconnect()
          sourceNode = null
        }
        if (muteGain) {
          muteGain.disconnect()
          muteGain = null
        }
        if (mediaStream) {
          for (const track of mediaStream.getTracks()) {
            track.stop()
          }
          mediaStream = null
        }
        if (audioContext) {
          await audioContext.close().catch(() => {})
          audioContext = null
        }

        isMicActive = false
        els.voiceBtn.disabled = !socket || socket.readyState !== WebSocket.OPEN
        els.stopBtn.disabled = true
      }

      function handleServerMessage(payload) {
        appendEvent(payload)

        switch (payload.type) {
          case 'ready':
            currentSessionId = payload.session_id
            els.sessionId.textContent = payload.session_id
            els.turnState.textContent = 'idle'
            els.voiceBtn.disabled = false
            els.debugSendBtn.disabled = false
            els.interruptBtn.disabled = false
            els.pingBtn.disabled = false
            setStatus('Bridge listo para recibir voz o texto debug.', 'ok')
            return
          case 'partial_transcript':
            els.partialText.textContent = payload.text || 'Sin texto parcial'
            return
          case 'final_transcript':
            els.finalText.textContent = payload.text || 'Sin texto final'
            return
          case 'assistant_text':
            els.assistantText.textContent = payload.text || 'Sin texto del asistente'
            return
          case 'assistant_audio_start':
            handleAssistantAudioStart(payload)
            return
          case 'assistant_audio_chunk':
            handleAssistantAudioChunk(payload)
            return
          case 'assistant_audio_end':
            handleAssistantAudioEnd(payload)
            return
          case 'turn_state':
            els.turnState.textContent = payload.state
            if (payload.state === 'interrupted') {
              stopAssistantAudioPlayback()
            }
            setStatus('Turno actualizado a "' + payload.state + '".', payload.state === 'interrupted' ? 'warn' : 'ok')
            return
          case 'pong':
            setStatus('Pong recibido desde el bridge.', 'ok')
            return
          case 'error':
            setStatus(payload.message || 'Error del bridge.', 'err')
            return
        }
      }

      function sendMessage(payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          setStatus('El socket todavía no está listo.', 'warn')
          return
        }
        socket.send(JSON.stringify(payload))
      }

      function setConnectionState(text, isOk) {
        els.connectionState.textContent = text
        els.statusDot.className = 'dot' + (isOk ? ' ok' : '')
        els.voiceBtn.disabled = !isOk || isMicActive
        els.stopBtn.disabled = !isMicActive
        els.debugSendBtn.disabled = !isOk
        els.interruptBtn.disabled = !isOk
        els.pingBtn.disabled = !isOk
        if (!isOk) {
          els.turnState.textContent = 'idle'
          els.audioState.textContent = 'inactivo'
          setStatus('Conexión cerrada. Puedes reconectar cuando quieras.', 'warn')
        }
      }

      function setStatus(text, level) {
        els.statusLine.textContent = text
        els.statusDot.className = 'dot' + (level === 'ok' ? ' ok' : level === 'err' ? ' err' : '')
      }

      function appendEvent(payload) {
        const lines = els.eventLog.textContent === 'Esperando actividad…' ? [] : els.eventLog.textContent.split('\\n')
        lines.unshift('[' + new Date().toLocaleTimeString() + '] ' + JSON.stringify(payload))
        els.eventLog.textContent = lines.slice(0, 18).join('\\n')
      }

      async function prepareAssistantAudio() {
        if (!window.AudioContext) {
          els.audioState.textContent = 'sin soporte web audio'
          return null
        }

        if (!assistantAudioContext || assistantAudioContext.state === 'closed') {
          assistantAudioContext = new AudioContext()
        }

        if (assistantAudioContext.state === 'suspended') {
          await assistantAudioContext.resume().catch(() => {})
        }

        els.audioState.textContent = 'listo'
        return assistantAudioContext
      }

      function handleAssistantAudioStart(payload) {
        assistantAudioFormat = payload
        assistantSegmentBuffers.set(payload.segment_id, [])
        const label = payload.browser_playable
          ? (payload.encoding || 'desconocido') + (payload.sample_rate ? ' @ ' + payload.sample_rate + ' Hz' : '')
          : 'stream recibido, formato no reproducible'
        els.audioState.textContent = label
      }

      function handleAssistantAudioChunk(payload) {
        if (!payload.browser_playable || !payload.chunk_base64) {
          return
        }

        const bytes = base64ToBytes(payload.chunk_base64)
        if (!bytes.length) {
          return
        }

        if (payload.encoding === 'pcm_s16le') {
          void schedulePcm16Chunk(bytes, payload.sample_rate || config.targetSampleRate, payload.channels || 1)
          return
        }

        const segmentId = payload.segment_id || 'segment'
        const chunks = assistantSegmentBuffers.get(segmentId) || []
        chunks.push(bytes)
        assistantSegmentBuffers.set(segmentId, chunks)
      }

      function handleAssistantAudioEnd(payload) {
        const segmentId = payload.segment_id || 'segment'
        const bufferedChunks = assistantSegmentBuffers.get(segmentId) || []
        if (payload.browser_playable && payload.encoding !== 'pcm_s16le' && bufferedChunks.length > 0) {
          const combined = combineByteChunks(bufferedChunks)
          const mimeType = payload.mime_type || guessMimeType(payload.encoding)
          if (mimeType) {
            queueBlobPlayback(combined, mimeType)
          }
        }
        assistantSegmentBuffers.delete(segmentId)

        if (payload.reason === 'interrupted' || payload.reason === 'error') {
          stopAssistantAudioPlayback()
        }

        if (payload.reason === 'completed') {
          els.audioState.textContent = assistantAudioFormat && assistantAudioFormat.browser_playable
            ? 'audio reproducido'
            : 'audio recibido'
        } else if (payload.reason === 'interrupted') {
          els.audioState.textContent = 'audio interrumpido'
        } else if (payload.reason === 'error') {
          els.audioState.textContent = 'error de audio'
        }
      }

      async function schedulePcm16Chunk(bytes, sampleRate, channels) {
        if (channels !== 1) {
          els.audioState.textContent = 'canales no soportados'
          return
        }

        const context = await prepareAssistantAudio()
        if (!context) {
          return
        }

        const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        const audioBuffer = context.createBuffer(1, samples.length, sampleRate)
        const channel = audioBuffer.getChannelData(0)

        for (let i = 0; i < samples.length; i += 1) {
          channel[i] = Math.max(-1, Math.min(1, samples[i] / 32768))
        }

        const source = context.createBufferSource()
        source.buffer = audioBuffer
        source.connect(context.destination)

        const when = Math.max(context.currentTime, assistantPlaybackCursor)
        assistantPlaybackCursor = when + audioBuffer.duration
        assistantScheduledSources.add(source)
        source.onended = () => {
          assistantScheduledSources.delete(source)
        }
        source.start(when)
        els.audioState.textContent = 'reproduciendo pcm'
      }

      function stopAssistantAudioPlayback() {
        assistantPlaybackVersion += 1
        for (const source of assistantScheduledSources) {
          try {
            source.stop()
          } catch {}
        }
        assistantScheduledSources.clear()
        if (assistantActiveAudioElement) {
          try {
            assistantActiveAudioElement.pause()
            assistantActiveAudioElement.currentTime = 0
          } catch {}
          assistantActiveAudioElement = null
        }
        if (assistantAudioContext && assistantAudioContext.state !== 'closed') {
          assistantPlaybackCursor = assistantAudioContext.currentTime
        } else {
          assistantPlaybackCursor = 0
        }
        assistantSegmentBuffers.clear()
        assistantBlobPlaybackQueue = Promise.resolve()
      }

      function calculateRms(samples) {
        let sum = 0
        for (let i = 0; i < samples.length; i += 1) {
          sum += samples[i] * samples[i]
        }
        return Math.sqrt(sum / Math.max(samples.length, 1))
      }

      function downsampleToPcm16(input, sourceRate, targetRate) {
        if (targetRate > sourceRate) {
          return new Int16Array(0)
        }

        const ratio = sourceRate / targetRate
        const length = Math.max(1, Math.round(input.length / ratio))
        const result = new Int16Array(length)
        let offsetResult = 0
        let offsetBuffer = 0

        while (offsetResult < result.length) {
          const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
          let accum = 0
          let count = 0
          for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
            accum += input[i]
            count += 1
          }

          const sample = count > 0 ? accum / count : 0
          const clamped = Math.max(-1, Math.min(1, sample))
          result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
          offsetResult += 1
          offsetBuffer = nextOffsetBuffer
        }

        return result
      }

      function toBase64(bytes) {
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize)
          binary += String.fromCharCode.apply(null, chunk)
        }
        return btoa(binary)
      }

      function base64ToBytes(value) {
        const binary = atob(value)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i)
        }
        return bytes
      }

      function combineByteChunks(chunks) {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        return merged
      }

      function queueBlobPlayback(bytes, mimeType) {
        const version = assistantPlaybackVersion
        assistantBlobPlaybackQueue = assistantBlobPlaybackQueue
          .catch(() => {})
          .then(async () => {
            if (version !== assistantPlaybackVersion) {
              return
            }
            const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
            try {
              const audio = new Audio(url)
              assistantActiveAudioElement = audio
              els.audioState.textContent = 'reproduciendo ' + mimeType
              let started = true
              await audio.play().catch(() => {
                started = false
              })
              if (version !== assistantPlaybackVersion) {
                audio.pause()
                return
              }
              if (!started) {
                els.audioState.textContent = 'audio bloqueado por navegador'
                return
              }
              await new Promise((resolve) => {
                audio.onended = () => resolve()
                audio.onerror = () => resolve()
              })
            } finally {
              if (assistantActiveAudioElement) {
                assistantActiveAudioElement = null
              }
              URL.revokeObjectURL(url)
            }
          })
          .catch((error) => {
            console.error('Assistant blob playback failed', error)
            els.audioState.textContent = 'error de audio'
          })
      }

      function guessMimeType(encoding) {
        if (encoding === 'mp3') return 'audio/mpeg'
        if (encoding === 'wav') return 'audio/wav'
        if (encoding === 'opus') return 'audio/ogg; codecs=opus'
        return ''
      }
    </script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

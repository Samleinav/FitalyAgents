# FitalyVoice — Plan
> **Pipeline Python para audio ruidoso en entornos con múltiples personas.**
> Identifica quién habla, qué dice, y si está dirigiendo su discurso al agente.
> Output: eventos Redis idénticos al schema de FitalyAgents.

---

## El Problema que Resuelve

```
Sin FitalyVoice (agente de voz normal):
  Micrófono capta TODO → STT de todo → agente responde a TODOS
  → caos en tienda: agente responde a conversaciones ajenas

Con FitalyVoice:
  Micrófono capta TODO → pipeline identifica quién habla → 
  → solo TargetClient llega al agente como bus:SPEECH_FINAL
  → el resto llega como bus:AMBIENT_CONTEXT (sin procesar con LLM)
  → agente tiene contexto pero solo responde a Target
```

---

## Pipeline Completo

Con pyannote en FitalyCloud, FitalyVoice local se simplifica radicalmente. **Solo mantiene estado — el ML pesado vive en el cloud.**

```
┌──────────────────────────────────────────────────────────────────────┐
│  FITALY VOICE (local — Python ligero)                                │
│                                                                      │
│  ┌──────────────┐    ┌────────────────────────────────────────────┐  │
│  │  Audio Input  │    │  FitalyCloud WS /v1/audio/process         │  │
│  │               │    │                                            │  │
│  │  mic ambiente │───►│  → speaker_identified  (pyannote/fast)    │  │
│  │  + RTC stream │    │  → stt_partial          (Deepgram stream) │  │
│  │               │    │  → stt_final                              │  │
│  └──────────────┘    │  → ambient_detected                        │  │
│                       │  → speaker_embedding_ready                │  │
│                       └────────────────┬───────────────────────────┘  │
│                                        │ eventos streaming            │
│                       ┌────────────────▼───────────────────────────┐  │
│                       │  TargetGroupStateMachine                   │  │
│                       │  (estado local, sin ML)                    │  │
│                       │                                            │  │
│                       │  UNKNOWN → CANDIDATE → TARGET_ACTIVE       │  │
│                       │  TARGET_ACTIVE → QUEUED (nuevo cliente)    │  │
│                       │  CANDIDATE → TARGET_GROUP (cámara/confirm) │  │
│                       └────────────────┬───────────────────────────┘  │
│                                        │                              │
│          ┌─────────────────────────────┴──────────────────────┐       │
│          │                                                     │       │
│   TARGET ▼                                             AMBIENT ▼       │
│  bus:SPEECH_FINAL                              bus:AMBIENT_CONTEXT     │
│  bus:TARGET_DETECTED                                                   │
│  bus:TARGET_QUEUED                                                     │
│  bus:TARGET_GROUP                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**FitalyVoice local solo hace:**
1. Capturar y streamear audio a FitalyCloud
2. Mantener el estado de TargetGroup (máquina de estados, sin ML)
3. Publicar eventos al bus Redis de FitalyAgents
4. Reproducir el audio de respuesta del agente

**FitalyCloud hace todo el ML:**
- pyannote (speakers nuevos)
- Fast recognizer (speakers conocidos, embeddings en Redis cloud)
- STT streaming
- Embeddings storage por local

---

## Los 3 Modos de Entrada de Audio

### Modo 1: Micrófono Ambiente (on-premise)
```
Hardware local (Raspberry Pi 4 / mini PC / x86):
  ├── Micrófono array (ReSpeaker 4-mic o similar)
  ├── Python process corriendo pyannote + SpeechBrain
  └── Conecta a Redis local o cloud
```
Ventaja: latencia baja, privado, funciona sin internet (con Whisper local)  
Desventaja: requiere hardware físico en el local

### Modo 2: RTC desde Teléfono (Agora)
```
Cliente usa su teléfono:
  App/Web ──Agora RTC──► FitalyVoice AudioReceiver
                              │
                         audio stream
                              │
                         pipeline normal
```
Ventaja: sin hardware, el cliente usa su propio teléfono  
Desventaja: requiere que el cliente abra una app/web

### Modo 3: Dual (default para FitalyStore)
```
Micrófono ambiente: captura conversación general del local
RTC teléfono: canal de alta calidad cuando cliente quiere interacción directa

Micrófono ──► TargetDetector ──► "este cliente quiere hablar"
                    │
                    └──► envía invitación RTC al teléfono del cliente (QR/NFC)
                              │
                    cliente acepta ──► canal RTC dedicado
                              │
                    micrófono ambiente sigue como contexto
```

---

## Speaker Diarization: pyannote → embeddings locales

La clave del sistema es que **pyannote es caro y lento pero solo se necesita la primera vez**.

```python
# Primera vez que Ana aparece en el local
# pyannote detecta: "speaker_007 dijo: hola, buenos días"
# SpeakerTracker extrae el embedding de Ana (~256 floats)
# Guarda en Redis: speaker_embeddings:{local_id}:{speaker_id}

# Próximas veces (misma sesión o visita posterior)
# Nuevo audio llega
# SpeechBrain/resemblyzer genera embedding ~10ms
# Cosine similarity contra todos los embeddings guardados
# "es Ana con 94% confianza" → sin pyannote

# NUNCA más pyannote para Ana (en este local)
```

### Estrategia de identidad

```
UNKNOWN_VOICE ──► pyannote (costoso, una vez) ──► speaker_id temporal
      │
      └── ¿interactuó con el agente? ──► sí ──► TARGET_{n}, guarda embedding
      └── ¿reconocido antes? ──► sí ──► carga perfil, saludo personalizado
      └── ¿nunca interactuó? ──► permanece UNKNOWN, no se guarda embedding
```

**Privacidad:** embeddings de voz son datos biométricos. Opt-in explícito requerido. El cliente puede pedir borrado. Opción on-premise para guardar todo localmente sin cloud.

---

## TargetDetector: ¿Esta persona le habla al agente?

El problema más difícil. Múltiples señales combinadas:

### Señales de texto/audio (siempre disponibles)
```python
TARGETING_SIGNALS = [
    # Patrones de apertura directa al agente
    "hola", "buenos días", "disculpe", "me puede", "tiene",
    "quiero", "me da", "cuánto", "hay", "me cobras",
    
    # Patrones de cierre/pregunta
    "?",  # entonación ascendente detectada por prosody
    pausa larga antes de hablar (cliente espera respuesta)
]

# Si texto contiene ≥ 2 señales + proximidad al dispositivo → TARGET_CANDIDATE
```

### Señales de proximidad (opcionales)
```python
# Si hay sensor de distancia o cámara:
# persona a < 1.5m del dispositivo + habla → más probable que sea target
# persona de espaldas al dispositivo + habla → muy improbable
```

### Señal de respuesta del agente
```python
# Si el agente respondió algo y esta persona responde a eso → CONFIRMED TARGET
# Es la señal más fuerte: "diálogo establecido"
```

### Score final
```python
def is_target(speaker: SpeakerSegment, context: SessionContext) -> TargetDecision:
    score = 0.0
    score += 0.4 if has_targeting_phrases(speaker.text)    else 0.0
    score += 0.3 if proximity_score(speaker) > 0.7         else 0.0
    score += 0.3 if is_response_to_agent(speaker, context) else 0.0
    
    if score >= 0.7:   return TargetDecision.CONFIRMED
    if score >= 0.4:   return TargetDecision.CANDIDATE  # agente puede preguntar "¿me hablas a mí?"
    return TargetDecision.AMBIENT
```

---

## TargetClient y TargetGroup — Estados

```
UNKNOWN
    │
    ├── targeting score ≥ 0.7 ──────────────────────► TARGET_ACTIVE
    │                                                       │
    ├── targeting score 0.4-0.7 ──► TARGET_CANDIDATE        │
    │   agente pregunta: "¿me hablas?"                      │
    │   responde sí ──────────────────────────────────────► │
    │                                                       │
    │   [mientras TARGET_ACTIVE está activo]                │
    ├── nuevo speaker targeting ──► TARGET_QUEUED           │
    │   agente dice: "en un momento"                        │
    │   TARGET_ACTIVE termina ──────────────────────────────┼──► TARGET_ACTIVE (nuevo)
    │                                                       │
    │   [detección de grupo]                                │
    └── cámara: 3 personas juntas ──► agente pregunta       │
        "¿vienen juntos?" → sí ──────────────────────► TARGET_GROUP
                                                            │
                                                       todos en grupo
                                                       comparten session_id
```

### Eventos Redis de estado

```json
// bus:TARGET_DETECTED
{
  "event": "TARGET_DETECTED",
  "session_id": "sess_ana_001",
  "speaker_id": "spk_007",
  "local_id": "store_bcn_001",
  "confidence": 0.87,
  "detection_method": "targeting_phrases + proximity",
  "is_new_speaker": true,
  "timestamp": 1709123456789
}

// bus:TARGET_QUEUED
{
  "event": "TARGET_QUEUED",
  "queued_session_id": "sess_pedro_002",
  "active_session_id": "sess_ana_001",
  "queue_position": 1,
  "speaker_id": "spk_011",
  "timestamp": 1709123460000
}

// bus:TARGET_GROUP
{
  "event": "TARGET_GROUP",
  "group_session_id": "sess_group_001",
  "member_speaker_ids": ["spk_007", "spk_008", "spk_009"],
  "detection_method": "camera_proximity",
  "timestamp": 1709123470000
}

// bus:AMBIENT_CONTEXT
{
  "event": "AMBIENT_CONTEXT",
  "local_id": "store_bcn_001",
  "speaker_id": "spk_unknown_042",
  "text": null,           // sin STT completo para ambient
  "embedding_snippet": [0.12, 0.34, ...],  // para identificar si luego se vuelve target
  "keyword_detected": "bolsa",  // solo keywords si se usa LiteSTT
  "timestamp": 1709123456800
}

// bus:SPEAKER_EMBEDDING_READY
{
  "event": "SPEAKER_EMBEDDING_READY",
  "speaker_id": "spk_007",
  "local_id": "store_bcn_001",
  "embedding_dims": 256,
  "source": "pyannote_first_time",
  "timestamp": 1709123456900
}
```

---

## STT: Full vs Lite

### FullSTT (solo para Target)
- Deepgram Nova-2 (via FitalyCloud) — ~200ms, muy preciso
- O Whisper large-v3 local — ~400ms, gratis, privado
- Transcripción completa → bus:SPEECH_FINAL

### LiteSTT (para Ambient context)
- Solo detectar keywords predefinidos
- O embeddings de audio sin transcripción
- Mucho más barato: 90% menos costo que FullSTT
- Solo se usa para dar contexto superficial al agente

### Decisión dinámica
```python
def route_stt(speaker: SpeakerSegment, target_status: TargetStatus):
    if target_status in (CONFIRMED, CANDIDATE):
        return FullSTT(speaker.audio)
    else:
        return LiteSTT(speaker.audio)  # keywords + embedding solo
```

---

## Estructura del Repo `fitaly-voice`

Con pyannote en FitalyCloud, el repo local es mucho más ligero. Sin dependencias de torch, pyannote ni SpeechBrain.

```
fitaly-voice/
├── fitaly_voice/
│   ├── audio/
│   │   ├── input.py          # AudioInputManager: mic array + Agora RTC stream
│   │   ├── vad.py            # VAD local ligero (webrtcvad) — decide cuándo enviar
│   │   └── buffer.py         # Segmentación y buffering de chunks
│   │
│   ├── cloud/
│   │   └── audio_client.py   # WS client para /v1/audio/process de FitalyCloud
│   │                         # Maneja reconexión, backpressure, eventos
│   │
│   ├── targeting/
│   │   ├── target_group.py      # TargetGroup data class
│   │   ├── state_machine.py     # UNKNOWN→CANDIDATE→ACTIVE→QUEUED/GROUP
│   │   ├── target_detector.py   # Score: ¿esta persona habla al agente?
│   │   └── queue_manager.py     # Cola de TargetGroups esperando
│   │
│   ├── bus/
│   │   ├── redis_bus.py      # Publica eventos al bus de FitalyAgents
│   │   └── schemas.py        # Pydantic schemas de todos los eventos
│   │
│   ├── audio_output/
│   │   └── player.py         # Recibe TTS del agente y lo reproduce
│   │
│   └── pipeline.py           # Orquesta: AudioInput → Cloud → StateMachine → Bus
│
├── hardware/
│   ├── raspberry_pi/
│   │   ├── setup.sh          # Instala en Raspberry Pi 4 (sin GPU necesaria)
│   │   └── fitaly-voice.service
│   └── x86/
│       └── setup.sh
│
├── tests/
├── config/
│   └── store.example.yaml
│
├── requirements.txt           # Mucho más liviano: redis, websockets, sounddevice, pydantic
├── pyproject.toml
└── README.md
```

### Dependencias — Mucho más ligeras

```toml
[project]
dependencies = [
    "websockets>=12.0",          # WS client para FitalyCloud
    "webrtcvad>=2.0.10",         # VAD local muy ligero (no torch)
    "redis[hiredis]>=5.0",
    "pydantic>=2.0",
    "httpx>=0.27",
    "sounddevice>=0.4",          # mic input
    "numpy>=1.24",
]

[project.optional-dependencies]
agora = ["agora-rtc-python-sdk"]
# SIN torch, SIN pyannote local, SIN SpeechBrain — todo en el cloud
```

---

## Sprints FitalyVoice

> Puede desarrollarse en **paralelo** con FitalyAgents Fase 1.  
> Depende de que FitalyCloud Sprint C0.2 (Smart Audio Endpoint) esté listo.

### Sprint V0.1 — Audio Input + VAD local (0.5 semanas)
- [ ] `AudioInputManager`: micrófono con `sounddevice`, ReSpeaker support
- [ ] VAD con `webrtcvad` (sin torch, ~1ms) — segmenta cuándo hay voz activa
- [ ] `AudioBuffer`: acumula chunks de 100-200ms antes de enviar al cloud
- [ ] Test: grabar audio de 3 personas, verificar segmentación por turns de voz

### Sprint V0.2 — FitalyCloud WS Client (0.5 semanas)
- [ ] `AudioCloudClient`: WebSocket a `/v1/audio/process`
- [ ] Stream de audio PCM → chunks al cloud
- [ ] Manejo de todos los eventos del schema (`speaker_identified`, `stt_partial`, etc.)
- [ ] Reconexión automática con backoff
- [ ] Test con mock cloud: simular eventos y verificar que se reciben correctamente

### Sprint V0.3 — TargetGroup State Machine (1 semana)
- [ ] `TargetGroup` dataclass: `session_id`, `members[]`, `status`, `queue_position`
- [ ] `TargetGroupStateMachine`: UNKNOWN → CANDIDATE → ACTIVE → QUEUED/GROUP
- [ ] `TargetDetector`: score basado en eventos del cloud (`stt_partial` con trigger phrases, `speaker_identified` con proximity)
- [ ] `QueueManager`: lista de TargetGroups en espera, max N
- [ ] Publicar eventos Redis: `bus:TARGET_DETECTED`, `bus:TARGET_QUEUED`, `bus:TARGET_GROUP`
- [ ] Test: simular 3 speakers, verificar que solo el target avanza al estado ACTIVE

### Sprint V0.4 — Bus Integration + SPEECH_FINAL (0.5 semanas)
- [ ] `RedisBus`: publica a `bus:SPEECH_FINAL` cuando `stt_final` llega y speaker es TARGET_ACTIVE
- [ ] Publica `bus:AMBIENT_CONTEXT` para ambient speakers
- [ ] Schema idéntico al de FitalyAgents (ya definido en PLAN-ARCHITECTURE.md)
- [ ] Test E2E con mock FitalyCloud: audio ruidoso → solo target llega como SPEECH_FINAL

### Sprint V0.5 — Audio Output + Filler (0.5 semanas)
- [ ] `AudioPlayer`: subscribe a eventos TTS del agente, reproduce audio
- [ ] `FillerManager`: banco de frases pre-generadas por categoría (espera, pensando, error)
- [ ] Reproduce filler inmediato mientras espera respuesta real del agente
- [ ] Interrumpe filler cuando llega respuesta real (`bus:ACTION_COMPLETED`)

### Sprint V0.6 — Agora RTC + Dual Mode (1 semana)
- [ ] `AgoraReceiver`: recibe audio stream de teléfono vía Agora SDK
- [ ] Merge en pipeline: mic ambiente + RTC en el mismo stream al cloud
- [ ] RTC tiene prioridad de calidad cuando está activo
- [ ] Test: cliente usa teléfono, mic sigue captando ambient

### Sprint V0.7 — Hardware Setup (0.5 semanas)
- [ ] Script `setup.sh` para Raspberry Pi 4 (ligero: sin torch)
- [ ] `systemd` service
- [ ] Health check endpoint
- [ ] `store.yaml` completo con validación Pydantic

**Duración total FitalyVoice:** ~5 semanas (más ligero que antes — sin ML local)

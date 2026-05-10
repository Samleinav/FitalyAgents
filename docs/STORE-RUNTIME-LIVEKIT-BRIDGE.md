# Plan: Store Runtime LiveKit Bridge

> Status: Phase 2 implemented; browser bridge and room lifecycle deployed
> Goal: use LiveKit as an optional media layer while Fitaly keeps target-group,
> approvals, POS state, and tool governance.

## Product Decision

`store-runtime` remains the source of truth for store behavior. LiveKit is only a
transport/room layer:

```text
LiveKit room
  -> livekit-voice-bridge
  -> Redis bus
  -> store-runtime
  -> Redis TTS/UI events
  -> livekit-voice-bridge
  -> LiveKit room
```

This keeps the low-cost path open:

- demo: LiveKit Cloud media + self-hosted Fitaly bridge/runtime
- pilot: self-hosted LiveKit + self-hosted Fitaly bridge/runtime
- store floor: local `fitaly-voice` or LiveKit depending on hardware and cost

## Non-Negotiables

- Do not move target-group decisions into LiveKit.
- Do not let queued speakers trigger `InteractionRuntimeAgent`.
- Keep `store-runtime` in `capture.driver = "external-bus"` for LiveKit mode.
- Keep all real POS actions behind Fitaly tools, drafts, confirmations, and
  approvals.
- Keep provider choice outside LiveKit Inference by default so Groq, local STT,
  local TTS, or cheaper providers can be used directly.

## Event Contract

### LiveKit To Fitaly

The bridge publishes:

- `bus:SPEAKER_DETECTED`
- `bus:SPEAKER_LOST`
- `bus:SPEECH_PARTIAL`
- `bus:SPEECH_FINAL`
- `bus:BARGE_IN`

For browser/mobile rooms, the default speaker id is `participant.identity`. For
physical-store mixed microphones, diarization must run before publishing
speaker-scoped events.

### Fitaly To LiveKit

The bridge consumes:

- `bus:RESPONSE_START`
- `bus:AVATAR_SPEAK`
- `bus:TTS_SEGMENT_START`
- `bus:TTS_AUDIO_CHUNK`
- `bus:TTS_SEGMENT_END`
- `bus:RESPONSE_END`
- `bus:BARGE_IN`

`transport = "noop"` forwards these through an in-process test transport.
`transport = "livekit-rtc"` maps them to LiveKit data messages and publishes PCM
TTS chunks as a LiveKit audio track when possible.

## Room Lifecycle And Cost Control

`livekit-voice-bridge` no longer joins LiveKit at process boot. The HTTP server
can be healthy while `room_connected:false`, which is the expected idle state.

Flow:

1. A browser or client calls `GET /client-token`.
2. The bridge creates/joins `LIVEKIT_ROOM` with the configured bridge identity.
3. The browser joins the same room and sends transcripts on `input_topic`.
4. When all remote participants leave, the bridge waits
   `livekit_voice_bridge.room_idle_timeout_ms`.
5. If the room is still empty and `delete_room_on_idle=true`, the bridge
   disconnects locally and deletes the remote LiveKit room.

Manual cleanup is available through:

```bash
curl -X POST http://127.0.0.1:3050/room/close \
  -H "content-type: application/json" \
  -d "{}"
```

The browser test page on `GET /` exposes the same action as `Cerrar Sala`.

Lifecycle fields:

- `room_idle_timeout_ms`
  idle delay before closing an empty room
- `delete_room_on_idle`
  whether to delete the remote LiveKit room on idle/manual close
- `token_ttl`
  TTL for `/client-token` credentials

Operational checks:

- idle bridge: `GET /health` returns `room_connected:false`
- active test: `GET /state` shows at least one participant
- after cleanup: LiveKit dashboard no longer shows the room as `ACTIVE`

## Implementation Checklist

### Phase 1: Contract And Sidecar Shell

- [x] Add a written plan and acceptance checklist.
- [x] Add `livekit_voice_bridge` config schema.
- [x] Add a `livekit-voice-bridge` sidecar entrypoint.
- [x] Translate transcript inputs into Fitaly bus events.
- [x] Track response/TTS state for barge-in decisions.
- [x] Add health/state endpoints for the bridge.
- [x] Make the Phase 1 transport explicit as `transport = "noop"`.
- [x] Add tests for transcript-to-bus mapping and outbound transport events.
- [x] Add scripts, build entry, Compose profile, and README notes.

### Phase 2: LiveKit SDK Transport

- [x] Add a concrete LiveKit transport behind the sidecar abstraction.
- [x] Support LiveKit Cloud media with self-hosted agent runtime.
- [x] Support self-hosted LiveKit server with the same bridge.
- [x] Map participant lifecycle to `SPEAKER_DETECTED` / `SPEAKER_LOST`.
- [x] Map LiveKit transcript/data events to `SPEECH_PARTIAL` /
      `SPEECH_FINAL`.
- [x] Publish assistant PCM audio into the room from `TTS_AUDIO_CHUNK`.
- [x] Forward assistant text/state over LiveKit data channels for UI debugging.
- [x] Add a `dev:livekit-smoke` runner for Cloud/self-hosted rooms.
- [ ] Run a LiveKit Cloud room smoke test with credentials.
- [ ] Run a self-hosted LiveKit room smoke test with credentials.

### Phase 3: Audio And Diarization Choices

- [ ] Browser/mobile path: one participant equals one speaker identity.
- [ ] Store-floor path: mixed audio goes through `fitaly-voice` diarization.
- [ ] Decide when LiveKit VAD is enough and when Fitaly target gate owns turns.
- [ ] Add sample-rate/resampling validation for outbound TTS.
- [x] Add cost controls so sessions start only when a client requests a token.

### Phase 4: Deploy Modes

- [x] Document LiveKit Cloud media + self-hosted bridge/runtime.
- [ ] Document fully self-hosted LiveKit.
- [ ] Add Compose profile for local LiveKit when needed.
- [x] Add smoke flow for a browser room and mock transcripts.
- [ ] Add smoke flow for real STT/TTS providers.

### Phase 5: Production Hardening

- [x] Add admin-secret gate for bridge control routes when `STORE_ADMIN_SECRET` is set.
- [ ] Require auth for all browser-facing test controls in production deployments.
- [ ] Add idempotency keys for transcripts and TTS segments.
- [ ] Move critical event recovery to PostgreSQL/outbox or Redis Streams.
- [ ] Add per-room metrics: active minutes, STT/TTS cost, response latency.
- [ ] Add backpressure and bounded queues for audio chunks.

## Acceptance Criteria

The first real demo is ready when:

- a LiveKit web participant speaks or sends a transcript
- Fitaly publishes a target-group snapshot
- only the primary customer triggers the interaction runtime
- the runtime executes retail tools through normal governance
- TTS/audio returns to the same room
- customer display and staff UI still work from Redis events

## Open Questions

- Which LiveKit integration should be first: Agents SDK worker or lower-level
  room participant transport?
- Should LiveKit provide STT transcripts, or should the bridge send room audio to
  the existing Fitaly STT provider?
- For store-floor microphones, should LiveKit carry raw room audio only, while
  `fitaly-voice` owns diarization?
- Which TTS format should be the canonical outbound format for browser rooms:
  PCM or encoded segments?

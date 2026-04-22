# Store Runtime Operations

Runbook operativo para levantar, verificar y depurar el stack Redis-first del
store runtime.

## Topology

Servicios principales:

- `redis`
  Bus compartido entre runtime y sidecars.
- `store-runtime`
  Proceso principal Node; expone HTTP y ejecuta los agentes del store.
- `store-ui-bridge`
  Consola externa y SSE para dashboards/tablets.
- `customer-display`
  Segunda pantalla orientada al cliente, separada del avatar.
- `web-voice-bridge`
  Opcional; captura voz desde navegador por WebSocket y publica `SPEECH_*` al bus.
- `fitaly-voice`
  Opcional; captura, diariza y publica `SPEAKER_*`, `AMBIENT_CONTEXT`,
  `SPEECH_*`.
- `store-avatar`
  Opcional; sidecar `AvatarAgent` para AIRI.

## Ports And Endpoints

### `store-runtime`

- `GET /health`
- `GET /health/ready`
- `POST /approvals/respond`
- `POST /presence/checkin`
- `POST /presence/checkout`
- `GET /admin/sessions`

### `store-ui-bridge`

- `GET /`
- `GET /health`
- `GET /state`
- `GET /events`

### `customer-display`

- `GET /`
- `GET /health`
- `GET /state`
- `GET /events`

### `web-voice-bridge`

- `GET /`
- `GET /health`
- `GET /state`
- `WS /ws/voice`

Puertos por defecto:

- `store-runtime`: `3000`
- `store-ui-bridge`: `3010`
- `customer-display`: `3020`
- `web-voice-bridge`: `3040`
- `redis`: `6379`

## Config Baseline

Para topología Redis-first, la base esperada es:

- `providers.bus.driver = "redis"`
- `capture.driver = "external-bus"`
- `avatar.mode = "external"` cuando uses `store-avatar`
- `web_voice_bridge.enabled = true` cuando quieras probar voz desde navegador

Referencia rápida:
[apps/store-runtime/store.config.redis.json](/config/workspace/FitalyAgents/apps/store-runtime/store.config.redis.json:1)

## Local Smoke Flow

### Runtime + UI + Demo

```bash
pnpm --filter store-runtime dev -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:ui -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:customer-display -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:web-voice -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:demo -- --config apps/store-runtime/store.config.redis.json
```

Resultado esperado:

- `http://127.0.0.1:3000/health` devuelve `status: ok`
- `http://127.0.0.1:3010/health` devuelve `status: ok`
- `http://127.0.0.1:3020/health` devuelve `status: ok`
- `http://127.0.0.1:3040/health` devuelve `status: ok`
- `http://127.0.0.1:3010/` muestra target group, transcripción y paneles
- `http://127.0.0.1:3020/` muestra pedido, totales, cambios y sugerencias
- `http://127.0.0.1:3040/` abre la prueba web de voz/transcript
- después del demo, `/state` incluye `queue.primary`, transcript y components

### Docker Compose

```bash
cd apps/store-runtime
cp .env.example .env
docker compose up --build
```

Perfiles opcionales:

```bash
docker compose --profile voice up --build
docker compose --profile avatar up --build
```

## Validation Checklist

1. Confirma que Redis está accesible.
2. Arranca `store-runtime` con `store.config.redis.json`.
3. Arranca `store-ui-bridge`.
4. Arranca `customer-display`.
5. Arranca `web-voice-bridge` si vas a probar voz desde navegador.
6. Abre `GET /health` en los servicios activos.
7. Abre `GET /` del bridge UI, del customer display y del web voice bridge si aplica.
8. Publica el demo con `dev:demo`.
9. Verifica que la UI muestre:
   - `primary` activo
   - transcript de cliente
   - respuesta del asistente
   - al menos `product_grid`, `order_panel` y `approval_bar`
10. Verifica que el customer display muestre:
   - productos o sugerencias
   - orden actual
   - total visible
   - estado de pago o aprobación
11. Si usas `web-voice-bridge`, verifica que `/ws/voice` emita:
   - `partial_transcript`
   - `final_transcript`
   - `turn_state`
   - `assistant_text`
   - `assistant_audio_start`
   - `assistant_audio_chunk`
   - `assistant_audio_end`

## Bus Events That Matter

### Ingreso desde voz

- `bus:SPEAKER_DETECTED`
- `bus:SPEAKER_LOST`
- `bus:SPEAKER_AMBIENT`
- `bus:AMBIENT_CONTEXT`
- `bus:SPEECH_PARTIAL`
- `bus:SPEECH_FINAL`

### Ciclo de respuesta

- `bus:RESPONSE_START`
- `bus:AVATAR_SPEAK`
- `bus:RESPONSE_END`

### UI y operación

- `bus:TARGET_GROUP_CHANGED`
- `bus:UI_UPDATE`
- `bus:APPROVAL_RESOLVED`
- `bus:ORDER_QUEUED_NO_APPROVER`
- `bus:DRAFT_CREATED`
- `bus:DRAFT_CONFIRMED`
- `bus:DRAFT_CANCELLED`
- `bus:TOOL_RESULT`
- `bus:ORDER_APPROVAL_TIMEOUT`

## Troubleshooting

### La UI externa abre pero no cambia

Revisa:

- `providers.bus.driver = "redis"`
- `store-ui-bridge` apuntando al mismo Redis
- eventos llegando a `bus:TARGET_GROUP_CHANGED` o `bus:UI_UPDATE`

Prueba rápida:

```bash
pnpm --filter store-runtime dev:demo -- --config apps/store-runtime/store.config.redis.json
```

### El customer display no refleja la orden

Revisa:

- `retail.customer_display_enabled = true`
- `customer-display` apuntando al mismo Redis
- llegada de `bus:DRAFT_*`, `bus:TOOL_RESULT` y `bus:APPROVAL_*`

Prueba rápida:

```bash
pnpm --filter store-runtime dev:demo -- --config apps/store-runtime/store.config.redis.json
```

### El runtime no toma al speaker correcto

Revisa:

- `speaker_id` estable desde `fitaly-voice`
- `capture.driver = "external-bus"`
- normalización de sesiones en `src/bootstrap/speaker-session.ts`
- snapshots de `bus:TARGET_GROUP_CHANGED`

### El avatar no reacciona

Revisa:

- `"avatar": { "enabled": true, "mode": "external", "airi_url": "..." }`
- `store-avatar` levantado
- `bus:AVATAR_SPEAK` saliendo del runtime

### Hay cambios visuales pero no transcript

Revisa:

- `bus:SPEECH_FINAL`
- `bus:RESPONSE_START`
- `bus:RESPONSE_END`
- `bus:AVATAR_SPEAK`

La consola externa necesita esos eventos para construir el snapshot conversacional.

### El navegador recibe texto pero no audio reproducible

Revisa:

- qué provider TTS está configurado
- llegada de `bus:TTS_SEGMENT_START`, `bus:TTS_AUDIO_CHUNK` y `bus:TTS_SEGMENT_END`
- campo `browser_playable` en el stream enviado al navegador

En el estado actual:

- `pcm_s16le` se puede reproducir directamente en la página del bridge
- `mp3` y `wav` pueden reproducirse por segmento cuando llegan con
  `browser_playable = true`
- otros formatos todavía pueden llegar como stream/eventos, pero no siempre se
  reproducen en navegador sin adaptación adicional

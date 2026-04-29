# Store Runtime

Runtime local para una sola tienda física, impulsado por `fitalyagents`.

## Guías

- Desarrollo: [docs/STORE-RUNTIME-DEVELOPER-GUIDE.md](/config/workspace/FitalyAgents/docs/STORE-RUNTIME-DEVELOPER-GUIDE.md:1)
- Operación: [docs/STORE-RUNTIME-OPERATIONS.md](/config/workspace/FitalyAgents/docs/STORE-RUNTIME-OPERATIONS.md:1)
- Skills del proyecto: [store-runtime-dev](/config/workspace/FitalyAgents/.codex/skills/store-runtime-dev/SKILL.md:1) y [store-runtime-ops](/config/workspace/FitalyAgents/.codex/skills/store-runtime-ops/SKILL.md:1)

## Retail Preset

Fases 1, 2 y el arranque de la 3 ya están disponibles con:

- bloques `retail`, `connectors`, `devices` y `policies` en config
- tools base listas para demo:
  `product_search`, `inventory_check`, `customer_lookup`, `order_create`,
  `order_update`, `order_confirm`, `payment_intent_create`, `receipt_print`
- adapters mock para catálogo, clientes, órdenes, pagos y receipt printer
- conectores reales de productos/inventario por `rest` y `sqlite` para consultas de catálogo fuera del mock
- conectores reales de clientes y órdenes por `rest` y `sqlite`
- `payments` sigue en `mock` por ahora, listo para primeras pruebas sin integrar PSP/POS real todavía
- jerarquía retail por empleado con defaults desde `policies.role_approval_defaults`
- thresholds de aprobación para refunds y overrides preparados por rol
- estado visible de aprobaciones pendientes/resueltas en la UI externa
- `customer display` separado del avatar con estado curado de orden, pago, receipt, refunds y sugerencias

Configs incluidas:

- mínima local: [store.config.json](/config/workspace/FitalyAgents/apps/store-runtime/store.config.json:1)
- Redis-first: [store.config.redis.json](/config/workspace/FitalyAgents/apps/store-runtime/store.config.redis.json:1)
- ejemplo más completo: [store.config.example.json](/config/workspace/FitalyAgents/apps/store-runtime/store.config.example.json:1)

## Arquitectura

`store-runtime` es el proceso Node principal. Dentro de este proceso viven los
agentes internos (`InteractionRuntimeAgent`, `TargetGroupBridge`, `UIAgent`,
`StaffAgent`, etc.).

Servicios externos:

- `redis`: bus compartido entre runtime, voz y otros servicios
- `fitaly-voice`: captura, diarización, identidad y publicación de eventos
- `store-ui-bridge`: expone `bus:UI_UPDATE` por SSE para una UI externa
- `customer-display`: segunda pantalla para cliente, separada del avatar
- `web-voice-bridge`: puente opcional para hablar con el runtime desde navegador por WebSocket
- `store-avatar`: corre `AvatarAgent` sobre Redis y envía comandos a AIRI
- UI real o renderer visual: opcionales, fuera del runtime

## Modos de captura soportados

- `local-stt`: el runtime lee stdin/FIFO y hace STT local
- `voice-events`: el runtime lee NDJSON desde un sidecar local
- `external-bus`: el runtime no captura audio; espera eventos ya publicados en Redis

Para voz desde navegador, el patrón recomendado es:

- `providers.bus.driver = "redis"`
- `capture.driver = "external-bus"`
- `web_voice_bridge.enabled = true`

Para despliegue real, el modo recomendado es `providers.bus.driver = "redis"` y
`capture.driver = "external-bus"`.

## Uso rápido local

1. Ajusta `apps/store-runtime/store.config.json`.
2. Copia `apps/store-runtime/.env.example` a `.env` y completa las claves necesarias.
3. Instala dependencias con `pnpm install`.
4. Ejecuta `pnpm --filter store-runtime dev -- --config apps/store-runtime/store.config.json`.

## Docker Compose

El `docker-compose.yml` del app ya está preparado para Redis-first:

- `redis`
- `store-runtime`
- `store-ui-bridge`
- `customer-display`
- `web-voice-bridge`
- `fitaly-voice` bajo profile `voice`
- `store-avatar` bajo profile `avatar`

Comandos:

```bash
cd apps/store-runtime
cp .env.example .env
docker compose up --build
```

Para añadir voz:

```bash
docker compose --profile voice up --build
```

Para añadir avatar externo:

```bash
docker compose --profile avatar up --build
```

Por defecto, Compose monta [store.config.redis.json](/config/workspace/FitalyAgents/apps/store-runtime/store.config.redis.json:1) y usa `STORE_CONFIG_PATH`.

## Avatar externo

Para correr avatar fuera del runtime:

1. Usa `providers.bus.driver = "redis"`.
2. Configura `"avatar": { "enabled": true, "mode": "external", "airi_url": "ws://airi:6006" }`.
3. Levanta `store-avatar`.

Con `mode = "external"`, el runtime principal no instancia `AvatarAgent` interno.

## UI externa

`store-ui-bridge` escucha `bus:UI_UPDATE` y lo publica por SSE:

- `GET /`
- `GET /health`
- `GET /state`
- `GET /events`

Además, ahora construye un snapshot vivo con:

- `bus:TARGET_GROUP_CHANGED`
- `bus:SPEECH_FINAL`
- `bus:RESPONSE_START`
- `bus:AVATAR_SPEAK`
- `bus:RESPONSE_END`

Con eso, `GET /` ya sirve una consola externa mínima para seguir target group,
transcripción y respuestas sin meter la UI dentro del runtime.

Para publicar un escenario visual de prueba sobre Redis:

```bash
pnpm --filter store-runtime dev:demo -- --config apps/store-runtime/store.config.redis.json
```

Ese comando empuja un flujo de demo al bus y ayuda a validar la UI aunque todavía
no tengas toda la captura de voz conectada.

## Web Voice Bridge

`web-voice-bridge` es un sidecar opcional para pruebas y despliegues web. Expone:

- `GET /`
- `GET /health`
- `GET /state`
- `WS /ws/voice`

Script local:

```bash
pnpm --filter store-runtime dev:web-voice -- --config apps/store-runtime/store.config.redis.json
```

Puerto por defecto: `3040`.

Notas:

- para una prueba de voz real desde navegador necesitas un provider STT real
  como `vosk`
- si `providers.stt.driver = "mock"`, la página del bridge ofrece un panel
  `Debug / Mock transcript` para empujar texto como `SPEECH_FINAL`
- el runtime ahora publica `bus:TTS_SEGMENT_START`, `bus:TTS_AUDIO_CHUNK` y
  `bus:TTS_SEGMENT_END` para retorno de audio web
- el bridge reenvía esos eventos como `assistant_audio_*`
- reproducción directa en navegador queda soportada de entrada para
  `pcm_s16le`; otros formatos siguen llegando al cliente como stream/eventos,
  aunque no siempre serán reproducibles todavía
- con `elevenlabs`, ahora puedes definir `providers.tts.output_format`
  por ejemplo:
  - `mp3_44100_128` para reproducción por segmento en navegador
  - `pcm_16000` para retorno PCM más directo cuando tu tier lo permita

## LiveKit Voice Bridge

`livekit-voice-bridge` es el nuevo punto de integración para usar LiveKit como
capa de media sin mover la lógica de tienda fuera de Fitaly.

La topología esperada es:

- `providers.bus.driver = "redis"`
- `capture.driver = "external-bus"`
- `livekit_voice_bridge.enabled = true`

Script local:

```bash
pnpm --filter store-runtime dev:livekit-voice -- --config apps/store-runtime/store.config.redis.json
```

Puerto por defecto: `3050`.

Estado:

- `GET /health`
- `GET /state`

La primera fase del bridge usaba `transport = "noop"` para validar contrato. Para
conectar un room real usa `transport = "livekit-rtc"` y define:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_ROOM`

`LIVEKIT_ROOM` no tiene que existir de antemano. Es un nombre estable para la
sesión, por ejemplo `fitaly-demo-store-001`; LiveKit crea el room automáticamente
cuando entra el primer participante. Si quieres controlar `emptyTimeout` o
`maxParticipants`, también puedes precrearlo con RoomService API o LiveKit CLI.

El bridge se une al room como participante `participant_identity`, escucha data o
text streams en `input_topic` (`fitaly.transcript` por defecto), traduce
transcripts a `SPEAKER_DETECTED`, `SPEECH_PARTIAL`, `SPEECH_FINAL` y `BARGE_IN`,
y reenvía eventos runtime por `output_topic` (`fitaly.runtime` por defecto).
Cuando el TTS sale como `pcm_s16le`, también publica un track de audio LiveKit.

Payload de transcript esperado en `input_topic`:

```json
{
  "type": "transcript",
  "participant_identity": "customer-1",
  "text": "quiero unos tenis talla 42",
  "final": true,
  "role": "customer"
}
```

Smoke contra un room real:

```bash
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_ROOM=fitaly-demo
pnpm --filter store-runtime dev:livekit-smoke -- \
  --config apps/store-runtime/store.config.redis.json \
  --text "quiero ver tenis talla 42"
```

Por defecto el smoke envía el transcript por data packet. Para probar text
streams, añade `--text-stream`. Para comprobar solo conexión/envío sin esperar
respuesta del runtime, añade `--no-wait-output`.

Para seguimiento del trabajo:
[docs/STORE-RUNTIME-LIVEKIT-BRIDGE.md](/config/workspace/FitalyAgents/docs/STORE-RUNTIME-LIVEKIT-BRIDGE.md:1)

## Conectores Retail

`product_search` e `inventory_check` soportan:

- `mock`
  usa el catálogo sembrado en la SQLite local del runtime
- `rest`
  consulta un endpoint JSON remoto usando `query`, `product_id` y `limit`
- `sqlite`
  consulta una base SQLite externa con schema compatible de productos

Campos útiles en `connectors.products` y `connectors.inventory`:

- `driver`
- `url` para `rest`
- `database` o `connection_string` para `sqlite`
- `options`
  permite mapear tabla y columnas en `sqlite`

El deploy center básico usa estos mismos adapters para probar el conector antes o
después del deploy.

`customer_lookup`, `customer_register`, `order_create`, `order_update` y
`order_confirm` ahora también soportan:

- `mock`
  usa los repositorios locales del runtime para demos y smoke tests
- `rest`
  integra con endpoints HTTP/JSON para lookup/registro de cliente y ciclo de orden
- `sqlite`
  trabaja contra tablas SQLite compatibles con el schema base del app

Campos útiles en `connectors.customers` y `connectors.orders`:

- `driver`
- `url` para `rest`
- `database` o `connection_string` para `sqlite`
- `options`
  permite mapear tabla y columnas en `sqlite`, y endpoints/métodos por acción en `rest`

Notas:

- para `orders.rest`, si defines `options.update_url` o `options.confirm_url` y
  necesitas inyectar el id, usa el placeholder `{order_id}`
- `payments` sigue en `mock` intencionalmente hasta integrar un PSP/datáfono real

## Customer Display

La segunda pantalla vive como sidecar separado y escucha un subconjunto curado del bus:

- `bus:DRAFT_CREATED`
- `bus:DRAFT_CONFIRMED`
- `bus:DRAFT_CANCELLED`
- `bus:TOOL_RESULT`
- `bus:UI_UPDATE`
- `bus:ORDER_QUEUED_NO_APPROVER`
- `bus:APPROVAL_RESOLVED`
- `bus:ORDER_APPROVAL_TIMEOUT`
- `bus:AVATAR_SPEAK`

Endpoints:

- `GET /`
- `GET /health`
- `GET /state`
- `GET /events`

Comando local:

```bash
pnpm --filter store-runtime dev:customer-display -- --config apps/store-runtime/store.config.redis.json
```

Puerto por defecto: `3020`.

## Entradas y salidas de voz

- `mock` STT: escribe una línea por stdin. También acepta `speaker_id|role|texto`.
- STT local: si defines `STORE_AUDIO_INPUT_PIPE`, el runtime lee audio desde ese FIFO.
- Redis-first: `fitaly-voice` publica `bus:SPEAKER_*`, `bus:AMBIENT_CONTEXT` y `bus:SPEECH_*` al bus Redis.
- TTS: escribe audio a `stdout` o a `STORE_AUDIO_OUTPUT_PIPE` si ese env var está definido.

## Endpoints

- `GET /health`
- `GET /health/ready`
- `POST /approvals/respond`
- `POST /presence/checkin`
- `POST /presence/checkout`
- `GET /admin/sessions`

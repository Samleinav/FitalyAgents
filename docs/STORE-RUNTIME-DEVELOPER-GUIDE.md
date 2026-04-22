# Store Runtime Developer Guide

Guía de desarrollo para `apps/store-runtime`, sus sidecars externos y la
integración Redis-first del store.

## Scope

Usa esta guía cuando vayas a:

- cambiar el runtime principal en `apps/store-runtime/src/main.ts`
- tocar la captura de voz o el enrutado multi-speaker
- extender la UI externa o el sidecar de avatar
- añadir tools, contratos de bus o tests del app

Para el contexto de producto y el plan de construcción, consulta también
[docs/plans/STORE-RUNTIME-SINGLE-STORE.md](/config/workspace/FitalyAgents/docs/plans/STORE-RUNTIME-SINGLE-STORE.md:1).

## Runtime Map

### Proceso principal

- `src/bootstrap/bootstrap.ts`
  Construye config, DB, repositorios, providers, agentes, bridges HTTP/STT/TTS
  y el ciclo de arranque/shutdown.
- `src/agents/build-agents.ts`
  Ensambla `TargetGroupBridge`, `InteractionRuntimeAgent`, `UIAgent`,
  `StaffAgent`, `AmbientAgent` y el `AvatarAgent` interno cuando aplica.
- `src/agents/interaction-runtime-agent.ts`
  Punto de entrada de `SPEECH_FINAL` para clientes. Filtra staff, ignora
  speakers en cola y normaliza `session_id` según el modo de captura.
- `src/http/server.ts`
  Endpoints de health, approvals, presence y administración.

### Captura e identidad

- `src/bootstrap/stt-bridge.ts`
  Soporta `local-stt`, `voice-events` y `external-bus`.
- `src/bootstrap/speaker-session.ts`
  Reglas para convertir sesiones de ingreso en sesiones runtime por speaker.
- `packages/core/src/agent/target-group-bridge.ts`
  Traduce `SPEAKER_*`, `AMBIENT_CONTEXT` y `RESPONSE_*` a snapshots de target
  group y sesiones activas.

### Sidecars externos

- `src/external/ui-bridge.ts`
  Servicio Fastify para `GET /`, `GET /state`, `GET /events` y `GET /health`.
- `src/external/ui-dashboard-state.ts`
  Reducer del dashboard: pliega eventos de bus a un snapshot consumible por UI.
- `src/external/ui-dashboard-page.ts`
  Consola HTML mínima servida por el bridge.
- `src/external/web-voice-bridge.ts`
  Sidecar opcional para voz web por WebSocket y publicación de `SPEECH_*` al bus.
- `src/external/web-voice-bridge-page.ts`
  Página HTML de prueba para micrófono, transcript y turn-state.
- `src/bootstrap/tts-audio-sink.ts`
  Fanout de audio TTS hacia salida local y eventos `TTS_*` para clientes web.
- `src/external/avatar-service.ts`
  `AvatarAgent` externo sobre Redis.
- `src/external/demo-publisher.ts`
  Publica un flujo de demo en Redis para validar la consola sin esperar a voz.

### Configuración

- `src/config/schema.ts`
  Contrato Zod de config.
- `store.config.json`
  Config local/simple.
- `store.config.redis.json`
  Config Redis-first con UI/avatar externos.

## Working Rules

- No edites `dist/`, `data/` ni `node_modules/`.
- Si cambias `TargetGroupBridge` o la normalización de sesiones, valida también
  `packages/core`.
- Si añades un sidecar nuevo, mantenlo Redis-first en vez de acoplarlo al
  proceso principal.
- Si tocas UI externa, piensa en snapshots estables primero y HTML después.
- Si cambias el contrato de eventos, actualiza tests, README y esta guía.

## Validation Matrix

### Cambio normal dentro del app

```bash
pnpm --filter store-runtime type-check
pnpm --filter store-runtime lint
pnpm --filter store-runtime test
pnpm --filter store-runtime build
```

### Cambio que toca target group o sesiones multi-speaker

```bash
pnpm --filter fitalyagents test -- src/agent/target-group-bridge.test.ts
pnpm --filter fitalyagents build
pnpm --filter store-runtime test
```

### Cambio que toca UI externa

```bash
pnpm --filter store-runtime test -- src/external/ui-bridge.test.ts
pnpm --filter store-runtime test -- src/external/ui-dashboard-state.test.ts
pnpm --filter store-runtime build
```

## Common Extension Paths

### Añadir un tool nuevo

1. Implementa el tool en `src/tools/`.
2. Regístralo en `src/tools/registry.ts`.
3. Ajusta `store.config*.json` si quieres activarlo por defecto.
4. Cubre el comportamiento en `src/tools/core-tools.test.ts` o en un test nuevo.

### Añadir un nuevo dato al dashboard externo

1. Decide si el dato viene de un evento existente o de uno nuevo.
2. Actualiza `src/external/ui-dashboard-state.ts`.
3. Refleja el dato en `src/external/ui-dashboard-page.ts`.
4. Cubre el reducer y el bridge en tests.

### Ajustar captura o diarización

1. Cambia `src/bootstrap/stt-bridge.ts` o `packages/core/src/agent/target-group-bridge.ts`.
2. Conserva la regla: speakers en cola no deben disparar `InteractionRuntimeAgent`.
3. Valida casos de `session_id` entrante reutilizado y fallback por `speaker_id`.

## Known Good Flows

### Desarrollo local simple

```bash
pnpm --filter store-runtime dev -- --config apps/store-runtime/store.config.json
```

### Flujo Redis-first con consola externa

```bash
pnpm --filter store-runtime dev -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:ui -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:demo -- --config apps/store-runtime/store.config.redis.json
```

## Where To Look First

- Runtime no responde: `src/agents/interaction-runtime-agent.ts`
- Cola/speaker equivocado: `src/bootstrap/stt-bridge.ts`,
  `src/bootstrap/speaker-session.ts`,
  `packages/core/src/agent/target-group-bridge.ts`
- UI externa no refleja estado: `src/external/ui-bridge.ts`,
  `src/external/ui-dashboard-state.ts`
- Avatar externo no reacciona: `src/external/avatar-service.ts`
- Config rota: `src/config/schema.ts`, `src/config/load-store-config.ts`

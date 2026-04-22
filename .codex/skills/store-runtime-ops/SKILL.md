---
name: store-runtime-ops
description: Use when running, validating, or troubleshooting the Redis-first store-runtime stack, including store-ui-bridge, avatar sidecars, compose flows, smoke tests, and operational checks.
---

# Store Runtime Ops

Usa esta skill cuando el trabajo sea levantar, verificar o depurar el stack
operativo del store runtime.

## First Reads

Lee primero:

- [apps/store-runtime/README.md](../../../apps/store-runtime/README.md)
- [docs/STORE-RUNTIME-OPERATIONS.md](../../../docs/STORE-RUNTIME-OPERATIONS.md)

## Default Topology

Asume esta topología por defecto:

- `redis`
- `store-runtime`
- `store-ui-bridge`
- `fitaly-voice` opcional
- `store-avatar` opcional

Config esperada para producción o demos realistas:

- `providers.bus.driver = "redis"`
- `capture.driver = "external-bus"`

## Smoke Flow

Para una validación rápida sin esperar voz real:

```bash
pnpm --filter store-runtime dev -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:ui -- --config apps/store-runtime/store.config.redis.json
pnpm --filter store-runtime dev:demo -- --config apps/store-runtime/store.config.redis.json
```

## Health Checks

- Runtime: `GET /health`, `GET /health/ready`
- UI bridge: `GET /health`, `GET /state`, `GET /events`, `GET /`

## Troubleshooting Focus

- Si no hay UI: revisa Redis compartido y `bus:UI_UPDATE`.
- Si no hay transcript: revisa `SPEECH_FINAL`, `RESPONSE_START`,
  `AVATAR_SPEAK`, `RESPONSE_END`.
- Si el speaker activo es incorrecto: revisa `speaker_id`, target group y
  normalización de sesiones.
- Si el avatar no responde: revisa `avatar.mode = "external"` y `bus:AVATAR_SPEAK`.

## Constraints

- Si no hay `docker` en el entorno, valida por procesos y config, y declara la
  ausencia de prueba real de compose.
- No supongas que `fitaly-voice` ya está cableado; usa `dev:demo` para smoke
  visual cuando haga falta.

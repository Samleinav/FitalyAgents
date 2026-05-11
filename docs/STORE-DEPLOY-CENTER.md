# Store Deploy Center

Runbook operativo para usar el portal local que configura, valida y despliega el
stack de una tienda Fitaly desde una sola pantalla.

## Purpose

`store-deploy-center` esta pensado para pruebas locales, demos de tienda y
operacion asistida del stack Redis-first. No reemplaza CI/CD ni un orquestador
de produccion; coordina archivos locales y `docker compose` para que el equipo
pueda levantar el store completo sin recordar todos los comandos.

## Local Topology

Puertos habituales del stack local:

- `3000`: `store-runtime`
- `3010`: `store-ui-bridge`
- `3020`: `customer-display`
- `3030`: `store-deploy-center`
- `3050`: `livekit-voice-bridge` cuando se activa el profile `livekit`
- `6380`: Redis publicado por el compose del store

El deploy center trabaja sobre:

- `apps/store-runtime/store.config.redis.json`
- `apps/store-runtime/docker-compose.yml`
- `apps/store-runtime/.env`
- `apps/store-runtime/.env.example`

La config base vive en:

- [apps/store-deploy-center/deploy-center.config.json](/config/workspace/FitalyAgents/apps/store-deploy-center/deploy-center.config.json:1)

## Start

```bash
pnpm --filter store-deploy-center dev -- --config apps/store-deploy-center/deploy-center.config.json
```

Luego abre:

```text
http://127.0.0.1:3030
```

## Main Flow

1. Revisa o ajusta el preset del store.
2. Completa `.env` desde la plantilla.
3. Guarda `store.config.redis.json`.
4. Lanza `docker compose up -d --build`.
5. Verifica health de runtime, staff UI y customer display.
6. Abre pantallas embebidas para probar el flujo de venta.
7. Lee logs por servicio si algo queda en amarillo o rojo.

## Services

Servicios principales controlables desde el stack:

- `redis`
- `store-runtime`
- `store-ui-bridge`
- `customer-display`
- `store-avatar` si se habilita profile `avatar`
- `fitaly-voice` si se habilita profile `voice`
- `livekit-voice-bridge` si se habilita profile `livekit` en compose

El deploy center puede iniciar, detener, reiniciar y leer logs de los servicios
declarados en `deploy-center.config.json`. Si agregas un servicio nuevo al
compose y quieres verlo en el portal, agrega una entrada en `services` con su
`service_name` y, si aplica, su `health_url`.

## LiveKit Notes

Para pruebas con LiveKit:

1. Define `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` y
   `LIVEKIT_ROOM` en `.env`.
2. Usa `livekit_voice_bridge.transport = "livekit-rtc"`.
3. Levanta el profile:

```bash
cd apps/store-runtime
docker compose --profile livekit up -d --build livekit-voice-bridge
```

El bridge debe quedar con `room_connected:false` cuando no hay navegador
conectado. La sala se abre al pulsar `Conectar LiveKit` en `http://127.0.0.1:3050`
y se cierra por idle o con `Cerrar Sala`.

## Validation

Comandos utiles:

```bash
pnpm --filter store-deploy-center type-check
pnpm --filter store-deploy-center lint
pnpm --filter store-deploy-center test
pnpm --filter store-deploy-center build
```

Health checks esperados:

```text
http://127.0.0.1:3000/health
http://127.0.0.1:3010/health
http://127.0.0.1:3020/health
http://127.0.0.1:3050/health
```

Para una prueba basica, el store debe mostrar:

- staff UI con transcript, target group y respuesta
- customer display con productos, orden, pago o sugerencias
- LiveKit bridge idle cuando no hay pruebas de voz activas

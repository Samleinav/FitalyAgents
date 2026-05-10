# Store Deploy Center

Portal web local para configurar y desplegar el stack del store desde una sola
pantalla.

Runbook largo:
[docs/STORE-DEPLOY-CENTER.md](/config/workspace/FitalyAgents/docs/STORE-DEPLOY-CENTER.md:1)

## Qué hace hoy

- edita `store.config.json` o `store.config.redis.json`
- valida el config con el schema real de `store-runtime`
- guía el deploy con un wizard corto: preset, `.env`, guardado y despliegue
- prueba el conector de productos usando los adapters reales del runtime
- prueba conectores de `customers` y `orders` usando los adapters reales del runtime
- prueba `payments` en modo `mock`; si la orden no existe, crea una preview local temporal para el intento de cobro
- ofrece presets guiados para pasar rápido entre `demo mock`, `sqlite local` y `REST backoffice`
- edita `.env` tomando `.env.example` como plantilla inicial si hace falta
- lanza `docker compose up -d --build`
- detiene el stack con `docker compose down`
- inicia, detiene y reinicia servicios individuales del compose
- lee logs recientes por servicio con `docker compose logs --tail`
- embebe `staff-ui` y `customer-display` en split view
- sirve como panel operativo del stack local `3000`/`3010`/`3020`/`3030`, y se
  puede extender para controlar `livekit-voice-bridge` en `3050`

## Uso rápido

```bash
pnpm --filter store-deploy-center dev -- --config apps/store-deploy-center/deploy-center.config.json
```

Luego abre:

```text
http://127.0.0.1:3030
```

## Configuración

Archivo base:

- [deploy-center.config.json](/config/workspace/FitalyAgents/apps/store-deploy-center/deploy-center.config.json:1)

Campos principales:

- `project.store_config_path`
  store config que el portal va a editar y validar
- `project.compose_file_path`
  compose usado para deploy
- `project.working_directory`
  cwd desde donde corre `docker compose`
- `project.env_file_path`
  archivo `.env` que el portal lee y escribe
- `project.env_example_path`
  plantilla inicial para sembrar variables si `.env` todavía no existe
- `project.profiles`
  profiles opcionales como `avatar`, `voice` o `livekit`
- `project.logs_tail_lines`
  número por defecto de líneas para logs por servicio
- `services`
  servicios controlables y sus health URLs
- `screens`
  pantallas embebibles en la UI

## Requisitos

- `docker` y `docker compose` instalados si quieres usar deploy real
- `apps/store-runtime` construido si el compose levanta imágenes locales
- `.env` completo para profiles opcionales como `livekit`, `voice` o `avatar`

## LiveKit en pruebas locales

El deploy center trabaja sobre el mismo compose de `apps/store-runtime`. Para
probar LiveKit, agrega el servicio `livekit-voice-bridge` a
`deploy-center.config.json` si quieres controlarlo desde el portal, o levanta el
profile manualmente:

```bash
cd apps/store-runtime
docker compose --profile livekit up -d --build livekit-voice-bridge
```

La pantalla de prueba queda en `http://127.0.0.1:3050`. Cuando no hay navegador
conectado, `GET /health` debe devolver `room_connected:false`.

## Validación

```bash
pnpm --filter store-deploy-center type-check
pnpm --filter store-deploy-center lint
pnpm --filter store-deploy-center test
pnpm --filter store-deploy-center build
```

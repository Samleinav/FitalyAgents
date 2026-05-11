## Task completada: GP-07

### Archivos creados
- Ninguno.

### Archivos modificados
- apps/store-runtime/src/external/ui-dashboard-state.ts - agrega sessionStats, timestamps de speech/response, calculo de latencia y reset al cerrar sesion.
- apps/store-runtime/src/external/ui-dashboard-page.ts - muestra sesion activa y latencia en la cabecera, expone window.__dashboardState y agrega export de replay JSON.
- apps/store-runtime/src/external/ui-dashboard-state.test.ts - cubre timestamp de SPEECH_FINAL, calculo de latencia, reset por SESSION_ENDED y RESPONSE_START sin speech previo.
- apps/store-runtime/src/external/ui-bridge.test.ts - valida que el HTML del dashboard incluya sesion activa, export replay y estado global para debug.
- .codex/tasks/LAST-RESULT.md - actualiza el reporte de la tarea GP-07.

### Que se implemento
Se agrego observabilidad basica de replay al Staff UI: el reducer calcula la latencia entre SPEECH_FINAL y RESPONSE_START, mantiene la sesion activa visible y limpia esos datos al cerrar sesion. La pagina del dashboard muestra el ID truncado, colorea la latencia segun umbral, mantiene window.__dashboardState para debug y permite descargar un JSON con sessionStats, recentEvents y transcript.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

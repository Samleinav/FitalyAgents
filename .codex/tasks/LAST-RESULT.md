## Task completada: GP-05

### Archivos creados
- Ninguno.

### Archivos modificados
- apps/store-runtime/src/agents/interaction-runtime-agent.ts - cierra la sesion runtime en despedidas y publica bus:SESSION_ENDED.
- apps/store-runtime/src/agents/interaction-runtime-agent.test.ts - cubre cierre de sesion y evento SESSION_ENDED en despedidas.
- apps/store-runtime/src/retail/preset.ts - agrega instruccion para omitir productos agotados en la respuesta oral.
- apps/store-runtime/src/retail/ui/customer-display-bridge.ts - suscribe el display a bus:SESSION_ENDED.
- apps/store-runtime/src/retail/ui/customer-display-bridge.test.ts - valida reset del display desde el bridge al cerrar sesion.
- apps/store-runtime/src/retail/ui/customer-display-state.ts - resetea estado de pantalla cliente cuando llega bus:SESSION_ENDED.
- apps/store-runtime/src/retail/ui/customer-display-state.test.ts - cubre reset de display a estado idle.
- .codex/tasks/LAST-RESULT.md - actualiza el reporte de la tarea GP-05.

### Que se implemento
Se agrego cierre limpio de sesion cuando el cliente se despide: el runtime marca ended_at en session_summaries, guarda el resumen de cierre y emite bus:SESSION_ENDED. La pantalla cliente escucha ese evento y vuelve a estado idle, limpiando sesion, speaker, orden, sugerencias y mensaje. Tambien se reforzo el prompt retail para que el agente no mencione oralmente productos agotados y busque alternativas cuando todo este sin stock.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

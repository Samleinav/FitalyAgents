## Task completada: GP-04

### Archivos creados
- Ninguno.

### Archivos modificados
- apps/store-runtime/src/retail/preset.ts - agrega instruccion de correccion de seleccion al system prompt.
- apps/store-runtime/src/agents/interaction-runtime-agent.ts - cancela drafts ante intent de correccion, pregunta por opciones visibles y agrega stockStatus a listas recordadas.
- apps/store-runtime/src/agents/interaction-runtime-agent.test.ts - cubre correccion con draft activo y fallback sin draft.
- apps/store-runtime/src/retail/ui/customer-display-state.ts - agrega stockStatus a sugerencias de producto.
- apps/store-runtime/src/retail/ui/customer-display-state.test.ts - cubre estados low/out/available.
- apps/store-runtime/src/retail/ui/customer-display-page.ts - muestra indicadores visuales de stock bajo y agotado.
- .codex/tasks/LAST-RESULT.md - actualiza el reporte de la tarea GP-04.

### Qué se implementó
Se agrego el flujo de correccion "no, mejor el otro" para cancelar el draft activo y pedir una nueva seleccion con codigos visuales. Tambien se agregaron estados de stock a sugerencias y al customer display, con "Últimas unidades" para stock bajo y "Agotado" con producto atenuado cuando no hay stock.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

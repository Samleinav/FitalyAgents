## Task completada: GP-01

### Archivos creados
- .codex/tasks/LAST-RESULT.md

### Archivos modificados
- apps/store-runtime/src/retail/ui/customer-display-state.ts - agrega visualId A1-A6 a sugerencias visibles.
- apps/store-runtime/src/retail/ui/customer-display-page.ts - muestra el visualId como badge del producto.
- apps/store-runtime/src/agents/interaction-runtime-agent.ts - recuerda la ultima lista visible y resuelve selecciones naturales antes del LLM.
- apps/store-runtime/src/agents/interaction-runtime-agent.test.ts - cubre seleccion por A2, ordinal, atributo unico y fallback sin lista activa.
- apps/store-runtime/src/retail/ui/customer-display-state.test.ts - cubre visualId estable y limite de seis productos.
- apps/store-runtime/src/retail/adapters/product-connectors.test.ts - cierra adapters SQLite externos para evitar bloqueo de catalog.db en Windows.

### Qué se implementó
Se agregaron IDs visuales A1-A6 al customer display y el agente ahora puede seleccionar productos desde la lista visible por codigo visual, ordinal o atributo unico. Al detectar una seleccion valida, crea el borrador de orden directamente con order_create sin pasar por el LLM. Tambien se cerro el handle SQLite externo del test de conectores para que la suite completa pueda limpiar temporales correctamente.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

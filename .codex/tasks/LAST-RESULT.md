## Task completada: GP-02

### Archivos creados
- Ninguno.

### Archivos modificados
- apps/store-runtime/src/retail/preset.ts - amplia el system prompt para mencionar codigos visuales A1-A3 en respuestas orales de productos.
- .codex/tasks/LAST-RESULT.md - actualiza el reporte de la tarea GP-02.

### Qué se implementó
Se agregaron instrucciones al system prompt para que, cuando la pantalla de cliente esta activa, el agente mencione los codigos visuales A1, A2 y A3 al listar productos. Tambien se definio el formato oral de respuesta para busquedas de productos: codigo visual, nombre, precio y talla/color cuando aplique, sin IDs internos ni nombres de herramientas.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK (no requerido para GP-02)

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

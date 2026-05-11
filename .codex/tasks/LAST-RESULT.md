## Task completada: BUG-01

### Archivos creados
- Ninguno.

### Archivos modificados
- apps/store-runtime/src/agents/interaction-runtime-agent.ts - auto-confirma payment_intent_create cuando el cliente ya indico tarjeta o efectivo.
- apps/store-runtime/src/agents/interaction-runtime-agent.test.ts - cubre auto-confirmacion de tarjeta, efectivo y preserva el caso sin metodo explicito.
- .codex/tasks/LAST-RESULT.md - actualiza el reporte de la tarea BUG-01.

### Que se implemento
Se corrigio el loop de doble confirmacion del checkout shortcut. Cuando el cliente dice explicitamente que quiere pagar con tarjeta o efectivo, el runtime ahora confirma inmediatamente el protected tool con "si" en el mismo turno si InteractionAgent devuelve draft_ready o needs_confirmation. Si el cliente solo dice "quiero pagar" sin metodo, se mantiene el comportamiento existente y el agente pregunta por el metodo.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

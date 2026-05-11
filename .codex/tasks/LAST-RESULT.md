## Task completada: GP-06

### Archivos creados
- Ninguno.

### Archivos modificados
- apps/store-runtime/src/external/ui-dashboard-state.ts - agrega staffAction, reduce bus:TOOL_RESULT a acciones de empleado y limpia la accion al cerrar sesion.
- apps/store-runtime/src/external/ui-dashboard-page.ts - muestra un panel superior de Accion requerida para el empleado con mensaje, metodo, monto, orden y sesion.
- apps/store-runtime/src/external/ui-dashboard-state.test.ts - cubre pagos en efectivo, pagos con tarjeta, receipt_print y SESSION_ENDED.
- apps/store-runtime/src/external/ui-bridge.ts - suscribe el Staff UI a bus:TOOL_RESULT y bus:SESSION_ENDED.
- apps/store-runtime/src/external/ui-bridge.test.ts - valida que el bridge propague staffAction y que el HTML incluya el panel de accion requerida.
- .codex/tasks/LAST-RESULT.md - actualiza el reporte de la tarea GP-06.

### Que se implemento
Se agrego una accion operativa pendiente para el Staff UI. Cuando payment_intent_create termina, el dashboard muestra si el empleado debe recibir efectivo o atender el datafono con el monto de la orden. Cuando order_confirm termina, queda lista la accion de entrega de producto. receipt_print y SESSION_ENDED limpian el panel. El bridge ahora escucha los canales necesarios para que el comportamiento funcione en el dashboard real.

### Tests ejecutados
- [ ] type-check: OK
- [ ] lint: OK
- [ ] test: OK

### Bloqueantes o preguntas
Ninguno.

### Estado
COMPLETA

# Workflow Protocol — Claude + Codex

## Roles
- **Claude**: tech lead. Diseña, asigna tareas, verifica código, decide qué sigue.
- **Codex**: implementador. Ejecuta la tarea activa, reporta resultado.

## Archivos de coordinación
- `CURRENT-TASK.md` — tarea activa escrita por Claude. Leer antes de empezar.
- `LAST-RESULT.md` — resultado escrito por Codex al terminar. Claude lo lee para decidir.

## Regla de reporte (Codex SIEMPRE hace esto al terminar)

Cuando termines una tarea, **antes de cerrar**, escribe `.codex/tasks/LAST-RESULT.md`
con este formato exacto y haz commit de ese archivo junto con los cambios:

```
## Task completada: <TASK-ID>

### Archivos creados
- path/al/archivo.ts

### Archivos modificados
- path/al/archivo.ts — descripción del cambio

### Qué se implementó
Resumen breve de lo que se hizo.

### Tests ejecutados
- [ ] type-check: OK / FAIL
- [ ] lint: OK / FAIL
- [ ] test: OK / FAIL

### Bloqueantes o preguntas
Ninguno. / Descripción si hay algo.

### Estado
COMPLETA / PARCIAL / BLOQUEADA
```

No esperes respuesta de Claude. Después de escribir el archivo y hacer commit, muestra
este mensaje exacto al usuario para que lo copie a Claude:

```
@claude TASK-DONE: <TASK-ID> — listo para revisión
```

Ejemplo: `@claude TASK-DONE: GP-01 — listo para revisión`

Claude leerá LAST-RESULT.md y el git diff, y decidirá qué sigue.

## Branch activo
`feat/store-agent-golden-path`

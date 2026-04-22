---
name: store-runtime-dev
description: Use when working on apps/store-runtime code, tests, Redis-first runtime wiring, multi-speaker routing, UI bridge state, avatar sidecars, or store-runtime developer workflows.
---

# Store Runtime Dev

Usa esta skill cuando el trabajo sea de implementación o revisión técnica dentro
de `apps/store-runtime` o su integración inmediata con `packages/core`.

## First Reads

Lee primero:

- [apps/store-runtime/README.md](../../../apps/store-runtime/README.md)
- [docs/STORE-RUNTIME-DEVELOPER-GUIDE.md](../../../docs/STORE-RUNTIME-DEVELOPER-GUIDE.md)

Si el cambio es arquitectónico o afecta el scope del producto, consulta también:

- [docs/plans/STORE-RUNTIME-SINGLE-STORE.md](../../../docs/plans/STORE-RUNTIME-SINGLE-STORE.md)

## Fast File Map

- Runtime boot: `apps/store-runtime/src/bootstrap/bootstrap.ts`,
  `apps/store-runtime/src/agents/build-agents.ts`
- Conversación: `apps/store-runtime/src/agents/interaction-runtime-agent.ts`
- Captura/ingress: `apps/store-runtime/src/bootstrap/stt-bridge.ts`,
  `apps/store-runtime/src/bootstrap/speaker-session.ts`
- Multi-speaker core: `packages/core/src/agent/target-group-bridge.ts`
- UI externa: `apps/store-runtime/src/external/ui-bridge.ts`,
  `apps/store-runtime/src/external/ui-dashboard-state.ts`
- Avatar externo: `apps/store-runtime/src/external/avatar-service.ts`
- Demo Redis: `apps/store-runtime/src/external/demo-publisher.ts`

## Working Rules

- No edites `apps/store-runtime/dist/`, `apps/store-runtime/data/` ni
  `apps/store-runtime/node_modules/`.
- Mantén el enfoque Redis-first cuando agregues sidecars o consumidores externos.
- No dejes que speakers en cola disparen `InteractionRuntimeAgent`.
- Si cambia un contrato de evento, actualiza tests y docs del app.

## Validation

Después de cambios normales:

```bash
pnpm --filter store-runtime type-check
pnpm --filter store-runtime lint
pnpm --filter store-runtime test
pnpm --filter store-runtime build
```

Si tocas target group, sesiones o speaker routing:

```bash
pnpm --filter fitalyagents test -- src/agent/target-group-bridge.test.ts
pnpm --filter fitalyagents build
```

## When To Go Deeper

- Para extensión de tools, sidecars o contratos usa la guía de desarrollo.
- Para levantar el stack y smoke checks usa
  [docs/STORE-RUNTIME-OPERATIONS.md](../../../docs/STORE-RUNTIME-OPERATIONS.md).

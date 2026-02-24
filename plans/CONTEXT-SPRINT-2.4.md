# Contexto para Continuación: Sprint 2.4 - Integración E2E (Fase 2)

## Estado Actual del Proyecto
El proyecto **FitalyAgents** se encuentra finalizando la **Fase 2 (Agentes Concretos / End-to-End)**.
Los Sprints 2.1, 2.2 y 2.3 se han completado con éxito, lo que significa que ya están implementados y probados:
1. `AudioQueueService` (Gestión de Audio)
2. `InteractionAgent` (Agente frontend, manejador de latencia y fillers vía `TEN Framework` mockeado)
3. `WorkAgent` (Agente backend, orquestador de herramientas paralelas vía `LangChain.js` mockeado)

**El objetivo actual (Sprint 2.4) es realizar el test de integración End-to-End (E2E)** que une todo el flujo desde que el usuario habla hasta que el sistema responde de forma definitiva, validando la orquestación distribuida (events: `SPEECH_FINAL` -> `TASK_AVAILABLE` -> `ACTION_COMPLETED`).

## Lo que se estaba haciendo justo antes

Se creó el archivo de pruebas End-to-End: `examples/voice-retail/src/e2e/pipeline.e2e.test.ts`.

Se corrió la prueba con `vitest`, pero **dos de las pruebas fallaron (`full pipeline` y `validates complete event sequence`)**.

**El motivo de los fallos identificados fue:**
1.  **Problema de Enrutamiento en el Test:** En el E2E se usó una función auxiliar llamada `createSimpleRouter` para simular el comportamiento del `CapabilityRouter` (el cual es muy complejo para un test E2E ya que usa Locks, colas de base de datos, etc.).
2.  **El Bug (Ya Parcialmente Corregido):** Inicialmente, el `createSimpleRouter` usaba `bus.publish()` para enviar las tareas (`TASK_PAYLOAD`) a los inboxes del `WorkAgent` y del `InteractionAgent`. Sin embargo, `NexusAgent` (la clase base de los agentes) usa una cola lista de Redis implementada en memoria (`bus.lpush` y lectura con `bus.brpop`) en su método `listenInbox()`.
3.  **Corrección en Proceso:** Se modificó la línea en el router del E2E para usar `bus.lpush(agentChannel, workPayload)` en vez de `publish`.

**El Estado Exacto de Dónde Quedamos:**
Luego de corregir el `lpush`, íbamos a verificar el método `start()` de `InMemoryAudioQueueService`, pues en el código del E2E se intentó desuscribirse (`audioUnsub = audioQueue.start()`), y es necesario validar si ese método retorna una función (unsubscribe) o si retorna `void`.

## Próximos pasos exactos para quien continúe

Para completar exitosamente el E2E, debes hacer lo siguiente:

1. **Revisar `InMemoryAudioQueueService.start()`:**
   - Verifica en `packages/core/src/audio/in-memory-audio-queue-service.ts` cómo está implementado `start()`.
   - Modifica el archivo de pruebas `examples/voice-retail/src/e2e/pipeline.e2e.test.ts` (línea ~194 y final del `afterEach`) si `start()` no devuelve una función de limpieza (Unsubscribe).

2. **Ejecutar las pruebas en el entorno Retail:**
   - Corre el comando: `npx vitest run --reporter=verbose` en la carpeta `examples/voice-retail`.
   - Tu principal enfoque es que los tests en `pipeline.e2e.test.ts` pasen limpiamente (actualmente están en 3/5 o fallando por problemas de suscripción de eventos o latencia de inserción en la cola).

3. **Verificar los Eventos E2E Esperados en Pipeline:**
   El flujo exitoso que las pruebas evalúan es:
   1. `bus.publish('bus:SPEECH_FINAL')`
   2. MockClassifier crea el intent
   3. `router` publica (con `bus.lpush`) en el *Inbox* (ej. `queue:work-agent:inbox`)
   4. El `WorkAgent` processa, y devuelve un `bus.publish('bus:ACTION_COMPLETED')`
   5. El `InteractionAgent` debe recibirlo y hacer un `audioQueue.interrupt()` seguido de un payload al audioQueue.

4. **Refinar Latencias y Sincronismo en los Tests E2E:**
   Las aserciones verifican `toolExecutor.executionLog.length === 2` y la colección de eventos del bus. Si continúan fallando, asegúrate de utilizar `wait(ms)` o `await Promise.all()` en los lugares correctos del test unitario, ya que la naturaleza asíncrona del `lpush / brpop` y los timeouts a veces fallan porque `vitest` verifica *antes* de que el bus termine.

5. **Actualizar el Plan a Sprint 2.4 FINISHED:**
   Una vez que pasen las 5 pruebas de `pipeline.e2e.test.ts`, abre `plans/PLAN-SPRINTS.md` y marca:
   - "Integrar source de bus:SPEECH_FINAL"
   - "Test completo: speech → Dispatcher..."
   - "Barge-in: bus:BARGE_IN..."
   - "Entregable: Pipeline voice → speech completo"
   Como **Completados ✅**. 
   Con eso, cerramos oficialmente toda la "Fase 2" y el flujo asíncrono avanzado con Agentes concretos quedará 100% verificado y validado.

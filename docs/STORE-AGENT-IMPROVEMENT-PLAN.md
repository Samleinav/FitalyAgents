# Store Agent Improvement Plan

Plan de casos, mejoras y criterios de aceptacion para pasar del primer demo
funcional a un agente de tienda mas natural, confiable y operable.

## Current Baseline

Ya existe una primera prueba integrada:

- `store-runtime` en `:3000`
- `store-ui-bridge` en `:3010`
- `customer-display` en `:3020`
- `store-deploy-center` en `:3030`
- `livekit-voice-bridge` en `:3050`
- acceso HTTPS para pruebas de voz en `https://store1.entomai.com`
- bus Redis compartido entre runtime, pantallas y bridge LiveKit
- cierre de room LiveKit por idle o `POST /room/close`

La meta de este plan es convertir esa base en un flujo de venta completo:
explorar productos, seleccionar, editar orden, pagar, entregar cierre y dejar
pantallas/logs consistentes.

## Principles

- El agente habla como vendedor de tienda, no como sistema tecnico.
- Nunca menciona nombres internos de herramientas, drafts, schemas, payloads ni
  ids con guion bajo.
- La pantalla cliente debe mostrar datos accionables: productos, ids visuales,
  atributos, stock, orden y pago.
- Toda orden activa debe continuar entre turnos de la misma sesion.
- No hay pago sin orden completa.
- No hay orden confirmada sin total claro.
- Si el cliente se despide, el agente cierra corto y limpia la atencion cuando
  corresponda.

## Phase 0 - Golden Path

Objetivo: una venta feliz de punta a punta, repetible por texto y por voz.

### Case GP-01 - Greeting

Input:

```text
hola
```

Expected:

- Respuesta corta y calida.
- No crea orden.
- Customer display queda en estado inicial o bienvenida.
- Staff UI muestra sesion activa.

### Case GP-02 - Product Browsing

Input:

```text
quiero ver tenis talla 42
```

Expected:

- El agente muestra opciones disponibles.
- Customer display renderiza una lista con ids visuales simples: `A1`, `A2`,
  `A3`.
- Cada producto muestra nombre, precio, talla/color si existen y stock.
- El agente invita a escoger por id visual o descripcion.

### Case GP-03 - Visual Selection

Input:

```text
quiero el A2
```

Expected:

- El agente entiende el producto mostrado como `A2`.
- Crea o actualiza la orden activa.
- Customer display muestra producto seleccionado y total.
- El agente pide confirmacion en lenguaje natural.

### Case GP-04 - Checkout

Input:

```text
quiero pagar con tarjeta
```

Expected:

- El agente usa la orden activa, no vuelve a preguntar productos.
- Simula datafono o paso al empleado.
- Customer display muestra estado de pago.
- Staff UI muestra accion pendiente o completada.

### Case GP-05 - Closing

Input:

```text
gracias, chao
```

Expected:

- Si la orden esta pagada, responde corto: `Gracias por tu compra. Hasta luego.`
- Limpia o marca la sesion como cerrada.
- No abre nuevo flujo.

## Phase 1 - Conversation Continuity

Objetivo: que el agente no pierda el contexto de orden.

### Required Behaviors

- `como pago`, `quiero pagar`, `y para pagar` deben continuar con la orden
  activa.
- `si`, `confirmo`, `dale` deben confirmar la ultima pregunta pendiente, no una
  accion generica.
- `quita ese`, `cambia la talla`, `agrega otro` deben operar sobre la orden o la
  ultima lista visible.
- Si no hay orden activa y el cliente pide pagar, el agente pregunta que desea
  comprar.
- Si hay productos visibles pero no seleccion, el agente acepta referencias como
  `el primero`, `el azul`, `el barato`, `el A1`.

### Acceptance Tests

| ID    | Conversation                                | Expected                                     |
| ----- | ------------------------------------------- | -------------------------------------------- |
| CT-01 | `quiero ver tenis talla 42` -> `el primero` | Orden con primer producto visible            |
| CT-02 | `quiero pagar` tras orden activa            | Inicia checkout sin pedir productos otra vez |
| CT-03 | `si` tras confirmacion                      | Confirma la accion pendiente correcta        |
| CT-04 | `no, mejor el otro`                         | Cambia seleccion sin crear orden duplicada   |
| CT-05 | `cancela`                                   | Cancela draft/orden pendiente y actualiza UI |

## Phase 2 - Customer Display UX

Objetivo: que la segunda pantalla ayude al cliente a decidir.

### Product List

Cada resultado debe exponer:

- id visual corto
- nombre
- precio
- stock
- atributos existentes: talla, color, marca, categoria
- estado: disponible, bajo stock, agotado

### Order Panel

Debe mostrar:

- items seleccionados
- cantidades
- subtotal
- descuentos si existen
- total
- estado de confirmacion
- estado de pago

### Interaction Rules

- Si el cliente pregunta por productos, se muestra lista.
- Si el cliente selecciona, se resalta item elegido.
- Si cambia la orden, se actualiza sin parpadeos ni perdida de contexto.
- Si no hay resultados, se muestra estado vacio y alternativas.

## Phase 3 - Checkout Mock

Objetivo: simular pago real sin integrar PSP/POS todavia.

### Card Flow

Input examples:

- `pago con tarjeta`
- `tarjeta`
- `datafono`

Expected:

- Agente: `Perfecto, te paso al datafono.`
- Payment mock crea intento de pago.
- Staff UI muestra `datafono pendiente` o `pago aprobado`.
- Customer display muestra total y metodo.

### Cash Flow

Input examples:

- `pago en efectivo`
- `tengo efectivo`

Expected:

- Agente: `Un empleado te recibe el efectivo.`
- Staff UI muestra accion para empleado.
- Al completar mock, agente cierra corto.

### Employee In The Loop

Casos donde se espera empleado:

- efectivo
- datafono fisico
- entrega de producto
- producto con bajo stock
- anulacion o cambio sensible

## Phase 4 - Natural Voice Flow

Objetivo: que la prueba por voz se sienta natural.

### HTTPS Path

Use:

```text
https://store1.entomai.com
```

Expected:

- El navegador permite microfono por secure context.
- `GET /health` mantiene `room_connected:false` en idle.
- `Conectar LiveKit` abre room.
- `Cerrar Sala` limpia room despues de la prueba.

### Thinking Cue

El agente puede decir una frase corta de espera solo cuando:

- hay busqueda de catalogo lenta
- hay checkout mock en proceso
- hay aprobacion o empleado en el loop
- hay tool call que supera un umbral de latencia

Frase recomendada:

```text
Un momento, estoy revisando.
```

No debe usarse si la respuesta final llega casi inmediata.

## Phase 5 - Skills And Policy

Objetivo: separar conocimiento operativo del codigo.

Skills sugeridas:

- `retail-sales-flow`
  guia de saludo, exploracion, seleccion, confirmacion y cierre
- `retail-checkout`
  reglas de pago, efectivo, tarjeta, empleado y recibo
- `retail-display-language`
  como referirse a ids visuales, productos y atributos en pantalla
- `retail-recovery`
  manejo de errores, no stock, ambiguedad, cancelacion y correccion

Cada skill debe incluir:

- frases buenas
- frases prohibidas
- ejemplos de multi-turn
- criterios de exito
- casos borde

## Phase 6 - Observability And Replay

Objetivo: depurar conversaciones sin adivinar.

Agregar o consolidar:

- session id visible en staff UI
- timeline por sesion
- ultimo producto mostrado
- orden activa
- pregunta pendiente
- tool calls y resultados
- latencia desde `SPEECH_FINAL` a `RESPONSE_START`
- latencia desde `RESPONSE_START` a primer TTS
- export de replay para bugs

## Priority Backlog

### P0

- Continuidad de orden activa para `quiero pagar`.
- Eliminar lenguaje tecnico restante del agente.
- Product list con ids visuales en customer display.
- Seleccion por id visual y por referencia natural.
- Checkout mock tarjeta/efectivo.
- Cierre corto de atencion.

### P1

- Correcciones de seleccion.
- Cancelacion y limpieza de sesion.
- Estados de stock y alternativas.
- Staff UI con accion esperada.
- Replay basico por sesion.

### P2

- Skills retail formales.
- Metricas de latencia y costo.
- Auth/Cloudflare Access para host publico.
- PSP/dataphone real.
- Persistencia durable para ordenes y eventos criticos.

## Definition Of Done

Una mejora cuenta como lista cuando:

- pasa por texto manual en `:3050`
- pasa por voz en `https://store1.entomai.com`
- se refleja correctamente en `:3010`
- se refleja correctamente en `:3020`
- deja logs claros en bus/runtime
- no deja room LiveKit activo tras cerrar la prueba
- tiene al menos una prueba automatizada o caso manual documentado

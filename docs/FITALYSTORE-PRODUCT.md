# FitalyStore — Visión de Producto

> FitalyAgents es el motor interno. FitalyStore es lo que se vende.
> El modelo: Next.js (framework gratis) + Vercel (el negocio).

---

## La Propuesta de Valor

```
FitalyStore — AI assistant for your store, ready in 15 minutes

Your customers talk, Fitaly responds.
Search products, take orders, answer questions — by voice.
Works in Spanish, English, Portuguese.
No code required.
```

**El dueño de tienda no sabe qué es un embedding. Solo sabe que:**
- Sus clientes hacen preguntas → Fitaly las responde
- Fitaly puede tomar pedidos → empleado solo despacha
- Fitaly escala a un humano cuando algo necesita aprobación
- Ve qué preguntan los clientes en su dashboard

---

## Onboarding en 6 Pasos

```
Paso 1: Registro en fitalycloud.com
        → nombre de tienda, tipo (retail, restaurante, farmacia...)
        → plan seleccionado

Paso 2: Subir catálogo
        → CSV, Shopify sync, WooCommerce sync, o carga manual
        → Fitaly indexa productos con embeddings automáticamente

Paso 3: Conectar pagos (opcional)
        → Pasarela de pago → cobros por voz

Paso 4: Configurar reglas básicas
        → Idioma(s): español, inglés, portugués
        → Horario de atención
        → Personalidad: nombre, tuteo/usted, tono
        → Reglas: "órdenes > ₡50,000 requieren empleado"

Paso 5: Recibir / instalar hardware
        → Hardware: Raspberry Pi + micrófono array + parlante (enviado por FitalyStore)
        → o instalar app en tablet existente

Paso 6: Encender. Funciona.
```

---

## Tiers de Servicio

### Starter — $199/mes

```
├── 1 local
├── 1 idioma
├── Catálogo hasta 500 productos
├── STT + LLM + TTS incluidos en el precio
├── Tools SAFE: búsqueda, precios, horarios, stock
├── Dashboard básico: ver conversaciones, historial
├── Aprobaciones por webhook (app móvil)
└── Soporte por email (48h)
```

**Para:** Tienda pequeña que quiere automatizar atención básica.

---

### Pro — $499/mes

```
├── 1 local
├── 2 idiomas
├── Catálogo hasta 5,000 productos
├── Todo Starter +
├── Tools STAGED: órdenes en borrador, carritos
├── Tools PROTECTED: cobros con confirmación del cliente
├── Aprobaciones multi-canal: voz + app
├── Integraciones: Shopify, WooCommerce
├── FitalyInsights analytics básico
├── RAG: sube documentos (políticas, FAQ, manual)
├── Multi-target: hasta 3 clientes simultáneos
└── Soporte prioritario (12h)
```

**Para:** Tienda mediana con integración a e-commerce y necesidad de analytics.

---

### Enterprise — $999-2,000/mes por local

```
├── Multi-local (cadenas): precio por local
├── Idiomas ilimitados
├── Catálogo ilimitado
├── Todo Pro +
├── Tools RESTRICTED: reembolsos, descuentos, overrides
├── Human roles completos: staff/cashier/manager/owner
├── Voice identification de empleados
├── ApprovalOrchestrator: voz + webhook + herramienta externa
├── FitalyInsights completo: comparación entre locales
├── RAG avanzado: docs por local, actualización automática
├── API para integraciones custom
├── SLA de uptime 99.9%
└── Account manager dedicado
```

**Para:** Cadenas de retail, restaurantes con múltiples locales, franquicias.

---

## FitalyCloud — Infraestructura por Tienda

Cada local tiene sus datos aislados:

```
Por tienda:
├── Catálogo de productos (search + embeddings actualizados)
├── Speaker profiles (voces conocidas → roles)
├── Session history (historial de conversaciones)
├── Intent library (intents entrenados específicos de esta tienda)
│   Ej: tienda de zapatos aprende "¿tienen el modelo que salió en el comercial?"
├── DraftStore (órdenes en borrador con TTL)
└── Configuración completa (idioma, horario, reglas, personalidad)

Compartido (eficiencia de costo):
├── LLM inference (Groq / OpenRouter)
├── STT (Deepgram Nova-3)
├── TTS (ElevenLabs Flash / Cartesia)
└── Base model de embeddings (multilingüe)
```

---

## FitalyInsights — Analytics para el Dueño

FitalyInsights traduce datos técnicos (Langfuse traces) al idioma del negocio:

```
Langfuse trace (técnico):
  span: embedding_classify, intent: product_search, conf: 0.92
  span: llm_call, model: llama-8b, tokens: 150, cost: $0.001
  span: tool_call: product_search, latency: 300ms
  score: teacher_correction, value: 0

FitalyInsights muestra al dueño:
  "Hoy 47 clientes preguntaron por productos.
   Tu agente respondió en promedio 0.8 segundos.
   3 preguntas no pudo responder — revísalas aquí.
   Sugerencia: agrega 'promoción de verano' a tus productos."
```

### Métricas disponibles

| Métrica | Descripción |
|---|---|
| Preguntas frecuentes | Top 10 intents del día/semana/mes |
| Gaps de training | Preguntas que el agente no supo responder |
| Tasa de conversión | Consulta → draft → orden confirmada |
| Tiempo de respuesta | Latencia promedio por tipo de query |
| Satisfacción | Score de correcciones del Teacher |
| Comparación entre locales | Solo Enterprise multi-local |

---

## FitalyConnect — Integraciones

| Integración | Plan mínimo | Descripción |
|---|---|---|
| Shopify | Pro | Sync automático de catálogo + órdenes |
| WooCommerce | Pro | Sync automático de catálogo + órdenes |
| Pasarelas de pago | Pro | SINPE Móvil, tarjetas, transferencias |
| WhatsApp Business | Enterprise | Atención por chat también |
| POS systems | Enterprise | Sincronizar inventario en tiempo real |
| CRM | Enterprise | Historial de clientes por voz reconocida |
| External Approval Tool | Enterprise | Sistema propio de autorizaciones |

---

## Hardware

### Opción 1: FitalyBox (recomendado)

Raspberry Pi 5 preconfigurado por FitalyStore:
```
├── Micrófono array (ReSpeaker 6-mic)
├── Parlante de 10W
├── LED ring (indica estado: escuchando, procesando, hablando)
└── Precargado con FitalyEdge (cliente local)
```
Precio: $299 + envío (o incluido en contrato anual).

### Opción 2: App en tablet existente

FitalyApp para Android/iOS:
```
└── Tablet del cliente + app de FitalyStore
    → Funciona con micrófono integrado de la tablet
    → Pantalla muestra transcripción y estado
```

### Opción 3: Integración con hardware existente

Para cadenas con hardware propio:
```
└── FitalyEdge SDK (Docker container)
    → Se conecta a cualquier micrófono/parlante de la tienda
    → Comunica con FitalyCloud via websockets
```

---

## Arquitectura de Dos Capas

```
CAPA 1: FitalyAgents (framework, open source, npm)
├── Motor interno de FitalyStore
├── Disponible para desarrolladores
├── Monetización: $0 (atrae talento, contribuciones, credibilidad)
└── npm install fitalyagents

CAPA 2: FitalyStore / FitalyCloud (producto, SaaS)
├── Plataforma lista para usar — sin código
├── Clientes: tiendas, restaurantes, cadenas retail
├── Monetización: $199-2000/mes por local
└── fitalycloud.com
```

Modelo inspirado en Vercel (Next.js es gratis, la plataforma Vercel es el negocio).

---

## Roadmap de Producto

### Ahora (Fase 1-3 del framework)
- Safety model + multi-channel approval
- Interaction Agent con LLM streaming
- Draft flow multi-turno

### Mes 1 (primer cliente real)
- FitalyCloud API mínima (`/v1/audio/stream`)
- Dashboard básico (Langfuse backend + frontend propio)
- Conector de catálogo (CSV upload → vector search)
- Deploy en 1 tienda piloto

### Mes 2-3
- FitalyBox hardware
- Integraciones Shopify / WooCommerce
- RAG para documentación (políticas, FAQ)
- Multi-target + ambient context

### Mes 4+
- Pricing page + sign-up self-service
- Onboarding automatizado
- Escalar a más tiendas
- WhatsApp Business integration

> **El paso más importante: deploy en 1 tienda real.**
> Una tienda real usando Fitaly vale más que 6 meses de arquitectura perfecta.
> Las decisiones de producto reales se toman cuando un dueño dice "esto no sirve porque..."

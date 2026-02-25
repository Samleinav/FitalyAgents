# FitalyAgents — Estrategia de Producto

> Notas estratégicas sobre publicación, monetización y productos a construir con el SDK.
> Actualizado: 2026-02-24

---

## Publicar en npm

### ¿Cuándo tiene sentido?

El SDK ya está listo para publicar (v1.1.0, 325 tests, licencia definida). Publicar en npm tiene sentido cuando:

- Quieres que otros lo descubran y evalúen
- Necesitas que clientes o socios instalen el SDK sin acceso al repo privado
- Commons Clause ya te protege: pueden usar el SDK, pero **no venderlo como SaaS ni como producto**

### Pasos antes de publicar

1. Cambiar `"your-org"` en los badges de los README por tu GitHub real
2. Agregar en cada `package.json`:
   ```json
   "repository": { "type": "git", "url": "https://github.com/TU-ORG/fitalyagents" },
   "homepage": "https://github.com/TU-ORG/fitalyagents#readme"
   ```
3. Revisar `"private": false` (si aplica) en `packages/core/package.json` y `packages/asynctools/package.json`
4. Publicar:
   ```bash
   cd packages/core && npm publish --access public
   cd packages/asynctools && npm publish --access public
   cd packages/dispatcher && npm publish --access public
   ```

---

## Productos que puedes construir CON el SDK

### Como plataforma B2B

| Producto | Qué hace | Por qué funciona |
|---|---|---|
| **Asistente de voz para retail** | Busca productos, verifica precios, gestiona pedidos por voz | El example `voice-retail` ya es un MVP completo |
| **Centro de atención multiagente** | Agentes especializados por tema, escalada a humano con `ApprovalQueue` | `OrderAgent` + `ApprovalQueue` ya modelan este flujo |
| **Back-office con IA** | Integra ERP, WMS, CRM a través de `ToolRegistry` con aprobaciones humanas | `ToolRegistry` + `inject_when_all` paraleliza todas las llamadas |
| **Kiosko interactivo** | `NexusAgent` + TEN Framework en hardware físico, flujo de audio ya resuelto | El bus funciona tanto en memoria como con Redis |
| **Asistente de hostelería** | Check-in, room service, concierge por voz o texto | Copia el patrón WorkAgent + InteractionAgent, cambia las tools |

### Como infraestructura técnica

- El SDK resuelve los problemas difíciles: paralelismo de tools, clasificación de intents, sesiones concurrentes, aprobaciones humanas
- Tú o tus clientes solo tienen que implementar las tools de negocio (llamadas a APIs propias)
- El patrón `IToolExecutor` / `ITENClient` permite sustituir cualquier dependencia externa

---

## Productos que puedes ofrecer PARA el SDK

> Similar a cómo `ClaudeLLMProvider` se enchufta al SDK, puedes ofrecer providers y servicios que otros usuarios del SDK compren o usen.

### Opción 1 — FitalyCloud (Intent Library as a Service) ⭐ recomendada

**El problema que resuelve:**
Los usuarios del SDK tienen que poblar la `IntentLibrary` con ejemplos, mantener embeddings, y no tienen visibilidad de qué se clasifica bien o mal.

**Qué ofrece:**

```typescript
import { CloudIntentLibrary } from '@fitalyagents/cloud'

const intentLibrary = new CloudIntentLibrary({
  apiKey: process.env.FITALY_API_KEY,
  projectId: 'mi-proyecto',
})
// Sincroniza intents desde la nube, con versionado y analytics
```

**Funcionalidades:**
- Dashboard web para ver qué intents se clasifican bien/mal en producción
- Auto-sugerencia de nuevos ejemplos basada en utterances que cayeron a fallback
- API REST para gestionar intents sin tocar código
- `DispatcherBootstrapper` integrado — registra tu agente y se auto-configura
- A/B testing de conjuntos de ejemplos
- Histórico de clasificaciones y tasa de error por intent

**Monetización:** SaaS mensual por proyecto + por volumen de clasificaciones. El SDK sigue siendo gratis. El servicio de nube es el negocio.

---

### Opción 2 — `@fitalyagents/ten-provider`

**El problema que resuelve:**
`ITENClient` está mockeable pero los usuarios tienen que integrar TEN Framework ellos solos (documentación escasa, configuración compleja).

**Qué ofrece:**
```typescript
import { TENFrameworkClient } from '@fitalyagents/ten-provider'

const tenClient = new TENFrameworkClient({
  appId: process.env.TEN_APP_ID,
  region: 'us-east-1',
})
```

Un wrapper real de TEN Framework listo para producción que implementa `ITENClient`. Los usuarios del SDK lo compran para no integrar TEN ellos solos.

**Monetización:** Licencia por proyecto o por instalación.

---

### Opción 3 — `@fitalyagents/tools-catalog`

**El problema que resuelve:**
Cada proyecto tiene que implementar sus tools desde cero (búsqueda, CRM, inventario, base de datos).

**Qué ofrece:**
Colección de `ToolExecutor` preconfigurados para casos comunes:
```typescript
import { ShopifyToolExecutor, SalesforceToolExecutor } from '@fitalyagents/tools-catalog'

const toolExecutor = new ShopifyToolExecutor({ shopDomain, accessToken })
// Incluye: product_search, price_check, inventory_check, order_create...
```

**Monetización:** Paquetes por integración (Shopify, Salesforce, SAP, etc.).

---

### Opción 4 — `@fitalyagents/observability`

**El problema que resuelve:**
No hay visibilidad de lo que pasa en producción — latencias, errores, clasificaciones fallidas.

**Qué ofrece:**
Plugin que se suscribe al bus y envía métricas a Datadog, Grafana, o dashboard propio:
```typescript
import { FitalyObservability } from '@fitalyagents/observability'

new FitalyObservability({ bus, destination: 'datadog', apiKey: '...' }).start()
// Emite: clasificación, latencia por agente, tasa de fallback, audio metrics
```

**Monetización:** Gratuito (fideliza usuarios) o como parte de FitalyCloud.

---

### Opción 5 — Templates de industria

Paquetes de agentes preconfigurados para industrias específicas que se instalan en un comando:

```bash
npm install @fitalyagents/template-retail
npm install @fitalyagents/template-hospitality
npm install @fitalyagents/template-healthcare
```

Cada template incluye: manifests, intents preentrenados, tools comunes de la industria, guías de configuración.

**Monetización:** Gratuito (canal de adquisición) o premium con soporte y actualizaciones.

---

## Prioridad recomendada

1. **FitalyCloud** — mayor impacto, monetización recurrente, cierra el loop del SDK (generación + observabilidad + gestión de intents)
2. **Templates de industria** — más rápido de ejecutar, ayuda a la adopción del SDK
3. **`@fitalyagents/tools-catalog`** — acelera el tiempo de integración de los clientes
4. **TEN Provider / Observability** — complementos una vez que hay base de usuarios

---

## Ventaja competitiva del SDK

Lo que hace difícil de copiar a FitalyAgents:

- **Paralelismo de tools** — el problema más difícil de resolver bien; la mayoría de SDKs de agentes son secuenciales
- **Bus desacoplado** — los agentes no saben nada del bus; se pueden probar con InMemoryBus y deployar con Redis sin cambiar código
- **SessionManager + ContextStore** — gestión de estado por sesión con aislamiento y control de acceso built-in
- **ApprovalQueue** — el loop humano ya está modelado; la mayoría de frameworks lo ignoran
- **Barge-in de audio** — el interrupt protocol de audio es raro que esté resuelto a nivel de SDK

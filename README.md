# Ecom Connect · FarmaHouse Demo

Demo funcional de parafarmacia omnicanal, derivada del motor **Logic2B Ecommerce**.
45 productos ficticios, carrito y checkout simulado, pedidos centralizados y
adaptadores intercambiables de proveedor y hub de marketplaces.

**FarmaHouse** es la tienda ficticia; **Ecom Connect**, el panel que coordina la
operación; **Logic2B**, el motor de comercio que reutiliza el proyecto.

**Demo publicada:** [Tienda](https://ecom-connect.marinerandreu.workers.dev/) ·
[Panel omnicanal](https://ecom-connect.marinerandreu.workers.dev/admin) ·
[Feed XML](https://ecom-connect.marinerandreu.workers.dev/feeds/products.xml).

## Arranque

Requiere Node.js 22 o superior y pnpm.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Tienda: `http://localhost:4327/`. Panel: `http://localhost:4327/admin`.
La semilla usa `INSERT OR IGNORE`: repetirla no borra pedidos ni sustituye cambios.

## Documentación técnica e integración dropshipping

El panel incluye un [centro de documentación local](http://localhost:4327/admin/documentacion)
con una guía de presentación, un plan de conexión por servicio, arquitectura,
contrato del proveedor, documentación de Lighthouse, API de la demo y verificación.
La revisión identifica expresamente los bloqueos
para la conexión comercial: dirección de entrega ausente en el alta del proveedor,
precios/impuestos, pedidos ERP múltiples, expediciones y prueba sandbox completa.

- [Guía de presentación de 15 minutos](docs/GUIA-DEMO.md): preparación, recorrido,
  funcionalidades, ventajas comprobables y respuestas a preguntas del cliente.
- [Cómo conectamos todos los servicios](docs/CONEXION-SERVICIOS.md):
  responsabilidades, intercambio de datos y pasos de implantación con criterios
  de aceptación por proveedor, Lighthouse y canal.
- [Arquitectura dropshipping y requisitos](docs/INTEGRACION-DROPSHIPPING.md).
- [API del proveedor: análisis del PDF](docs/PROVEEDOR.md).
- [Lighthouse: contratos oficiales y cobertura](docs/LIGHTHOUSE.md).
- [Imágenes OpenAI y prompts](docs/IMAGENES.md).

Los normalizadores de contrato funcionan offline. La demo añade acuses locales
de estado/tracking hacia el hub y conciliación, con todas las integraciones
todavía simuladas. Aplicar las nuevas migraciones locales antes de arrancar
una copia existente. No se han activado cuentas comerciales.

## Recorrido de presentación

El [guion detallado](docs/GUIA-DEMO.md) incluye tiempos, botones, resultados
esperados y límites de cada simulación. Preparar el modo **Envío agrupado** para
poder enseñar el envío al proveedor paso a paso, y restaurar el ajuste inicial
al terminar. La configuración y los datos de prueba se comparten entre visitas.

1. Explorar la tienda, buscar «Champú», añadir a la cesta y completar una compra
   con el cliente ficticio precargado. No se solicita tarjeta ni se cobra.
2. Abrir **Panel → Pedidos**. El pedido aparece con canal **WEB**.
3. En **Marketplaces**, seleccionar Amazon, producto y cantidad; pulsar
   **Simular pedido**. Revisar el nuevo pedido con canal **AMAZON**.
4. En **Integraciones → Proveedor**, simular un stock de 7 y después sincronizar.
   La tienda y el feed muestran el disponible actualizado. Los pedidos aún no
   enviados al proveedor se descuentan del disponible, evitando reponerlos por error.
   La misma pantalla permite simular un precio y PVP opcional: compara proveedor
   y tienda antes de sincronizar. El guion explica cómo mostrar su efecto en una
   compra abierta y restaurar los importes originales después.
5. En un pedido, **Enviar al proveedor**. Se obtiene un ID `PED-ERP-*`.
   Avanzar por procesando, parcial/error si se desea, y enviado. Aparece `DEMO-*`.
   El recorrido visual muestra las etapas y el siguiente paso; en marketplaces,
   el retorno se completa cuando el acuse coincide con el seguimiento actual.
6. En **Configuración**, alternar inmediato/agrupado. El botón para procesar
   pendientes ejecuta el lote; el programador automático queda preparado, pendiente de activación.
7. En **Lighthouse Feed**, regenerar y abrir el XML o JSON. Los cuatro canales
   muestran publicación simulada y la fecha real de la última operación.

Los contadores del panel y de cada marketplace incluyen todos los pedidos
guardados. **Pedidos** permite buscar y filtrar todo el historial con páginas
de 25 resultados. Canal, estado del pedido y situación del proveedor se combinan
para localizar pendientes, errores o envíos parciales. La URL conserva los filtros y la página para retomar o
compartir la consulta. Los importes son simulados, no facturación real.

**Productos** combina búsqueda por nombre, referencias, EAN o marca con categoría,
estado y stock en tienda. Los filtros quedan en la URL y se conservan al volver
de una ficha. Las referencias inactivas siguen en administración, identificadas
como no visibles en tienda; no se ofrecen enlaces a fichas que no están publicadas.

Si una compra pierde su respuesta, **Reintentar confirmación** recupera el mismo
intento sin volver a cotizar el stock en pantalla. Al confirmarse, la cesta
descuenta solo las cantidades de la selección original y conserva los añadidos
posteriores, incluso un producto eliminado y añadido de nuevo. Si no puede
actualizarla con seguridad, indica que debe revisarse; el pedido sigue confirmado.
La recuperación tras recarga requiere que el almacenamiento de sesión esté
disponible.

Si cambia el precio o el envío desde que se mostró el resumen, el checkout
explica el importe anterior y el actualizado y pide confirmarlo de nuevo.
No crea el pedido hasta aceptar ese desglose. Los pedidos ya confirmados
conservan sus importes originales al recuperarlos.

## Arquitectura

```mermaid
flowchart LR
  P[Proveedor Demo] -->|catálogo y stock| E[Ecom Connect · motor Logic2B]
  W[FarmaHouse · tienda web] -->|pedido simulado| E
  E -->|SupplierAdapter| P
  E <-->|MarketplaceHubAdapter| L[Lighthouse Feed simulado]
  L <--> M[Amazon · Miravia · Carrefour · eBay simulados]
  E <--> D[(Cloudflare D1)]
```

[Análisis y reutilización](docs/ARQUITECTURA.md). El núcleo importado conserva
los snapshots de precios, ledger de inventario/pagos, cotización y escritura
transaccional de pedidos. Las migraciones propias añaden metadata omnicanal,
acuses de marketplace, fotografías demo y recibos idempotentes de cambios de precio.

## Endpoints

| Endpoint | Uso |
| --- | --- |
| `GET /api/products` | Catálogo activo |
| `POST /api/cart/quote` | Cotización en servidor |
| `POST /api/checkout/session` | Pedido/pago ficticio idempotente |
| `GET /api/demo/state` | Estado del panel |
| `GET /api/demo/orders` | Historial paginado con búsqueda y filtros |
| `GET /api/demo/orders/:id` | Pedido, líneas y eventos |
| `GET /api/demo/stock?code=…` | Existencias, reservas y comparación de precios proveedor/tienda |
| `POST /api/demo/action` | Sync, stock, precios, pedidos marketplace, envío y ajustes |
| `GET/POST /api/supplier/catalog` | Catálogo del proveedor simulado |
| `GET/POST /api/supplier/stock` | Stock del proveedor simulado |
| `GET/POST /api/supplier/orders` | Consulta/creación de pedido de proveedor |
| `POST /api/supplier/status` | Avanzar estado del proveedor |
| `GET /feeds/products.xml` | Feed conceptual Google Merchant |
| `GET /api/feeds/products.json` | Feed JSON |

Las mutaciones requieren los flags `DEMO_MODE=true`, `OMNICHANNEL_DEMO=true`,
JSON válido y cabecera `Origin` igual al origen del Worker. No hay credenciales
de pago, correo, proveedor ni marketplaces. Los adaptadores reales futuros deben
reemplazar los mocks y añadir autenticación, credenciales y validación operativa.

## Verificación

```sh
pnpm check
# Con pnpm dev activo, crean exclusivamente datos ficticios locales:
node scripts/smoke.mjs
node scripts/stock-race.mjs
```

El smoke comprueba importes, validación, mismo origen, idempotencia concurrente,
stock, los cinco canales, ambos modos de envío, estados, tracking y feeds.
La segunda prueba enfrenta dos compras contra una última unidad disponible.
Estas pruebas de integración se ejecutan en local: cambian ajustes y stock y
pueden tramitar pedidos pendientes.

Para comprobar el despliegue sin modificar datos, ejecutar
`node scripts/verify-public.mjs`. Verifica páginas, guías, enlaces, imágenes,
feeds y cotizaciones con GET y POST de cotización exclusivamente. Su destino
predeterminado es el Worker propio; `DEMO_URL` permite indicar localhost.

## Cloudflare

Worker **ecom-connect** y D1 **ecom-connect-db**, separados del proyecto original.
La configuración real del recurso está en `wrangler.jsonc`; no contiene secretos.

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 migrations apply ecom-connect-db --remote
# Solo al preparar una nueva base de demostración:
pnpm exec wrangler d1 execute ecom-connect-db --remote --file seed/demo.sql
pnpm deploy
```

Para actualizar la demo existente, aplicar las migraciones pendientes y desplegar;
no hace falta volver a cargar el catálogo inicial.

No requiere VPS, R2, KV ni servicios de pago. El consumo depende del tráfico y de
las cuotas de la cuenta Cloudflare. El panel es una demostración pública con
datos compartidos; no introducir datos personales reales. Todos los productos,
EAN, pagos, integraciones, promociones y expediciones son ficticios.

### Programación de pedidos agrupados

El 18/09/2026 Cloudflare rechazó el alta del cron con error 10072: esta cuenta
ya utiliza los 5 cron del plan Workers Free. El despliegue funciona con envío
inmediato o ejecución manual de pendientes. No se modificó ningún otro Worker
ni se contrató un plan. Cuando haya cuota disponible, añadir a wrangler.jsonc
`"triggers": { "crons": ["*/15 * * * *"] }`, cambiar
`GROUPED_CRON_ENABLED` a `"true"` y volver a desplegar. El handler scheduled
ya está implementado y el panel informa si la programación está activa.

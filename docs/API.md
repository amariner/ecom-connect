# API de FarmaHouse Demo

Este despliegue es una demostración omnicanal con datos ficticios en su propia D1. El proveedor, Lighthouse Feed y los marketplaces son simuladores locales. No existen pagos, emails, expediciones ni conexiones comerciales reales. La demo reutiliza el cálculo de carrito, los snapshots de pedidos, la confirmación de pago simulada y el ledger de inventario de Logic2B Ecommerce.

## Acceso y seguridad

Los endpoints requieren las variables `DEMO_MODE=true` y `OMNICHANNEL_DEMO=true`. Si falta alguna, responden `403`. Las mutaciones requieren una cabecera `Origin` exactamente igual al origen de la URL y rechazan `Sec-Fetch-Site: cross-site`. Los POST JSON requieren `Content-Type: application/json`; el cuerpo está limitado a 64.000 bytes, también cuando la petición no declara `Content-Length`. El middleware aplica límites por IP. Los errores tienen forma `{ "error": "Mensaje en español" }`.

Las respuestas de API no se almacenan en caché. El panel público está destinado a datos ficticios: no introducir información personal ni conectar credenciales de producción. El control de origen reduce peticiones cruzadas, pero no equivale a autenticación de administración. Para una implantación real se debe añadir autenticación y autorización independientes antes de exponer operaciones.

En los ejemplos, `BASE` es el origen de este despliegue, por ejemplo `https://ecom-connect.example.workers.dev`. Una llamada POST desde consola sería:

```sh
curl "$BASE/api/demo/action" \
  -H "Origin: $BASE" \
  -H 'Content-Type: application/json' \
  --data '{"action":"sync"}'
```

## Catálogo, carrito y checkout

`GET /api/products` devuelve `{ products: Product[] }` con los productos activos. Cada producto incluye `id`, `slug`, `name`, `description`, `price_cents`, `compare_at_price_cents`, `stock`, `image`, `category`, `active`, `sku`, `supplier_sku`, `ean`, `brand`, `vat` y `last_synced_at`. Los importes son céntimos enteros y `vat` es un porcentaje entero permitido: 0, 4, 10 o 21. El PVP comparativo es informativo y no modifica el importe cobrado.

`POST /api/cart/quote` recalcula precios, disponibilidad y envío desde D1:

```json
{
  "lines": [{ "slug": "slug-real-del-catalogo", "qty": 2 }],
  "postal_code": "12001"
}
```

La respuesta incluye `lines`, `subtotal_cents`, `shipping_cents`, `total_cents`, `purchasable` y `shipping`. Cada línea contiene `slug`, `name`, `qty`, `unit_price_cents`, `line_total_cents`, `available_stock` y un estado: `ok`, `not-found`, `out-of-stock` o `insufficient-stock`. Sin código postal con cobertura, los importes de envío y total son `null`. El núcleo admite hasta 50 líneas y cantidades entre 1 y 99; agrupa slugs repetidos con un máximo de 99 unidades por producto.

`POST /api/checkout/session` crea un pedido WEB y confirma un pago exclusivamente simulado:

```json
{
  "lines": [{ "slug": "slug-real-del-catalogo", "qty": 2 }],
  "customer": {
    "name": "Laura Martínez (demo)",
    "email": "laura@example.test",
    "street": "Calle de la Demo, 18",
    "city": "Castellón",
    "postal_code": "12001"
  },
  "idempotency_key": "94267324-2d63-4ee2-bc7f-42fcda7f17e9"
}
```

La respuesta es `{ order_number, order_id, url }`, donde `url` apunta a `/gracias?session=demo_…`. Puede incluir `supplier_warning` si el pedido quedó pagado pero el envío inmediato al proveedor encontró una incidencia; el panel conserva `ERROR` y la confirmación de compra sigue disponible. No se aceptan precios enviados por el navegador. El cliente debe generar un UUID aleatorio nuevo para cada intento de compra y conservarlo durante sus reintentos. Repetir la misma clave y el mismo payload devuelve el mismo pedido; reutilizarla con otro payload devuelve `409`. La sesión deriva de un SHA-256 de esa clave, por lo que no se deben utilizar identificadores previsibles.

El checkout guarda una copia del contenido enviado y su clave de intento.
Si la respuesta es incierta, mantiene esa copia, bloquea los datos del formulario
y ofrece **Reintentar confirmación**. El reintento envía el mismo contenido y
clave directamente al endpoint, sin exigir una nueva cotización de stock:
el pedido anterior podría estar ya confirmado y haber consumido sus unidades.
Los cambios posteriores en la cesta no modifican el intento pendiente.

Errores de red, timeout, respuestas `5xx`, `408`, `429` o una confirmación inválida
mantienen el intento pendiente. Una respuesta de validación `400`, `409`, `413`
o `415` con un mensaje de error reconocido permite volver a editar y cotizar.
El cliente no interpreta una respuesta ilegible como prueba de que no se creó
el pedido.

Cuando `sessionStorage` funciona, se restaura el intento guardado al volver al
checkout, también después de una recarga. Si el almacenamiento no está
disponible, el respaldo en memoria mantiene el intento durante la misma página;
no conserva esa garantía al recargarla o cerrarla.

Al iniciar una compra, el navegador conserva también una identidad local por
línea de la cesta (`lineage`). Es información del intento y de su recuperación;
no se envía como parte del payload de este endpoint. Tras recibir una confirmación
válida, descuenta las cantidades del intento únicamente cuando la línea actual
conserva esa identidad. Así mantiene productos distintos, unidades adicionales
y un producto que se eliminó y se volvió a añadir mientras la compra estaba
pendiente. Si un intento antiguo carece de esas identidades, conserva la cesta
y pide revisarla.

El cliente guarda un recibo `order:<id>` junto a la cesta para evitar repetir el
descuento cuando se procesa de nuevo la misma confirmación. No recorta ese
registro por antigüedad ni por cantidad de recibos; su conservación depende del
almacenamiento del navegador. La página de confirmación solo recupera una
actualización pendiente si coinciden su URL y el recibo del pedido: abrir una
confirmación antigua no vacía una cesta nueva.

Si no puede aplicar una actualización pendiente, la confirmación muestra un
aviso para revisar la cesta y el pedido permanece confirmado. Cuando fallan tanto
la escritura del marcador de recuperación como la actualización de la cesta,
el checkout añade `#revisar-cesta` al enlace de confirmación para mostrar el aviso
sin depender de ese marcador. El fragmento no modifica el contrato de respuesta
del servidor ni solicita repetir la compra.

Estos recibos son una protección local del navegador. No equivalen a una
transacción entre pestañas ni garantizan recuperación ante cualquier cierre
inesperado o pérdida del almacenamiento; la idempotencia del pedido sigue
resolviéndose por su clave y las restricciones del servidor.

Si falla la publicación del catálogo después de confirmar el pedido, la respuesta
puede incluir `feed_warning`. La compra ya está guardada y conserva su URL de
confirmación; el fallo de publicación no debe inducir a crear otra venta. Se puede
recuperar el feed desde Integraciones. Esta recuperación también se aplica a los
pedidos creados con `simulate-order`.

El alta reutiliza la restricción única de sesión del núcleo. La confirmación aplica pago, stock, movimientos y eventos en una batch D1; las guardas de estado, versión y unicidad arbitran reintentos concurrentes. Un conflicto de disponibilidad devuelve `409` y no crea un segundo pago ni stock negativo. El alta inicial y la confirmación son operaciones separadas del núcleo: una confirmación fallida puede dejar un pedido `pending`, visible en el panel.

En los canales marketplace, el alta, despacho y avance intentan comunicar el
estado al hub simulado. Un fallo exclusivo de ese acuse no revierte una compra
o expedición ya guardada ni devuelve un error comercial: la respuesta puede
añadir `marketplace_warning`. El detalle conserva `marketplace_sync: null` si
no se puede leer el acuse. La acción `sync` repara las notificaciones desde el
estado canónico y devuelve sus errores por separado de los errores de catálogo.
Los pedidos WEB no requieren acceso a la tabla de acuses del hub.

`GET /api/demo/confirmation?session=demo_…` devuelve únicamente el resumen del pedido y sus líneas: `order_number`, `status`, `customer_name`, importes y `lines`/`items`. Las líneas usan `name_snapshot`, `unit_price_cents` y `qty`. La sesión debe tener el formato y la entropía exigidos; un número de pedido legible no concede acceso a esta confirmación.

## Panel y acciones

`GET /api/demo/state` devuelve:

```text
products: catálogo del panel, incluidos los productos inactivos
orders: últimos 100 pedidos centralizados, sin emails ni direcciones
order_summary: { total, total_cents, pending_supplier } sobre todos los pedidos
integrations.supplier: connected, status, last_sync, processed, updated, errors
integrations.lighthouse: connected, status, last_sync, published, feed_url, json_url, orders_synced
settings.dispatch_mode: immediate | grouped
settings.scheduled_dispatch: boolean (false en el despliegue actual)
marketplaces: [{ channel, connected, published, orders_count, total_cents, pending_supplier, last_order, stock_synced, orders_synced, last_order_sync }]
events: últimos 30 eventos de integración
```

`order_summary.total` cuenta todos los pedidos de la base y `total_cents` suma
sus importes, incluidos los pedidos pendientes o cancelados: no es un indicador
de ventas cobradas. `pending_supplier` cuenta los pedidos con `status='paid'` y
`supplier_stock_committed=0`, incluidos los que quedan fuera del listado reciente.
Los tres agregados de cada marketplace tienen la misma semántica, restringida a
su canal; `orders_count` es su número de pedidos. `last_order` es el número del
pedido de mayor ID de ese canal, o `null` si no tiene ninguno.

`orders` en esta respuesta conserva los últimos 100 pedidos por ID descendente
para las vistas de actividad reciente. La pantalla Pedidos consulta el endpoint
paginado siguiente para buscar en todo el historial. Los contadores e importes
de `order_summary` siguen siendo globales y no se reducen al aplicar filtros.

### Historial paginado y búsqueda

`GET /api/demo/orders` consulta todos los pedidos de D1, con filtros opcionales:

| Parámetro | Valor y validación | Predeterminado |
| --- | --- | --- |
| `q` | Texto recortado en los extremos, máximo 120 caracteres. | Vacío: sin búsqueda. |
| `channel` | `WEB`, `AMAZON`, `MIRAVIA`, `CARREFOUR`, `EBAY` o vacío. | Vacío: todos los canales. |
| `status` | `pending`, `paid`, `shipped`, `delivered`, `cancelled` o vacío. | Vacío: todos los estados comerciales. |
| `page` | Entero decimal entre 1 y 100.000. | `1`. |
| `limit` | Entero decimal entre 1 y 50. | `25`. |

Los parámetros inválidos devuelven `400`. `status` filtra el estado comercial,
no los estados `SUPPLIER_*` del proveedor. La búsqueda abarca número de pedido,
nombre del cliente ficticio, referencia del proveedor y número de seguimiento.
No distingue mayúsculas/minúsculas ni acentos españoles; `%` y `_` se buscan como
caracteres literales, no como comodines.

Ejemplo:

```text
GET /api/demo/orders?q=laura&channel=AMAZON&status=paid&page=1&limit=25
```

La respuesta tiene `orders`, `pagination: { page, limit, total, pages }` y
`filters: { q, channel, status }`. `orders` utiliza la misma representación
pública del pedido, sin direcciones ni emails, y se ordena por ID descendente.
`pagination.total` es el número que cumple los filtros, mientras que
`getState.order_summary.total` es el número global de la demo. El servidor lee
recuento y filas en una batch D1.

Si se solicita una página superior a la disponible, se devuelve la última
existente. Una búsqueda vacía de resultados devuelve `orders: []`, `total: 0`,
`page: 1` y `pages: 1`. El cliente debe usar la página devuelta para representar
el estado de navegación.

En el panel, las páginas contienen 25 pedidos y los controles **Anterior** y
**Siguiente** muestran el rango consultado. Los filtros `q`, `channel`, `status`
y `page` se conservan en la URL de `/admin/pedidos`, por lo que se puede recargar
o compartir una consulta. Cambiar búsqueda, canal o estado vuelve a la primera
página. La escritura de búsqueda actualiza la entrada actual del historial del
navegador; los cambios de canal, estado, página y limpieza crean una entrada,
y Atrás/Adelante recupera sus controles y consulta. Al abrir un resultado, el enlace de detalle conserva
un destino de retorno al listado; **Volver a pedidos** recupera esa consulta.
El parámetro `return` del detalle se restringe a la ruta local de pedidos y a
los cuatro parámetros admitidos del listado. Si falla una consulta, el panel
conserva los filtros y ofrece **Volver a intentar**.

### Detalle y recorrido del pedido

`GET /api/demo/orders/:id` devuelve `{ order, items, events, marketplace_sync }`. Los eventos del pedido incluyen `from_status`, `to_status`, `note` y `created_at`. `marketplace_sync` es `null` para WEB o si no hay acuse; en los otros canales incluye `order_id`, `channel`, `reference`, `supplier_status`, `tracking_number`, `tracking_carrier` y `synced_at`. La referencia es el número interno de la demo, no un `lighthouseId` real. El panel muestra este retorno de estado y seguimiento.

El pedido público incluye `tracking_carrier` junto a `tracking_number`, tanto en
el listado como en el detalle. El recorrido visual del panel deriva sus etapas
de estos datos: venta confirmada para `paid`, `shipped` o `delivered`; proveedor
acepta cuando hay `supplier_order_id`; envío acreditado cuando ambas condiciones
anteriores se cumplen y hay `SUPPLIER_SHIPPED` con tracking. El retorno al canal solo se completa para
marketplaces tras ese envío y con un acuse sin advertencias que coincide en
estado, tracking y transportista. Un acuse de un estado anterior sigue pendiente
de conciliar. En WEB no existe esta última etapa.

### Desglose de disponibilidad

`GET /api/demo/stock?code=PRV-00001` consulta la disponibilidad de una referencia
del proveedor simulado. `code` es obligatorio, se recorta en los extremos y debe
tener entre 1 y 120 caracteres. Una referencia desconocida devuelve `404`; un
parámetro inválido devuelve `400`. Es una lectura: no cambia el stock ni ejecuta
una sincronización.

La respuesta tiene la forma `{ demo: true, snapshot: { … } }`:

| Campo de `snapshot` | Significado |
| --- | --- |
| `code`, `name`, `slug` | Código del proveedor y nombre/slug del catálogo local; si no está importado, usa los del proveedor. |
| `store_product_id` | ID del producto importado en la tienda, o `null`. |
| `supplier_active` | Si la referencia del proveedor está activa. |
| `store_active` | Si el producto importado está activo, o `null` si no está importado. |
| `supplier_stock` | Unidades actuales del proveedor; no suma el almacén de respaldo. |
| `reserved_units` | Suma de `current_qty` (o `qty` si no existe) de pedidos `paid`, `shipped` o `delivered` todavía sin una compra registrada en `supplier_orders` para su referencia. |
| `reserved_orders_count` | Número de pedidos distintos que aportan unidades positivas a esas reservas para el producto. |
| `theoretical_available` | `max(0, supplier_stock - reserved_units)`: cantidad que debe resultar al sincronizar. |
| `store_stock` | Stock actualmente guardado en el catálogo local, o `null` si no está importado. |
| `stock_difference` | `store_stock - theoretical_available`, o `null` si no está importado. |
| `supplier_updated_at` | Fecha de actualización guardada para el producto del proveedor. |
| `store_synced_at` | Fecha de sincronización guardada para el producto local, o `null`. |

La lectura calcula el desglose en una sola consulta. Excluye reservas ya
acreditadas por una compra en el proveedor para no descontarlas dos veces.
`reserved_orders_count` describe pedidos que comprometen este producto; no es
el contador operativo global `order_summary.pending_supplier`.

Una diferencia positiva indica que la tienda tiene más unidades que el disponible
calculado; una negativa, que tiene menos. Una diferencia de cero acredita solo
que las cantidades coinciden en esta consulta, no que se haya ejecutado una nueva
sincronización ni que un marketplace real haya recibido el dato. Las fechas son
las guardadas en la demo y no sustituyen una confirmación externa. La cantidad
calculada no acredita por sí sola que el producto esté activo o se pueda comprar;
los campos de actividad se consultan por separado.

El panel consulta este endpoint al entrar en Proveedor, cambiar el producto y
refrescar tras un cambio de stock o una sincronización. **Reintentar consulta**
repite solo la lectura. El selector usa la referencia del proveedor para consultar
el desglose; el formulario de cambio conserva el `slug` que exige su acción.

### Acciones de demostración

`POST /api/demo/action` admite estos payloads:

| Acción | Payload | Resultado |
|---|---|---|
| Sincronizar proveedor | `{ "action": "sync" }` | Importa catálogo y stock, publica el feed simulado y concilia acuses de pedidos pendientes. Devuelve además `marketplace_orders: { processed, errors }`. |
| Cambiar stock remoto | `{ "action": "simulate-stock", "slug": "…", "stock": 7 }` | Cambia el proveedor; la tienda conserva el stock anterior hasta sincronizar. |
| Regenerar feed | `{ "action": "regenerate-feed" }` | Actualiza la publicación en los cuatro marketplaces simulados. |
| Simular pedido | `{ "action": "simulate-order", "channel": "AMAZON", "slug": "…", "qty": 2 }` | Crea un pedido en el mismo sistema que WEB con cliente ficticio. |
| Enviar al proveedor | `{ "action": "dispatch", "order_id": 12 }` | Obtiene `supplier_order_id`; los reintentos no duplican el pedido remoto. |
| Avanzar proveedor | `{ "action": "advance", "order_id": 12, "status": "shipped" }` | Actualiza estado y, si corresponde, tracking ficticio. |
| Procesar lote | `{ "action": "dispatch-pending" }` | Procesa hasta 30 pendientes y devuelve `{ processed, errors }`. |
| Configurar envío | `{ "action": "settings", "dispatch_mode": "immediate" }` | Guarda `immediate` o `grouped`. |

Canales válidos: `WEB`, `AMAZON`, `MIRAVIA`, `CARREFOUR` y `EBAY`. `simulate-order` acepta también un `idempotency_key` UUID; sin él, cada llamada crea una simulación independiente. `simulate-stock` acepta entre 0 y 10.000 unidades; si se omite `stock`, alterna el ejemplo entre 7 y 18. El modo predeterminado sin configuración es `grouped`.

En modo inmediato, un pedido pagado se envía al proveedor. En modo agrupado permanece pendiente hasta pulsar el botón de lote. La ejecución programada está preparada pero desactivada por el límite de cron de la cuenta; su activación se documenta en [README](../README.md). Cambiar a inmediato no procesa retroactivamente todos los pendientes: el botón de lote sigue disponible.

## API del proveedor simulado

| Método y ruta | Función |
|---|---|
| `GET /api/supplier/catalog` | `{ demo: true, products }` con el catálogo remoto ficticio. |
| `POST /api/supplier/catalog` | Alta de un artículo completo o actualización por `code`. |
| `GET /api/supplier/stock` | Stock principal, backup y disponibilidad por código. |
| `POST /api/supplier/stock` | `{ "code": "PROV-…", "stock": 7, "backup_stock": 12 }`. El backup es opcional. |
| `POST /api/supplier/orders` | `{ "order_id": 12 }`: envía un pedido interno existente y pagado. |
| `GET /api/supplier/orders?reference=…` | Consulta por número interno o ID del proveedor. |
| `POST /api/supplier/status` | `{ "order_id": 12, "status": "processing" }`. |

La API HTTP demo recibe un `order_id` existente para impedir altas de pedidos sin validación de dinero y stock. El puerto `SupplierAdapter.createOrder` recibe el contrato del proveedor: `{ reference, items: [{ code, qty }] }`, y devuelve `{ supplier_order_id, reference, status, date, expedition_number, tracking }`.

Ejemplo de alta de una nueva referencia en el proveedor, usando una imagen que ya exista en `/public/images`:

```json
{
  "code": "PROV-NUEVO-001",
  "slug": "gel-demo-nueva-referencia",
  "name": "Gel de cuidado — referencia demo",
  "description": "Producto ficticio de parafarmacia para demostrar la importación.",
  "price_cents": 790,
  "pvp_cents": 990,
  "discount": 0,
  "brand": "Marca Demo",
  "vat": 21,
  "category": "higiene",
  "image": "/images/products/imagen-existente.svg",
  "ean": "2000000000991",
  "sku": "FH-NUEVO-001",
  "active": 1,
  "stock": 24,
  "backup_stock": 6
}
```

Después de crearla, ejecutar `sync`: el producto aparecerá en D1, tienda y feed. `code`, `slug` y `sku` deben identificar una referencia nueva sin colisiones. Para actualizar un artículo existente basta, por ejemplo, `{ "code": "PROV-NUEVO-001", "stock": 7, "price_cents": 690 }`. El PVP debe ser mayor que el precio o `null`; los identificadores EAN son ficticios. Solo se admiten rutas de imágenes locales bajo `/images/`.

## Estados y stock

El estado comercial del núcleo permanece separado del estado del proveedor:

| Estado comercial | Significado en la demo |
|---|---|
| `pending` | Pedido creado, confirmación simulada pendiente. |
| `paid` | Pago simulado confirmado y stock descontado. |
| `shipped` | El proveedor ficticio ha devuelto una expedición. |
| `delivered`, `cancelled` | Estados conservados del motor; no hay controles nuevos para activarlos en esta demo. |

| Proveedor externo simulado | Estado interno |
|---|---|
| Aún no enviado | `PENDING_SUPPLIER` |
| `pending` tras aceptación | `SUPPLIER_ACCEPTED` |
| `processing` | `SUPPLIER_PROCESSING` |
| `partial` | `SUPPLIER_PARTIAL` |
| `shipped` | `SUPPLIER_SHIPPED` |
| `error` o fallo al enviar | `ERROR` |

`advance` sin estado explícito recorre aceptación → procesamiento → enviado; después de un error vuelve a procesamiento. El envío es terminal: el simulador no permite revertirlo. Al enviar devuelve `EXP-DEMO-…` y `DEMO-…`. El estado parcial demuestra el intercambio de estados; no implementa expediciones parciales por línea.

Al confirmar el pedido se descuenta inventario local, pero el proveedor todavía puede informar del stock anterior. Para evitar que una sincronización reponga unidades ya vendidas, el stock publicable se calcula así:

```text
stock tienda = max(0, stock proveedor − cantidades pagadas aún no descontadas por el proveedor)
```

La existencia de la referencia en `supplier_orders` indica que el proveedor ya descontó las cantidades; esta condición cubre incluso la breve ventana entre aceptación remota simulada y actualización local. No se suma automáticamente el almacén backup. Al despachar, la referencia interna es única en `supplier_orders`; una guarda por creación hace que los reintentos descuenten stock remoto una sola vez.

Cada producto se sincroniza en una batch que mantiene juntos `products`, su variante por defecto, balance y movimiento del ledger. Una referencia inválida revierte su batch, aumenta `errors` y permite continuar las demás. La sincronización completa puede ser parcial: el panel informa de procesados, actualizados y errores, y puede reintentarse. Los detalles técnicos del fallo quedan en los logs del Worker.

## Feed y sustitución de adaptadores

`GET /feeds/products.xml` expone RSS con namespace `g` y campos conceptualmente compatibles con Google Merchant: `id`, `title`, `description`, `link`, `image_link`, `price`, `availability`, `brand`, `gtin` y `condition`. `GET /api/feeds/products.json` devuelve `{ demo: true, products }`. Las URLs son absolutas y el catálogo incluye solo productos activos; los agotados se publican como `out_of_stock`. Este feed ficticio no está preparado para conectar una cuenta comercial real.

Los contratos están en `src/integrations/supplier-adapter.ts` y `src/integrations/marketplace-hub-adapter.ts`. Sus implementaciones actuales son `MockSupplierAdapter` y `MockLighthouseAdapter`. La composición se realiza en `src/lib/demo.ts`; el Worker solo invoca procesos demo autorizados.

Para sustituir el proveedor, implementar `catalog`, `stock`, `createOrder` y `orderStatus` contra la API documentada. `advanceOrder` es un control de simulación y deberá retirarse o mantenerse únicamente en el entorno demo. La nueva implementación debe traducir códigos, importes, disponibilidad y estados al contrato existente, conservar la referencia interna idempotente y definir reintentos, conciliación y timeouts. El stock real necesita una confirmación durable de las unidades ya comprometidas en el proveedor, equivalente a la evidencia que hoy representa `supplier_orders`; no debe depender de una tabla exclusiva del mock.

Para sustituir Lighthouse, implementar `publish` y la entrada de pedidos del contrato `MarketplaceHubAdapter`, validando las notificaciones entrantes y conservando la referencia única del marketplace. Ambos adaptadores reales deberán componerse explícitamente en un despliegue de cliente con credenciales aisladas y autenticación; cambiar flags o variables de esta demo no habilita automáticamente integraciones reales.

# API de FarmaHouse Demo

Este despliegue es una demostración omnicanal con datos ficticios en su propia D1. El proveedor, Lighthouse Feed y los marketplaces son simuladores locales. No existen pagos, emails, expediciones ni conexiones comerciales reales. La demo reutiliza el cálculo de carrito, los snapshots de pedidos, la confirmación de pago simulada y el ledger de inventario de Logic2B Ecommerce.

## Acceso y seguridad

Los endpoints requieren las variables `DEMO_MODE=true` y `OMNICHANNEL_DEMO=true`. Si falta alguna, responden `403`. Las mutaciones requieren una cabecera `Origin` exactamente igual al origen de la URL y rechazan `Sec-Fetch-Site: cross-site`. Los POST JSON requieren `Content-Type: application/json`; el cuerpo está limitado a 64.000 bytes, también cuando la petición no declara `Content-Length`. El middleware aplica límites por IP. Los errores incluyen `{ "error": "Mensaje en español" }` y pueden añadir datos específicos documentados para cada endpoint.

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
  "idempotency_key": "94267324-2d63-4ee2-bc7f-42fcda7f17e9",
  "expected_quote": {
    "lines": [{ "slug": "slug-real-del-catalogo", "qty": 2, "unit_price_cents": 1299 }],
    "subtotal_cents": 2598,
    "shipping_cents": 399,
    "total_cents": 2997
  }
}
```

La respuesta es `{ order_number, order_id, url }`, donde `url` apunta a `/gracias?session=demo_…`. Puede incluir `supplier_warning` si el pedido quedó pagado pero el envío inmediato al proveedor encontró una incidencia; el panel conserva `ERROR` y la confirmación de compra sigue disponible. Los precios se calculan siempre en el servidor. El cliente debe generar un UUID aleatorio nuevo para cada intento de compra y conservarlo durante sus reintentos. Repetir la misma clave y el mismo payload devuelve el mismo pedido; reutilizarla con otro payload devuelve `409`. La sesión deriva de un SHA-256 de esa clave, por lo que no se deben utilizar identificadores previsibles.

`expected_quote` conserva la cotización que aceptó el comprador. Sus importes son
una condición de aceptación, nunca la fuente para calcular el pedido. Debe
contener entre 1 y 50 líneas con `slug` único de 1 a 120 caracteres, `qty` entre
1 y 99 y `unit_price_cents`; junto con `subtotal_cents`, `shipping_cents` y
`total_cents`, todos los importes son enteros seguros no negativos. Los importes
del ejemplo son ilustrativos: se deben tomar de la respuesta de `/api/cart/quote`.

Antes de crear un pedido nuevo, el servidor recalcula y compara las líneas,
precios unitarios, subtotal, envío y total. Si difieren, devuelve `409` con
`{ error, code: "quote_changed", quote }`, donde `quote` contiene la cotización
actual con la misma estructura que `expected_quote`; no crea el pedido. También
detecta cambios compensados entre productos o portes que mantienen el mismo
total. El comprador debe revisar la nueva cotización antes de volver a confirmar.
El checkout muestra **Revisa el importe actualizado**, consulta de nuevo el
desglose y ofrece **Confirmar importe** con el total actual. Si falla la consulta,
**Volver a consultar la cesta** la repite sin crear un pedido.

El campo es opcional para mantener la compatibilidad con clientes anteriores;
estos conservan el cálculo del servidor, pero no la comparación con el importe
que habían visto. El checkout actual sí lo envía y lo congela con el intento.
El servidor ordena sus líneas por `slug` al comparar y calcular la identidad de
la petición. Un pedido ya confirmado y compatible con el mismo intento se
recupera antes de volver a cotizar: los precios o el stock actuales no cambian
su importe aceptado.

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

### Filtros del catálogo administrativo

La pantalla `/admin/productos` filtra el catálogo completo de `products` devuelto
por `/api/demo/state`, incluidos los inactivos. Estos parámetros pertenecen a la
URL del panel; no añaden filtros al contrato de `/api/products`, que sigue
mostrando solo productos activos:

| Parámetro | Valores |
| --- | --- |
| `q` | Búsqueda recortada en los extremos y limitada a los primeros 120 caracteres. |
| `categoria` | Slug de una categoría existente en el catálogo; una categoría desconocida se elimina. |
| `estado` | `activo` o `inactivo`. |
| `stock` | `con-stock` (más de 0), `bajo` (entre 1 y 5 inclusive) o `sin-stock` (0 o menos). |

La búsqueda abarca nombre, SKU interno, código de proveedor, EAN y marca, sin
distinguir mayúsculas ni acentos. Los filtros se combinan; los valores
predeterminados se omiten de la URL y los valores de estado o stock no admitidos
se descartan.
La búsqueda actualiza la entrada actual del historial del navegador; cambiar
selectores o limpiar los filtros crea una entrada. Recargar la URL o usar
Atrás/Adelante recupera los criterios y los resultados del catálogo consultado.
La actividad y el stock son independientes: un producto inactivo puede conservar
unidades. Se muestra con **No visible en tienda**, sin un enlace a su ficha
pública ni controles para activarlo o desactivarlo.

### Historial paginado y búsqueda

`GET /api/demo/orders` consulta todos los pedidos de D1, con filtros opcionales:

| Parámetro | Valor y validación | Predeterminado |
| --- | --- | --- |
| `q` | Texto recortado en los extremos, máximo 120 caracteres. | Vacío: sin búsqueda. |
| `channel` | `WEB`, `AMAZON`, `MIRAVIA`, `CARREFOUR`, `EBAY` o vacío. | Vacío: todos los canales. |
| `status` | `pending`, `paid`, `shipped`, `delivered`, `cancelled` o vacío. | Vacío: todos los estados comerciales. |
| `supplier` | `pending_dispatch`, `accepted`, `processing`, `partial`, `shipped`, `error` o vacío. | Vacío: todas las situaciones del proveedor. |
| `page` | Entero decimal entre 1 y 100.000. | `1`. |
| `limit` | Entero decimal entre 1 y 50. | `25`. |

Los parámetros inválidos devuelven `400`. `status` filtra el estado comercial,
no los estados `SUPPLIER_*` del proveedor. La búsqueda abarca número de pedido,
nombre del cliente ficticio, referencia del proveedor y número de seguimiento.
No distingue mayúsculas/minúsculas ni acentos españoles; `%` y `_` se buscan como
caracteres literales, no como comodines.

`supplier` se combina con la búsqueda, el canal y el estado comercial antes de
contar y paginar todo el historial. Sus valores significan:

| Valor | Criterio en el pedido |
| --- | --- |
| `pending_dispatch` | `status='paid' AND supplier_stock_committed=0`, igual que el contador operativo de pendientes. |
| `accepted` | `supplier_status='SUPPLIER_ACCEPTED'`. |
| `processing` | `supplier_status='SUPPLIER_PROCESSING'`. |
| `partial` | `supplier_status='SUPPLIER_PARTIAL'`. |
| `shipped` | `supplier_status='SUPPLIER_SHIPPED'`. |
| `error` | `supplier_status='ERROR'`. |

`pending_dispatch` puede incluir un error de envío o una compra ya aceptada por
el proveedor cuyo registro local aún falta confirmar; no demuestra que el pedido
nunca haya llegado al proveedor. `error` incluye incidencias anteriores o
posteriores a la aceptación: no todos esos pedidos están pendientes de enviar.
Estos dos criterios pueden coincidir en un mismo pedido. El filtro consulta la
situación actual, no los errores o parciales conservados en el historial de
eventos, ni las incidencias de retorno al marketplace.

Ejemplo:

```text
GET /api/demo/orders?q=laura&channel=AMAZON&status=paid&supplier=partial&page=1&limit=25
```

La respuesta tiene `orders`, `pagination: { page, limit, total, pages }` y
`filters: { q, channel, status, supplier }`. `orders` utiliza la misma representación
pública del pedido, sin direcciones ni emails, y se ordena por ID descendente.
`pagination.total` es el número que cumple los filtros, mientras que
`getState.order_summary.total` es el número global de la demo. El servidor lee
recuento y filas en una batch D1.

Si se solicita una página superior a la disponible, se devuelve la última
existente. Una búsqueda vacía de resultados devuelve `orders: []`, `total: 0`,
`page: 1` y `pages: 1`. El cliente debe usar la página devuelta para representar
el estado de navegación. Una combinación incompatible, como `status=cancelled`
y `supplier=pending_dispatch`, también devuelve ese resultado vacío.

En el panel, las páginas contienen 25 pedidos y los controles **Anterior** y
**Siguiente** muestran el rango consultado. **Situación del proveedor** es un
selector independiente de **Estado del pedido**. Los filtros `q`, `channel`,
`status`, `supplier` y `page` se conservan en la URL de `/admin/pedidos`, por lo
que se puede recargar o compartir una consulta. Cambiar búsqueda, canal, estado
o situación del proveedor vuelve a la primera
página. La escritura de búsqueda actualiza la entrada actual del historial del
navegador; los cambios de canal, estado, proveedor, página y limpieza crean una entrada,
y Atrás/Adelante recupera sus controles y consulta. Al abrir un resultado, el enlace de detalle conserva
un destino de retorno al listado; **Volver a pedidos** recupera esa consulta.
El parámetro `return` del detalle se restringe a la ruta local de pedidos y a
los cinco parámetros admitidos del listado. Si falla una consulta, el panel
conserva los filtros y ofrece **Volver a intentar**.

### Detalle y recorrido del pedido

`GET /api/demo/orders/:id` devuelve `{ order, items, events, marketplace_sync }`. Los eventos del pedido incluyen `from_status`, `to_status`, `note` y `created_at`. `marketplace_sync` es `null` para WEB o si no hay acuse; en los otros canales incluye `order_id`, `channel`, `reference`, `supplier_status`, `tracking_number`, `tracking_carrier` y `synced_at`. La referencia es el número interno de la demo, no un `lighthouseId` real. El panel muestra este retorno de estado y seguimiento.

`events` contiene el historial completo, ordenado por ID de inserción ascendente,
sin paginación. El panel invierte una copia para mostrar primero los movimientos
más recientes, inicialmente hasta 10. **Ver 10 anteriores** amplía la lista en
bloques de hasta 10 hasta **Historial completo**, sin otra consulta a la API.
El contador muestra los visibles frente al total; las fechas se presentan en
la hora local del navegador. Los eventos con la misma fecha mantienen su orden
de inserción inverso en pantalla.

Si `dispatch` falla antes de confirmar localmente la aceptación, registra una
transición a `ERROR` en el historial y una incidencia en la actividad. Los
reintentos fallidos mientras sigue en `ERROR` no duplican esa incidencia;
la recuperación conserva el evento anterior.

El pedido público incluye `tracking_carrier` junto a `tracking_number`, tanto en
el listado como en el detalle. También expone `supplier_dispatch_mode`:
`"immediate"`, `"grouped"` o `null` si no hay una política original registrada.
El recorrido visual del panel deriva sus etapas
de estos datos: venta confirmada para `paid`, `shipped` o `delivered`; proveedor
acepta cuando hay `supplier_order_id`; envío acreditado cuando ambas condiciones
anteriores se cumplen y hay `SUPPLIER_SHIPPED` con tracking. El retorno al canal solo se completa para
marketplaces tras ese envío y con un acuse sin advertencias que coincide en
estado, tracking y transportista. Un acuse de un estado anterior sigue pendiente
de conciliar. En WEB no existe esta última etapa.

### Desglose de disponibilidad y precios

`GET /api/demo/stock?code=PRV-00001` consulta disponibilidad y precios de una referencia
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
| `supplier_price_cents`, `supplier_pvp_cents` | Precio de venta recibido del proveedor y PVP comparativo; el PVP puede ser `null`. |
| `store_price_cents`, `store_pvp_cents` | Precio y PVP guardados en la tienda; ambos son `null` si no está importado. Un PVP `null` también puede significar que el producto importado no tiene comparativo. |

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
refrescar tras un cambio de stock, precio o una sincronización. **Reintentar consulta**
repite solo la lectura. El selector usa la referencia del proveedor para consultar
el desglose; el formulario de cambio conserva el `slug` que exige su acción.

### Acciones de demostración

`POST /api/demo/action` admite estos payloads:

| Acción | Payload | Resultado |
|---|---|---|
| Sincronizar proveedor | `{ "action": "sync" }` | Importa catálogo y stock, publica el feed simulado y concilia acuses de pedidos pendientes. Devuelve además `marketplace_orders: { processed, errors }`. |
| Cambiar stock remoto | `{ "action": "simulate-stock", "slug": "…", "stock": 7 }` | Cambia el proveedor; la tienda conserva el stock anterior hasta sincronizar. |
| Cambiar precio remoto | `{ "action": "simulate-price", "code": "…", "price_cents": 2390, "pvp_cents": 2890, "expected_price": { "price_cents": 2290, "pvp_cents": 2890 }, "idempotency_key": "UUID" }` | Cambia solo precio y PVP del proveedor con control de concurrencia e idempotencia; la tienda y el feed requieren `sync`. |
| Regenerar feed | `{ "action": "regenerate-feed" }` | Actualiza la publicación en los cuatro marketplaces simulados. |
| Simular pedido | `{ "action": "simulate-order", "channel": "AMAZON", "slug": "…", "qty": 2 }` | Crea un pedido en el mismo sistema que WEB con cliente ficticio. |
| Enviar al proveedor | `{ "action": "dispatch", "order_id": 12 }` | Obtiene `supplier_order_id`; los reintentos no duplican el pedido remoto. |
| Avanzar proveedor | `{ "action": "advance", "order_id": 12, "status": "shipped" }` | Exige un estado explícito; actualiza estado y, si corresponde, tracking ficticio. |
| Procesar lote | `{ "action": "dispatch-pending" }` | Procesa hasta 30 pendientes y devuelve `{ processed, errors }`. |
| Configurar envío | `{ "action": "settings", "dispatch_mode": "immediate" }` | Guarda `immediate` o `grouped`. |

Canales válidos: `WEB`, `AMAZON`, `MIRAVIA`, `CARREFOUR` y `EBAY`. `simulate-order` acepta también un `idempotency_key` UUID; sin él, cada llamada crea una simulación independiente. `simulate-stock` acepta entre 0 y 10.000 unidades; si se omite `stock`, alterna el ejemplo entre 7 y 18. El modo predeterminado sin configuración es `grouped`.

`simulate-stock` admite un producto importado inactivo para modificar su origen
simulado sin reactivarlo. La consulta administrativa conserva esas referencias;
el catálogo público, el checkout y los feeds siguen excluyendo los productos
inactivos. La acción no modifica el campo `active` ni constituye un control de
publicación.

La configuración de envío se aplica al alta de nuevos pedidos. Cada uno guarda
su `supplier_dispatch_mode`; los reintentos usan esa política, no la configuración
vigente. Un pedido `grouped` no se autoenvía al recuperar su confirmación aunque
el modo general haya pasado a `immediate`. Un pedido `immediate` puede recuperar
su envío fallido o interrumpido aunque el modo general haya pasado a `grouped`.
Se conserva la misma referencia para no duplicar la compra al proveedor.

La migración `0049_supplier_dispatch_mode.sql` añade el campo y lo captura con
un trigger dentro del alta de un pedido demo, identificado por sesión `demo_`
y `request_hash`. El valor de configuración `immediate` guarda ese modo; si
falta o tiene otro valor, guarda `grouped`. No cambia el payload de checkout
ni su `request_hash`. No rellena el histórico: `null` significa que no se conoce
el modo original y su reintento no activa un envío automático. El envío explícito
desde el detalle o el lote sigue disponible para los pedidos pagados pendientes.

Cambiar a inmediato no procesa retroactivamente los pendientes. La ejecución
programada está preparada pero desactivada; la [guía operativa](OPERACION-DEMO.md)
distingue esta configuración de un horario activo.

### Recuperar un pedido de marketplace

El panel envía un UUID por intento a `POST /api/demo/action`. Para integrar el
mismo comportamiento, guardar el payload completo antes de enviarlo y repetir
exactamente esos datos cuando la respuesta sea incierta:

```json
{
  "action": "simulate-order",
  "channel": "AMAZON",
  "slug": "slug-real-del-catalogo",
  "qty": 1,
  "idempotency_key": "679dc5f4-87fc-4f01-b78c-3abeb818cb62"
}
```

El `slug` debe proceder del catálogo; generar un UUID propio para una venta nueva
y conservarlo para sus reintentos. Repetir la clave y el mismo contenido recupera
el pedido ya pagado sin exigir el stock o la actividad actuales del producto.
La clave con otro contenido devuelve `409`. Sin clave, cada llamada puede crear
otra venta.

La tarjeta mantiene canal, producto, cantidad y clave ante errores de red, un
error del servidor o una respuesta que no confirma `order_id` y `order_number`,
incluso si devuelve HTTP `200`. **Reintentar confirmación** repite ese intento;
no vuelve a validar su disponibilidad en el formulario. Los rechazos
`400`, `409`, `413` o `415` con un mensaje `error` válido liberan el formulario
para revisar los datos. Los avisos `supplier_warning`, `marketplace_warning` y
`feed_warning` acompañan un pedido confirmado y no requieren crear otra compra.

El intento se conserva en `sessionStorage`, con respaldo en memoria si no se
puede escribir. Solo el primero permite recuperarlo tras recargar esa pestaña;
sin almacenamiento se debe mantener la página abierta. Una restauración
incompleta pide revisar el historial: una clave aislada no permite reconstruir
el pedido. El recibo visible de la tarjeta dura mientras siga abierta la página;
el pedido confirmado permanece en D1.

### Cambio de precio del proveedor

`simulate-price` exige un `code` recortado de 1 a 120 caracteres y un UUID
`idempotency_key`. Tanto los valores nuevos como `expected_price` contienen
`price_cents` y `pvp_cents` explícitos: importes enteros entre 0 y 1.000.000
céntimos; el PVP debe superar el precio o ser `null`. Enviar `null` retira el
comparativo de forma explícita. Los valores de `expected_price` deben proceder
de la última consulta del proveedor, no del precio todavía importado en tienda.

Si otro cambio modificó esos valores, devuelve `409` con
`{ error, code: "supplier_price_changed", price: { price_cents, pvp_cents } }`.
Se debe consultar y revisar el precio vigente antes de intentar otro cambio.
Reutilizar una clave con un payload diferente devuelve `409` con
`code: "idempotency_conflict"`. Una referencia inexistente devuelve `404`; los
datos inválidos, `400`.

La respuesta correcta es `{ demo: true, replayed, change }`. `change` incluye
`code`, `before` y `after` (ambos con `price_cents` y `pvp_cents`), `changed` y
`created_at`. `changed` indica si los valores anterior y solicitado difieren.
El resultado se conserva como recibo histórico: repetir exactamente el intento
devuelve ese mismo cambio sin aplicarlo de nuevo, incluso si el precio cambió
después. Para conocer el precio vigente, volver a consultar `/api/demo/stock`.
Si el precio y el PVP solicitados ya coinciden con los esperados, guarda un
recibo con `changed: false` sin modificar la fecha del proveedor ni crear un
evento de cambio.

Cuando hay un cambio, la acción guarda el recibo y modifica únicamente precio/PVP del proveedor;
conserva stock y demás atributos. No sincroniza la tienda ni publica el feed.
`sync` importa después el precio al catálogo y regenera la publicación simulada.
El precio recibido se usa como precio de venta; este contrato no calcula costes,
márgenes ni tarifas específicas por marketplace.

En el panel se introducen euros con hasta dos decimales; dejar el PVP vacío envía
`null`. **Precios coinciden** compara precio y PVP del proveedor con los de la
tienda, no la recepción en un canal externo. Una respuesta incierta conserva el
intento y ofrece **Reintentar cambio de precio** con los mismos valores y clave;
si el almacenamiento de sesión funciona, también se recupera tras recargar.
Sin ese almacenamiento, la recuperación se limita a la misma página. Un rechazo
definitivo permite revisar el precio vigente y editar la propuesta.

## API del proveedor simulado

| Método y ruta | Función |
|---|---|
| `GET /api/supplier/catalog` | `{ demo: true, products }` con el catálogo remoto ficticio. |
| `POST /api/supplier/catalog` | Alta de un artículo completo o actualización por `code`. |
| `GET /api/supplier/stock` | Stock principal, backup y disponibilidad por código. |
| `POST /api/supplier/stock` | `{ "code": "PROV-…", "stock": 7, "backup_stock": 12 }`. El backup es opcional. |
| `POST /api/supplier/orders` | `{ "order_id": 12 }`: envía un pedido interno existente y pagado. |
| `GET /api/supplier/orders?reference=…` | Consulta por número interno o ID del proveedor. |
| `POST /api/supplier/status` | `{ "order_id": 12, "status": "processing" }`; `status` obligatorio. |

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

Una actualización de catálogo modifica solo los campos enviados: un parche de
precio no restaura el stock leído anteriormente. La escritura vuelve a comprobar
la coherencia entre precio y PVP frente al estado vigente. El panel utiliza la
acción dedicada `simulate-price` para añadir la expectativa de precio y un recibo
idempotente a los cambios que se presentan durante la demo.

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

Tanto `POST /api/supplier/status` como la acción `advance` exigen `status`:
`processing`, `partial`, `shipped` o `error`. Omitirlo o enviar otro valor —incluido
`pending`— devuelve `400` con `{ "error": "Datos no válidos. Revisa el formulario." }`
sin modificar datos. `pending` es un estado observado tras la aceptación, no un
destino de actualización. Cada petición solicita el destino explícito: repetirla
no significa avanzar a la fase siguiente. El envío es terminal y no se puede
revertir. Al enviar devuelve `EXP-DEMO-…` y `DEMO-…`. El estado parcial demuestra
el intercambio de estados; no implementa expediciones parciales por línea.

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

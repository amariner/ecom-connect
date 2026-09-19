# Cómo conectamos todos los servicios

Guía de implantación basada en el código y los contratos documentados en este
repositorio. Explica qué está conectado dentro de la demo, qué datos circulan y
cómo preparar cada integración comercial. Revisión documental: **19 de
septiembre de 2026**.

**Situación actual:** la tienda y el panel utilizan un Worker y una base D1
propios. El proveedor y Lighthouse son adaptadores simulados que escriben en
esa base. Los botones del panel no llaman a un ERP, una cuenta de vendedor, una
pasarela o un transportista real. Cambiar los flags de demostración no instala
adaptadores reales.

Para una reunión comercial, empezar por la [guía de presentación](GUIA-DEMO.md).
Para el detalle de cada contrato, consultar [proveedor](PROVEEDOR.md),
[Lighthouse](LIGHTHOUSE.md) y [arquitectura dropshipping](INTEGRACION-DROPSHIPPING.md).

## Mapa de servicios y responsabilidades

En las pantallas, FarmaHouse nombra la tienda ficticia y Ecom Connect el centro
de operaciones. La atribución «Motor Logic2B» identifica la tecnología de comercio
reutilizada; no representa otra integración que deba conectar el cliente.

| Sistema | Responsabilidad | Recibe | Devuelve | Estado en esta demo |
| --- | --- | --- | --- | --- |
| Tienda FarmaHouse | Experiencia de compra | Catálogo, precio y disponibilidad | Referencias, cantidades y cliente ficticio | Funcional sobre el servidor de la demo. |
| Ecom Connect | Coordinar catálogo, reservas, pedidos y seguimiento | Datos de todos los orígenes | Decisiones y operaciones por adaptador | Funcional sobre el núcleo heredado. |
| Proveedor | Surtido, disponibilidad y preparación | Referencia de compra y líneas | Catálogo, stock, pedido ERP y estados | `MockSupplierAdapter`, persistido en D1. |
| Lighthouse | Distribuir catálogo y conectar canales | Feed, stock, precio y estado de pedidos | Ventas, identidad remota y acuses | `MockLighthouseAdapter`, persistido en D1. |
| Amazon, Miravia, Carrefour y eBay | Origen de ventas externas | Publicaciones y seguimiento a través del hub | Pedido del comprador | Simuladores; ninguna cuenta enlazada. |
| Cloudflare Worker | Servir la web y ejecutar las APIs | Peticiones HTTP; eventos programados si se habilitan | Respuestas y operaciones en D1 | Recurso propio `ecom-connect`. |
| Cloudflare D1 | Persistir catálogo y operación | Escrituras del servidor | Datos, historial y restricciones de unicidad | Base propia `ecom-connect-db`. |
| GitHub | Versionar código y documentación | Cambios revisados del proyecto | Historial y código para desplegar | Repositorio independiente `amariner/ecom-connect`. |
| Pasarela, correo y transporte | Cobrar, comunicar y entregar | Operaciones comerciales futuras | Confirmaciones externas | No conectados ni ejecutados. |

El proyecto mantiene Astro 5, TypeScript estricto y JavaScript de navegador sin
framework de interfaz. Los puertos de integración separan los servicios del
catálogo y del motor de pedidos. Su procedencia está en
[Arquitectura y reutilización](ARQUITECTURA.md).

## Los tres recorridos de datos

**Catálogo y disponibilidad:** proveedor → Ecom Connect → tienda y feed →
Lighthouse → canales. La demo persiste cada tramo interno; la publicación en
cuentas externas queda pendiente.

**Venta y preparación:** tienda, o marketplace a través de Lighthouse → pedido
central → validación y reserva → compra al proveedor → aceptación. La venta
web y la de marketplace llegan a las mismas tablas `orders` y `order_items`.

En la compra web, una respuesta incierta conserva el contenido y la clave del
intento. **Reintentar confirmación** vuelve a enviar ese mismo intento sin
recotizar sus unidades, que podrían haberse consumido en la primera llamada.
Al confirmarse, se descuentan de la cesta las cantidades de la selección original
y se conservan los añadidos posteriores, incluido un producto eliminado y creado
de nuevo. Si no se puede identificar o actualizar esa selección con seguridad,
la confirmación pide revisar la cesta sin repetir la compra. La restauración tras
recarga depende del almacenamiento de sesión del navegador; la identidad del
pedido se deduplica en el servidor.

Las tarjetas de marketplaces conservan también el intento completo. Ante una
respuesta incierta, **Reintentar confirmación** recupera la misma venta sin exigir
que el producto siga disponible; hasta resolverla, ese canal no ofrece otra
simulación. La recuperación tras recarga requiere almacenamiento de sesión; si
falla, el panel pide mantener la pestaña abierta. El pedido confirmado queda en
el historial central, con acceso directo desde la tarjeta.

**Seguimiento:** proveedor → pedido central e historial → acuse Lighthouse →
canal de origen. El acuse actual es local; antes de operar hará falta conservar
una confirmación remota y recuperar los envíos que no hayan sido notificados.

Estos recorridos no son equivalentes: publicar una oferta no confirma una
venta; recibir una venta no confirma la aceptación del proveedor; aceptar una
compra no acredita que se haya expedido.

El detalle del pedido los presenta en un recorrido visual con el siguiente paso
disponible. La aceptación se acredita con la referencia del proveedor; el envío
requiere su estado enviado y un número de tracking. Para completar el retorno de
un marketplace, el acuse local debe coincidir con el estado, tracking y
transportista actuales. Un acuse antiguo no cierra esa etapa. Los pedidos WEB
terminan el recorrido en el envío y no muestran una etapa de retorno al canal.

Los resúmenes operativos se calculan sobre todos los pedidos de D1. La pantalla
**Pedidos** consulta todo el historial mediante una API paginada, con búsqueda
y filtros por canal y estado. Los últimos 100 de `GET /api/demo/state` sirven
como colección reciente para el resumen del panel; no limitan la búsqueda del
historial ni los contadores globales. Los filtros y la página quedan en la URL
para mantener el contexto al navegar o compartir una consulta. Todos estos
datos siguen siendo ficticios y compartidos entre visitas.

## 1. Preparar la plataforma y su entorno

### Lo que ya usa el proyecto

- `wrangler.jsonc` declara el Worker, los assets y el binding `DB` de D1.
- `DEMO_MODE=true` y `OMNICHANNEL_DEMO=true` autorizan las mutaciones ficticias.
- Los precios se calculan en céntimos enteros; cantidades, stock y totales se
  validan en servidor.
- Las APIs de mutación requieren mismo origen y JSON válido. El panel público
  no tiene autenticación administrativa comercial.
- `GROUPED_CRON_ENABLED=false` indica que el planificador no está activo en la
  configuración revisada. El modo agrupado puede ejecutarse manualmente.

GitHub conserva el código y la documentación; no participa en la validación de
una compra. Los scripts del proyecto permiten verificar y desplegar con Wrangler.
La existencia de un repositorio no implica que cada cambio se publique
automáticamente: el resultado de tipos, tests, build y recorridos se debe revisar
antes del despliegue, y después comprobar el Worker publicado.

El procedimiento de [operación de la demo](OPERACION-DEMO.md) reúne arranque,
migraciones, publicación y verificación sin mutaciones, distinguiendo la primera
carga de una actualización.

Para ejecutar una copia local:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

La tienda local abre en `http://localhost:4327/` y el panel en
`http://localhost:4327/admin`. Migraciones y semilla actúan en D1 local con esos
comandos. La semilla usa `INSERT OR IGNORE`; no representa una restauración que
borre pedidos o deshaga cambios previos.

### Para una implantación de cliente

Crear recursos y configuración propios del cliente, separar sandbox de
producción, añadir acceso administrativo autenticado y permisos por operación.
El Worker comercial deberá componer adaptadores reales explícitamente y usar
secretos de servidor aislados. No reutilizar la D1, dominio o Worker de
`logic-ecom`, ni introducir datos de compradores en esta demo pública.

No hay requisitos actuales de R2, KV o VPS para ejecutar esta demostración.
La elección de colas, almacenamiento adicional, plan y observabilidad de una
implantación se hará según las integraciones y su volumen. La demo no acredita
capacidad de producción ni un coste fijo mensual.

**Criterio de salida:** el entorno sandbox tiene recursos identificados,
permisos de administración, secretos separados y un procedimiento probado de
despliegue y recuperación.

## 2. Conectar el proveedor

### Qué hace el adaptador actual

`src/integrations/supplier-adapter.ts` define `catalog`, `stock`, `createOrder`,
`orderStatus` y `advanceOrder`. El último método controla la simulación; no es
una operación comercial confirmada. La composición en `src/lib/demo.ts` usa
`MockSupplierAdapter`.

El mock permite importar catálogo y disponibilidad, aceptar un pedido una sola
vez por referencia y avanzar sus estados. Guarda pedidos ficticios en
`supplier_orders`; esa evidencia permite distinguir unidades ya descontadas
por el proveedor de reservas que aún solo existen en Ecom Connect.

### Cómo se demuestra la disponibilidad

En [Proveedor](/admin/integraciones/proveedor), **Disponibilidad de este producto**
muestra el stock del proveedor, las reservas de pedidos, el disponible calculado
y el stock actual de la tienda. El cálculo es
`máximo(0, stock del proveedor − reservas pendientes de descontar allí)` y excluye
el almacén de respaldo. El número de pedidos permite dimensionar los compromisos
del producto sin confundirlos con el contador global de pedidos pendientes.

El panel consulta `GET /api/demo/stock?code=…`, una lectura del estado persistido
en D1. Las reservas usan las unidades actuales de pedidos `paid`, `shipped` o
`delivered` que todavía no tienen su compra registrada en `supplier_orders`.
Una compra ya registrada queda fuera de esa resta para no descontarla dos veces,
incluso si falta actualizar su acuse local.

**Pendiente de sincronizar** muestra una diferencia entre el cálculo y el
catálogo local. **Stock coincide** confirma solo igualdad de cantidades en la
consulta; no demuestra que se haya sincronizado con una cuenta externa. Si el
artículo aún no está importado, los valores locales no existen y se indica
**Sin importar**. Los estados activo/inactivo se muestran por separado de las
cantidades.

Esta vista permite explicar al cliente por qué recibir siete unidades del
proveedor no significa ofrecer siete si una ya está comprometida. Para conectar
un proveedor real habrá que conservar esa misma evidencia: cuándo se reserva,
cuándo el proveedor descuenta y cómo se comprueba su aceptación. El contrato
exacto y los valores nulos se detallan en la [API](API.md); abrir JSON es opcional
durante la presentación.

El mismo producto permite comparar el precio de venta recibido del proveedor
con el precio actual en tienda. Simular un cambio guarda solo el origen;
**Sincronizar ahora** importa precio y PVP al catálogo y al feed simulado. El PVP
comparativo se conserva, cambia o retira explícitamente; este precio no es un
coste de compra ni calcula márgenes o precios por marketplace. Un checkout que
tenía otro importe exige revisarlo y confirmarlo de nuevo, mientras los pedidos
ya confirmados conservan sus precios aceptados.

### Información que debe entregar el proveedor

1. Base URL HTTPS, credenciales sandbox y ejemplos anonimizados de errores.
2. Confirmación de la paginación del catálogo y del catálogo completo de estados.
3. Significado de coste, PVP, descuento, moneda e IVA.
4. Forma de transmitir destinatario y dirección para entrega directa.
5. Momento de reserva/descuento de stock y tratamiento del almacén backup.
6. Garantías ante reintentos, consulta por referencia y alta con resultado incierto.
7. Expediciones, transportistas, parciales, cancelaciones y devoluciones.

El PDF revisado **no documenta una dirección de destinatario en el alta**. Este
punto debe resolverse antes de prometer dropshipping al domicilio del comprador.

### Secuencia de implementación

| Paso | Operación del contrato recibido | Trabajo de Ecom Connect |
| --- | --- | --- |
| Importar surtido | `POST /inbound/getcatarticulos` | Completar bloques, validar referencias y conservar metadatos antes de publicar. |
| Consultar disponibilidad | `POST /inbound/getcatstocktotal` y `getcatstock` | Validar snapshot completo y confirmar referencias omitidas o críticas. |
| Crear compra | `POST /inbound/setcatpedido` propuesto | Usar referencia estable y líneas con códigos del proveedor; persistir todos los IDs ERP. |
| Resolver respuesta incierta | `POST /inbound/getcatestadopedido` | Consultar por `pedidocliente` antes de repetir una creación. |
| Consultar preparación | `POST /inbound/getcatestadopedido` | Interpretar líneas y expediciones sin confundir producido con enviado. |

La ruta de alta está escrita con un espacio en el PDF; la normalización sin
espacio requiere confirmación. Su autenticación documentada incluye `cliente`
y `psw` en el JSON; deben permanecer en el servidor y no aparecer en logs.
La [especificación del proveedor](PROVEEDOR.md) conserva la evidencia por página.

El adaptador real necesita ampliar el modelo para destino, compras con varios
pedidos ERP y expediciones por línea. El contrato local simplificado no cubre
por sí solo esos casos. Los normalizadores de
`src/integrations/supplier-api-contract.ts` preparan datos offline; no realizan
una llamada autenticada ni prueban el contrato externo.

**Criterio de salida:** un pedido sandbox multilínea llega al destino ficticio
acordado, devuelve todas sus referencias ERP y permite conciliar aceptación,
unidades y expediciones sin duplicar la compra tras un timeout.

## 3. Conectar Lighthouse

### Qué existe hoy

La demo genera [XML](/feeds/products.xml) y
[JSON](/api/feeds/products.json) desde el catálogo activo. El mock registra
publicaciones y acuses locales de estado/tracking. El puerto
`MarketplaceHubAdapter` incluye `publish`, `incomingOrder` y `syncOrder`.
`incomingOrder` crea una venta ficticia: no importa ventas externas.

### Pasos para la conexión comercial

1. **Solicitar cuenta sandbox.** Confirmar con Lighthouse entorno, canales,
   permisos, frecuencia de consulta y muestras de pedidos. La revisión local
   referencia el entorno de pruebas ofrecido por su documentación; no se ha
   validado una cuenta de este proyecto.
2. **Implementar OAuth en servidor.** Según el contrato documentado, usar Client
   Credentials, conservar el token fuera del navegador, renovar con
   `expires_in` y manejar errores de autorización.
3. **Validar el feed base.** Mapear el SKU y el `gID`; completar atributos,
   imágenes y requisitos por categoría. Los GTIN y productos sintéticos no
   deben publicarse como un catálogo comercial.
4. **Actualizar stock y precio.** Construir `Products/ExtraInfo` con stock
   explícito y disponibilidad neta. El lote documentado admite hasta 1.000
   productos; el constructor offline del proyecto valida esa forma.
5. **Importar ventas.** Consultar `Sales` de forma incremental y paginada.
   Persistir cada página antes de avanzar el cursor y deduplicar por cuenta,
   canal e identidad remota. Conservar importes originales y pago del canal.
6. **Devolver seguimiento.** Mapear transportistas con `Carriers` y usar
   `UpdateCmsSales` con la identidad real del pedido. Conservar intención,
   intentos y acuse de cada notificación.
7. **Conciliar.** Recuperar ventas o cambios pendientes y volver a transmitir
   seguimiento sin repetir compras al proveedor.

Las rutas, campos, referencias oficiales y limitaciones se recogen en
[Lighthouse y marketplaces](LIGHTHOUSE.md). La guía de conexión se apoya en esa
revisión documental y no sustituye la comprobación con la cuenta sandbox.

`taxRate` se expresa como `0.21` en el contrato del hub; el IVA local se expresa
como `21`. La conversión está probada en el constructor offline. Omitir `stock`
en el contrato documentado equivale a cero: los campos no se deben trasladar
sin validar sus unidades y significado.

Si se incorporan webhooks, verificar la firma sobre los bytes originales,
la ventana temporal y la unicidad del evento. No asumir que existe un webhook
de altas de pedidos utilizable porque se mencione un evento sin contrato
completo. Mantener un mecanismo de consulta y conciliación comprobable.

**Criterio de salida:** publicar productos de prueba, importar dos veces una
venta multilínea sin duplicarla y obtener un acuse remoto válido de su tracking,
incluido un fallo temporal y su posterior recuperación.

## 4. Activar los canales de venta

Los cuatro marketplaces comparten el mismo flujo de demostración. Su alta real
depende de las cuentas del cliente y de los canales efectivamente disponibles
en su contrato con Lighthouse.

| Canal | Lo que presenta la demo | Preparación antes de activar una cuenta |
| --- | --- | --- |
| Web | Compra ficticia y pedido WEB | Dominio del cliente, catálogo real, condiciones comerciales y proceso de pago propio. |
| Amazon | Publicación y pedido simulado | Cuenta de vendedor, autorización, región, logística, fichas y prueba de seguimiento. |
| Miravia | Publicación y pedido simulado | Cuenta de vendedor, datos de fabricante/responsable, fichas exportables y revisión de atributos. |
| Carrefour | Publicación y pedido simulado | Confirmar acceso al canal, contrato del vendedor, atributos, logística y pruebas con Lighthouse. |
| eBay | Publicación y pedido simulado | Confirmar acceso al canal, cuenta, autorización, atributos, logística y pruebas con Lighthouse. |

La documentación local contiene referencias específicas para Amazon y Miravia.
No atribuir a Carrefour o eBay requisitos técnicos concretos que todavía no se
hayan confirmado en el proyecto.

Para cada canal mantener una correspondencia de oferta, SKU, cuenta y producto.
Una publicación aceptada por Lighthouse no garantiza que la oferta sea visible
en el marketplace: revisar su acuse y cualquier error de atributos o elegibilidad.

**Criterio de salida:** el canal confirma la ficha de prueba, su stock/precio,
una venta y el tracking. Registrar el resultado por canal, sin extrapolar el
éxito de uno al resto.

## 5. Completar cobro, correo y entrega

Estas funciones no están conectadas a servicios reales en la demo. La presencia
de módulos heredados o de una dependencia en `package.json` no equivale a una
integración comercial activa.

- **Pago web:** elegir el proveedor y acordar confirmación, reintentos,
  conciliación y devoluciones. El pedido debe quedar pagado por evidencia del
  servidor. Una venta de marketplace ya pagada no se vuelve a cobrar.
- **Correo:** definir comunicaciones transaccionales y su emisor en un entorno
  independiente, con plantillas y tratamiento de datos adecuados. La demo no
  envía mensajes.
- **Transporte:** confirmar si lo contrata y opera el proveedor; mapear
  transportista, número y cantidades expedidas al hub. Una tarifa de portes en
  el checkout no acredita un acuerdo logístico ni una etiqueta de transporte.
- **Cancelaciones y devoluciones:** acordar quién detiene la preparación, quién
  recibe la mercancía y quién reembolsa cada canal. Los estados heredados no
  sustituyen ese procedimiento.

**Criterio de salida:** cada acción comercial tiene un responsable, una operación
confirmada y una prueba sandbox. Ninguna de ellas se activa en el Worker público
de demostración.

## 6. Automatizar y supervisar

La aplicación permite envío inmediato de nuevas ventas y lotes manuales de
hasta 30 pendientes. El handler programado está preparado, pero la configuración
revisada no activa cron. La [guía operativa](OPERACION-DEMO.md) explica cómo
preparar y comprobar el entorno; elegir el modo agrupado no habilita un horario.

Una implantación necesita algo más que un horario de ejecución:

| Proceso | Protección necesaria | Evidencia operativa |
| --- | --- | --- |
| Catálogo y stock | Lecturas completas, cursores y antigüedad máxima | Último éxito, referencias fallidas y stock obsoleto. |
| Importación de ventas | Unicidad remota e inbox durable | Pedidos recibidos, retenidos y ya procesados. |
| Alta al proveedor | Intención durable y consulta tras timeout | Referencia estable, todos los IDs ERP y aceptación. |
| Tracking al hub | Outbox independiente del envío físico | Intentos, error y confirmación remota. |
| Lotes programados | Capacidad de cron y control de solapamiento | Ejecución real, duración y pendientes restantes. |
| Conciliación | Ventanas repetibles y cursores confirmados | Diferencias detectadas y reparación sin duplicados. |

Las tablas y colas de integración descritas son requisitos del diseño real;
no se presentan como funcionalidades completas ya desplegadas. El núcleo
heredado aporta primitivas, pero hay que componerlas con cada adaptador.

No guardar payloads personales completos ni secretos en logs. Las alertas deben
identificar la operación y referencia para poder investigar sin exponer los
datos del destinatario.

**Criterio de salida:** provocar una caída temporal de un servicio y comprobar
que el sistema conserva la operación, la hace visible y se recupera sin repetir
una venta, una compra o un descuento de stock.

## 7. Validar antes de publicar

Para revisar la demo local, ejecutar las comprobaciones del proyecto:

```sh
pnpm check
```

Este comando ejecuta tipos, tests y build. Con el servidor local activo, los
recorridos de integración existentes crean exclusivamente datos ficticios:

```sh
node scripts/smoke.mjs
node scripts/stock-race.mjs
```

Complementar los resultados con el recorrido real de tienda, checkout y panel
en escritorio y móvil. Verificar estados de carga/error, navegación por teclado,
formularios, tablas y enlaces de los documentos. La lista de comandos es una
instrucción de verificación; la evidencia de ejecuciones se conserva en
[Pruebas y verificación](VERIFICACION.md).

Para la integración comercial, acordar al menos estos casos de aceptación:

1. Catálogo multilote completo y referencia agotada correctamente conciliada.
2. Pedido externo multilínea duplicado que produce una única venta interna.
3. Venta que conserva sus importes aunque cambie la tarifa del catálogo.
4. Dos compras concurrentes contra la última unidad sin inventario negativo.
5. Alta al proveedor aceptada cuya respuesta se pierde, sin duplicar la compra.
6. Pedido desdoblado en varios IDs ERP y expediciones por línea.
7. Tracking guardado durante una caída del hub y confirmado tras recuperarse.
8. Evento inválido/repetido rechazado o deduplicado sin repetir efectos.
9. Cancelación o devolución con evidencia operativa y tratamiento de stock.
10. Despliegue, permisos y recuperación comprobados en el entorno de cliente.

## Datos que debemos preservar entre servicios

| Concepto | Regla |
| --- | --- |
| SKU interno | Identidad estable del catálogo propio; no reemplazarlo al cambiar un título. |
| Código proveedor | Correspondencia separada con `supplier_sku`; tratarlo como cadena. |
| GTIN/EAN | Identidad de unidad de venta; no utilizar los códigos ficticios en producción. |
| Pedido marketplace | Guardar cuenta, canal, referencia original e ID de Lighthouse con unicidad. |
| Compra proveedor | Referencia propia estable y relación con todos los pedidos ERP resultantes. |
| Importe | Céntimos internos y snapshots separados de venta, coste, impuestos, portes y comisión. |
| Reserva | Descontar una vez y acreditar cuándo queda reflejada en el stock del proveedor. |
| Expedición | Transportista, seguimiento, líneas y cantidades; no solo un estado global. |
| Acuse | Distinguir operación intentada de confirmación recibida. |
| Fecha de sincronización | Actualizar el éxito solo tras una lectura/operación válida. |

## Documentación y decisiones de la puesta en marcha

Antes de estimar una implantación, completar con el cliente los siguientes
entregables: surtido y taxonomía, cuentas/canales, reglas de precio y margen,
territorios y portes, destino dropshipping, estados por servicio, matriz de
responsables y procedimiento de incidencias.

La puesta en marcha depende especialmente de confirmar dirección de entrega,
precios/IVA, resultados ambiguos del proveedor, varios IDs ERP y expediciones.
La matriz de prioridad y evidencia está en
[Requisitos de activación](INTEGRACION-DROPSHIPPING.md#bloqueos-concretos-y-criterio-de-salida).

- [Presentar la demo en 15 minutos](GUIA-DEMO.md).
- [Preparar, actualizar y verificar la demo](OPERACION-DEMO.md).
- [API del proveedor y referencias del PDF](PROVEEDOR.md).
- [Contrato Lighthouse y fuentes oficiales](LIGHTHOUSE.md).
- [API local y payloads de demostración](API.md).
- [Arquitectura y procedencia del núcleo](ARQUITECTURA.md).
- [Verificación](VERIFICACION.md).

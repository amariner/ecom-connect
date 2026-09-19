# Verificación de la entrega

## Noveno ciclo: localizar y recuperar incidencias del proveedor · 19/09/2026

- Tipos: **186 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **359 pruebas en 19 archivos**. Los nuevos casos cubren filtrado
  global, combinaciones, paginación, conservación de URL y trazabilidad de fallos.
- El filtro «Por enviar al proveedor» comparte el criterio del contador global
  y el lote de despacho. Distingue pedidos sin aceptación local confirmada de
  incidencias posteriores, combinándose con canal, estado y búsqueda.
- Navegador local: dos pedidos con error aparecen en la misma consulta. Tras
  reintentar uno, desaparece del filtro de errores; al avanzar el otro a parcial,
  aparece en ese filtro. Abrir el detalle y volver conserva la consulta.
- Móvil de 390 px: canal WEB, estado Pagado y proveedor Envío parcial se
  combinan; controles apilados y sin desbordamiento de página. Tras avanzar el
  pedido a preparación, el retorno conserva los tres filtros y muestra vacío.
- Se fuerza falta de stock local al enviar `FH-260919-WQDD`. Dos intentos
  fallidos registran una única incidencia. Tras restaurar existencias y pulsar
  «Reintentar envío», el proveedor acepta y el historial conserva el fallo y la
  recuperación; el pedido deja de aparecer en errores.
- La verificación HTTP local completa **27 grupos, 158 solicitudes, 169 enlaces
  y 48 imágenes**, exclusivamente con lecturas y cotizaciones. Las mutaciones
  del recorrido se hicieron en la base local. Este ciclo no añade migraciones.

## Octavo ciclo: filtros del catálogo y referencias inactivas · 19/09/2026

- Tipos: **186 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **337 pruebas en 19 archivos**. Se añaden 16 casos de filtros/URL y
  una regresión integral para editar stock de una referencia inactiva.
- Revisión independiente: 192 combinaciones de estado, existencias y filtros
  con serialización de URL; caracteres especiales no alteran la ruta ni otros
  parámetros. Categorías y valores desconocidos se normalizan al cargar.
- Navegador local: Bálsamo labial Sunny se desactiva en el proveedor mock y se
  sincroniza. El panel mantiene 45 referencias y muestra 44 activas. Desde
  Proveedor se cambian sus existencias de 32 a 3 y se sincroniza de nuevo sin
  reactivarlo. Catálogo público y feed quedan en 44; la cotización lo rechaza.
- Estado «Inactivos», stock «Stock bajo (1–5)» y búsqueda `PRV-00045` encuentran
  esa única referencia. Muestra «No visible en tienda» y ningún enlace público.
  Recargar conserva la consulta; atrás/adelante alterna correctamente entre
  un resultado inactivo y cero resultados activos con los mismos filtros.
- Móvil de 390 px y escritorio de 1280 px: sin desbordamiento de página;
  la tabla mantiene desplazamiento horizontal y los filtros se apilan en móvil.
  Limpiar devuelve el foco al buscador. Abrir Gel Citrus y volver conserva
  búsqueda «citrus», categoría Higiene diaria y el único resultado.
- Se restauraron estado activo y 32 unidades de la referencia de prueba,
  exclusivamente en la base local. No hay migraciones nuevas en este ciclo.

Publicado el octavo ciclo: commit `20a4c40`, versión Cloudflare
`106ff807-6d23-4522-b519-74a3f3c1ad5f`. Build correcto y verificaciones local
y remota de **25 grupos, 154 solicitudes, 169 enlaces y 48 imágenes**. En el
navegador publicado, «Activos» + «Sin stock» encuentra la referencia agotada,
sin alterar datos de la demo compartida.

## Séptimo ciclo: simulación visible de precios · 19/09/2026

- Tipos: **184 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **320 pruebas en 18 archivos**. Incluye 24 escenarios nuevos de
  servidor, 30 del editor de precios y dos del foco tras una consulta diferida.
- La migración aditiva `0048_supplier_price_changes.sql` guarda recibos de
  cambios ficticios. Recibo, precio y actividad se escriben en una transacción.
  Las pruebas cubren reintentos, concurrencia, rollback, precondiciones, PVP y
  rechazo de fracciones de céntimo. Un parche de precio concurrente con un envío
  conserva el stock descontado y los demás campos no incluidos en el parche.
- Recorrido real local con respuesta perdida: el panel guarda **9,90 €** y
  recibe HTTP 502. Otra operación guarda **9,50 €**. Tras recargar y reintentar,
  se recupera el primer recibo y se conserva **9,50 €**; tienda todavía a 8,90 €,
  existencias **49 − 1 = 48**, sin duplicar ni revertir el cambio posterior.
- Se introduce **9,40 €** y se vacía explícitamente el PVP. Antes de sincronizar,
  la comparación muestra la diferencia; después, tienda y feed reflejan 9,40 €
  y la ausencia de PVP. La compra abierta muestra **13,80 € → 14,30 €** y exige
  revisión. Se mantienen 47 pedidos, y `FH-260919-677U` conserva sus 14,80 €.
- Validación visual a 390 y 1280 px, sin desbordamiento. Los inputs aceptan
  coma decimal y rechazan 9,901 sin redondearlo. Repetir valores actuales muestra
  que no se ha aplicado ningún cambio. El foco vuelve al botón ya habilitado.
- Se restauraron precio 8,90 € y PVP 10,90 € mediante el panel local y se
  sincronizaron. El aviso de aplicar el cambio desaparece al finalizar.
- Las guías explican la variante de dos pestañas y distinguen precio de venta,
  PVP comparativo y publicación simulada. No se afirma conocer tarifas reales
  de marketplaces ni márgenes comerciales.

Publicado el séptimo ciclo: commit `3be0277`, versión Cloudflare
`3d9af754-df73-4921-91c3-7f9a275951ce`. Build correcto y migración `0048`
aplicada en la D1 propia. La verificación local y la remota completan **25 grupos,
154 solicitudes, 168 enlaces y 48 imágenes**. El editor publicado se comprobó
en navegador sin cambiar precios ni existencias de la demo compartida.

## Sexto ciclo: revisión de precios antes de confirmar · 19/09/2026

- Tipos: **181 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **264 pruebas en 16 archivos**. Incluye cambios de precio y portes,
  importes compensados con el mismo total, reintentos concurrentes, recuperación
  del pedido original y disponibilidad modificada entre lecturas.
- El checkout conserva el desglose aceptado. El servidor calcula sus propios
  importes y rechaza cualquier diferencia antes de crear el pedido; un pedido
  ya confirmado conserva sus precios y se recupera por su misma referencia.
- Navegador local: Gel Citrus cambia de 8,90 € a 9,90 € tras mostrar el resumen.
  El total pasa de **13,80 € a 14,80 €**, con aviso visible y segunda confirmación.
  El primer clic conserva 46 pedidos y 49 unidades; el segundo crea únicamente
  `FH-260919-677U`, por el importe revisado. Restaurar el precio también exige
  revisión de la bajada y conserva el foco en el botón de confirmación.
- Un proxy local devuelve 502 en una consulta de la cesta: «Volver a consultar
  la cesta» recupera el resumen sin recargar ni crear un pedido. El foco vuelve
  al botón de confirmación; los datos ficticios del formulario se conservan.
- Aviso y resumen revisados en móvil de 390 px y escritorio de 1280 px, sin
  desbordamiento horizontal. Los fallos HTTP de estas pruebas son deliberados.
- Build de producción correcto. Todos los cambios de precio y la compra de
  prueba se realizaron exclusivamente en el entorno local.

Publicado el sexto ciclo: commit `7c90a30`, versión Cloudflare
`fd8f9c6a-275a-4ea1-9a1f-7f3d04c5be92`. La verificación remota posterior
completa **24 grupos, 154 solicitudes, 168 enlaces y 48 imágenes**, mediante
lecturas y cotizaciones sin alterar pedidos, precios ni existencias.

## Quinto ciclo: existencias y reservas visibles · 19/09/2026

- Tipos: **181 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **226 pruebas en 16 archivos**. Incluye 15 nuevos escenarios de stock
  y siete de selección, borradores, errores y respuestas de consultas atrasadas.
- El desglose usa una sola lectura y comparte la regla de reservas con la
  sincronización. Las pruebas cubren más de 100 reservas, cantidades actuales,
  pedidos ya aceptados sin acuse local, exclusión del almacén de respaldo,
  mínimos de cero, productos sin importar y ausencia de escrituras al consultar.
- Recorrido real local del acondicionador: **21 − 1 = 20**; simular stock 7
  muestra **7 − 1 = 6** con 20 todavía en tienda; sincronizar publica 6 y
  conserva producto seleccionado, borrador y foco. Despachar el pedido
  `FH-260919-87UM` deja **6 − 0 = 6**, sin restar dos veces.
- Escritorio de 1280 px y móvil de 390 px: desglose legible, ecuación vertical
  en móvil, sin desbordamiento ni errores de consola en el recorrido. Cambiar
  de producto y volver conserva el borrador introducido.
- Verificación local sin mutaciones: **24 grupos, 154 solicitudes, 168 enlaces
  y 48 imágenes**. Comprueba también el desglose y errores 400/404 del endpoint.
- Guías de demostración y conexión actualizadas con la explicación visible;
  consultar JSON es opcional durante la presentación comercial.

«Stock coincide» compara cantidades. No certifica la actualización del resto
del catálogo ni una conexión externa. Un cambio del proveedor todavía no
sincronizado se muestra separado del stock que la tienda tiene publicado.

Publicado el quinto ciclo: commit `c4b8bdf`, versión Cloudflare
`b46b15cf-27c7-4fab-bb94-035296a19ca2`. Build correcto. La comprobación remota
supera los **24 grupos, 154 solicitudes, 168 enlaces y 48 imágenes** con lecturas
y cotizaciones. El navegador confirma el desglose publicado y el aviso de stock
pendiente de sincronizar, sin ejecutar acciones sobre la demo compartida.

## Cuarto ciclo: recuperación de compras y conservación de cesta · 19/09/2026

- Tipos: **178 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **204 pruebas en 15 archivos**. Incluye pérdida de respuesta,
  restauración de intento, selección congelada, rechazos corregibles, respuestas
  inválidas, almacenamiento bloqueado y la conexión del script real del checkout.
- Regresión de servidor: un pedido ya pagado se recupera aunque el producto
  esté agotado, inactivo o tenga otro precio. Conserva el importe confirmado.
- Cesta: identidad de líneas y recibo guardados junto con las cantidades;
  pruebas de eliminación/recreación del mismo producto y repetición de un recibo
  después de 69 compras posteriores. Un error al escribir conserva la cesta.
- Navegador local con un proxy temporal que sustituye la primera respuesta
  exitosa de checkout por HTTP 502, después de guardar el pedido en D1:
  - `FH-260919-GECM`: compra de las últimas seis unidades de Champú Dermocare,
    recuperación tras recarga con stock cero y conservación del acondicionador
    añadido desde otra pestaña. Solo se creó un pedido.
  - `FH-260919-87UM`: compra de una unidad de acondicionador, eliminación y
    nueva adición de tres unidades durante la incertidumbre. Tras recuperar el
    pedido anterior, las tres unidades nuevas permanecen intactas.
- Recuperación y confirmación revisadas a 390 px: controles legibles y sin
  desbordamiento horizontal. Los errores HTTP de esas pruebas son deliberados.
- Panel: Ecom Connect identifica el centro, FarmaHouse la tienda y Logic2B el
  motor; estados del proveedor en español y retorno al canal marcado simulado.
- Verificación local: **22 grupos, 151 solicitudes, 168 enlaces y 48 imágenes**,
  únicamente lecturas y cotizaciones.

Los recorridos con fallos crearon exclusivamente pedidos ficticios locales.
La demo pública no se utilizó para provocar fallos ni modificar existencias.

Publicado el cuarto ciclo: commit `493403e`, versión Cloudflare
`746472ff-4ea1-40a3-bd54-4878835c40cb`. Build correcto. Verificación remota:
**22 grupos, 151 solicitudes, 168 enlaces y 48 imágenes**, sin mutaciones.
También se comprobó en navegador el mapa publicado con Ecom Connect en el
centro y los proveedores y canales rotulados como demostración.

## Tercer ciclo: historial completo y reintentos · 19/09/2026

- Tipos: **173 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **157 pruebas en 12 archivos**. Incluye paginación de 107 pedidos,
  filtros combinados, búsqueda sin acentos, caracteres SQL tratados como texto,
  páginas vacías/extremas, retorno seguro y descarte de respuestas obsoletas.
- Checkout: siete casos comprueban la identidad de reintento, incluidos fallos
  al leer o escribir `sessionStorage`. El respaldo en memoria dura esa página.
- Navegador local a 1280 px: páginas 1–25 y 26–44, búsqueda «martinez» que
  encuentra «Martínez», filtros Amazon/enviado y retorno desde el detalle
  conservando la consulta. Los botones de página mantienen el foco.
- Móvil de 390 px: estado vacío y limpieza de filtros con foco en el buscador;
  sin desbordamiento horizontal ni errores de consola en el recorrido.
- Verificación local sin mutaciones: **22 grupos, 151 solicitudes**, 45 fichas,
  48 imágenes y 168 enlaces/anclas. Se comprueba además la API paginada y el
  rechazo de filtros inválidos. Solo GET y cuatro POST de cotización.

Este ciclo elimina la limitación de 100 pedidos del historial y sus filtros.
La colección reciente de `/api/demo/state` mantiene ese límite para el resumen;
los agregados y la búsqueda paginada incluyen todos los pedidos.

Publicado el tercer ciclo: commit `fffc57f`, versión Cloudflare
`dbeadfb9-8d56-46e1-8388-a171deb462fa`. Build correcto y verificación remota
posterior: **22 grupos, 151 solicitudes, 168 enlaces y 48 imágenes**. El filtro
Amazon también se comprobó en el navegador publicado: cuatro resultados,
sin errores de consola ni cambios en los datos compartidos.

## Segundo ciclo: operación visible y accesibilidad · 19/09/2026

- Tipos: **168 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **130 pruebas en 10 archivos**, incluidos 41 escenarios omnicanal y
  14 casos del recorrido visual del pedido.
- Un escenario con 109 pedidos confirma que los totales, los pendientes y el
  último pedido por canal incluyen operaciones fuera de los últimos 100.
  Los errores del proveedor después de aceptar no vuelven a entrar en la cola
  de envío de pedidos nuevos.
- Navegador local: pedido Amazon `FH-260919-Q66Z` recorrido desde pendiente
  hasta aceptación, parcial, error recuperado y envío con tracking/acuse.
  El indicador no completa la expedición mientras está parcial o en error.
- Escritorio de 1280 px y móvil de 390 px: recorrido legible, sin
  desbordamiento en las pantallas comprobadas y sin errores de consola.
- Cesta con teclado: cantidad actualizada conservando foco, eliminación con
  foco en la siguiente línea y salida a catálogo al retirar la última.
  Un estado accesible anuncia cantidades y total recalculado.
- Verificador público contra localhost: **18 grupos, 144 solicitudes**, incluidos
  los agregados globales y la exclusión de tokens internos de la respuesta.
  Conserva 45 fichas, 48 imágenes, 167 enlaces y solo cuatro POST de cotización.

Publicado el segundo ciclo: commit `3ece793`, versión Cloudflare
`81a25012-2f23-4a61-90cb-dbc1e0b06a87`. El build de producción terminó
correctamente. La comprobación remota posterior aprobó los **18 grupos y 144
solicitudes** sin modificar datos. La portada y el recorrido del pedido también
se revisaron en escritorio a 1280 px.

Los totales comprenden todos los estados y son importes ficticios; no representan
facturación cobrada. El listado y sus filtros siguen limitados a los últimos 100
pedidos, con esa ventana indicada en pantalla. El retorno de tracking exige
coincidencia de estado, número y transportista con el acuse local, sin advertencia.

## Ciclo de pulido y presentación · 19/09/2026

Validación previa a publicar este ciclo:

- `pnpm check`: TypeScript/Astro sin errores, advertencias ni sugerencias;
  **113 pruebas en 9 archivos** y build correctos.
- `scripts/smoke.mjs`: **24 comprobaciones locales** de compra, stock,
  canales, proveedor, estados, tracking, acuses y feeds.
- `scripts/stock-race.mjs`: dos compras contra una última unidad; solo una
  confirmada, stock de tienda y proveedor en cero.
- `scripts/verify-public.mjs` contra localhost: **15 grupos de comprobación**,
  45 productos y fichas, 48 imágenes y 167 enlaces internos/anclas correctos.
  Solo utiliza GET y cuatro POST de cotización; no crea pedidos ni cambia stock.
- Navegador a 390 px: catálogo sin desbordamiento, filtros plegables, cesta,
  código postal sin cobertura y recuperación, compra completa y confirmación.
  Visitar una confirmación anterior conserva una cesta creada después.
- Panel móvil: menú por teclado, cierre con Escape y retorno de foco; creación
  de pedido Amazon, bloqueo durante la operación y enlace al pedido confirmado.
- Documentación: nuevas guías de presentación y conexión por servicio,
  accesibles desde el centro y revisadas en móvil.

La cobertura añadida valida límites de cantidad y stock del carrito, recuperación
ante fallo de publicación del feed tras pagar, repetición de envío/tracking sin
duplicar eventos, snapshots de importes, IDs inválidos y lectura JSON limitada a
64.000 bytes incluso sin `Content-Length`.

La consulta remota de migraciones confirma que **no quedan migraciones por
aplicar** en `ecom-connect-db`. Este ciclo no cambia el esquema ni reinicia datos.
Publicado en el Worker propio el 19/09/2026: commit `a60d3e0`, versión Cloudflare
`b429cc3a-8d11-499d-981d-0e65bbd9d67f`. La verificación pública posterior
completó los mismos **15 grupos**, 143 solicitudes, 167 enlaces y 48 imágenes,
con lecturas y cotizaciones exclusivamente. No se modificaron pedidos, stock ni
ajustes de la demo compartida durante esa comprobación.

El smoke completo modifica ajustes y despacha pendientes: se reserva para el
entorno local. Para comprobar el Worker público sin alterar su estado:

```sh
node scripts/verify-public.mjs
# También admite otro origen de esta demo:
DEMO_URL=http://localhost:4327 node scripts/verify-public.mjs
```

## Revisión local · 19/09/2026

Los cambios de integración, documentación e imágenes se han verificado en
desarrollo local. Esta revisión **no es un despliegue nuevo** ni una certificación
de conexión comercial con proveedor o Lighthouse.

- TypeScript/Astro: sin errores, advertencias ni sugerencias.
- Vitest: **76 pruebas** en 7 archivos. Incluye 27 escenarios omnicanal con
  SQLite real, 14 de contrato proveedor y 8 de payload Lighthouse.
- Build de producción: correcto con las páginas técnicas y los assets nuevos.
- HTTP local: **24 comprobaciones** de `scripts/smoke.mjs`, incluidos acuse de
  aceptación, retorno de tracking y reintento sin duplicación del acuse.
- Última unidad: dos compras concurrentes, una confirmada y otra rechazada;
  stock local y del proveedor igual a cero.
- Imágenes: **45 productos + 3 hero**, todos con respuesta HTTP 200 y tipo WebP;
  dimensiones verificadas, aproximadamente 1,85 MiB en conjunto. Los 45 registros
  D1 y las 45 imágenes del feed apuntan a las fotografías nuevas.
- Documentación: índice y siete documentos responden HTTP 200. Navegación,
  tablas e índice interno revisados en navegador a 390 px y escritorio.
- Interfaz: portada, banners, catálogo, ficha y retorno de tracking revisados;
  imágenes individuales revisadas y plancha de los 45 productos inspeccionada.

Las pruebas nuevas cubren falta de stock en una línea de un lote, artículos
inactivos/desconocidos, backup excluido, referencias concurrentes con distinto
contenido, reparación de acuses, ausencia de regresión de entregado a enviado y
fallos del hub después de guardar pago o expedición. Un fallo exclusivo del
acuse deja una advertencia recuperable, sin invalidar la operación comercial.

Se aplicaron localmente `0046_marketplace_order_updates.sql` y
`0047_generated_product_images.sql`. La segunda actualiza solo las rutas SVG
originales del catálogo demo, conservando pedidos, precios, stock e imágenes
personalizadas. Los recorridos HTTP crean exclusivamente datos ficticios locales.

Fuentes revisadas y límites reales: [proveedor](PROVEEDOR.md),
[Lighthouse](LIGHTHOUSE.md) y [requisitos dropshipping](INTEGRACION-DROPSHIPPING.md).
No se han probado credenciales, direcciones variables ni expediciones reales.

## Historial de la entrega publicada · 18/09/2026

Fecha: 18/09/2026. Worker: `ecom-connect`. D1: `ecom-connect-db`.

- TypeScript/Astro: 157 archivos, 0 errores, 0 avisos.
- Vitest: 36 pruebas aprobadas. Incluye 9 escenarios con SQLite real y todas las
  migraciones, no únicamente respuestas simuladas del repositorio de datos.
- Build de producción: correcto. Worker subido: aproximadamente 1,34 MiB sin
  comprimir; assets y fuentes locales.
- HTTP local: 21 comprobaciones end-to-end de `scripts/smoke.mjs` aprobadas.
- HTTP Cloudflare: esas 21 comprobaciones aprobadas contra el Worker publicado.
- Última unidad: dos checkouts simultáneos, un único pedido confirmado, stock
  local/proveedor igual a cero (`scripts/stock-race.mjs`).
- Navegador: compra web completa hasta confirmación, cesta, ficha y simulación
  de pedido Amazon. Tienda y panel revisados a 375 px y escritorio, sin
  desbordamiento horizontal en las pantallas comprobadas.

Se verificaron cinco canales, cotización sin aceptar precios del cliente,
idempotencia concurrente, descuento de stock único, sincronización conservando
pedidos pendientes, envío agrupado/manual, envío inmediato, estados parcial y
error, tracking y los dos formatos de feed.

Los pedidos creados durante la comprobación remota son ficticios y sirven como
datos iniciales del panel. El catálogo inicial tiene 45 referencias.

## Límite de la infraestructura

Cloudflare rechazó el alta del cron con error **10072**: la cuenta ya tiene
los cinco triggers del plan Workers Free. No se alteraron otros proyectos ni
se cambió de plan. El handler está implementado, pero
`GROUPED_CRON_ENABLED=false` y no se registra ningún cron. El panel muestra
ejecución manual para el envío agrupado. Activación futura documentada en README.

## Revisión

Arquitectura: recursos aislados y adaptadores sustituibles. Backend: importes,
stock, concurrencia y estados comprobados. Frontend/UX: acciones, estados vacíos,
errores y móvil revisados. Producto: catálogo y operaciones marcados como demo.
SEO: `noindex` y robots bloqueados, sin publicar la demo como tienda real.

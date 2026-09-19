# Verificación de la entrega

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

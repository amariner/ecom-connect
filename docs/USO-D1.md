# Uso de D1 y demo sin tareas automáticas

## Incidente del 22 de septiembre de 2026

El límite del plan gratuito es de **5 millones de filas leídas al día por cuenta**,
compartido entre sus bases de datos. Una operación con datos ficticios consume
filas reales de D1: que la tienda sea una demo no evita ese consumo.

La analítica de Cloudflare consultada a las 17:06, hora de Madrid, atribuyó
**7.391.558 filas leídas** a `ecom-connect-db` durante el 22/09/2026. La otra base
con actividad sumaba 293. Es una lectura de la analítica, no una estimación del
número de visitantes. No se modificó ningún recurso de otro proyecto.

Dos causas verificadas:

- El selector unía 695 referencias del proveedor con productos mediante una
  condición que no aprovechaba el índice parcial existente. Cloudflare registró
  **484.565 filas leídas en una sola ejecución**. El plan local mostraba un
  recorrido de productos por cada referencia del proveedor.
- El catálogo completo se consultaba para páginas y relacionados de cada ficha.
  Query Insights registró **2.394 ejecuciones**, 545 filas por consulta y
  **1.304.730 filas leídas**. Las verificaciones exhaustivas de publicación,
  de más de 1.500 solicitudes por ejecución, contribuyeron a esta carga.

También había consultas del panel cada 15 segundos. El servidor de desarrollo
ejecutaba un programador local con esa misma frecuencia. Este último actuaba
sobre D1 local, no explica por sí mismo el consumo remoto, pero se elimina
igualmente para que la demo no haga trabajo en segundo plano.

Los datos de Query Insights corresponden a su ventana y muestreo; no se suman
para deducir el total de la cuenta. La cifra por base procede del conjunto
`d1AnalyticsAdaptiveGroups` de la API de analítica.

## Recuperación de hoy

La cuota gratuita se restablece a las **00:00 UTC del 23/09/2026**, equivalentes a
las **02:00 del 23 de septiembre en Madrid**. El bloqueo no borra datos. Reducir
consultas no devuelve la cuota ya consumida; no se ha contratado un plan de pago.

Hasta ese instante, `D1_READ_PAUSED_UNTIL=2026-09-23T00:00:00Z` hace que las rutas
que necesitan D1 respondan **503** antes de consultar la base. La página explica
la pausa y la hora prevista. Las API devuelven `code: D1_READ_LIMIT`, `resume_at`
y `Retry-After`, para evitar cadenas de reintentos. Imágenes y documentación
siguen disponibles sin consultar D1.

La pausa tiene fecha de caducidad: después del reinicio de cuota, una petición
normal vuelve a atenderse sin cron, temporizador ni nuevo despliegue. Dev ignora
esta fecha de emergencia porque usa su base local. Una nueva detección real de
cuota agotada abre un circuito por instancia de Worker hasta el siguiente día
UTC; no se reintenta la misma consulta ni se ocultan los errores como datos vacíos.

## Ningún cron ni proceso periódico

Por decisión expresa para esta demo:

- `wrangler.jsonc` declara `triggers.crons: []` y `GROUPED_CRON_ENABLED=false`.
- El handler `scheduled` es inerte incluso si recibiera un evento antiguo o
  alguien cambiara únicamente la variable. No lee ni escribe D1.
- `/api/demo/scheduler` rechaza las peticiones con `SCHEDULER_DISABLED`, tanto
  en desarrollo como en producción, sin acceder a la base.
- `pnpm dev` arranca únicamente Astro. No hay intervalos de ejecución de tareas.
- El panel carga al entrar y actualiza por acciones del usuario. Las animaciones
  del esquema son decorativas y no disparan lecturas periódicas.
- Los horarios guardados se conservan como configuración de demostración; no
  arrancan ningún ejecutor. Reactivar un programador requiere una nueva decisión
  expresa y cambios de código, además de revisar presupuesto y configuración.

Las pestañas abiertas antes de este cambio pueden conservar JavaScript que
consultaba cada 15 segundos. Sus GET a `state`, `catalog-selection` y `sync-control`
se rechazan antes de tocar D1 con **409 `CLIENT_REFRESH_REQUIRED`**. Hay que
recargar esas pestañas. La versión actual y el verificador envían
`X-Demo-Read: manual-v1` en estas lecturas. Es una marca de versión del cliente,
no una credencial ni un mecanismo de autenticación.

Las operaciones iniciadas por el usuario siguen siendo demostraciones: comprar,
simular un pedido, sincronizar o guardar una selección pueden leer y escribir D1
una vez recuperada la cuota. Las respuestas inmediatas vinculadas a una acción
del usuario no son tareas programadas. No hay cobros, emails ni conexiones
comerciales con proveedor o marketplaces.

## Reducción de lecturas

El selector carga proveedor, productos y vínculos una sola vez y hace la
correspondencia en memoria, evitando el cruce cuadrático. Las consultas de una
referencia aprovechan el índice de SKU ya existente cuando el código no está
vacío. Esta corrección no requiere una migración remota ni volver a cargar seeds.

Medición de `meta.rows_read` en Miniflare sobre una copia aislada de la base local
con 695 productos, sin ejecutar consultas remotas:

| Consulta | Filas antes | Filas después |
| --- | ---: | ---: |
| Catálogo del selector | 484.565 | 2.235 |
| Stock de una referencia | 723 | 30 |
| Resumen de sincronización | 394.335 | 17.195 |
| Comprobación de nuevas referencias | 181.865 | 1.935 |

El GET completo del selector añade siete filas de selecciones: pasa de 484.572 a
2.242 lecturas. El catálogo del selector conserva los mismos resultados con un
**99,54 % menos de filas leídas**. Los otros valores dependen del estado local
de reservas y vínculos; no son una promesa de coste fijo para cualquier catálogo.

La portada, la tienda y `/api/products` usan una caché de catálogo público de
**60 segundos**, acotada a 128 entradas y 4 MiB por binding/instancia. Las consultas
simultáneas comparten una carga en curso; los errores no se almacenan como un
catálogo vacío. Las fichas consultan su referencia y hasta cuatro relacionados,
sin leer todo el catálogo cuando la caché está fría.

La caché sirve datos para visualización. Cotización, checkout, validación de stock,
feeds, pedidos y administración siguen consultando su fuente actual. Las
mutaciones invalidan la caché local incluso cuando terminan con error, porque
una operación recuperable puede haber escrito parte de sus datos. Otras
instancias pueden conservar una vista durante un máximo de 60 segundos; el
servidor vuelve a validar precios y stock al tramitar.

Las tres API de lectura intensiva del panel limitan las actualizaciones a
30 por minuto, por ruta e IP e instancia. Es una protección frente a ráfagas,
no una cuota global. El consumo de otros proyectos y el tráfico externo no
están controlados por este Worker; no se promete un límite diario global rígido.

## Verificar sin repetir la sobrecarga

Tipos, pruebas y compilación son locales y no consumen filas de D1 remoto:

```sh
pnpm check
```

La verificación pública usa una muestra y un presupuesto de solicitudes por
defecto. Recorrer todas las fichas, filtros e imágenes requiere seleccionar
expresamente el modo exhaustivo, reservado preferentemente a una base local.
No ejecutar verificaciones exhaustivas recurrentes contra la demo publicada.
La muestra local de esta revisión completa 35 comprobaciones con 110 solicitudes,
dentro de un tope de 150; el recorrido anterior generaba 1.540 solicitudes.

Durante la pausa basta verificar la respuesta 503, `Retry-After`, el código
de error de la API, la documentación y la ausencia de cron. No ejecutar seeds,
reimportaciones, sincronizaciones, sondeos o exportaciones para intentar
restablecer una cuota que solo se reinicia al comenzar el siguiente día UTC.

Para atribuir consumo, consultar la analítica de Cloudflare, que no ejecuta SQL
sobre la base de la demo:

```sh
pnpm exec wrangler d1 insights ecom-connect-db --time-period 1d --sort-by reads --sort-type sum --limit 10
```

El gráfico de D1 del panel Cloudflare permite contrastar las filas por día y por
base. Si el consumo vuelve a crecer, revisar primero la consulta concreta y su
plan; no aumentar la frecuencia de sincronización ni activar cron para probar.

## Validación de esta corrección

- `pnpm check`: tipos sin errores ni advertencias, 651 pruebas en 39 archivos y
  compilación correcta.
- Verificador por muestra contra localhost: 35 comprobaciones, 110 solicitudes
  de un máximo de 150, sin cambiar datos.
- Cliente anterior: las tres API devuelven 409 sin consultar D1; con la cabecera
  de la versión manual devuelven 200 en local.
- Recorrido en navegador: actualización manual del esquema, sin sondeos;
  página de pausa legible en móvil de 390 px.
- Preview Worker con la pausa vigente: portada y API 503, documentación 200 y
  programador 403 `SCHEDULER_DISABLED`, sin consultar D1 remoto.

## Fuentes y alcance

- [Precios y reinicio de límites de D1](https://developers.cloudflare.com/d1/platform/pricing/).
- [Métricas y Query Insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
- [Índices y filas leídas](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

El cambio afecta exclusivamente a Ecom Connect. No modifica bases, tareas,
dominios ni planes de otros proyectos de la cuenta.

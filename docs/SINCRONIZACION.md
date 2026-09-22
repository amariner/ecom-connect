# Pedidos por canal y sincronización

## Panel

**Vista general** distingue los pedidos web de los de marketplaces, con totales del historial completo y cinco pedidos recientes por origen. Los contadores y listas se actualizan cada 15 segundos mientras la página está visible. La gráfica muestra siete días en la zona de Madrid. Los importes son de demostración, incluyen el histórico con sus diferentes estados y no representan cobros.

El apartado antes llamado Lighthouse se presenta como **Integraciones → Marketplaces** y conserva su URL para no romper enlaces. Los canales de destino aparecen primero, seguidos de estadísticas de pedidos, controles de sincronización y selectores de feeds. El enlace **Gestionar productos y pedidos** abre `/admin/marketplaces`, con la selección por marketplace y la simulación de nuevos pedidos; esta página ya no tiene una entrada separada en el menú lateral.

En **Pedidos**, la configuración del proveedor y el historial de sus cinco últimas
ejecuciones se presentan en dos bloques plegados. Sus cabeceras muestran el modo de
envío, el último resultado y las incidencias disponibles. En **Configuración**, el
formulario de sincronización permanece abierto. En Marketplaces los controles
principales siguen visibles y el detalle de operaciones se despliega a petición.
Véase [Experiencia y diseño](UX-UI.md) para la organización y verificación de la UI.

## Envío de pedidos al proveedor

Los mismos controles están en **Pedidos** y **Configuración**:

- Interruptor general de envío automático.
- Envío inmediato al confirmar cada compra simulada, o hasta doce horarios diarios.
- Cantidad de pedidos por horario y por ejecución manual: entre 1 y 500. «Todos los pendientes» toma los pedidos pendientes al comenzar el lote, sin incluir compras que lleguen después.
- Horas de Madrid (`Europe/Madrid`), también en los cambios de horario estacional.
- Pedido completo: un mensaje con todas sus referencias. Producto a producto: un mensaje por referencia con su cantidad, manteniendo la misma referencia de pedido. No fusiona distintos pedidos de una persona ni divide sus unidades en nuevas compras.
- Con datos del cliente: incluye nombre y dirección de entrega. Sin datos: omite el objeto cliente completo del mensaje al proveedor. No transmite email. Todo queda en la base local de la demo.

Las opciones de empaquetado y datos de cliente quedan fijadas al primer intento de envío, también si falla y se reintenta después. La aceptación del proveedor y sus mensajes se guardan juntos: reenviar una referencia no descuenta stock ni duplica mensajes. La ficha del pedido muestra cantidad de mensajes, número de referencias, modalidad, fecha y si incluían datos de entrega, sin exponer la dirección en ese resumen.

El interruptor desactivado bloquea los nuevos envíos automáticos. El botón manual sigue disponible. Desmarcar «inmediato» hace que los nuevos pedidos esperen al horario; un pedido ya creado conserva su política histórica. Las ejecuciones mantienen el bloqueo de concurrencia e historial del motor existente. Si un envío falla, queda pendiente y puede reintentarse manualmente. No se cobra ni se envían emails.

## Marketplaces: automático o manual

En automático, las compras actualizan la copia del catálogo en el hub demo; los cambios de estado intentan comunicar su acuse, y el ejecutor realiza una conciliación periódica configurable. En manual, estas actualizaciones quedan pendientes hasta una acción explícita. Guardar y publicar una selección de feed es también una acción manual explícita.

El botón **Sincronizar marketplaces ahora** registra estos pasos:

| Paso | Qué guarda la demo | Operación del contrato de referencia |
| --- | --- | --- |
| Catálogo, stock y precios | Copia efectiva por marketplace según sus selecciones | `Products/ExtraInfo` |
| Consulta de pedidos | Lectura del registro local de pedidos entrantes simulados | `Sales` |
| Transportistas | Referencias de transportistas utilizados | `Carriers` |
| Ventas web | Copia de ventas web, líneas y datos de cliente de demostración | `CmsSales` |
| Estados y seguimiento | Acuses de estado, cancelación y expediciones | `UpdateCmsSales` |

Las fechas de stock corresponden a la última copia recibida por el hub. El panel compara esa copia con el surtido, stock y precio vigentes e indica cuántas referencias han cambiado. El feed público continúa representando el catálogo actual aunque la copia del marketplace esté pendiente.

Se muestra el resultado de cada paso, incluida una ejecución fallida. La consulta de pedidos usa el registro local; no consulta una cuenta real ni crea nuevos pedidos por leerla. Los identificadores del hub son ficticios. Los payloads reflejan campos del OpenAPI, pero no constituyen una integración externa validada: para una conexión real hacen falta autenticación, correspondencia de IDs, cursores incrementales y respetar los límites de cada recurso (por ejemplo, 100 ventas web por llamada). Los datos del cliente para ventas web son independientes de la opción de compartirlos con el proveedor.

Contrato revisado el 22/09/2026: [OpenAPI oficial de Lighthouse](https://app.lighthousefeed.com/api/help/versions/1.0/document.json).

## Ejecutor desactivado

Por decisión expresa del 22/09/2026, la demo no tiene ningún cron ni proceso de
sincronización periódica. `pnpm dev` solo arranca Astro en 4327. La ruta
`/api/demo/scheduler` responde `403 SCHEDULER_DISABLED` sin consultar D1 en
cualquier entorno. El handler `scheduled` del Worker también es inerte y la
configuración declara `triggers.crons: []` y `GROUPED_CRON_ENABLED=false`.

Guardar un horario o un intervalo conserva la configuración, pero no crea tareas
ni habilita un programador. Las acciones manuales y los pasos inmediatos de una
operación iniciada por el usuario siguen disponibles cuando D1 tiene cuota.
No hay comprobaciones cada 15 segundos ni reintentos de sincronización en segundo
plano. La animación de conexiones no significa que se estén consultando servicios.

El motor de horarios conserva sus pruebas locales de idempotencia y concurrencia
para una futura revisión; no está conectado a ningún ejecutor de esta demo.
Reactivarlo requiere una decisión expresa, una revisión de consumo y cambios de
código. Véase [Uso de D1 y límites de la demo](USO-D1.md).

## Persistencia y validación

Migración `0057_sync_policies.sql`. La configuración usa revisiones para impedir que una pestaña sobrescriba cambios de otra. Se rechazan horarios repetidos, horas inválidas y cantidades fuera de rango. Las escrituras y ejecuciones exigen `DEMO_MODE=true`, `OMNICHANNEL_DEMO=true` y origen local. Los guardados repetidos con el mismo contenido son idempotentes.

Pruebas: política inmediata/manual, horas de Madrid, cantidades y «todos», ejecución simultánea de un horario, mensajes por referencia, privacidad del payload, reintentos sin duplicados, copias de stock pendientes y conciliación fallida recuperable.

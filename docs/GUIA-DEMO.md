# Guía para presentar Ecom Connect

Una presentación de **15 minutos** para explicar al cliente cómo se coordinan
la tienda, el proveedor y los marketplaces desde un mismo sistema. El recorrido
usa acciones disponibles en la aplicación y deja resultados que se pueden volver
a consultar. No requiere credenciales externas.

**Alcance:** FarmaHouse es una tienda ficticia de parafarmacia. El catálogo y los
pedidos persisten en la base de datos de la demo; proveedor, Lighthouse, pagos,
marketplaces y expediciones son simulados. No se cobra, no se envían correos y no
se prepara mercancía. Los datos se comparten entre las visitas a este entorno.

## El mensaje que queremos demostrar

En la presentación, **FarmaHouse** es la tienda que visita el comprador;
**Ecom Connect** es el panel central de catálogo, pedidos e integraciones;
**Logic2B** es su motor de comercio. Lighthouse distribuye el catálogo entre
canales y el proveedor simulado representa la preparación del pedido.

«Una venta puede empezar en la web o en un marketplace. Ecom Connect la reúne
con las demás, controla el inventario, coordina el pedido al proveedor y conserva
su seguimiento. El equipo puede revisar el recorrido sin ir cambiando de
herramienta para cada paso.»

El valor se presenta con tres pruebas visibles:

1. **Un mismo catálogo:** cambiar la disponibilidad del proveedor y comprobar
   cómo se traslada a la tienda y al feed.
2. **Una misma operativa:** crear una venta web y otra de marketplace, y
   gestionarlas en el mismo panel conservando el canal de origen.
3. **Un recorrido trazable:** seguir un pedido desde la reserva hasta el tracking
   y el acuse del hub simulado.

La demo muestra estas capacidades; no acredita mejoras porcentuales de ventas,
ahorro de horas, aceptación de productos por un marketplace ni un acuerdo de
nivel de servicio. Esas métricas se medirían con una operación real.

## Preparación antes de la reunión

Para arrancar o actualizar el entorno, seguir [Operar y verificar la demo](OPERACION-DEMO.md).
Esa guía separa las pruebas locales que crean datos de la comprobación pública
sin mutaciones. El recorrido siguiente sí guarda cambios y pedidos ficticios.

Reservar unos minutos para comprobar el entorno y abrir estas pestañas:

- [Tienda](/), [catálogo](/tienda) y [panel general](/admin).
- [Proveedor](/admin/integraciones/proveedor),
  [marketplaces](/admin/marketplaces) y [pedidos](/admin/pedidos).
- [Configuración](/admin/configuracion) y
  [Lighthouse](/admin/integraciones/lighthouse).

En **Configuración**, anotar el modo actual, elegir **Envío agrupado** y pulsar
**Guardar configuración**. Así el pedido de la presentación quedará pendiente
para poder explicar su envío al proveedor paso a paso. Este ajuste se comparte
con las demás visitas; evitar otra presentación simultánea en el mismo entorno.

En **Proveedor**, pulsar **Sincronizar ahora** y revisar el resultado. Escoger un
producto activo con stock suficiente, anotar nombre y SKU, y usar ese mismo
producto durante la reunión. Si está agotado, simular un stock suficiente y
volver a sincronizar; no hace falta reiniciar ni borrar la base de datos.

Revisar el carrito y retirar líneas de pruebas anteriores. En la compra usar los
datos ficticios precargados. Guardar los números de los pedidos creados durante
la presentación: hay actividad compartida y no conviene identificar un pedido
únicamente por ser el primero de una lista.

## Recorrido de 15 minutos

| Tiempo | Pantalla | Acción | Evidencia para el cliente |
| --- | --- | --- | --- |
| 0–2 min | Tienda y ficha | Buscar un producto y ver su ficha | Catálogo comercial, precio y disponibilidad. |
| 2–5 min | Carrito y checkout | Comprar una unidad con el cliente demo | Total recalculado y número de pedido WEB. |
| 5–7 min | Marketplaces y pedidos | Simular una unidad en Amazon | Segundo pedido, mismo panel y canal propio. |
| 7–10 min | Detalle del pedido Amazon | Enviar al proveedor y avanzar a enviado | ID ERP, historial, tracking y retorno al hub. |
| 10–12 min | Proveedor, productos y feed | Cambiar stock y sincronizar | Disponibilidad coherente y fecha de operación. |
| 12–14 min | Configuración | Procesar pendientes y explicar inmediato | Una misma operación con dos ritmos de envío. |
| 14–15 min | Documentación | Revisar conexiones y requisitos reales | Alcance de la demo y siguientes pasos concretos. |

Para un recorrido de 10 minutos, omitir los estados intermedios y la ejecución
del lote; conservar la compra web, el pedido Amazon, el tracking y el cambio de
stock. Las pruebas de error se pueden dejar para una sesión técnica.

### 1. Enseñar la experiencia de compra

En la [tienda](/tienda), buscar el producto seleccionado, abrir su ficha y añadir
una unidad a la cesta. Mostrar que el cliente puede explorar el catálogo antes
de entrar en el proceso de compra.

En el carrito revisar producto, cantidad e importe. En el checkout mantener el
cliente ficticio y un código postal admitido, por ejemplo **12001**. Completar la
compra simulada y anotar el número de pedido mostrado en la confirmación.

**Qué explicar:** el navegador envía referencias y cantidades; el servidor
consulta precio y disponibilidad y calcula los portes. No confía en un total
introducido por el cliente. Si cambia el precio de un producto o el envío antes
de confirmar, aparece **Revisa el importe actualizado** y el botón **Confirmar
importe** muestra el nuevo total. El comprador lo revisa y confirma de nuevo;
la compra no se completa
automáticamente con un precio distinto. No se introduce una tarjeta.

**Qué comprobar:** en [Pedidos](/admin/pedidos) aparece la venta con canal WEB y
su importe. Al abrirla se conservan sus líneas y precios aceptados. Si la
API rechaza la compra por falta de stock, volver a revisar el carrito: la demo
no permite comprar unidades que ya no están disponibles. Si se interrumpe la
conexión y aparece **Reintentar confirmación**, usar ese botón para recuperar el
mismo intento; una respuesta perdida no demuestra que la compra haya fallado.

Al confirmarse, se retiran de la cesta las cantidades de la selección original.
Los productos o unidades añadidos después se conservan para otra compra de prueba.
También se conserva un producto eliminado y añadido de nuevo mientras la primera
compra seguía pendiente. Volver a abrir un enlace antiguo de confirmación no debe
vaciar esa nueva cesta.

### 2. Crear una venta de otro canal

En [Marketplaces](/admin/marketplaces), elegir el mismo producto en la tarjeta de
Amazon, cantidad **1**, y pulsar **Simular pedido**. Anotar el número del nuevo
pedido confirmado y pulsar **Seguir pedido**. **Ver pedidos de Amazon** abre
el historial filtrado por ese canal.

Compararlo con la venta web: ambas se consultan y gestionan igual, pero cada
pedido conserva su canal. Mirar el stock disponible después de las ventas.

**Qué explicar:** la centralización evita que el equipo tenga que mantener un
procedimiento distinto por canal. El mismo ejercicio está disponible para
Miravia, Carrefour y eBay.

**Límite concreto:** este botón fabrica una venta ficticia con una línea y el
precio del catálogo de la demo. La integración comercial tendrá que importar
pedidos multilínea, direcciones e importes originales del canal; ese importador
real aún no está conectado.

### 3. Seguir el pedido hasta su tracking

Abrir el pedido Amazon. El **Recorrido del pedido** permite explicar su avance
antes de entrar en los controles: **Venta confirmada → Proveedor acepta → Envío
y tracking → Retorno al canal**. La indicación **Siguiente paso** dirige a la
acción o evidencia que corresponde. En un pedido WEB aparecen las tres primeras
etapas, porque no hay que notificar su seguimiento a un marketplace.

Localizar **Gestión del proveedor**:

1. Comprobar que el pedido está pagado de forma simulada y pendiente de proveedor.
2. Pulsar **Enviar al proveedor**. Aparece una referencia `PED-ERP-*` y un nuevo
   evento en el historial.
3. Seleccionar **En preparación** y pulsar **Actualizar estado**.
4. Seleccionar **Enviado + tracking** y volver a actualizar. Aparecerá un
   seguimiento `DEMO-*`.
5. Revisar **Retorno al marketplace**: estado comunicado, tracking y fecha del
   último acuse local deben corresponder al pedido.

Comprobar que el recorrido completa el retorno solo después del envío y con un
acuse vigente que coincide en estado, número de seguimiento y transportista.
Un acuse anterior de aceptación no acredita que el canal tenga el tracking.
El estado parcial no completa el envío; un error posterior a la aceptación
conserva ese hito, pero requiere resolver la incidencia para seguir avanzando.

**Qué explicar:** el equipo puede separar «venta recibida», «proveedor aceptó» y
«expedición registrada». El historial permite saber qué ha ocurrido y cuándo.
El retorno del tracking cierra el recorrido de demostración.

En **Historial del pedido**, los movimientos más recientes aparecen primero,
con fecha y hora local. Se muestran inicialmente hasta 10; **Ver 10 anteriores**
amplía la lista hasta poder consultar todo el recorrido. El contador indica
cuántos movimientos se ven y el botón termina en **Historial completo**. Para
explicar el origen de una incidencia, desplegar también los movimientos antiguos.

**Límite concreto:** el acuse está guardado en D1 por el hub simulado; no es una
confirmación de recepción de Amazon o Lighthouse. `DEMO-*` no permite seguir un
paquete real. Al completarse, la etapa muestra **Seguimiento registrado · Amazon
demo** y habla de una confirmación simulada. Un pedido enviado es terminal en el
simulador.

### 4. Demostrar que el stock viene del proveedor

En [Proveedor](/admin/integraciones/proveedor), seleccionar el producto del
recorrido y mostrar **Disponibilidad de este producto**. El desglose permite
explicar el cálculo sin salir del panel:

- **Stock del proveedor:** unidades que declara el origen simulado.
- **Reservas de pedidos:** unidades ya comprometidas que el proveedor todavía
  no ha descontado; también se muestra cuántos pedidos las aportan.
- **Disponible al sincronizar:** resultado de descontar esas reservas, con un
  mínimo de cero.
- **Stock actual en tienda:** cantidad que tiene ahora el catálogo importado.

Al cambiar de producto se consulta su disponibilidad. Si aparece un error,
**Reintentar consulta** recupera el desglose sin cambiar el stock. Las cifras
proceden de los datos guardados, no de una estimación del formulario.

Introducir **7** unidades y pulsar **Simular cambio de stock**. El origen cambia,
pero el catálogo conserva su cantidad anterior. Comparar el disponible calculado
con el stock de tienda: **Pendiente de sincronizar** señala que difieren.

Pulsar **Sincronizar ahora**. Revisar procesados, actualizados y errores y volver
al desglose. **Stock coincide** indica que ambas cantidades son iguales en esa
consulta; no equivale a una confirmación de un marketplace real. Abrir **Ver
producto en FarmaHouse** para mostrar el resultado en la ficha, si el producto
está importado y activo.

La cantidad resultante **puede ser inferior a 7**: si el pedido WEB sigue pagado
y pendiente de enviar al proveedor, su unidad está comprometida localmente. Con
una única reserva, el panel mostrará **7 − 1 = 6** y una tienda sincronizada tendrá
6 unidades. La actividad de otras visitas puede cambiar las cifras; utilizar
las que devuelve el panel durante la reunión.

```text
Disponible demo = máximo(0,
  stock del proveedor − unidades pagadas todavía no descontadas allí)
```

**Qué explicar:** una sincronización no debe volver a poner a la venta unidades
ya comprometidas. Cuando la compra ya consta en el proveedor, esas unidades no
se restan otra vez como reserva local. El almacén de respaldo no se suma
automáticamente. **Ver historial de pedidos** abre el historial general; no es
un filtro automático por el producto seleccionado.

**Comprobación técnica opcional:** en [Lighthouse](/admin/integraciones/lighthouse),
abrir el feed XML para revisar identidad, precio y disponibilidad, o el
[feed JSON](/api/feeds/products.json) para consultar stock numérico. No hace falta
abrirlos para explicar el cálculo al cliente. **Regenerar feed** actualiza el
registro de publicación simulada; el contenido del feed refleja el catálogo
actual.

**Variante opcional: cambio de precio, en dos pestañas.** Puede sustituir los
estados intermedios del proveedor cuando interese mostrar el control del importe:

1. Preparar una compra web y dejar el checkout abierto, con su total visible y
   sin confirmar.
2. En otra pestaña, abrir Proveedor, seleccionar el mismo producto y anotar su
   precio y PVP originales. En **Precio de venta por unidad**, editar el importe
   y pulsar **Simular cambio de precio**. Mantener un PVP mayor que el nuevo
   precio, o dejar su campo vacío para retirarlo explícitamente.
3. Comparar **Precio en el proveedor** y **Precio actual en tienda**: solo cambió
   el primero. Pulsar **Sincronizar ahora** y comprobar **Precios coinciden**,
   que compara tanto precio como PVP.
4. Volver al checkout sin recargarlo y confirmar: aparece **Revisa el importe
   actualizado**. Revisar el nuevo desglose y pulsar **Confirmar importe** para
   completar la compra con ese importe aceptado.
5. Para devolver el precio al valor anterior, volver a Proveedor, introducir
   precio y PVP originales, guardar y sincronizar otra vez. El pedido ya confirmado
   conserva su importe; no se modifica retroactivamente.

**Ventaja que se demuestra:** actualizar el precio desde un origen y pedir una
nueva confirmación al comprador si cambia el importe que había revisado. La demo
no calcula márgenes ni demuestra precios diferentes para cada marketplace.

### 5. Explicar las dos formas de operar

Volver a [Configuración](/admin/configuracion). Si el pedido WEB sigue pendiente,
pulsar **Enviar pendientes ahora** y comprobar su referencia de proveedor.

- **Agrupado:** permite revisar los pedidos antes de ejecutar un lote. Cada
  ejecución procesa hasta 30 pendientes; si quedan más, repetir la operación.
- **Inmediato:** cada nuevo pedido pagado intenta enviarse al proveedor sin
  esperar al lote. Para enseñarlo, guardar este modo y crear otra venta demo.

Cambiar de modo no envía retroactivamente los pedidos pendientes. El botón de
lote sigue siendo el control disponible para ellos. La programación periódica
está preparada pero desactivada en la configuración revisada; no presentar el
envío agrupado como automático mientras el panel indique ejecución manual.

Restaurar al terminar el modo de envío anotado antes de la reunión. Los pedidos
de prueba permanecen en el historial; la semilla de datos no los borra.

### 6. Cerrar con el plan de conexión

Abrir [Cómo conectamos los servicios](CONEXION-SERVICIOS.md). Mostrar qué
conector corresponde a cada participante y qué evidencia se necesita antes de
activar una cuenta real.

La decisión siguiente es concretar catálogo, territorios, canales y operativa
con el cliente, y obtener contratos y acceso sandbox del proveedor y de
Lighthouse. No se trata de pegar claves de producción en esta demo.

## Ventajas y cómo enseñarlas sin promesas vacías

| Necesidad del negocio | Capacidad visible | Prueba durante la demo | Métrica para una futura puesta en marcha |
| --- | --- | --- | --- |
| Evitar mantener varios catálogos a mano | Catálogo central y feed compartido | Cambiar stock una vez y revisar sus destinos | Tiempo desde dato del proveedor hasta aceptación en cada canal. |
| Tramitar ventas de distintos canales | Pedidos centralizados con canal de origen | Comparar la venta WEB y la de Amazon | Tiempo de gestión por pedido y pedidos pendientes por canal. |
| Reducir ventas con stock comprometido | Desglose de proveedor, reservas y disponibilidad | Mostrar la resta en Proveedor y comparar el resultado con la tienda | Incidencias por sobreventa y antigüedad del stock publicado. |
| Evitar duplicados al reintentar | Claves de idempotencia y referencias estables | Revisar las pruebas de repetición documentadas | Duplicados detectados y reintentos recuperados. |
| Localizar incidencias de preparación | Filtro de situación del proveedor e historial | Filtrar errores o parciales, reabrir un pedido y resolverlo | Pedidos retenidos y tiempo hasta resolución. |
| Completar el seguimiento del canal | Acuse mock de estado y tracking | Comparar tracking del pedido y del retorno | Tiempo hasta confirmación remota del seguimiento. |
| Adaptar cuándo se tramitan ventas | Envío inmediato o por lote | Cambiar el modo y observar un nuevo pedido | Antigüedad de pendientes y latencia de aceptación. |
| Sustituir servicios sin rehacer la tienda | Contratos de adaptador separados | Abrir la guía de conexiones | Esfuerzo y cobertura de pruebas de cada adaptador real. |

Los contadores generales y por marketplace abarcan todos los pedidos guardados
en la demo, incluidos los pendientes antiguos. La pantalla **Pedidos** busca y
filtra todo el historial, con páginas de **25 resultados**. El resumen del panel
muestra actividad reciente, pero no limita la búsqueda histórica. La actividad
de otras visitas puede cambiar las cifras durante una
sesión. El importe total simulado describe pedidos de prueba y no es facturación
real ni un informe contable; incluye también pedidos pendientes o cancelados.

## Funcionalidades por pantalla

| Pantalla | Qué permite hacer | Qué conviene mostrar |
| --- | --- | --- |
| Tienda | Explorar, buscar, filtrar y abrir fichas | Presentación de producto y conexión al carrito. |
| Carrito y checkout | Modificar cantidades y realizar una compra demo | Validación de stock, portes y total en servidor. |
| Vista general | Revisar catálogo, canales, pendientes globales y actividad | Mapa del circuito, totales de la demo y última sincronización. |
| Productos | Buscar por texto/SKU/EAN/marca y combinar categoría, estado y stock | Referencias agotadas o inactivas, datos del catálogo y consulta compartible. |
| Pedidos | Buscar y filtrar todo el historial, cambiar de página y abrir el detalle | Resultados por consulta, totales globales y URL compartible. |
| Detalle | Consultar el recorrido, enviar, avanzar estados y revisar eventos | Siguiente paso, referencia ERP y retorno vigente del tracking. |
| Proveedor | Cambiar stock o precio remoto, consultar los desgloses y sincronizar | Origen menos reservas y comparación de disponibilidad y precios con la tienda. |
| Lighthouse | Consultar feeds, regenerar y conciliar | Publicación y acuses locales de pedidos. |
| Marketplaces | Simular ventas de cuatro canales | Contadores y último pedido de cada canal, además del stock compartido. |
| Configuración | Elegir modo y enviar pendientes | Control del ritmo operativo. |
| Documentación | Consultar guía comercial, contratos y pruebas | Alcance verificable y preparación de la conexión real. |

## Revisar el catálogo y compartir una consulta

En [Productos](/admin/productos), combinar la búsqueda y categoría con los filtros
de estado y stock para centrar la revisión. **Activos** e **Inactivos** separan la
visibilidad del catálogo; **Con stock**, **Stock bajo (1–5)** y **Sin stock**
permiten revisar sus unidades. Un producto puede tener stock y estar inactivo.

La URL conserva los filtros para compartir la consulta o retomarla después.
Atrás y Adelante recuperan los criterios; **Limpiar filtros** vuelve al catálogo
completo. Una consulta vacía indica que ninguna referencia cumple esa combinación.
El contador de resultados refleja los filtros; las cifras superiores describen
el catálogo completo.

Un artículo inactivo aparece como **No visible en tienda** y no ofrece un enlace
a una ficha pública. Sigue disponible para revisión en el panel: simular su stock
no lo reactiva. La tienda, el checkout y los feeds excluyen estos artículos.
Esta pantalla permite consultar el estado; no ofrece activar o desactivar
productos.

## Buscar un pedido y conservar el contexto

La pantalla [Pedidos](/admin/pedidos) permite recuperar ventas de presentaciones
anteriores, aunque ya no estén entre las más recientes. Para mostrarlo:

1. Buscar el número de un pedido conocido y combinarlo, si conviene, con su
   **Canal**, **Estado del pedido** y **Situación del proveedor**. Este último
   permite localizar **Error de proveedor** o **Envío parcial** en todo el historial.
2. Revisar el rango y el total de resultados. Los controles **Anterior** y
   **Siguiente** recorren la consulta en páginas de 25 pedidos.
3. Abrir un resultado y seguir su recorrido. **Volver a pedidos** recupera los
   filtros y la página desde los que se abrió el detalle.
4. Copiar la URL del listado para compartir esa consulta de la demo o retomarla
   después. Recargarla mantiene los criterios; los resultados pueden cambiar si
   otras visitas crean o actualizan pedidos.
5. Usar **Limpiar filtros** para volver al historial completo.

Al cambiar la búsqueda, el canal, el estado o la situación del proveedor, la
consulta vuelve a la primera página. Los botones Atrás/Adelante del navegador permiten recuperar cambios de
filtro y página. Si una consulta falla por conexión, **Volver a intentar** la
repite manteniendo los criterios elegidos.

Los totales de las tarjetas describen el conjunto de pedidos de la demo; el
rango de la tabla corresponde a los filtros seleccionados. Una consulta sin
resultados no significa que el canal nunca haya vendido: revisar los criterios
o limpiarlos para ampliar la búsqueda.

**Por enviar al proveedor** reúne pedidos pagados cuya aceptación aún necesita
confirmación en el panel; alguno puede haber llegado ya al proveedor. Un error
también puede ocurrir después de aceptar el pedido. Estos filtros describen la
situación actual: al resolver una incidencia, el pedido deja ese filtro y su
historial conserva lo ocurrido.

## Incidencias que podemos demostrar

**Stock insuficiente.** Usar un producto sin unidades o pedir más de las
disponibles. La compra no debe confirmarse con cantidades imposibles. Si se
modificó el stock remoto para la prueba, restaurarlo y sincronizar al terminar.

**Error de proveedor.** En un pedido aceptado pero aún no enviado, seleccionar
**Error de proveedor** y actualizar. Volver a Pedidos, elegir **Error de proveedor**
en **Situación del proveedor** y reabrir el pedido. Revisar el evento y volver a
**En preparación**: al regresar al listado filtrado, ya no aparecerá como error.
Se puede recuperar por su número quitando el filtro. Si el fallo ocurrió antes
de obtener un ID de proveedor, el control disponible será **Reintentar envío**.
Ese fallo también queda en el historial y la actividad: los reintentos fallidos
no duplican la incidencia y su recuperación la conserva. No crear otra venta
para resolver el mismo pedido.

**Retorno pendiente al marketplace.** Si el detalle muestra **Pendiente de
conciliar**, pulsar **Conciliar sincronización** y verificar el resultado. Esa
acción también sincroniza catálogo y feed. Un fallo de acuse no debe borrar una
venta o expedición que ya quedó guardada.

**Envío parcial.** Seleccionar ese estado en el detalle y volver al listado.
Filtrar **Envío parcial** en **Situación del proveedor**, reabrir el pedido y
avanzarlo a **En preparación** para mostrar su recuperación. Sale del filtro de
parciales, pero conserva el evento. No existen aún expediciones separadas por
línea: presentarlo como una señal operativa de la simulación.

**No se puede consultar el importe.** Pulsar **Volver a consultar la cesta**.
Esta acción actualiza precios, stock y envío; no crea el pedido. La compra queda
a la espera de una cotización válida y una confirmación del comprador.

**Confirmación interrumpida en la tienda.** Si se pierde la respuesta al crear la
compra, el checkout conserva el intento y bloquea sus datos. Pulsar **Reintentar
confirmación**: se reenvía el mismo intento, aunque la primera llamada
haya consumido la última unidad. No hace falta modificar la cesta ni crear otra
venta. Con el almacenamiento de sesión disponible, el intento se recupera al
recargar el checkout; sin él, la recuperación se limita a la página que sigue
abierta. Revisar el panel si hace falta comprobar qué quedó guardado.

**Cesta después de confirmar.** El sistema retira solo las cantidades de la
selección original y conserva los artículos añadidos después, incluso un producto
que se eliminó y se volvió a añadir. Si el navegador impide identificar o
actualizar la cesta con seguridad, aparece un aviso para revisarla antes de una
nueva compra de prueba. El pedido ya confirmado permanece guardado: el aviso no
pide repetir la compra. La recuperación depende de los datos conservados en ese
navegador; no es una sincronización de la cesta entre dispositivos.

**Confirmación interrumpida en un marketplace.** Si la tarjeta muestra
**Confirmación pendiente**, pulsar **Reintentar confirmación**. Conserva canal,
producto, cantidad y referencia; puede recuperar el pedido ya creado aunque
ahora el producto esté agotado o inactivo. Mientras se comprueba ese intento,
la tarjeta no propone crear otra venta. Al confirmarse, **Seguir pedido** abre
su detalle y los avisos de proveedor, feed o retorno se muestran por separado
de la confirmación de compra.

Con el almacenamiento de sesión disponible, el intento se recupera al recargar
esa pestaña. Si el panel avisa que no puede guardarlo, mantenerla abierta hasta
confirmar. Si no puede restaurar todos los datos, revisar **Ver pedidos de Amazon**
—o el canal correspondiente— antes de simular otra compra. El recibo de la tarjeta
no se conserva tras recargar; el pedido confirmado sí permanece en el historial.

**Resultado incierto en el panel.** Tras una desconexión, revisar el listado o
detalle: la operación podría haberse guardado aunque no llegara su respuesta.
Refrescar la página no deshace una operación guardada.

## Preguntas habituales del cliente

**¿Esto ya vende en Amazon o Miravia?** No. Las tarjetas representan canales
simulados. La conexión real requiere cuenta de vendedor, autorización del hub,
datos de producto válidos y pruebas de publicación por canal.

**¿El proveedor envía directamente al comprador?** Ese es el circuito objetivo,
pero el alta del contrato recibido no incluye una dirección de destinatario.
Hay que confirmar con el proveedor cómo se transmite y acepta cada destino.

**¿Hay que pagar otra vez un pedido que viene del marketplace?** No debe
hacerse. Un importador real conservará los importes y el pago comunicado por el
canal. La demo solo representa pagos ficticios.

**¿Se puede cambiar de proveedor?** El catálogo, el stock y los pedidos están
separados mediante `SupplierAdapter`. Conectar otro proveedor requiere mapear su
contrato, implementar el adaptador y probarlo. No es un cambio de nombre en el
panel ni una garantía de compatibilidad automática.

**¿Qué pasa si un servicio falla?** La demo permite observar errores y reintentos
locales. La operación real necesitará colas durables, conciliación, límites de
reintento y alertas comprobadas con los servicios externos.

**¿Se pueden gestionar devoluciones?** No hay un recorrido completo de
devolución, cancelación ni reembolso en esta demo. Debe acordarse el responsable
y el procedimiento por canal antes de operar.

**¿Los datos son privados para cada visitante?** No. Este panel es público y
comparte datos ficticios. Una implantación real necesitará autenticación,
permisos y tratamiento de datos de cliente en un entorno separado.

## Después de la presentación

Guardar los números de los pedidos enseñados y las observaciones del cliente.
Restaurar la configuración de envío y cualquier stock cambiado solo para un
caso de error. No borrar pedidos ni modificar recursos de otros proyectos.

Para preparar una propuesta técnica, recoger surtido, canales prioritarios,
volumen previsto, territorios, reglas de precio, transportistas, horarios de
preparación y responsabilidades sobre incidencias. Estos datos condicionan las
conexiones y el coste operativo; la demo no los presupone.

- [Cómo conectamos todos los servicios](CONEXION-SERVICIOS.md).
- [Contratos y requisitos del circuito](INTEGRACION-DROPSHIPPING.md).
- [API local y ejemplos](API.md).
- [Pruebas y verificación](VERIFICACION.md).

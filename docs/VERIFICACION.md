# Verificación de la entrega

## Vigesimosegundo ciclo: devoluciones del comprador · 20/09/2026

- Tipos: **225 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **598 pruebas en 31 archivos** aprobadas; build de producción correcto.
- Al abrir el área de cliente quedó a la vista que el circuito terminaba en
  «enviado»: ningún pedido llegaba nunca a «entregado», así que la devolución
  era inalcanzable. El panel confirma ahora la entrega, y esa confirmación es la
  que abre el plazo del comprador. La prueba de entrega la da el comercio.
- **Defecto del núcleo heredado corregido.** `panelTransitionEvent` emitía
  siempre un hecho de cancelación, fuera cual fuera el destino de la transición.
  Nunca había dado un dato falso porque el panel solo cancelaba; al confirmar la
  primera entrega, el pedido quedaba «entregado» pero su historial y su
  auditoría decían «Cancelado desde el panel». Ahora emite el hecho que
  corresponde y el recorrido del panel incluye su etapa **Entrega**.
- El comprador pide la devolución desde su pedido entregado: elige artículos y
  unidades, un motivo y un comentario. El plazo es de 30 días naturales desde la
  entrega, solo hay una devolución viva por pedido y nunca se pueden reclamar
  más unidades de las compradas. Puede anularla mientras nadie la tramite.
- El comercio la resuelve en la tarjeta **Devoluciones** del pedido: aceptar con
  una nota que el comprador lee, rechazar, registrar la recepción o anotar el
  reembolso simulado. Anular la solicitud es solo del comprador, y el panel lo
  rechaza si lo intenta.
- La reposición del stock cuelga de un disparador de la propia transición a
  «recibida», y cada movimiento ocupa una versión única de la devolución. Dos
  recepciones simultáneas reponen las unidades una sola vez y anotan un único
  movimiento; la segunda lee el resultado de la primera en lugar de duplicarlo.
- La migración `0054` crea la devolución, sus líneas y sus movimientos con las
  guardas de ventana, propiedad y unidades. No modifica pedidos existentes.
- La bandeja **Requiere atención** suma un quinto tipo: devoluciones que esperan
  una decisión o su reembolso. Una aceptada espera al comprador y no cuenta.
- El historial que lee el comprador deja de mostrar el vocabulario interno:
  `SUPPLIER_ACCEPTED` y `SUPPLIER_SHIPPED` se cuentan como «Pedido en
  preparación» y «Pedido enviado», y las incidencias del proveedor no se le
  muestran porque no son suyas.
- Las 18 pruebas nuevas cubren la confirmación de entrega y su repetición, la
  ventana antes y después de la entrega y su caducidad a los 30 días, el alta con
  líneas y motivo, el exceso de unidades, la idempotencia del formulario, el
  aislamiento entre cuentas, el recorrido completo hasta el reembolso, los pasos
  que no se pueden saltar, la liberación de unidades al rechazar, la anulación
  del comprador y su límite, la bandeja y dos carreras forzadas con el adaptador
  de intercalado: dos solicitudes simultáneas y dos recepciones simultáneas.
- El smoke local añade siete comprobaciones HTTP del circuito completo: entrega
  confirmada, formulario ofrecido en la cuenta, solicitud del comprador, lectura
  desde el panel, recepción con su reposición de stock, reembolso simulado con el
  importe de las líneas y el estado final con la nota que ve el comprador. En
  local: **43 comprobaciones**.
- La verificación pública comprueba estados, líneas, reembolso y movimientos de
  las devoluciones de un pedido entregado, sin pedir ninguna. En local completa
  **34 grupos, 175 solicitudes, 181 enlaces y 48 imágenes**.
- Recorrido en navegador con D1 real: el panel acepta con nota, registra la
  recepción —el stock sube— y reembolsa; la cuenta muestra la devolución
  reembolsada, permite pedir otra con la unidad restante y anularla, y el
  historial del pedido aparece traducido. A 390 px la lista de artículos dejaba
  una línea de 240 px de alto: `flex-basis` mide alto en columna. Corregido y
  vuelto a medir en 114 px, sin desplazamiento horizontal.
- Límites que la demostración mantiene: no hay logística inversa, ni etiqueta de
  envío, ni dinero. El proveedor demo no participa en la devolución y el
  reembolso no llega a ninguna forma de pago.

## Vigesimoprimer ciclo: área de cliente · 20/09/2026

- Tipos: **222 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **580 pruebas en 30 archivos** aprobadas; build de producción correcto.
- La tienda no tenía ninguna zona de cliente: quien compraba solo recibía un
  enlace al panel de administración para seguir su pedido. En cambio, el esquema
  heredado ya traía sin usar las tablas de cliente (`0036`–`0044`): perfil,
  identidad sin contraseña, sesiones revocables, direcciones con revisiones,
  consentimiento versionado y referencias públicas opacas. El área de cliente se
  ha construido sobre ellas en lugar de crear un modelo paralelo.
- Comprar sigue sin exigir cuenta. Al confirmar un pedido web, queda a nombre del
  perfil de ese correo; al entrar con el mismo correo, la cuenta reclama también
  las compras anteriores que aún no tuvieran dueño, sin importar mayúsculas.
- El acceso es un enlace sin contraseña. Como la demo no envía correos, el mensaje
  se guarda en `emails_outbox` y el enlace se muestra en pantalla como una bandeja
  de entrada simulada. Caduca en diez minutos, solo sirve una vez y anula al
  anterior; la base guarda únicamente su huella SHA-256. Un mismo correo admite
  tres enlaces cada quince minutos y diez al día. Queda dicho en la interfaz y en
  la documentación que, por eso, cualquiera puede entrar con cualquier correo
  ficticio: es la única diferencia con un acceso sin contraseña real.
- Pedidos, direcciones y devoluciones se identifican con referencias públicas
  opacas (`ord_…`, `addr_…`): el número de pedido no da acceso. Cada lectura y
  cada acción comprueban la propiedad; un pedido ajeno responde 404 y no se puede
  cancelar. La cookie es `HttpOnly`, `SameSite=Lax` y dura seis días.
- El comprador ve el estado, las etapas, los importes, la dirección con la que
  compró, sus expediciones con seguimiento y el historial; puede cancelar
  mientras nada haya salido del almacén. La cancelación reutiliza el circuito del
  panel con el nuevo origen `account`: el proveedor demo anula, la tienda repone
  su stock y el panel muestra «Solicitada por el cliente desde su cuenta».
- Las direcciones se guardan por revisiones: corregir una cierra la anterior en la
  misma sentencia y los pedidos ya hechos conservan la suya. La clave de
  idempotencia evita que un reenvío cree una segunda dirección. El checkout llega
  relleno con la preferida y con el correo de la sesión.
- «Mis datos» guarda nombre y teléfono, registra el consentimiento como evidencia
  versionada con su aviso y su fecha, permite descargar una copia en JSON, cerrar
  la sesión en todos los dispositivos y retirar los datos de contacto. Los pedidos
  se conservan: son la prueba de una compra, no un dato editable del perfil.
- La migración `0053` añade el nombre visible y el teléfono del perfil, la
  dirección preferida y el tercer origen de cancelación. SQLite no permite ampliar
  un `CHECK`, así que `order_cancellations` se reconstruye conservando sus filas.
  No modifica pedidos ni direcciones existentes.
- Las 30 pruebas nuevas cubren el enlace y su caducidad, la sustitución del
  anterior, el límite por correo sin afectar a otros compradores, el reclamo de
  compras de invitado, el detalle, la paginación fuera de rango, el aislamiento
  entre cuentas, la cancelación y su rechazo tras el envío, el ciclo completo de
  direcciones, el consentimiento y su retirada, la copia de datos y el borrado.
  Cuatro fuerzan carreras con el adaptador de intercalado: el mismo enlace abierto
  en dos navegadores deja una sola sesión, dos primeros accesos simultáneos no
  duplican el perfil, dos correcciones a la vez dejan una sola revisión vigente y
  dos cancelaciones simultáneas reponen el stock una sola vez.
- El smoke local añade doce comprobaciones HTTP del recorrido completo: acción sin
  sesión rechazada, redirección al acceso, enlace emitido, cookie entregada,
  enlace no reutilizable, pedido de invitado visible, dirección guardada, checkout
  relleno, copia de datos, cancelación del comprador, origen visto desde el panel
  y cookie revocada al salir. En local: **36 comprobaciones**.
- La verificación pública comprueba que el área de cliente responde sin sesión y
  que un enlace inválido no abre ninguna. En local completa **33 grupos, 173
  solicitudes, 181 enlaces y 48 imágenes**.
- Recorrido en navegador con D1 real: compra como invitado con un correo nuevo,
  confirmación, **Seguir mi pedido**, enlace de acceso en pantalla, resumen,
  detalle del pedido, cancelación con su aviso, dirección guardada como preferida
  y consentimiento registrado. El panel muestra la cancelación con su origen. A
  390 px las cuatro pantallas caben sin desplazamiento horizontal.
- Pendiente y documentado como tal: la demostración no simula devoluciones ni
  reembolsos de un pedido enviado o entregado. La cuenta lo dice con esas palabras
  en lugar de ofrecer una acción que no existe.

Publicado el vigesimoprimer ciclo: commit `ef536f4`, versión Cloudflare
`f335a7ee-fea3-4dfc-ad99-1cf956669d82`. Migración `0053` aplicada en
`ecom-connect-db` antes del despliegue: 14 pedidos conservados, ninguna
cancelación previa que reconstruir y 14 referencias públicas de pedido creadas.
La verificación pública completa **33 grupos, 171 solicitudes, 181 enlaces y 48
imágenes**. En la demo publicada, entrar con `laura@example.com` reclama su
compra web anterior y muestra su detalle completo; cerrar sesión devuelve al
acceso, sin errores de consola. No se cancela ningún pedido compartido.

## Vigésimo ciclo: envío agrupado supervisado · 20/09/2026

- Tipos: **199 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **550 pruebas en 28 archivos** aprobadas; build de producción correcto.
- Cada ejecución del envío agrupado, manual o programada, queda registrada con
  su origen, resultado, pedidos enviados, errores y pendientes restantes. Solo
  puede haber una en curso: lo garantiza un índice único parcial y una segunda
  simultánea se anota como omitida. Una ejecución que se rompe libera su turno, y
  una que lleva más de diez minutos en curso se da por interrumpida.
- **Pausar envío programado** detiene solo las ejecuciones automáticas; el envío
  manual nunca se bloquea. Cambiar la pausa conserva el modo de envío y viceversa.
- La programación automática **sigue desactivada**: `GROUPED_CRON_ENABLED=false`
  y sin disparadores cron. El manejador programado ya usa la ejecución
  supervisada, de modo que activarla será solo una decisión de configuración.
- La migración `0052` crea el registro de ejecuciones. No modifica datos existentes.
- Las 11 pruebas cubren recuento y pendientes, límite por lote, errores del
  proveedor, ejecución vacía, solapamiento forzado con el adaptador de
  intercalado, turno interrumpido reciente y antiguo, fallo inesperado, pausa,
  ajustes independientes y las cinco últimas ejecuciones del panel.
- Recorrido local con D1 real: **Enviar pendientes ahora** envía el único
  pendiente, el contador pasa a 0 y aparece la fila «Manual · Completada · 1 · 0 ·
  0». **Pausar envío programado** cambia la insignia a **Programado en pausa** y
  el botón a **Reanudar**, con el foco de vuelta en el botón. Se restaura el ajuste.
- Las reglas de tabla estrecha, antes limitadas al detalle del pedido, se aplican
  ahora a cualquier tabla del panel que las use. A 378 px la tabla de ejecuciones
  cabe sin desplazamiento ni desbordar la página y el botón mide 44 px. La
  emulación a 320 px del navegador de pruebas dejó de responder en esta sesión:
  ese ancho no se pudo medir en esta página.
- La verificación pública comprueba la pausa, las últimas ejecuciones y que haya
  como máximo una en curso. En local completa **32 grupos, 168 solicitudes, 177
  enlaces y 48 imágenes**.
- El servidor local se reinició desde `.claude/launch.json`. La prueba envió al
  proveedor demo el pedido local pendiente. No se modifican datos del entorno
  compartido para QA.

Publicado el vigésimo ciclo: commit `8adb872`, versión Cloudflare
`4c00a60b-bffa-49cc-897c-e25e3eb9616d`. Migración `0052` aplicada en
`ecom-connect-db` antes del despliegue: 13 pedidos conservados y ninguna
ejecución registrada. La verificación pública completa **32 grupos, 166
solicitudes, 177 enlaces y 48 imágenes**. En **Configuración** publicada la
tarjeta indica **Programado sin activar**, la pausa está desactivada y el pedido
pendiente compartido no se ha enviado, sin errores de consola. Por decisión
expresa, el disparador automático no se activa. GitHub Actions termina correcta.

## Decimonoveno ciclo: bandeja «Requiere atención» · 20/09/2026

- Tipos: **198 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **539 pruebas en 27 archivos** aprobadas; build de producción correcto.
- La portada del panel agrupa las excepciones que alguien debe resolver: errores
  de proveedor, envíos parciales por completar, acuses pendientes con el
  marketplace y cancelaciones interrumpidas o que el proveedor no pudo atender.
  Cada tipo cuenta todo el historial y lista sus cinco pedidos más recientes.
  Cada pedido enlaza con la tarjeta del detalle donde se resuelve y **Ver todos**
  abre el historial ya filtrado. Sin excepciones indica **Todo en orden**.
- El detalle del pedido atiende el ancla de la URL después de cargar: desplaza
  la tarjeta bajo la cabecera fija y le pasa el foco.
- La bandeja y la conciliación comparten una única definición de «acuse
  pendiente». Al extraerla apareció un defecto del ciclo anterior: una solicitud
  de cancelación que no llegó a completarse podía comunicarse al canal como
  cancelada si después se enviaba el pedido al proveedor. Ahora el acuse exige
  que el pedido esté cancelado. La prueba falla sin la corrección y pasa con ella.
- Las 9 pruebas de la bandeja cubren cada tipo, su salida al resolverse, los
  pedidos web, el límite de cinco con recuento completo y los datos expuestos.
- Recorrido local: un error de proveedor en eBay (`FH-260919-TECE`) y una
  expedición parcial en Miravia (`FH-260919-Z6AA`) aparecen en la bandeja con
  sus enlaces. Abrir `…/59#order-shipments` deja el foco en **Expediciones**. Al
  recuperar el primero y completar el segundo, la bandeja vuelve a **Todo en orden**.
- A 320 px la tarjeta no desborda y los enlaces de pedido y **Ver todos** miden
  44 px. Inspección visual a 320 px y en escritorio.
- La verificación pública comprueba los cuatro tipos, sus totales, el límite de
  cinco pedidos, los datos públicos y que errores y parciales coincidan con los
  filtros del historial. En local completa **31 grupos, 169 solicitudes, 177
  enlaces y 48 imágenes**.
- Las pruebas locales crearon los pedidos 58 y 59 en la D1 local. No se añaden
  migraciones ni se modifican datos del entorno compartido para QA.

Publicado el decimonoveno ciclo: commit `2ace2a3`, versión Cloudflare
`dec45d58-1db5-43d7-bd95-f64d9d2a2905`, sin migraciones. La verificación pública
completa **31 grupos, 166 solicitudes, 177 enlaces y 48 imágenes**. La portada
publicada muestra la bandeja en **Todo en orden**, sin errores de consola. La
ejecución de GitHub Actions sobre ese commit termina correcta; avisa de que
`ubuntu-latest` pasará a Ubuntu 26 a partir del 19 de octubre de 2026.

## Decimoctavo ciclo: cancelaciones de extremo a extremo · 20/09/2026

- Tipos: **197 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **529 pruebas en 26 archivos** aprobadas; build de producción correcto.
- Un pedido sin unidades expedidas se puede cancelar desde el panel o como
  solicitud del marketplace. Si aún no se envió al proveedor, se libera la unidad
  comprometida. Si el proveedor ya lo aceptó, primero anula su pedido y repone
  sus unidades; después el núcleo cancela, repone el stock de tienda y deja el
  pago simulado en revisión. Con alguna expedición la cancelación se rechaza con
  `409` y el historial lo anota una sola vez. No se reembolsa ningún importe.
- Un pedido cancelado rechaza envío, cambios de estado y expediciones, sale de
  los filtros de situación del proveedor y muestra **Sin gestión**. En
  marketplaces la cancelación se comunica una vez al canal y se concilia si falta.
- La migración `0051` guarda la solicitud antes de actuar, la respuesta del
  proveedor demo y el acuse al canal. Las 51 migraciones se aplican desde cero
  con el ejecutor real de Wrangler.
- Una revisión independiente forzó intercalados entre solicitudes y reprodujo
  seis defectos, todos corregidos con su prueba:
  una sincronización entre la anulación del proveedor y la reposición de tienda
  duplicaba 2 unidades vendibles; una escritura de stock simultánea o dos
  cancelaciones a la vez respondían `500`; un envío al proveedor que perdía
  contra la cancelación respondía `503` y podía sobrescribir origen y motivo; un
  corte tras cancelar dejaba el pedido sin registro ni aviso al canal; y una
  expedición simultánea podía quedar sin constancia. Ahora las unidades siguen
  comprometidas hasta cancelar aquí, la transición se relee y reintenta, la
  primera solicitud fija origen y motivo, **Sincronizar** completa los registros
  interrumpidos y anula en el proveedor lo que siguiera activo, y una expedición
  durante la cancelación queda como incidencia visible.
- Las pruebas usan un adaptador D1 con puntos de intercalado para reproducir cada
  carrera e interrupción de forma determinista.
- Recorrido local `FH-260919-XNKJ` (Amazon, 2 unidades, aceptado): sin marcar la
  confirmación el navegador impide enviar. Con origen **Solicitud de Amazon demo**
  la tarjeta muestra anulación aceptada y acuse al canal, tienda y proveedor
  vuelven a 41 unidades, el recorrido queda detenido y el foco pasa a la tarjeta.
  `FH-260919-J45C` (WEB, sin enviar): no fue necesario avisar al proveedor y la
  tienda pasa de 34 a 35. Un pedido ya expedido no ofrece formulario y la API
  responde `409`.
- Prueba HTTP local en Carrefour: dos cancelaciones simultáneas con orígenes
  distintos responden `200`, se conserva el de la primera, el stock vuelve a
  27/27 tras sincronizar y los intentos posteriores de estado y envío reciben `409`.
- A 320 px la tarjeta no desborda y selector, casilla y botón ofrecen 44 px. La
  consola solo registra los rechazos provocados y dos `500` transitorios del
  entorno local, al recargarse una página entre el cambio de código y el de su tabla.
- La verificación pública añade la coherencia de un pedido cancelado, si existe.
  En local completa **30 grupos, 166 solicitudes, 177 enlaces y 48 imágenes**.
- Las pruebas locales crearon los pedidos 55, 56 y 57 en la D1 local. No se
  modifican datos del entorno compartido para QA.

Publicado el decimoctavo ciclo: commit `a64fe06`, versión Cloudflare
`f3d38ed4-de0b-49aa-874f-e1252c2b0593`. Migración `0051` aplicada en
`ecom-connect-db` antes del despliegue: 4 comandos, 13 pedidos y 3 expediciones
conservados, ninguna cancelación creada. La verificación pública completa
**30 grupos, 164 solicitudes, 177 enlaces y 48 imágenes**. En el panel publicado,
solo en lectura, un pedido pagado ofrece el formulario de cancelación y uno
expedido indica que no se puede cancelar, sin errores de consola. La ejecución
de GitHub Actions sobre ese commit termina correcta.

## Decimoséptimo ciclo: expediciones por línea e integración continua · 19/09/2026

- Tipos: **196 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **501 pruebas en 25 archivos** aprobadas; build de producción correcto.
- Un pedido aceptado puede salir en varios paquetes. Cada expedición registra las
  unidades de cada referencia, tiene su propio seguimiento ficticio y, en
  marketplaces, su propio acuse. El pedido queda en **Envío parcial** hasta cubrir
  todas las líneas; solo entonces pasa a **Enviado** con el último seguimiento.
  **Enviado + tracking** expide de una vez lo pendiente y no se duplica al repetirlo.
- Validación, expedición, líneas y estado comparten una transacción. Las pruebas
  cubren tres solicitudes simultáneas por las mismas unidades (solo una prospera),
  repetición con la misma clave, clave reutilizada con otras líneas, exceso de
  unidades, referencias ajenas, pedido ya expedido y pedido sin aceptar. Ningún
  rechazo escribe datos ni movimientos.
- La migración `0050` añade las expediciones del proveedor demo, su copia canónica
  por pedido y el acuse por expedición. Cada pedido ya expedido se convierte en
  una única expedición completa y conserva su acuse vigente. Aplicada con el
  ejecutor real de Wrangler: 12 comandos, 51 pedidos conservados, 12 expedidos
  convertidos en 12 expediciones y 7 acuses, los mismos 7 que ya estaban comunicados.
- Recorrido local `FH-260919-4CB6` (Amazon, 3 unidades): desde el panel se
  registra 1 unidad. Aparece **Expedición 1** con `DEMO-7A50F8ED`, la tabla
  muestra 1 expedida y 2 pendientes, el recorrido indica «1 de 3 unidades
  expedidas en 1 expedición» y el foco vuelve al botón. **Enviado + tracking**
  crea la **Expedición 2** con las 2 unidades restantes y `DEMO-7A50F8ED-2`;
  ambas constan comunicadas a Amazon demo y el recorrido queda completo.
- Pruebas HTTP locales sobre `FH-260919-…` (WEB, 2 unidades, 1 ya expedida): sin
  clave o con 0 unidades, `400`; 9 unidades o una referencia ajena, `409`; pedido
  inexistente, `404`. Ninguna cambia expediciones, movimientos ni estado. Dos
  solicitudes con la misma clave devuelven `200`, una sola expedición
  `DEMO-D96B35F0-2` y un único movimiento; el pedido pasa a `shipped`. Otra
  expedición posterior recibe `409`. La consulta del proveedor lista ambas.
- Indicar 0 unidades muestra un aviso, enfoca el campo y no crea expedición; el
  navegador impide superar las pendientes. En un pedido WEB no se menciona el canal.
- A 320 px la tarjeta no desborda, la tabla de cuatro columnas cabe sin
  desplazamiento y campo y botón miden 44 px de alto. Inspección visual a 320 y
  1280 px. La consola solo registra los rechazos HTTP provocados en las pruebas.
- La verificación pública añade la coherencia de las expediciones sobre un pedido
  expedido y, si existe, uno parcial: unidades, secuencia, seguimiento y estado.
  En local completa **29 grupos, 177 enlaces y 48 imágenes**, con 163 solicitudes
  o 164 si existe un pedido parcial que consultar. Un acuse de expedición
  pendiente se acepta como estado legítimo.
- Una revisión independiente del cambio reprodujo una carrera: si otra expedición
  completaba el pedido justo después de que **Enviado + tracking** leyera su
  estado, la respuesta era `500` aunque los datos quedaban coherentes. Ahora se
  trata como ya realizado y los rechazos del proveedor devuelven `409`. También
  se corrige que las unidades pedidas salgan de lo aceptado por el proveedor y no
  de una modificación posterior del pedido, y que un pedido parcial se encuentre
  al buscar el seguimiento de cualquiera de sus expediciones (`FH-…` de Miravia
  localizado por `DEMO-CB8206A3` con su seguimiento propio aún vacío).
- Tras un rechazo, el panel recarga el pedido para mostrar lo vigente. Al
  registrar la última expedición el formulario desaparece y el foco pasa a la
  tarjeta **Expediciones**. La barra lateral del panel ya no muestra el isotipo.
- Nuevo flujo de GitHub Actions: tipos, pruebas y build en cada push a `main` y
  en cada pull request. No despliega ni usa secretos.
- Las pruebas locales crearon los pedidos 52, 53 y 54 en la D1 local. No se modifican
  datos del entorno compartido para QA.

Publicado el decimoséptimo ciclo: commit `cc564b1`, versión Cloudflare
`7513a376-8e1a-4f6f-8f0d-80abc14e5f5a`. Migración `0050` aplicada en
`ecom-connect-db` antes del despliegue: 12 comandos, 13 pedidos conservados y los
3 ya expedidos convertidos en 3 expediciones, 1 con su acuse vigente. La
verificación pública completa **29 grupos, 163 solicitudes, 177 enlaces y 48
imágenes**. El pedido histórico de Amazon consultado muestra su **Expedición 1**
comunicada al canal y el recorrido completo, sin formulario ni errores de
consola. La primera ejecución de GitHub Actions sobre ese commit termina correcta.

## Decimosexto ciclo: foco conservado al cruzar los puntos de corte móviles · 19/09/2026

- Tipos: **194 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **469 pruebas en 24 archivos** aprobadas; build de producción correcto.
- **Panel.** Al girar el dispositivo o redimensionar la ventana, el foco ya no se
  pierde en un control que deja de existir. De escritorio a móvil, un enlace del
  menú lateral enfocado queda dentro de un cajón inerte: el foco pasa al botón
  **Abrir menú**. De móvil a escritorio, los botones de abrir y cerrar se
  ocultan: el foco pasa al enlace de la página actual o, si no hay, a la marca.
- **Tienda.** El panel **Filtrar productos** se plegaba al pasar a móvil aunque
  se estuviera escribiendo dentro: el foco caía en el documento y el filtro a
  medio rellenar quedaba oculto. Ahora permanece abierto mientras uno de sus
  campos tiene el foco y se sigue plegando en cualquier otro caso. De móvil a
  escritorio, su cabecera desaparece: si tenía el foco, pasa al buscador del catálogo.
- El navegador puede retirar el foco del control oculto antes de notificar el
  cambio de tamaño, con o sin evento `focusout`. Ambos scripts recuerdan por
  `focusin` que el control móvil tenía el foco y solo lo olvidan ante un
  desenfoque en la vista móvil o un nuevo destino. Un desenfoque deliberado
  anterior o un foco elegido entre ambos eventos se respetan.
- Pruebas nuevas: 13 ejecutan el script real de `Admin.astro` sobre un DOM
  simulado y 12 cubren `filter-panel.ts`: ambos sentidos, pérdida de foco con y
  sin evento, desenfoque deliberado, página sin enlace actual y foco del
  contenido, que nunca se sustituye.
- Recorrido real en `/admin/pedidos`: a 390 px se abre el menú y el foco queda en
  **Cerrar menú**; al pasar a 1100 px el foco está en **Pedidos**, sin cajón,
  fondo ni zonas inertes. Lo mismo desde **Abrir menú** con el cajón cerrado.
  Con **Vista general** enfocada a 1100 px, volver a 390 px deja el foco en
  **Abrir menú** con `aria-expanded="false"`. Con **Simular pedido** enfocado,
  cruzar el punto de corte conserva ese foco.
- Recorrido real en `/tienda`: antes del cambio, escribir «cre» a 900 px y pasar
  a 390 px plegaba el panel y dejaba el foco en el documento. Después, el panel
  sigue abierto, con el foco y el texto en el buscador y sin desbordamiento.
  Con la cabecera enfocada a 390 px, pasar a 900 px registra
  `focusout` de la cabecera hacia el buscador. Con un producto enfocado, el
  panel se pliega y el foco no cambia. Sin errores de consola.
- Límite de la comprobación: en el navegador real el aviso de cambio llegó
  siempre antes de que se retirase el foco. El orden inverso solo queda cubierto
  por las pruebas automáticas. Una página sin foco del sistema no emite eventos
  de foco: los recorridos se repitieron tras activar la pestaña.
- Verificación HTTP local: **28 grupos, 160 solicitudes, 177 enlaces y 48 imágenes**.
  No se añaden migraciones ni se modifican datos para QA.

Publicado el decimosexto ciclo: commit `4922aae`, versión Cloudflare
`0b2e817c-a63c-49e8-88b0-df345084bc78`. La comprobación remota completa
**28 grupos, 160 solicitudes, 177 enlaces y 48 imágenes**. En la tienda
publicada, escribir «cre» a 900 px y pasar a 390 px conserva el panel abierto,
el foco y el texto en el buscador, sin errores de consola.

## Decimoquinto ciclo: estados explícitos y ordenación del catálogo · 19/09/2026

- Tipos: **191 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **444 pruebas en 22 archivos** aprobadas; build correcto.
- Las dos APIs de actualización del proveedor exigen el estado de destino.
  Omitirlo ya no significa «avanzar una fase», lo que podía convertir un reintento
  de preparación en una expedición. Los valores omitidos o inválidos se rechazan
  antes de consultar o modificar la base de datos.
- Pruebas locales HTTP sobre `FH-260919-AU93`: ocho solicitudes inválidas
  reciben `400` sin cambiar el detalle. Dos solicitudes de preparación dejan
  `SUPPLIER_PROCESSING`, sin tracking y con cuatro movimientos.
- Desde el panel se solicita expresamente **Enviado + tracking**. Se obtiene
  `DEMO-F9253176`; repetir la expedición por ambas APIs conserva los cinco
  movimientos, el acuse de Amazon y las 13 unidades del proveedor. Incluso
  expedido, omitir el estado se rechaza. No se crean pedidos adicionales.
- La ordenación de la tienda incluye siempre el botón **Ordenar**. Elegir una
  opción no navega hasta aplicarla. Con teclado, Tab alcanza el botón e Intro
  ejecuta el formulario conservando búsqueda, categoría, marca y ofertas.
- Comprobación real con dos productos faciales: precio descendente muestra
  sérum antes que crema; ascendente invierte ese orden y conserva los filtros.
  A 320 y 390 px no hay desbordamiento; el botón mide 44 px de alto.
  Se inspecciona visualmente la combinación de selector, botón y filtros a 320 px.
- Verificación HTTP local: **28 grupos, 160 solicitudes, 177 enlaces y 48 imágenes**.
  No se añaden migraciones ni se modifican datos del entorno compartido para QA.

Publicado el decimoquinto ciclo: commit `c227983`, versión Cloudflare
`f0576ac2-6bcc-414d-a882-5dbc7a587efe`. La comprobación remota completa
**28 grupos, 160 solicitudes, 177 enlaces y 48 imágenes**. En el navegador
publicado, el botón aplica el orden descendente de las cinco referencias
faciales y conserva la categoría; seleccionar por sí solo no navega.

## Decimocuarto ciclo: modalidad de envío conservada por pedido · 19/09/2026

- Tipos: **191 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **436 pruebas en 22 archivos** aprobadas; build de producción correcto.
- La migración `0049` captura la modalidad dentro del alta de cada pedido demo.
  No reinterpreta el histórico: conserva `NULL` y el panel indica **Gestión manual**.
  Las pruebas cubren cambios de configuración, alta concurrente, rollback y
  recuperación tras una interrupción entre pago y despacho.
- Se comprueba la migración con el ejecutor real de Wrangler. La primera versión
  se revierte íntegramente por una incompatibilidad del separador SQL; la versión
  corregida se aplica localmente y conserva los 49 pedidos existentes.
- Recorrido local: `FH-260919-AU93` se crea agrupado; cambiar a inmediato y
  repetir la misma solicitud conserva el pedido pendiente sin descontar stock
  del proveedor. El envío explícito desde el panel lo acepta una sola vez.
- `FH-260919-NJVN` se crea inmediato con falta de stock y queda en error.
  Tras reponer existencias y cambiar a agrupado, dos reintentos recuperan el
  mismo pedido aceptado, un único descuento y el acuse actualizado de Miravia.
- Resultado local: 51 pedidos, un pendiente previo conservado, sérum a 13
  unidades y crema a 23. Se restaura el modo agrupado; no se modifican pedidos
  ni existencias del entorno compartido para estas pruebas.
- En navegador, **Modo de este pedido** muestra inmediato, agrupado o gestión
  manual según el dato propio. A 320 px el detalle y sus nuevas explicaciones
  no desbordan, y el enlace del recorrido permite ejecutar el envío individual.
- La verificación pública añade la coherencia de la modalidad entre resumen,
  historial y detalle, manteniendo ocultos los campos internos del pedido.
  En local completa **28 grupos, 160 solicitudes, 177 enlaces y 48 imágenes**.

Publicado el decimocuarto ciclo: commit `550c8c9`, versión Cloudflare
`db71c592-5aca-452c-b1c1-a13e4e7d109a`. Migración `0049` aplicada en
`ecom-connect-db` antes del despliegue. La verificación pública completa
**28 grupos, 160 solicitudes, 177 enlaces y 48 imágenes**. El pedido histórico
consultado muestra **Gestión manual**, sin alterar su estado ni su stock.

## Decimotercer ciclo: acceso directo a los pendientes · 19/09/2026

- Tipos: **191 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **423 pruebas en 22 archivos** aprobadas.
- «Ver pendientes» abre el conjunto global desde resumen, Pedidos y
  Configuración; cada marketplace conserva su canal. Los enlaces permanecen
  disponibles con cero pendientes y abren la primera página sin filtros ajenos.
- Navegador local: desde una búsqueda sin coincidencias con canal Amazon,
  estado Enviado y proveedor Enviado, el enlace global abre únicamente
  `supplier=pending_dispatch` y encuentra el pedido pendiente de FarmaHouse.
  Desde Miravia abre su canal más ese filtro y muestra correctamente el vacío.
- A 320 px, resumen y marketplaces no desbordan; los enlaces tienen 44 px de
  altura. Activar con Intro el del resumen abre la misma cola y muestra un pedido.
- La ayuda aclara que son pedidos pagados sin aceptación confirmada, incluidos
  envíos pendientes y reintentos. Sin referencia, el detalle muestra
  «Aceptación no confirmada». No cambia el criterio de la cola ni el despacho.

Publicado el decimotercer ciclo: commit `775a788`, versión Cloudflare
`f09034bd-6903-48f0-ac8d-da69e1ce552a`. Build correcto y verificación pública
de **27 grupos, 159 solicitudes, 177 enlaces y 48 imágenes**. El acceso global
abre el pedido pendiente de Miravia con los filtros correctos, sin mutaciones.

## Duodécimo ciclo: lectura y tarjetas en pantallas estrechas · 19/09/2026

- Tipos: **191 archivos**, sin errores, advertencias ni sugerencias. Vitest:
  **423 pruebas en 22 archivos** aprobadas.
- Recorrido local a 320 px por resumen, pedidos, productos, configuración,
  marketplaces, proveedor, Lighthouse, tienda, ficha y guía operativa. Las
  páginas revisadas no tienen desbordamiento horizontal general.
- Se detecta un recorte interno en Lighthouse: su rejilla de 290 px contenía
  317 px de contenido, ocultando parte de los canales de la derecha. Ahora usa
  una columna hasta 380 px; a 320, ancho y contenido son 290 px. A 390 mantiene
  dos columnas y ambos anchos son 352 px; a 768, 548 px sin recorte.
- Las explicaciones bajo el título de Proveedor/Lighthouse pasan de 9 a 12 px,
  con contraste calculado **5,72:1** sobre blanco.
- El aviso «Producto ficticio · Imagen generada con IA» pasa de 5–6 a 11 px,
  con contraste **5,62:1** sobre fondo uniforme. A 320 px ocupa dos líneas sin
  salirse de la imagen; se reserva espacio para que no tape el producto.
  La ficha se inspecciona también visualmente a 768 px.
- Revisión adicional a 768 px de resumen, marketplaces, proveedor, Lighthouse
  y detalle de pedido, sin desbordamiento. No se añaden pruebas que repliquen
  reglas CSS ni se modifica el comportamiento de las integraciones.

Publicado el duodécimo ciclo: commit `ef4271b`, versión Cloudflare
`52d39c58-7bf2-4a08-a66e-2203894042ee`. Build correcto y verificación remota
de **27 grupos, 159 solicitudes, 177 enlaces y 48 imágenes**. En navegador
publicado a 320 px se confirma Lighthouse sin recortes y el aviso de ficha
a 11 px, sin cambiar datos compartidos.

## Undécimo ciclo: historial completo y detalle adaptable · 19/09/2026

- Tipos: **191 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **423 pruebas en 22 archivos**. Ocho regresiones cubren el historial
  extenso, empates de fecha, acceso sin omisiones, foco y ampliación persistente.
- El detalle muestra los diez movimientos más recientes y permite consultar
  todos los anteriores por bloques. Mantiene el orden de inserción entre eventos
  con la misma fecha; la API sigue devolviendo el historial completo ascendente.
- Navegador local: `FH-260919-VSMU` acumula 36 movimientos y muestra primero
  la expedición `DEMO-F9A00FB8`. Las ampliaciones 10 → 20 → 30 → 36 permiten
  llegar a la creación; el foco termina en «Historial completo» sin saltar.
- En `FH-260919-5W5C`, ampliar los 16 movimientos y actualizar a preparación
  muestra 17 de 17, conservando la ampliación. La nueva transición aparece
  primero y el foco vuelve al botón de actualización.
- Móvil de 390 px: se corrige el ancho mínimo del bloque de detalle que hacía
  crecer toda la página por la tabla. Página y viewport miden 390 px; la tabla
  desplaza sus columnas dentro de su contenedor y admite foco y flecha derecha
  (40 px de desplazamiento comprobados). El historial no desborda la página.
- Fechas visibles con año, segundos y hora local; atributos `datetime` en UTC.
  Las guías explican el orden visual y el acceso a los movimientos anteriores.
- Cambios de estado únicamente en pedidos ficticios locales. Sin nuevos
  endpoints ni migraciones; se conserva el historial registrado.

Publicado el undécimo ciclo: commit `ac04dae`, versión Cloudflare
`5b48519c-6c32-4329-9d33-66ef66b377e5`. Build correcto y verificaciones local
y remota de **27 grupos, 159 solicitudes, 177 enlaces y 48 imágenes**. El pedido
público consultado muestra sus dos movimientos completos, el más reciente primero.

## Décimo ciclo: recuperación de ventas marketplace y guía operativa · 19/09/2026

- Tipos: **189 archivos**, sin errores, advertencias ni sugerencias.
- Vitest: **415 pruebas en 21 archivos**. Incluye 51 escenarios del intento
  marketplace, cuatro de integración del panel y una regresión HTTP con SQLite
  para recuperar la última unidad incluso tras desactivar el producto.
- Cada canal conserva producto, cantidad y referencia mientras el resultado
  está pendiente. La recuperación no depende del selector ni del stock actual.
  Los intentos válidos guardados por la versión anterior también se recuperan.
- Navegador local con proxy de fallos: Amazon compra la última unidad de Agua
  micelar Fresh Moment; el servidor guarda `FH-260919-VSMU`, pero se devuelve
  HTTP 502. Recargar restaura el intento antiguo con el producto agotado.
  El siguiente reintento recibe `200 {}` y sigue pendiente, con foco en
  «Reintentar confirmación». Tras otra recarga, la respuesta completa recupera
  el mismo pedido y el foco pasa a «Seguir pedido».
- Después de las tres solicitudes siguen existiendo **48 pedidos**, una única
  reserva de esa referencia y stock de tienda cero. No se duplica la venta.
- Segundo recorrido: Miravia confirma `FH-260919-5W5C` y muestra expresamente
  el aviso de falta de stock del proveedor. Tras restaurar existencias, su
  detalle permite reintentar el envío; conserva fallo y aceptación en historial
  y actualiza el acuse del canal. Se restauró el modo agrupado local.
- Interfaz comprobada a 390 px, sin desbordamiento horizontal. Mientras un
  intento está pendiente, no se ofrece otro formulario de compra para su canal.
  Si no se puede guardar la sesión, se indica mantener abierta la pestaña.
- La nueva guía **Operar y verificar la demo** enlaza preparación, migraciones,
  publicación y verificación sin mutaciones desde el centro documental.
- Verificación HTTP local: **27 grupos, 159 solicitudes, 177 enlaces y
  48 imágenes**. Este ciclo no cambia endpoints ni añade migraciones.

Publicado el décimo ciclo: commit `b969ee5`, versión Cloudflare
`6c35341a-84fd-4c90-ab7c-9491acefd910`. Build correcto y verificación remota
de **27 grupos, 159 solicitudes, 177 enlaces y 48 imágenes**. La guía operativa
y su índice se comprobaron también en navegador publicado, sin mutaciones.

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

Publicado el noveno ciclo: commit `09fe8ca`, versión Cloudflare
`4862b208-bf5e-426e-89cb-74b08df02072`. Build correcto y verificación remota
de **27 grupos, 158 solicitudes, 169 enlaces y 48 imágenes**. El navegador
publicado muestra el mismo pedido pendiente que el contador global, sin
modificar datos compartidos.

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

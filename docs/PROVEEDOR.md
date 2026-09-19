# Contrato del proveedor y preparación para dropshipping

Revisión: 19 de septiembre de 2026. Fuente: **Documentacion API.pdf**, documento
aportado por el cliente, 8 páginas, sin número de versión ni fecha de edición
visibles. Las páginas citadas son las páginas físicas del PDF. Se revisaron el
texto y la representación visual de las ocho páginas. El PDF es una fuente del
contrato técnico; no es una autorización para operar servicios externos.

Esta especificación distingue los campos confirmados por el PDF de las decisiones
de implementación propuestas. El documento no identifica el nombre del proveedor,
el dominio de la API ni un entorno de pruebas. No se han conectado servicios ni
creado pedidos reales. La aplicación sigue utilizando proveedores simulados y
datos ficticios en su D1 independiente; véanse [Arquitectura](ARQUITECTURA.md) y
[API de la demo](API.md).

## Qué confirma el documento

| Operación | Método y ruta del PDF | Entrada específica | Salida | Fuente |
| --- | --- | --- | --- | --- |
| Catálogo habilitado al cliente | `POST /inbound/getcatarticulos` | `numbloque`, `registrosbloque` | `articulos[]`, `numtotalarticulos` | pp. 1-2 |
| Stock global disponible | `POST /inbound/getcatstocktotal` | Sin filtro de artículos | `articulos[]`; excluye artículos sin existencias | pp. 2-3 |
| Stock de referencias concretas | `POST /inbound/getcatstock` | `articulos: string[]` | `articulos[]`; incluye referencias sin disponibilidad | pp. 4-5 |
| Crear pedido | `POST /inbound/setcatpedido`* | `referenciapedcli`, `líneas[]` | `pedidoerp`, `numlineas`, y grupos con sufijos `2` y `3` | pp. 5-6 |
| Consultar pedido | `POST /inbound/getcatestadopedido` | `pedidocliente` o `pedidoerp` | Cabeceras y líneas de uno o varios pedidos ERP | pp. 6-8 |

\* El PDF imprime `/inbound/ setcatpedido` con un espacio. La ruta sin espacio es
una normalización propuesta que debe confirmar el proveedor, no una URL probada.

Todas las peticiones mostradas incluyen `cliente` y `psw` dentro del JSON. El PDF
indica que las credenciales se entregan por separado (p. 1). No documenta OAuth,
cabecera Bearer, claves de idempotencia, firma, cookies ni autenticación adicional.
En una integración futura las credenciales vivirán únicamente en secretos del
Worker; el navegador no debe recibirlas y los cuerpos de petición no deben
registrarse en logs.

Las respuestas de ejemplo incluyen `status: "OK"` y `message: ""`. El catálogo
de errores, los códigos HTTP y el significado de otros valores de `status` no
están documentados. Un HTTP 200 por sí solo no acredita éxito de negocio.

## Catálogo: contrato y mapeo

`getcatarticulos` devuelve exclusivamente los artículos habilitados para el
cliente. Su paginación utiliza un número de bloque y un máximo de registros por
bloque; `numtotalarticulos` informa del total (pp. 1-2). No se especifican el
primer bloque (0 o 1), el máximo de registros, la estabilidad de la ordenación,
un cursor, filtros por fecha ni la garantía de una instantánea consistente.

| Campo externo | Significado confirmado | Destino o tratamiento propuesto |
| --- | --- | --- |
| `codigo` | Código interno del proveedor | Identificador estable; corresponde a `supplier_sku`. No convertir a número. |
| `descripcion` | Descripción del artículo | Nombre original del artículo. El título comercial y el texto largo se enriquecen por separado. |
| `precio` | Precio decimal | Conservar separado del precio de venta; convertir a céntimos con aritmética decimal cuando estén confirmadas moneda y reglas de redondeo. |
| `descuento` | Descuento; ejemplo `-N` | Conservar el valor recibido. No asumir signo, porcentaje ni fórmula. |
| `pvp` | PVP decimal | Conservar como PVP del proveedor; no convertir automáticamente en precio tachado/promoción. |
| `marca` | Marca | `brand`, tras normalizar espacios y validar longitud. |
| `iva` | IVA | Validar contra la política fiscal acordada; la demo admite 0, 4, 10 y 21. |
| `encargo` | Artículo de encargo | Metadato y regla comercial pendiente; el PDF no enumera valores. |
| `categoria1`, `categoria2`, `categoria3` | Categorías del artículo | Conservar los tres campos y mapear a la taxonomía de cada canal. El orden jerárquico no está definido formalmente. |
| `indicaciones`, `posologia`, `composicion`, `contraindicaciones` | Información del artículo | Conservar por campo; no inventar indicaciones ni sustituirlas por texto generado. El surtido demo excluye medicamentos. |
| `imagen` | Imagen con formato HTTPS | Recurso original del proveedor, sujeto a permisos y validación de URL; la demo solo admite imágenes locales bajo `/images/`. |
| `roturastocklab` | Rotura de stock del laboratorio | Conservar como señal de disponibilidad; ejemplo `NO`, resto del catálogo de valores pendiente. |
| `codigoobsoleto` | Código antiguo | Tabla de correspondencias históricas. No sustituir el identificador vigente ni crear duplicados. |
| `codigobarra` | Varios códigos separados por comas | Separar, recortar espacios, deduplicar y validar cada GTIN como cadena. Elegir el correspondiente a la unidad de venta antes de publicar. |

El PDF no aporta `slug`, SKU de nuestra plataforma, estado comercial activo,
moneda, dimensiones, peso, contenido/unidad de venta, variantes, idiomas ni
marcadores de baja del catálogo. Son datos que la plataforma debe crear,
enriquecer o confirmar por otro contrato. Un código desaparecido de un bloque
aislado no equivale a una baja.

### Precios

No está confirmado si `precio` es tarifa, coste neto o importe final; tampoco si
incluye IVA, qué moneda emplea ni cómo aplicar `descuento` (pp. 1-2). Por ello el
adaptador futuro no debe copiar `precio` directamente a `products.price_cents`.
Se necesitan campos de coste y una política explícita de PVP por canal que
considere portes, impuestos y comisiones. Los pedidos conservarán un snapshot
inmutable del precio de venta aceptado y del coste previsto. Los cálculos internos
continuarán usando céntimos enteros.

## Stock: dos consultas con semántica distinta

La respuesta de stock contiene (pp. 3-5):

| Campo | Significado | Normalización propuesta |
| --- | --- | --- |
| `codigo` | Código del artículo | Cadena, relación con catálogo. |
| `stock` | Etiqueta de disponibilidad principal | Texto informativo; no es una cantidad. |
| `stocknum` | Cantidad del almacén principal | Entero validado; los ejemplos lo representan entre comillas. |
| `stockbackup` | Etiqueta de disponibilidad del backup | Texto informativo, si existe ese almacén. |
| `stockbackupnum` | Cantidad del backup | Entero validado; no sumarlo sin política de cobertura acordada. |
| `roturastocklab` | Rotura de laboratorio | Conservar el valor original y confirmar valores posibles. |
| `diaslaboentest` | Días laborales estimados cuando no hay stock | Entero validado; no equivale a una fecha de entrega garantizada. |

Las etiquetas descritas son una unidad, menos de cinco, menos de veinte y
disponible. La consulta por artículos también contempla no disponible. No debe
transformarse una etiqueta como «menos de cinco» en una cantidad vendible.

`getcatstocktotal` omite los artículos con stock cero, negativo o no registrado
(p. 2). Después de obtener una respuesta global completa y válida, una referencia
conocida ausente no puede conservar indefinidamente el stock anterior: debe pasar
a cero vendible o confirmarse mediante `getcatstock`. Un timeout, error de
negocio, cuerpo truncado o respuesta inválida nunca debe interpretarse como una
instantánea vacía correcta.

`getcatstock` permite confirmar las referencias concretas de un pedido antes del
despacho, incluyendo las agotadas (p. 4). Esa comprobación no es una reserva: otra
venta puede consumir las unidades antes del alta. La integración necesita manejar
rechazos y aceptaciones parciales del proveedor.

La política propuesta para publicar disponibilidad es:

```text
stock vendible = máximo(0,
  stock de almacenes habilitados
  - compromisos locales todavía no reflejados en el stock remoto
  - margen de seguridad configurado)
```

No hay confirmación documental del momento en que el proveedor descuenta o reserva
las unidades, de la latencia de sus consultas ni de una fecha de instantánea.
Hasta acordar esta semántica no se debe liberar el compromiso local solo porque
el alta devolvió un identificador: eso puede reponer unidades ya vendidas. La
evidencia debe persistirse por pedido, línea y cantidad para soportar parciales.

## Alta, desdoblamiento y seguimiento de pedidos

El alta transmite una referencia propia en `referenciapedcli` y una colección
llamada **`líneas`**, con tilde, según el ejemplo del PDF (pp. 5-6). Cada elemento
incluye `codart` y `cantid`; `codart` puede ser código de proveedor o EAN y
`cantid` aparece como cadena. Se propone usar siempre el código de proveedor
para evitar ambigüedad entre varios códigos de barras del mismo artículo.

El cuerpo documentado **no contiene destinatario, dirección, teléfono, correo,
código postal, país, transportista, servicio ni instrucciones de entrega**.
Esto impide afirmar que el contrato proporcionado permite dropshipping al cliente
final. El proveedor debe confirmar cómo asociar cada pedido a un destino variable,
si dispone de otra operación de entrega o si el contrato solo expide a un destino
fijo de la cuenta. No hay que añadir campos inventados y confiar en que los acepte.

Una referencia de cliente puede generar varios pedidos ERP por almacén, stock o
tipo de artículo (pp. 5-6). La respuesta muestra hasta tres grupos:

```text
pedidoerp / numlineas
pedidoerp2 / numlineas2
pedidoerp3 / numlineas3
```

No se indica si tres es un máximo contractual ni cómo se representan los grupos
ausentes. `numlineas` es número de líneas, no número de unidades. El alta no
incluye un reparto de cantidades por línea: hay que conciliarlo con la consulta
de estado. El esquema interno debe permitir una relación de un pedido comercial
con varios pedidos ERP y varias expediciones.

La consulta `getcatestadopedido` acepta la referencia propia (`pedidocliente`,
equivalente a `referenciapedcli`) o el identificador ERP (`pedidoerp`). La primera
puede devolver varios pedidos; la segunda únicamente el pedido indicado (pp. 6-7).
El ejemplo incluye ambos campos, pero no especifica precedencia, omisión o valor
vacío cuando solo se utiliza uno: se debe confirmar antes de programar el cliente
HTTP. La respuesta repite grupos `pedidocliente`, `pedidoerp`, `estado`, `lineas`
con sufijos `2` y `3` (pp. 7-8).

### Estados documentados

| Código | Cabecera | Línea | Interpretación interna segura |
| --- | --- | --- | --- |
| `V` | Pendiente de producción | Pendiente de producción | Aceptado/en espera del proveedor; no enviado. |
| `S` | Producido por completo | Línea producida | Producción completada; no prueba por sí sola la expedición ni la entrega. |
| `P` | Producido parcialmente | Línea producida parcialmente | Conservar cantidades pendientes y producidas. |
| `E` | Con error | Línea con error | Incidencia que necesita conciliación; no implica anulación automática. |

Por línea se reciben `codigo`, `descripcion`, `estado`, `canped` (cantidad
pedida), `canser` (cantidad producida), `albaran` y `numexp` (expedición de
transporte) (p. 7). No existen en este documento fecha del evento, transportista,
URL de seguimiento, entrega confirmada, motivo de error, cancelación, devolución
ni reembolso. `numexp` se conserva como identificador de expedición; no se debe
presentar como URL de tracking ni asumir su compatibilidad con un marketplace.

La plataforma debe informar al hub de cantidades efectivamente expedidas por
línea conforme al contrato logístico acordado. Recibir `S`, un albarán o el primer
pedido ERP completado no permite marcar el pedido comercial completo como
enviado si quedan unidades o subpedidos pendientes.

### Idempotencia y resultados inciertos

El PDF no garantiza que repetir `referenciapedcli` devuelva el mismo pedido, ni
que la consulta por referencia tenga consistencia inmediata. La referencia es
una correlación documentada, no una garantía de deduplicación remota.

Flujo propuesto para una integración futura:

1. Persistir la intención de despacho con referencia estable, hash del contenido,
   líneas, cantidades y estado; un solo ejecutor puede tramitar esa intención.
2. Consultar disponibilidad y aplicar las reglas comerciales antes de enviar.
3. Registrar los pedidos ERP aceptados y conciliar sus líneas con el pedido
   original. No marcar una aceptación parcial como aceptación completa.
4. Ante timeout o respuesta ambigua después del envío, marcar resultado incierto
   y consultar por `pedidocliente`. No repetir automáticamente el alta.
5. Reintentar el alta solo con la garantía contractual de idempotencia o evidencia
   acordada de que la primera solicitud no creó pedidos. La ausencia temporal
   de resultados no demuestra por sí sola que el pedido no exista.
6. Consultar periódicamente el estado con límites y backoff acordados, guardando
   cantidades, expediciones e incidencias sin sobrescribir información más nueva
   con una respuesta anterior.

Los reintentos de consulta pueden ser automáticos. Los de alta requieren una
política distinta por su efecto de crear pedidos. Los POST de consulta y los
POST de alta no deben compartir indiscriminadamente la misma política.

## Encaje con la demo existente

Esta tabla audita el puerto y la composición de simulación; no describe un
adaptador HTTP real desplegado.

| Área | Implementación demo auditada | Diferencia que hay que resolver para producción |
| --- | --- | --- |
| Composición | `src/lib/demo.ts` instancia `MockSupplierAdapter` | Inyectar un adaptador HTTP en una composición separada y autorizada; cambiar flags no basta. |
| Puerto | `src/integrations/supplier-adapter.ts` | El contrato normalizado necesita líneas, varios pedidos ERP, almacenes y expediciones. |
| Catálogo | El mock entrega `SupplierProduct[]` completo con stock | El proveedor separa catálogo paginado y consultas de stock. |
| Campos | Un `ean`, una categoría, imagen local, sin atributos de encargo | Conservar códigos múltiples, categorías y metadatos externos en el modelo de importación. |
| Importes | `price_cents` se usa como PVP de tienda y `discount` se limita a 0-100 | Confirmar coste, IVA, moneda y descuento externo antes de mapear. |
| Idempotencia | Referencia única y `creation_token` en `supplier_orders` | La garantía del mock es local; no demuestra idempotencia del ERP. |
| Stock comprometido | Descuento remoto atómico en D1 y `supplier_stock_committed` | Registrar evidencia remota por cantidad y conciliación de instantáneas. |
| Pedido remoto | Un `supplier_order_id` por pedido comercial | Persistir todos los pedidos ERP y su correspondencia por línea. |
| Parciales | Expediciones con unidades por referencia; pedidas, expedidas y pendientes por línea | Mapear `canped`, `canser`, albarán y `numexp` reales; la demo no distingue producido de expedido. |
| Cancelación | `cancelOrder` anula un pedido sin expediciones y repone sus unidades | El PDF no documenta ninguna operación de cancelación: hay que acordar canal, plazos y quién libera la reserva. |
| Seguimiento | `advanceOrder` y `shipOrder` inventan expediciones y trackings demo | Consultar estados del ERP; retirar el avance manual del entorno real. |
| Estado enviado | El mock tiene `shipped` explícito | No mapear el código externo `S` directamente a `shipped`. |
| Cron | Despacho agrupado preparado, no activado en el despliegue auditado | Programar y observar importación, conciliación de estados y envío de actualizaciones al hub. |

Los endpoints internos `/api/supplier/*` permiten controlar la simulación;
**no son un proxy ni reproducen literalmente `/inbound/*`**. La API interna de
alta requiere un `order_id` existente y pagado para conservar la validación del
servidor. Esta protección debe mantenerse aunque cambie el transporte externo.

### Normalizador de contrato implementado

[`src/integrations/supplier-api-contract.ts`](../src/integrations/supplier-api-contract.ts)
incorpora funciones puras para validar respuestas ya recibidas. No tiene `fetch`,
credenciales ni conexión con la composición de la demo. Es una base verificable
para el adaptador futuro, y no una integración real habilitada.

| Función | Comportamiento implementado |
| --- | --- |
| `supplierAmountToCents` | Convierte la representación decimal mediante enteros `BigInt`, sin multiplicación binaria ni redondeo implícito. Rechaza negativos, comas, notación exponencial, más de dos decimales y desbordamientos. |
| `splitSupplierBarcodes` | Separa y deduplica cadenas preservando ceros iniciales. No certifica GTIN ni elige uno como principal. |
| `normalizeSupplierCatalogResponse` | Valida el bloque y total; conserva precios del proveedor, descuento y metadatos sin aplicar una política de PVP. |
| `normalizeSupplierStockResponse` | Separa cantidad cero, backup ausente y códigos omitidos. Acepta el alias editorial `stockum`, rechazándolo si contradice `stocknum`. |
| `normalizeSupplierOrderCreation` | Conserva identificadores ERP y números de líneas en grupos independientes. |
| `normalizeSupplierOrderStatus` | Conserva estados de producción y cantidades/expediciones por línea, incluso cuando varios pedidos contienen el mismo producto. Nunca produce un estado de envío o entrega. |

Las funciones exigen el sobre `status: "OK"` y `message` textual antes de aceptar
una respuesta. Los errores no reproducen el cuerpo remoto. Los metadatos
opcionales ausentes quedan como `null`; una cantidad explícita mal formada no
se convierte a cero. Los precios normalizados no incluyen una afirmación de
moneda ni de IVA. Si el transporte convierte JSON numérico antes de normalizar,
no es posible recuperar precisión ya perdida: para importes extensos se necesita
preservar el decimal original como cadena.

Los grupos ERP adicionales al tercero se rechazan expresamente para evitar
descartarlos en silencio hasta confirmar el límite con el proveedor. Los grupos
incompletos, IDs duplicados, referencias mezcladas, cantidades producidas mayores
que las pedidas y estados desconocidos también requieren conciliación.

[`tests/supplier-api-contract.test.ts`](../tests/supplier-api-contract.test.ts)
verifica estos comportamientos con 14 pruebas y datos sintéticos. La comprobación
del módulo se ejecuta con:

```sh
pnpm exec vitest run tests/supplier-api-contract.test.ts
```

## Erratas y ambigüedades del PDF

| Hallazgo | Página | Tratamiento |
| --- | --- | --- |
| `stockum` en el primer ejemplo de stock por artículos; `stocknum` en los demás | 4-5 | Confirmar la clave real. Si se admite alias, rechazar valores contradictorios cuando aparezcan ambas. |
| Espacio dentro de la ruta de alta | 5 | Confirmar `/inbound/setcatpedido`. |
| `líneas` con tilde al crear; `lineas` sin tilde al consultar | 5, 7-8 | Conservar la diferencia en el contrato y validarla con el proveedor. |
| Comillas tipográficas, `...`, marcadores no JSON y un `13` aislado | 3-6, 8 | Son ejemplos editoriales; no usarlos como fixtures JSON sin normalización explícita. |
| Descuento ilustrado como `-N` | 2 | No deducir signo ni fórmula comercial. |
| Grupos de pedido con sufijos hasta `3` | 6-8 | Confirmar máximo, omisión, nulos y campos vacíos. |

## Información necesaria del proveedor

Bloquea la integración real de extremo a extremo:

1. Nombre del servicio, URL base HTTPS, versión, entorno de pruebas y credenciales
   de prueba por un canal seguro.
2. Contrato de entrega a destinatarios variables: campos, alta de direcciones,
   vinculación con el pedido, países y cobertura, embalaje y documento de entrega.
3. Garantías de idempotencia, consulta por referencia tras timeout y momento
   exacto de reserva/descuento de stock.
4. Significado de `precio`, `descuento` y `pvp`, moneda, IVA incluido o excluido,
   portes y facturación al intermediario.
5. Reparto de cantidades entre pedidos ERP, límite de subpedidos y semántica de
   expedición completa/parcial; transportistas y seguimiento aceptables al hub.
6. Primera página, límites de paginación y listas, orden estable, errores,
   límites de llamadas, timeouts y ventanas de mantenimiento.
7. Bajas de catálogo, obsolescencia, múltiples EAN/unidades de venta, uso de
   imágenes y catálogo elegible para cada marketplace.
8. Cancelaciones, sustituciones, devoluciones, incidencias y conciliación de
   cantidades/costes posteriores a la aceptación.

## Casos mínimos para certificar un futuro adaptador

Los siguientes casos son criterios de aceptación propuestos, no pruebas de que
la conexión real exista:

- Importación con varias páginas, códigos duplicados, última página incompleta y
  error intermedio sin borrar catálogo correcto.
- Instantánea global con un artículo que pasa a cero, respuesta global fallida,
  consulta puntual sin stock y stock numérico mal formado.
- Stock backup disponible con principal agotado y almacén backup no habilitado
  para el canal; compromisos locales conservados durante una respuesta antigua.
- Importes con decimales, descuento negativo, moneda/IVA pendientes y varios EAN
  sin seleccionar automáticamente una unidad de venta equivocada.
- Alta con un pedido ERP, con varios, con rechazo parcial y con timeout después
  de aceptación; el reintento no genera pedidos duplicados.
- Dos pedidos ERP que comparten un producto, producción parcial y varias
  expediciones; las cantidades no se pierden ni se contabilizan dos veces.
- Estado `S` sin expedición que permanece sin anunciar como enviado; incidencia
  en una línea aunque otra se haya producido correctamente.
- Mensajes inválidos o referencias desconocidas que quedan en conciliación, sin
  alterar pedidos ajenos ni publicar stock/precios corruptos.
- Ninguna credencial en respuestas al navegador, logs, fixtures o repositorio;
  todas las mutaciones de esta demo siguen exigiendo ambos flags de demostración.

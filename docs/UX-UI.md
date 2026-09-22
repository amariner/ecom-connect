# Portada y panel: criterios de UX y UI

Esta revisión del 22 de septiembre de 2026 amplía el descubrimiento de productos
en la portada y reduce la densidad inicial del panel. La información de operación
queda visible; las opciones de configuración, simulación y diagnóstico se abren
cuando hacen falta. Se mantiene la identidad FarmaHouse y su gama de verdes.

El alcance es de presentación y navegación. Los productos, pedidos, selecciones,
precios, reservas e historial siguen usando los mismos contratos y datos. Esta
pasada no requiere migraciones, no conecta cuentas externas y no cambia las
condiciones de la demo: proveedor y marketplaces simulados, sin cobros ni emails.

## 1. Portada: campañas y descubrimiento

### Hero de campañas

El carrusel abre la portada con tres escenas de campaña: cuidado facial, madre
y bebé, y sonrisa. Las fotografías con personas sustituyen la composición de
productos y precios del hero. Cada llamada a la acción conduce a su categoría
real del catálogo: `facial`, `bebe` o `bucodental`.

- Las imágenes tienen variantes de 1400 y 700 píxeles mediante `srcset`.
- La primera escena carga con prioridad alta; las demás usan carga diferida.
- Se conservan los tres selectores, los botones anterior/siguiente, el contador
  y el control de pausa. El avance automático tiene un intervalo de 7 segundos.
- Al interactuar manualmente con una escena, el carrusel queda pausado. También
  se detiene temporalmente con el puntero o el foco dentro, o al ocultar la pestaña.
- La preferencia de movimiento reducido desactiva el avance automático inicial
  y las animaciones. La selección manual continúa disponible.
- Hay un título principal accesible y un anuncio de la escena elegida manualmente;
  el cambio automático no va narrando cada fotografía al lector de pantalla.

Los assets de campaña son sintéticos y no representan testimonios de clientes.
La procedencia y los prompts se explican en [Imágenes y campañas](IMAGENES.md).
Las fotografías originales de los productos siguen independientes del hero.

### Dieciocho accesos a categorías

«¿Por dónde empezamos?» mantiene 18 accesos circulares: las 12 familias principales
y seis accesos a maquillaje, higiene íntima, cuidado ocular, vitaminas y minerales,
nutrición deportiva y descanso. Los enlaces aplican la categoría correspondiente
en la tienda. El megamenú conserva las familias y las subcategorías ya importadas.

### Doce productos, repartidos por intención

La portada pasa de cuatro tarjetas a un máximo de doce. Con el catálogo actual
hay una referencia de cada familia principal, en tres bloques de cuatro:

| Bloque | Categorías incluidas | Lugar en la portada |
| --- | --- | --- |
| Tu rutina de cada día | Facial, dermocosmética, capilar y bucodental | Después de los accesos a categorías |
| Cuidado para toda la familia | Bebé, maternidad, higiene y bienestar | Después del primer bloque de productos |
| Bienestar que te acompaña | Nutrición, solares, ortopedia y veterinaria | Después de las dos campañas intermedias |

La selección se calcula en el servidor al generar la página:

1. Se parte del catálogo activo y se priorizan las referencias con URL de origen
   público. Solo se usa el catálogo de ejemplo como alternativa si no existe
   ninguna referencia pública activa.
2. Las tarjetas requieren stock mayor que cero. Esto utiliza las existencias de
   la demo; no equivale a comprobar disponibilidad en la tienda de origen.
3. Se elige una referencia por categoría y se intenta variar las marcas dentro
   de cada bloque. Un conjunto de identificadores impide duplicados en la portada.
4. Si una familia no tiene productos elegibles, se omite esa tarjeta y su acceso
   dentro del bloque. Si el bloque queda vacío, se omite entero. No se inventan
   referencias ni se fuerzan doce tarjetas con productos agotados.

Los bloques incluyen una descripción corta, accesos a las categorías presentes
y «Ver catálogo». Los nombres de sección son editoriales: no afirman rankings de
ventas, descuentos nuevos ni popularidad medida. Las tarjetas reutilizan el precio,
la imagen y las acciones del componente compartido `ProductCard.astro`. La
validación definitiva de stock y totales al comprar sigue siendo del servidor.

### Lectura en escritorio, tablet y móvil

En escritorio se muestran cuatro columnas; hasta 900 píxeles pasan a dos. Hasta
580 píxeles cada bloque utiliza un carril horizontal nativo con una parte de la
siguiente tarjeta visible y una indicación de desplazamiento. Así, la ampliación
de surtido no convierte el móvil en una lista vertical de doce tarjetas completas.
No se añade un segundo carrusel JavaScript para estos productos.

Los nombres conservan su contenido, los precios y botones quedan alineados al pie
de cada fila y las áreas de añadir tienen al menos 42 píxeles. Las imágenes de
producto se muestran completas, con `object-fit: contain`; no se recorta el envase
para llenar la tarjeta. Los márgenes entre bloques son de 64 píxeles en escritorio
y 40 en móvil. Los estilos están acotados a `.home-product-collection` para no
cambiar la rejilla de la tienda ni la ficha de producto.

## 2. Navegación y lenguaje del panel

El menú principal conserva Vista general, Productos y Pedidos. Integraciones
contiene Proveedor y un único acceso **Marketplaces**. Se elimina el acceso lateral
duplicado «Canales de venta», pero se conserva su ruta y su funcionalidad de
selección de surtido y simulación de pedidos.

**Configuración** queda en la parte inferior de la barra y **Guía y documentación**
se presenta debajo como botón diferenciado. El usuario puede consultar la ayuda
desde cualquier pantalla; ya no hace falta repetir «Guía de la demo» en la cabecera
de Vista general.

Se retiran del menú «Entorno de demostración», «Explora, conecta y prueba. Sin
operaciones reales.» y el bloque «Espacio de demostración», con sus adornos y
separadores asociados. El espacio liberado permite agrupar la navegación sin un
panel informativo adicional. Permanecen las indicaciones de simulación donde
explican una acción, una estadística o la conexión de un servicio.

Los enlaces existentes continúan funcionando:

| Acceso | Ruta | Función |
| --- | --- | --- |
| Vista general | `/admin` | Estado de la operación y pedidos por origen |
| Productos | `/admin/productos` | Buscar, filtrar y consultar el catálogo |
| Pedidos | `/admin/pedidos` | Historial y envío al proveedor |
| Proveedor | `/admin/integraciones/proveedor` | Vincular catálogo, sincronizar y probar cambios |
| Marketplaces | `/admin/integraciones/lighthouse` | Canales, estadísticas, sincronización y feeds |
| Productos y pedidos por canal | `/admin/marketplaces` | Surtido y simulación específicos de cada marketplace |
| Configuración | `/admin/configuracion` | Ajustes de envío al proveedor |
| Guía y documentación | `/admin/documentacion` | Índice de documentación |

La ruta histórica que contiene `lighthouse` se mantiene para preservar enlaces.
Lighthouse continúa identificando al servicio de distribución y a su feed; no
se confunde el nombre del proveedor técnico con el título de toda la pantalla.

## 3. Ritmo visual y márgenes del panel

`src/styles/admin-refinements.css` concentra el espaciado compartido. Se importa
desde el layout del panel y no afecta a la tienda. Los componentes conservan sus
rejillas internas y sus estados, pero comparten alineación exterior:

| Variable | Escritorio | Hasta 680 px | Hasta 380 px |
| --- | --- | --- | --- |
| `--admin-gutter` | `clamp(20px, 2.25vw, 36px)` | 18 px | 14 px |
| `--admin-section-gap` | 24 px | 20 px | 20 px |
| `--admin-card-padding` | 24 px | 18 px | 16 px |

La cabecera, el contenido y el pie usan la misma referencia lateral. El contenedor
del panel organiza sus hijos con `gap` y elimina sus márgenes verticales externos
para evitar sumar separaciones de dos componentes contiguos. Las tarjetas comparten
relleno y cabeceras de altura mínima; los controles y títulos pueden pasar a una
nueva línea sin invadir las acciones de la derecha.

En móvil, las cabeceras reducen su relleno vertical a 16 píxeles, los títulos se
ajustan a 26 píxeles —24 en pantallas muy estrechas— y las acciones principales
tienen al menos 44 píxeles de alto. Las cifras usan dígitos de ancho uniforme para
evitar cambios de alineación cuando se actualizan los contadores. Las fechas tienen
un tamaño propio para no competir con una cifra de productos o pedidos.

## 4. Vista general, catálogo y proveedor

### Vista general

Se mantienen las dos tarjetas que separan **Pedidos de la web** y **Pedidos de
marketplaces**, la actividad por fecha, las incidencias y el esquema de conexiones.
Se retira la tabla general de «Últimos pedidos», que repetía pedidos ya visibles
en esas tarjetas. El historial completo sigue en Pedidos y los enlaces por origen
continúan disponibles.

«Actividad reciente» ocupa todo el ancho disponible y deja de compartir fila con
la tabla retirada. La actualización de las cifras y la actividad continúa siendo
una consulta a la API de la demo, con la frecuencia y el tratamiento de desconexión
ya documentados. No representa una conexión con cuentas externas en tiempo real.

### Productos

La tabla de catálogo tiene altura limitada y cabecera fija dentro de su área de
desplazamiento. Esto permite consultar un catálogo grande sin alejar indefinidamente
los filtros del encabezado de la página. La barra conserva búsqueda, categoría,
estado y stock, y la ayuda explica el desplazamiento horizontal de las columnas.
Los campos editables de móvil se muestran a 16 píxeles para facilitar lectura y
entrada de datos.

### Proveedor

El selector de catálogo sigue siendo la acción principal: distingue productos
visibles, sin vincular y vinculados pendientes de sincronización. El recorrido
continúa siendo **seleccionar → vincular → sincronizar**. No se cambia la regla
que mantiene las referencias sin vincular fuera de la tienda.

Las herramientas para simular cambios de stock y precio pasan a un acordeón
secundario. Al abrirlo se conservan la consulta de disponibilidad, la comparación
de precios y sus formularios. Su estado abierto o cerrado se mantiene durante
los refrescos del panel en la misma página. No es una preferencia persistida en D1
ni una promesa de restauración después de cerrar el navegador.

## 5. Pedidos y envío al proveedor

En Pedidos, la configuración de sincronización se presenta cerrada como acordeón,
con el título y el modo Manual/Automática visibles. Al abrirla están disponibles
el interruptor general, el envío inmediato, los horarios y cantidades, «todos los
pendientes», el empaquetado y la opción de datos de cliente. Configuración mantiene
el acceso completo a esos mismos ajustes.

El historial «Últimos envíos al proveedor» también se pliega en Pedidos y
Configuración. El resumen muestra la última ejecución y el estado o la cantidad
de ejecuciones con incidencias, aunque la tabla esté cerrada. Al desplegarlo aparecen
las cinco últimas ejecuciones con inicio, resultado, enviados, errores y pendientes.
El plegado reduce altura inicial sin ocultar la existencia de un problema.

Los acordeones auxiliares del panel conservan su apertura cuando una acción
actualiza el contenido en la misma página. La revisión no cambia el bloqueo de
concurrencia, los reintentos ni los mensajes que se envían al proveedor simulado.
Las reglas de envío y la limitación del cron de producción siguen descritas en
[Horarios y sincronización de pedidos](SINCRONIZACION.md).

## 6. Marketplaces y feeds

### Orden de lectura

La pantalla principal se organiza en cuatro niveles:

1. **Canales de destino.** Amazon, Miravia, Carrefour y eBay muestran pedidos,
   productos publicados y estado de stock. Los pendientes de proveedor conservan
   su enlace directo. «Gestionar productos y pedidos» lleva a la pantalla por canal.
2. **Pedidos de marketplaces.** Totales, importe simulado, importe medio y
   pendientes quedan visibles. La gráfica de siete días se abre bajo demanda.
3. **Sincronización.** Interruptor automático/manual, intervalo, guardado y acción
   manual, seguidos del último resultado y el estado del ejecutor.
4. **Feeds de productos.** Tres selectores independientes, inicialmente plegados,
   con nombre, cantidad publicable y modo de selección.

La cabecera incluye «Gestionar feeds» como salto interno. La conexión simulada a
través de Lighthouse se explica una vez debajo de los canales, evitando repetir
la misma explicación en cada tarjeta.

### Sincronización: resultado visible y detalle opcional

El modo y las acciones habituales quedan agrupados. El intervalo de revisión se
desactiva visualmente cuando se trabaja en manual; la configuración sigue guardándose
de forma explícita. El texto de ayuda cambia con el modo elegido.

La última fecha y el resultado permanecen visibles. Si existe un error de la
última ejecución, aparece fuera del detalle plegado. El acordeón «Detalle de la
sincronización» contiene catálogo/stock/precios, pedidos, transportistas, ventas web
y estados/seguimiento, con cantidades y resultado de cada paso.

El sondeo periódico conserva la apertura del detalle y el foco de su cabecera.
Las actualizaciones completas tras una acción también conservan la apertura del
gráfico y del detalle operativo. Los nombres
técnicos del contrato se consultan en la documentación de integración; la operación
diaria usa etiquetas comprensibles. El estado del ejecutor sigue distinguiendo un
guardado de configuración de la disponibilidad efectiva de la tarea programada.

### Selección de productos y URL de cada feed

Cada acordeón reúne su URL de solo lectura, «Abrir XML» y el selector correspondiente:

| Destino | URL |
| --- | --- |
| Lighthouse | `/feeds/lighthouse.xml` |
| Google Merchant Center | `/feeds/google.xml` |
| Meta | `/feeds/meta.xml` |

El resumen permite distinguir «Automático», «Selección manual» y «Sin guardar» sin
abrir la tabla. Automático en este selector significa **incluir todos los productos
elegibles, también los futuros**; es una opción de surtido distinta del interruptor
de sincronización automática del hub.

Al desplegar un destino se mantienen búsqueda, familia/subcategoría, estado, marca,
disponibilidad, orden, selección de página o resultados y paginación. Las tablas
del selector tienen cabecera fija y altura máxima de 610 píxeles —520 en móvil—.
Las acciones quedan al pie; en móvil abandonan la posición adherida para no tapar
filas y controles.

Cada selección se guarda de forma independiente. Una selección manual vacía sigue
siendo válida, y guardar un destino conserva los borradores de los demás durante
la sesión de página. Los productos publicables dependen de la elegibilidad real
de la demo: para un marketplace, producto activo, incluido en Lighthouse e incluido
en su propia selección. El diseño compacto no cambia estas condiciones.

La pantalla `/admin/marketplaces` conserva sus cuatro selectores y los formularios
para simular pedidos. Un enlace «Volver a Marketplaces» devuelve al resumen central.
Los intentos pendientes de confirmación y sus mensajes de recuperación permanecen
visibles; no se ocultan dentro de los acordeones de catálogo.

## 7. Accesibilidad y estados de interacción

- Los desplegables usan `details` y `summary`, con comportamiento nativo de teclado
  y estado expandido accesible. El foco visible también se aplica a las cabeceras.
- Las flechas de apertura son decorativas; el título de cada control describe su
  contenido. El estado de conexión, guardado o error incluye texto, además del color.
- Las regiones de tabla tienen nombre accesible y pueden recibir foco para su
  desplazamiento. Las casillas de selección identifican el producto correspondiente.
- El selector anuncia el recuento de resultados y la confirmación, sin volver a
  anunciar la tabla completa en cada pulsación. Las flechas permanecen visibles
  cuando cambia el texto de resumen. El gráfico tiene una descripción accesible
  con los valores diarios y su escala usa únicamente los canales representados.
- Los formularios conservan etiquetas, estados deshabilitados y mensajes de
  confirmación o error anunciados. Las incidencias importantes no dependen de abrir
  un bloque secundario para saber que existen.
- El menú móvil mantiene cierre con Escape, control del foco, fondo inerte y
  devolución del foco al botón de apertura. La ayuda permanece dentro del menú.
- Las transiciones decorativas respetan `prefers-reduced-motion`. El movimiento
  no sustituye a un dato de última sincronización ni demuestra actividad externa.
- Los errores de red no deben sustituir las últimas cifras por ceros que aparenten
  un estado válido. Se mantienen los avisos y los mecanismos existentes de reintento.

## 8. Archivos responsables

| Archivo o grupo | Responsabilidad |
| --- | --- |
| `src/pages/index.astro` | Selección de productos, bloques y accesos de portada |
| `src/styles/home-products.css` | Rejillas, carriles móviles y alineación de tarjetas |
| `src/components/shop/HomeHero.astro`, `home-hero.ts`, `src/styles/home-hero.css` | Campañas, controles y movimiento del hero |
| `src/components/shop/catalog.ts`, `src/data/catalog-taxonomy.json` | Familias, subcategorías y 18 accesos |
| `src/layouts/Admin.astro` | Menú, acceso inferior a documentación y comportamiento móvil |
| `src/styles/admin-refinements.css` | Márgenes, separación compartida, tarjetas y detalles del panel |
| `src/components/admin/client.ts` | Composición de pantallas, historial plegado y conservación de apertura |
| `src/components/admin/channel-overview.ts` | Pedidos por origen y detalle de la gráfica de marketplaces |
| `src/components/admin/sync-controls.ts`, `src/styles/sync-controls.css` | Configuración y detalle de sincronización |
| `src/components/admin/catalog-selector.ts`, `src/styles/catalog-selector.css` | Selección por destino, resumen y URL de feeds |
| `src/lib/technical-docs.ts` | Registro de este documento como `ux-ui`, número 13 |

## 9. Recorridos de revisión

Esta lista define qué comprobar; no declara resultados de ejecución:

1. **Portada:** recorrer las tres campañas, pausar, navegar a sus categorías,
   contar los 18 accesos y revisar los tres bloques de productos. Comprobar que
   las referencias están activas, tienen stock y no se repiten.
2. **Compra desde portada:** añadir desde una tarjeta en una sesión de prueba
   aislada, abrir la cesta y confirmar nombre, cantidad y precio sin completar
   una operación en una cuenta real.
3. **Menú:** verificar los accesos principales, la ausencia de «Canales de venta»
   como entrada independiente y el botón inferior de documentación. Probar apertura,
   cierre y foco del menú en móvil.
4. **Vista general:** comprobar separación web/marketplaces, enlaces a pedidos,
   incidencias y actividad a todo el ancho, sin la tabla general duplicada.
5. **Productos y proveedor:** aplicar filtros, desplazar tablas, revisar cabeceras
   fijas y abrir herramientas de prueba. Confirmar que los refrescos respetan la
   apertura del acordeón y conservan los flujos de vincular/sincronizar.
6. **Pedidos y Configuración:** desplegar ajustes e historial, revisar el resumen
   de la última ejecución y comprobar que las incidencias son visibles al plegar.
7. **Marketplaces:** abrir y cerrar gráfica y detalle operativo; comprobar canales,
   enlace por canal, modos de sincronización y visibilidad de errores.
8. **Feeds:** desplegar cada destino, abrir su XML, cambiar filtros y revisar que
   el resumen representa su selección. Si se prueban guardados, usar un entorno
   de prueba y restaurar el surtido inicial al terminar.
9. **Adaptación y teclado:** revisar 320, 390, 768 y 1440 píxeles, sin desbordamiento
   de página; las tablas y carriles pueden desplazarse dentro de sus regiones.
   Recorrer controles con teclado y comprobar movimiento reducido.
10. **Documentación:** abrir `/admin/documentacion/ux-ui` desde el índice y comprobar
    navegación, tablas y enlaces cruzados.

## 10. Verificación de esta revisión

Verificación realizada el 22 de septiembre de 2026 sobre el servidor local
`http://localhost:4327` y el código de esta revisión:

| Comprobación | Resultado |
| --- | --- |
| `pnpm typecheck` | 248 archivos; 0 errores y 0 advertencias |
| `pnpm test` | 625 pruebas correctas en 35 archivos |
| `pnpm build` | Compilación de cliente y Worker completada |
| `git diff --check` | Sin errores de espacios ni conflictos de parche |
| Portada | 12 tarjetas distintas, sus 12 imágenes cargadas y 18 accesos a categorías |
| Portada adaptable | Revisión en 320, 390, 768 y 1440 px; carriles y rejillas sin desbordamiento de página |
| Tarjeta de portada | Añadir al carrito comprobado en una sesión de prueba aislada, sin completar compra |
| Vista general | Revisada a 1440 px: pedidos separados por origen y retirada de elementos duplicados |
| Pedidos | Ajustes e historial cerrados inicialmente; apertura/cierre con ratón y Enter; vista móvil a 390 px |
| Proveedor | Herramientas avanzadas cerradas al entrar, formularios visibles al abrir y sin desbordamiento a 390 px |
| Productos | Búsqueda «Bioderma»: 11 de 695 resultados; cabecera fija, tabla contenida y revisión a 320 y 390 px |
| Marketplaces y página por canal | Revisión a 320, 390, 768 y 1440 px; sin desbordamiento ni errores JavaScript |
| Feeds | Búsqueda y selección conservadas al plegar/reabrir; aviso «Sin guardar» visible en el resumen |
| Sincronización de marketplaces | Intervalo desactivado en manual y activo en automático; detalle abierto conservado durante el sondeo de 15 segundos |
| Menú móvil | A 320 px, acceso inferior a documentación y cierre con Escape devolviendo el foco al botón |
| Campos móviles | Inputs y selects de sincronización y selección comprobados a 16 px |
| Documentación | Ruta y enlace del índice operativos; página revisada a 390 y 1440 px sin desbordamiento |

Las pruebas visuales de selectores y configuración no guardaron cambios de
surtido ni ejecutaron envíos al proveedor. La conservación de los acordeones
auxiliares tras una actualización completa se revisó en el código: se recoge su
estado antes de reconstruir el panel y se restaura también el detalle del hub,
que se monta de forma asíncrona. La apertura durante el sondeo se comprobó en
navegador. No se han añadido pruebas que se limiten a repetir estilos o markup.

La publicación utiliza el Worker propio `ecom-connect` y sigue el procedimiento
de [Operación de la demo](OPERACION-DEMO.md), con comprobación pública posterior.
Los resultados anteriores corresponden a la verificación local previa. Esta
pasada de interfaz no habilita el cron de producción ni cambia su limitación
de capacidad. El historial de versiones de Cloudflare identifica el despliegue
activo y su revisión de código.

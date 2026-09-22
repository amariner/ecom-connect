# Catálogo público de FarmaHouse

La ampliación captura **650 productos** de las fichas públicas de
[farmahouse.com](https://farmahouse.com/), con nombre, marca, referencia, EAN cuando
está publicado, precio en euros, fotografía original, URL y fecha de captura.
La navegación ofrece **12 familias y 75 subcategorías con productos importados**.
Se omitieron tres categorías de la navegación de origen sin referencias disponibles.

La base local conserva además los 45 productos ficticios originales y los pedidos
existentes: **695 referencias** tras la primera carga. Las imágenes públicas se
sirven desde `public/images/products/farmahouse`; no se solicitan al comercio
original durante la navegación. El snapshot está en `seed/farmahouse-catalog.json`.
Las descripciones de la demo identifican el origen, sin copiar textos comerciales
extensos ni añadir propiedades de salud.

## Datos públicos y datos simulados

- Los precios son los observados en las fichas al capturarlas. No hay actualización
  automática desde la web externa ni garantía de precio comercial vigente.
- Cada nueva referencia recibe **24 unidades ficticias** para probar compras.
  `source_availability` guarda por separado la disponibilidad publicada; no se
  transforma en una cantidad de stock real. La ficha distingue expresamente ambos.
- El proveedor sigue siendo un mock. Sus referencias `DEMO-FH-*`, el IVA técnico
  de la simulación (21 %), los pedidos, pagos, envíos y marketplaces son ficticios.
- Se conservan las URLs, referencias y fechas de origen en columnas separadas.
  La sincronización del proveedor demo no elimina esa procedencia.

## Reproducir la carga local

```sh
pnpm catalog:import
```

Aplica las migraciones locales, valida el snapshot, genera `seed/farmahouse.sql`
y carga productos, variantes, saldos, movimientos iniciales y proveedor demo.
`INSERT OR IGNORE` conserva precios, existencias y pedidos al repetir la carga.
La prueba de integración confirma que una compra sigue descontada al reimportar.
El comando **no accede a la base de producción**.

Después, «Sincronizar ahora» en el panel actualiza el feed y las publicaciones
simuladas con el catálogo completo. Esta sincronización sigue siendo local al
entorno de demo en el que se ejecute.

## Volver a capturar las fichas públicas

```sh
python3 -m pip install -r scripts/catalog/requirements.txt
pnpm catalog:scrape
pnpm catalog:import
```

El capturador usa las categorías públicas de `src/data/catalog-taxonomy.json`,
selección repartida entre familias y datos estructurados Product/Offer. Opera con
un máximo de tres solicitudes simultáneas, pequeñas pausas, timeout y reintentos
limitados. No inicia sesión, no entra en cuentas ni realiza escrituras externas.
La caché en `tmp/farmahouse` permite reanudar sin repetir descargas. Para una nueva
captura temporal se debe apartar esa caché; las fechas reflejan cuándo se descargó
cada ficha, incluso al reutilizarla. La reimportación no actualiza deliberadamente
los precios o stocks ya gestionados por la demo.

La captura rechaza precios inválidos, referencias duplicadas, imágenes sin formato
reconocido y URLs fuera de `farmahouse.com`. No sustituye el snapshot si quedan menos
de 500 referencias válidas. Algunos productos pueden pertenecer a varias categorías.

## Navegación y movimiento

La tienda pagina en grupos de 24 y conserva búsqueda, marca, categoría y orden en
la URL. Cada enlace de subcategoría filtra las referencias capturadas en esa familia.
El hero alterna tres campañas con fotografía de contexto: cuidado facial, bebé e
higiene bucodental. Sus enlaces llevan a las categorías, con controles manuales y
pausa. Respeta reducción de movimiento, foco y pestaña oculta. Las fotografías de
campaña son generadas; su procedencia figura en [Imágenes](IMAGENES.md).

La portada muestra hasta doce productos distintos del catálogo activo y con stock,
repartidos entre rutina diaria, familia y bienestar. Prioriza el catálogo público
capturado y adapta las categorías visibles a la disponibilidad. Los criterios de
selección y el comportamiento móvil están en [Experiencia y diseño](UX-UI.md).

El esquema del panel anima por separado catálogo y pedidos. El movimiento es
visual: no dispara consultas. El estado se carga al entrar o al pulsar
«Actualizar datos». Si la consulta falla conserva las últimas cifras y muestra
el aviso. No hay polling periódico; véase [Uso de D1](USO-D1.md).

## Verificación

```sh
pnpm check
DEMO_URL=http://localhost:4327 EXPECTED_PRODUCTS=695 node scripts/verify-public.mjs
```

El valor esperado sirve para esta primera carga; si el catálogo cambia de manera
intencionada, indicar la cantidad correspondiente. El verificador admite las
imágenes originales importadas y comprueba la procedencia, todas las fichas,
los enlaces, los archivos de imagen y la coherencia de los feeds.

## Selección de surtido y feeds

La migración `0056_catalog_selections.sql` prepara las 650 referencias públicas con 500 visibles y 150 sin vincular. Se conservan además las 45 referencias ficticias originales. Las fichas de las 150 referencias quedan inactivas, manteniendo sus identificadores, procedencia e historial de inventario; no aparecen en la tienda ni pueden comprarse. Los disparadores aplican la misma preparación si se importa el catálogo después de migrar. Repetir la importación no deshace una vinculación posterior.

En **Integraciones → Proveedor**, filtra por nombre, marca, SKU/EAN, categoría o subcategoría, stock y estado. Puedes seleccionar una página o todos los resultados filtrados. **Vincular seleccionados** guarda la vinculación; **Sincronizar vinculados** activa las fichas y actualiza sus precios y stock. La sincronización ordinaria omite las referencias sin vincular. La vinculación es aditiva e idempotente y conserva las referencias ya vinculadas.

En **Integraciones → Marketplaces**, dentro de «Feeds de productos», hay tres
selecciones independientes que se despliegan al pulsar su cabecera:

- `/feeds/lighthouse.xml`: surtido de Lighthouse (los antiguos `/feeds/products.xml` y `/api/feeds/products.json` conservan esta misma selección).
- `/feeds/google.xml`: surtido para Google Merchant Center.
- `/feeds/meta.xml`: surtido para Meta.

Los tres XML usan RSS con atributos de catálogo Merchant: identificador, título, descripción, URL, imagen, precio EUR, disponibilidad, marca, GTIN y condición. Son feeds de demostración, sin conexión, validación ni publicación en cuentas comerciales reales.

Cada destino puede incluir automáticamente todos los productos elegibles —también los que se incorporen después— o guardar una selección manual. Una selección manual vacía se conserva como vacía. Los productos inactivos quedan excluidos de la salida aunque estén seleccionados. Los cambios de cada feed no modifican los demás.

Desde **Marketplaces → Gestionar productos y pedidos**, Amazon, Miravia, Carrefour y eBay tienen su propio selector. Su surtido efectivo es la intersección de los productos activos, la selección de Lighthouse y la selección de ese marketplace. La regeneración refleja esa intersección en los contadores. El formulario y el servidor rechazan nuevos pedidos simulados de referencias excluidas; un pedido ya registrado sigue pudiendo recuperarse con su misma clave de idempotencia.

Las selecciones se persisten en D1 y usan revisión para detectar ediciones simultáneas. El servidor valida ámbitos y referencias, y exige origen local y ambas banderas de demo para escribir. Guardar un selector conserva los borradores sin guardar de los demás selectores abiertos en la página.

La portada presenta 18 accesos circulares: las 12 familias y seis accesos directos a maquillaje, higiene íntima, cuidado ocular, vitaminas y minerales, nutrición deportiva y descanso.

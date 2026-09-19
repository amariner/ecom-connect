# Imágenes del catálogo y campañas

Se han generado imágenes fotográficas sintéticas para las **45 referencias
ficticias** del catálogo y **tres hero** de FarmaHouse. Se utilizó la herramienta
integrada de generación de imágenes de OpenAI disponible en esta sesión, sin
API key ni proveedores externos de generación.

## Dirección visual

Fotografía de estudio sobre fondo marfil, luz lateral suave, sombras de contacto
y materiales realistas. Cada marca ficticia conserva su familia de color: rosa
para Nuvéa Lab, salvia para Olva Studio, lavanda para Dermohaus, menta para Savia
Daily, melocotón para Petit Nido, kraft para Verdea, lino para Casa Calma, azul gris
para Movea y ocre para Brisa Sun.

Cada referencia tiene su propia imagen y un prompt independiente con producto,
marca y formato. Los accesorios muestran el objeto correspondiente: cepillos,
almohadilla, antifaz, neceser, plantillas, cojín, banda, rodillera y pelota; no
son envases genéricos compartidos entre referencias.

## Entregables y uso

| Recurso | Archivo | Uso |
| --- | --- | --- |
| Productos | `public/images/products/generated/{slug}.webp` | Catálogo, ficha, cesta, panel y feed. |
| Hero principal | `public/images/heroes/hero-care.webp` | Cabecera de la portada. |
| Hero facial | `public/images/heroes/hero-facial.webp` | Campaña de cuidado facial. |
| Hero solar | `public/images/heroes/hero-sun.webp` | Campaña de cuidado solar. |
| Prompts finales | `docs/IMAGE-PROMPTS.json` | Trazabilidad de cada asset y reproducción de la dirección visual. |

Las fotografías de producto se sirven en WebP de 900 px. Los hero conservan
1536 × 1024 px. Se ha convertido el formato y reducido la resolución para web,
sin retoque de contenido. Los PNG originales se conservan localmente en
`tmp/imagegen/originals/`; los originales de la herramienta permanecen en su
directorio de generación. Los archivos que consume la aplicación están dentro
del proyecto y no dependen de rutas privadas de Codex.

## Persistencia de las referencias

`scripts/generate-seed.mjs` selecciona la fotografía cuando existe y conserva
las ilustraciones SVG como fallback. La migración
`0047_generated_product_images.sql` actualiza únicamente las imágenes originales
de esas referencias en `products` y `supplier_products`. Respeta imágenes
personalizadas, pedidos, precios y stock; las sincronizaciones del proveedor
mock mantienen las nuevas imágenes. Los feeds usan URLs absolutas hacia los
mismos archivos.

`scripts/prepare-generated-images.mjs` permite optimizar un manifiesto local de
imágenes ya generadas. No llama a OpenAI ni necesita credenciales. Las generaciones
se hicieron con prompts independientes, no recortando una plancha de catálogo.

## Alcance comercial

La ficha identifica el producto como ficticio y su imagen como generada con IA.
Estas imágenes representan la demo y sus campañas. Para vender productos reales,
utilizar fotografías fieles y autorizadas del fabricante/proveedor; las imágenes
sintéticas no acreditan contenido, etiquetado, advertencias, eficacia o un SPF.
Lighthouse distingue expresamente las imágenes comerciales de las imágenes
de producto/etiquetado GPSR.
[Fuente oficial de Lighthouse](https://lighthousefeed.com/docs/datos-gpsr-productos/).

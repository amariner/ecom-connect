# Operar y verificar la demo

Procedimiento para preparar una copia local, actualizar la demo publicada y
comprobar su funcionamiento. Usa los scripts de este repositorio; no conecta
cuentas comerciales ni activa cobros, correos o envíos reales.

Para enseñar las funcionalidades, seguir la [guía de presentación](GUIA-DEMO.md).
Para planificar adaptadores reales, consultar [Conexión de servicios](CONEXION-SERVICIOS.md).

## 1. Identificar el entorno

Ejecutar los comandos desde la raíz del repositorio con Node.js 22 o superior
y pnpm. Antes de publicar, comprobar los recursos declarados en `wrangler.jsonc`:

| Recurso | Configuración de esta demo |
| --- | --- |
| Worker | `ecom-connect`. |
| Base D1 | `ecom-connect-db`, disponible para el servidor mediante el binding `DB`. |
| Mutaciones ficticias | `DEMO_MODE=true` y `OMNICHANNEL_DEMO=true`. |
| Programador de lotes | `GROUPED_CRON_ENABLED=false`; no hay un cron configurado. |

Los comandos con `--local` trabajan sobre la copia local de D1. Los que usan
`--remote` afectan a la base publicada indicada en la configuración. Estos
recursos son propios de Ecom Connect; no utilizar los de `logic-ecom`. Para otra
instalación, configurar antes su Worker y D1 propios.

## 2. Preparar y abrir la copia local

Instalar las dependencias y aplicar las migraciones:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
```

Solo para preparar el catálogo inicial de una base local nueva:

```sh
pnpm db:seed
```

La semilla genera el catálogo ficticio y usa `INSERT OR IGNORE`. Repetirla no
borra pedidos, no restaura precios o stock modificados y no reinicia la demo.
Para actualizar una copia existente, conservar sus datos y aplicar las
migraciones; no necesita volver a sembrarse.

Arrancar el servidor:

```sh
pnpm dev
```

Abrir `http://localhost:4327/` y `http://localhost:4327/admin`. Mantener ese
proceso activo durante las pruebas que consultan la web.

## 3. Comprobar antes de publicar

En otra terminal, ejecutar tipos, pruebas y build:

```sh
pnpm check
```

Con el servidor local activo, comprobar los recorridos de integración:

```sh
DEMO_URL=http://localhost:4327 node scripts/smoke.mjs
node scripts/stock-race.mjs
```

Estas dos pruebas **sí modifican datos ficticios locales**: crean pedidos,
cambian stock y ajustes, y pueden tramitar pedidos pendientes. Ejecutarlas en
una copia de pruebas, no durante una presentación compartida. `stock-race.mjs`
consulta expresamente `localhost:4327`.

Completar el recorrido de tienda, checkout y panel en escritorio y móvil.
Comprobar teclado, formularios, carga, errores y enlaces. Los comandos anteriores
son instrucciones, no una afirmación de que esta revisión haya pasado las pruebas;
las ejecuciones documentadas están en [Verificación](VERIFICACION.md).

## 4. Publicar una actualización de la demo

Usar una cuenta Cloudflare con acceso a los recursos propios identificados y
una revisión ya comprobada en local:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 migrations apply ecom-connect-db --remote
pnpm deploy
```

`pnpm deploy` ejecuta el build y publica el Worker y sus assets; no aplica las
migraciones por sí solo. Una actualización conserva los pedidos y cambios de
catálogo existentes. Guardar el resultado del despliegue y la versión publicada
para identificar qué se ha verificado después.

**Primera carga de una base remota nueva:** después de sus migraciones y antes
de usar la demo, cargar el catálogo inicial con el archivo de semilla del
repositorio:

```sh
pnpm exec wrangler d1 execute ecom-connect-db --remote --file seed/demo.sql
```

Este paso corresponde a la preparación inicial; no es parte de cada
actualización ni un mecanismo para deshacer una presentación. La existencia del
repositorio GitHub no implica un despliegue automático.

## 5. Verificar la publicación sin modificar datos

El siguiente script consulta el Worker propio publicado por defecto:

```sh
node scripts/verify-public.mjs
```

Para comprobar la misma lectura contra la copia local:

```sh
DEMO_URL=http://localhost:4327 node scripts/verify-public.mjs
```

`DEMO_URL` debe ser solo el origen, sin ruta ni credenciales. El script consulta
páginas, documentos, enlaces, imágenes, catálogo, pedidos y feeds. Sus solicitudes
POST solo cotizan carritos: **no crea pedidos ni cambia stock, precios o ajustes**.
También evita seguir redirecciones a otro origen.

La comprobación espera el catálogo de referencia de **45 productos activos**.
Si se ha cambiado deliberadamente ese conjunto, revisar la aserción concreta;
no borrar ni reiniciar los datos para hacerla pasar. Un error identifica qué
revisar antes de presentar la versión. Una ejecución correcta no acredita
conexiones reales con proveedor o marketplaces.

Abrir además [la tienda](/), [el panel](/admin) y [el centro de documentación](/admin/documentacion)
para comprobar la experiencia visual publicada. Completar una compra o pulsar
acciones de simulación crea cambios compartidos: pertenece al recorrido de
presentación, no a esta comprobación de solo lectura.

## 6. Preparar la reunión y cerrar la sesión

Seguir la [preparación comercial](GUIA-DEMO.md#preparación-antes-de-la-reunión):
anotar el modo de envío, seleccionar un producto activo, comprobar su stock y
conservar los números de los pedidos enseñados. Si se cambia precio o PVP,
anotar también los valores originales.

El envío agrupado se ejecuta con **Enviar pendientes ahora**, hasta 30 pedidos
por lote. Elegir ese modo no activa un horario. En la configuración actual el
programador sigue deshabilitado; su activación requeriría configurar y verificar
un cron propio con capacidad disponible. El envío inmediato sigue siendo una
opción para las ventas nuevas.

Al terminar, restaurar los ajustes y valores modificados solo para la prueba
cuando corresponda, y sincronizar el catálogo si se han restaurado datos del
proveedor. Los pedidos y sus eventos permanecen como evidencia; no hay un
reinicio de datos mediante la semilla. La demo comparte datos entre visitantes.

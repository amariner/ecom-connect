# Arquitectura y reutilización

## Análisis previo

Origen: `amariner/logic2b-ecom`, checkout local `logic-ecom`, commit
`b992527` (Document homepage production rollout and verification).
Destino independiente: `amariner/ecom-connect`.

El original utiliza Astro 5, TypeScript, un Worker con assets y D1. Su versión
pública actual lee fixtures: bloquea cotización y checkout persistentes con
`DEMO_MODE=true`. Copiar únicamente la interfaz no permitiría demostrar pedidos
centralizados ni sincronizaciones. El proyecto nuevo añade una composición
omnicanal autorizada por el encargo, limitada a datos ficticios y adaptadores mock.

## Piezas que reutilizamos

| Pieza original | Aplicación en esta demo |
| --- | --- |
| Astro + adaptador Cloudflare + Worker `fetch`/`scheduled` | Servidor edge, assets y envío agrupado |
| Migraciones D1 0001–0044 | Catálogo, pedidos, snapshots, inventario y ledger del motor |
| `src/lib/quote.ts`, `pricing.ts`, `shipping.ts` | Cotización y portes recalculados en servidor |
| `src/lib/cart-client.ts` | Carrito por colección en localStorage, solo slug y cantidad |
| `src/lib/orders.ts` | Numeración y tokens de confirmación |
| `src/composition/order-operations.ts` y dependencias | Alta y pago simulado, eventos e inventario |
| Módulos catálogo/pedidos/inventario/pagos | Persistencia y reglas del motor común |
| Tipografía local Inter/Fraunces | Interfaz sin CDN ni dependencias de cliente |

Se importa el cierre de dependencias del motor necesario. No se trasladan las
otras tiendas, propuestas comerciales, cuentas privadas, credenciales ni assets
de clientes del repositorio original. La presentación se adapta al nuevo vertical.

## Extensiones

`SupplierAdapter` aísla catálogo, stock, creación y seguimiento del proveedor.
`MarketplaceHubAdapter` aísla la publicación de catálogo y la entrada de pedidos.
Las implementaciones simuladas escriben exclusivamente en esta D1. Web y
marketplaces convergen en las mismas tablas `orders` y `order_items`.

El Worker se llama **ecom-connect** y su D1 **ecom-connect-db**. No se heredan
dominios ni IDs de recursos del proyecto original. El handler programado, preparado pero no activado por el límite de cron de la cuenta, procesa únicamente
pedidos simulados; no dispara integraciones externas del motor heredado.

## Límites de demostración

No hay medicamentos, cobros, transporte, emails ni conexiones reales con
marketplaces. Los EAN son identificadores sintéticos y no deben enviarse a un
Merchant Center real. El panel muestra datos ficticios compartidos entre visitas;
no debe utilizarse para registrar información personal de clientes reales.

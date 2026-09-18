# Ecom Connect — FarmaHouse Demo

Proyecto independiente derivado de Logic2B Ecommerce. La petición actual autoriza
una demo funcional con persistencia ficticia D1, nuevas integraciones simuladas,
su repositorio GitHub y un Worker Cloudflare propios. No modificar logic-ecom,
su dominio ni su base de datos.

- Mantener Astro 5, TypeScript estricto, vanilla TS, Cloudflare Worker y D1.
- Reutilizar el núcleo heredado de catálogo, precios, pedidos e inventario.
- Precios en céntimos; stock y totales validados en servidor; escrituras idempotentes.
- Proveedor, Lighthouse y marketplaces son mocks. Nunca cobrar ni enviar emails.
- Mutaciones de demostración solo con DEMO_MODE=true y OMNICHANNEL_DEMO=true.
- No secretos ni datos personales reales en código, seeds o pruebas.
- UI y documentación en español. Código y commits en inglés.
- Verificar tipos, tests, build y recorridos reales antes de publicar.

Consulta docs/ARQUITECTURA.md para procedencia y alcance de la reutilización.

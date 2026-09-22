import * as overview from '../../docs/INTEGRACION-DROPSHIPPING.md';
import * as supplier from '../../docs/PROVEEDOR.md';
import * as lighthouse from '../../docs/LIGHTHOUSE.md';
import * as api from '../../docs/API.md';
import * as architecture from '../../docs/ARQUITECTURA.md';
import * as verification from '../../docs/VERIFICACION.md';
import * as images from '../../docs/IMAGENES.md';
import * as demoGuide from '../../docs/GUIA-DEMO.md';
import * as services from '../../docs/CONEXION-SERVICIOS.md';
import * as operations from '../../docs/OPERACION-DEMO.md';
import * as syncGuide from '../../docs/SINCRONIZACION.md';
import * as publicCatalog from '../../docs/CATALOGO-PUBLICO.md';
import * as uxUi from '../../docs/UX-UI.md';

export const technicalDocs = [
  {slug:'ux-ui',file:'UX-UI.md',title:'Experiencia de la tienda y el panel',description:'Campañas, doce productos en portada, navegación, márgenes, accesibilidad y simplificación de Marketplaces.',number:'13',module:uxUi},
  {slug:'sincronizacion',file:'SINCRONIZACION.md',title:'Horarios y sincronización de pedidos',description:'Pedidos web y marketplaces, cantidades, horarios, datos del cliente y acuses automáticos o manuales.',number:'12',module:syncGuide},
  { slug: 'guia-demo', file: 'GUIA-DEMO.md', title: 'Presentar la demo en 15 minutos', description: 'Un recorrido paso a paso: compra web, venta marketplace, proveedor y seguimiento. Con ventajas que puedes enseñar.', number: '01', module: demoGuide },
  { slug: 'conexion-servicios', file: 'CONEXION-SERVICIOS.md', title: 'Cómo conectamos los servicios', description: 'Qué hace cada servicio, qué datos intercambia y qué necesitamos para pasar de la simulación a una cuenta real.', number: '02', module: services },
  { slug: 'operacion-demo', file: 'OPERACION-DEMO.md', title: 'Operar y verificar la demo', description: 'Preparar el entorno, actualizar recursos propios y verificar la publicación sin modificar datos.', number: '03', module: operations },
  { slug: 'arquitectura-dropshipping', file: 'INTEGRACION-DROPSHIPPING.md', title: 'Arquitectura dropshipping', description: 'Responsabilidades, datos, estados y requisitos para cerrar el circuito.', number: '04', module: overview },
  { slug: 'proveedor', file: 'PROVEEDOR.md', title: 'API del proveedor', description: 'Contrato del PDF, campos, pedidos ERP y límites de la entrega directa.', number: '05', module: supplier },
  { slug: 'lighthouse', file: 'LIGHTHOUSE.md', title: 'Lighthouse y marketplaces', description: 'OAuth, catálogo, pedidos, seguimiento y fuentes oficiales verificadas.', number: '06', module: lighthouse },
  { slug: 'api', file: 'API.md', title: 'API de la demo', description: 'Endpoints locales, payloads, idempotencia y ejemplos de uso.', number: '07', module: api },
  { slug: 'nucleo', file: 'ARQUITECTURA.md', title: 'Núcleo y reutilización', description: 'Procedencia del motor, módulos y recursos Cloudflare independientes.', number: '08', module: architecture },
  { slug: 'verificacion', file: 'VERIFICACION.md', title: 'Pruebas y verificación', description: 'Comprobaciones automatizadas y recorridos de aceptación.', number: '09', module: verification },
  { slug: 'catalogo-publico', file: 'CATALOGO-PUBLICO.md', title: 'Catálogo público de FarmaHouse', description: '650 productos, fotografías originales, procedencia, importación y existencias simuladas.', number: '11', module: publicCatalog },
  { slug: 'imagenes', file: 'IMAGENES.md', title: 'Imágenes y campañas', description: '45 fotografías de producto, tres hero y trazabilidad de los prompts OpenAI.', number: '10', module: images },
];

/** Only repository-authored markdown is rendered; never remote/user HTML. */
export function resolveDocumentationLinks(content: string): string {
  return content.replace(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g, (link, href: string, attributes: string, label: string) => {
    if (/^(?:https?:|#|\/)/.test(href)) return link;
    const [path = '', anchor] = href.split('#');
    const filename = path.split('/').at(-1);
    const target = technicalDocs.find((doc) => doc.file === filename);
    if (target) return `<a href="/admin/documentacion/${target.slug}${anchor ? `#${anchor}` : ''}"${attributes}>${label}</a>`;
    // Source-code references remain readable without broken website links.
    return `<span class="doc-source-reference">${label}</span>`;
  });
}

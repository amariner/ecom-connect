import * as overview from '../../docs/INTEGRACION-DROPSHIPPING.md';
import * as supplier from '../../docs/PROVEEDOR.md';
import * as lighthouse from '../../docs/LIGHTHOUSE.md';
import * as api from '../../docs/API.md';
import * as architecture from '../../docs/ARQUITECTURA.md';
import * as verification from '../../docs/VERIFICACION.md';
import * as images from '../../docs/IMAGENES.md';

export const technicalDocs = [
  { slug: 'arquitectura-dropshipping', file: 'INTEGRACION-DROPSHIPPING.md', title: 'Arquitectura dropshipping', description: 'Responsabilidades, datos, estados y requisitos para cerrar el circuito.', number: '01', module: overview },
  { slug: 'proveedor', file: 'PROVEEDOR.md', title: 'API del proveedor', description: 'Contrato del PDF, campos, pedidos ERP y límites de la entrega directa.', number: '02', module: supplier },
  { slug: 'lighthouse', file: 'LIGHTHOUSE.md', title: 'Lighthouse y marketplaces', description: 'OAuth, catálogo, pedidos, seguimiento y fuentes oficiales verificadas.', number: '03', module: lighthouse },
  { slug: 'api', file: 'API.md', title: 'API de la demo', description: 'Endpoints locales, payloads, idempotencia y ejemplos de uso.', number: '04', module: api },
  { slug: 'nucleo', file: 'ARQUITECTURA.md', title: 'Núcleo y reutilización', description: 'Procedencia del motor, módulos y recursos Cloudflare independientes.', number: '05', module: architecture },
  { slug: 'verificacion', file: 'VERIFICACION.md', title: 'Pruebas y verificación', description: 'Comprobaciones automatizadas y recorridos de aceptación.', number: '06', module: verification },
  { slug: 'imagenes', file: 'IMAGENES.md', title: 'Imágenes y campañas', description: '45 fotografías de producto, tres hero y trazabilidad de los prompts OpenAI.', number: '07', module: images },
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

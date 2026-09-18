import type { GeneratedOrderDocumentType } from '../domain/order-document';

export type OrderDocumentSnapshot = Readonly<{
  schema: 1;
  issuedAt: string;
  document: Readonly<{
    number: string;
    type: GeneratedOrderDocumentType;
    version: number;
    templateId: string;
    templateVersion: number;
  }>;
  seller: Readonly<{ name: string; legalName: string }>;
  order: Readonly<{ id: number; number: string }>;
  recipient: Readonly<{
    name: string;
    company: string | null;
    street: string;
    postalCode: string;
    city: string;
    phone: string | null;
  }>;
  fulfillment: Readonly<{
    id: number;
    carrier: string | null;
    trackingNumber: string | null;
  }>;
  lines: readonly Readonly<{
    orderItemId: number;
    sku: string;
    name: string;
    quantity: number;
  }>[];
}>;

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shell(snapshot: OrderDocumentSnapshot, body: string): string {
  const title = snapshot.document.type === 'packing_slip' ? 'Albarán' : 'Etiqueta interna';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title} ${escapeHtml(snapshot.document.number)}</title>
<style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;color:#111;background:#fff;font:14px/1.45 system-ui,-apple-system,sans-serif}main{max-width:182mm;margin:auto}.head{display:flex;justify-content:space-between;gap:24px;padding-bottom:18px;border-bottom:2px solid #111}.muted{color:#555}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{margin:4px 0 0;font-size:28px}h2{font-size:14px;margin:0 0 8px}.card{border:1px solid #bbb;border-radius:10px;padding:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:10px;border-bottom:1px solid #ccc;text-align:left}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em}.qty{text-align:right;width:80px}.notice{margin-top:18px;padding-top:12px;border-top:1px solid #bbb;font-size:11px;color:#555}.label{margin-top:22px;border:3px solid #111;border-radius:16px;padding:24px}.address{font-size:22px;line-height:1.35}.tracking{margin-top:22px;padding-top:18px;border-top:2px dashed #777;font:700 18px/1.4 ui-monospace,monospace;word-break:break-all}@media(max-width:600px){.head,.grid{display:block}.head>*+*,.grid>*+*{margin-top:14px}.address{font-size:18px}}@media print{a{color:inherit;text-decoration:none}}
</style></head><body><main>${body}</main></body></html>`;
}

function header(snapshot: OrderDocumentSnapshot, title: string): string {
  const issuedAt = snapshot.issuedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return `<header class="head"><div><p class="eyebrow">${escapeHtml(snapshot.seller.name)}</p><h1>${title}</h1><p class="muted">${escapeHtml(snapshot.document.number)} · v${snapshot.document.version}</p></div><div><p><strong>Pedido</strong><br>${escapeHtml(snapshot.order.number)}</p><p class="muted">${escapeHtml(issuedAt)}</p></div></header>`;
}

function address(snapshot: OrderDocumentSnapshot): string {
  const recipient = snapshot.recipient;
  return `<section class="card"><h2>Entrega</h2><p><strong>${escapeHtml(recipient.company ?? recipient.name)}</strong>${recipient.company ? `<br>${escapeHtml(recipient.name)}` : ''}<br>${escapeHtml(recipient.street)}<br>${escapeHtml(recipient.postalCode)} ${escapeHtml(recipient.city)}${recipient.phone ? `<br>${escapeHtml(recipient.phone)}` : ''}</p></section>`;
}

function packingSlip(snapshot: OrderDocumentSnapshot): string {
  const rows = snapshot.lines.map((line) => `<tr><td><strong>${escapeHtml(line.name)}</strong><br><span class="muted">${escapeHtml(line.sku)}</span></td><td class="qty">${line.quantity}</td></tr>`).join('');
  return shell(snapshot, `${header(snapshot, 'Albarán')}<div class="grid">${address(snapshot)}<section class="card"><h2>Envío</h2><p>${escapeHtml(snapshot.fulfillment.carrier ?? 'Transportista pendiente')}<br><span class="muted">${escapeHtml(snapshot.fulfillment.trackingNumber ?? 'Sin seguimiento')}</span></p></section></div><table><thead><tr><th>Producto</th><th class="qty">Unidades</th></tr></thead><tbody>${rows}</tbody></table><p class="notice">Documento logístico sin importes. No es una factura ni sustituye la documentación emitida por la herramienta fiscal del comercio.</p>`);
}

function internalLabel(snapshot: OrderDocumentSnapshot): string {
  const recipient = snapshot.recipient;
  return shell(snapshot, `${header(snapshot, 'Etiqueta interna')}<section class="label"><p class="eyebrow">Destino</p><p class="address"><strong>${escapeHtml(recipient.company ?? recipient.name)}</strong>${recipient.company ? `<br>${escapeHtml(recipient.name)}` : ''}<br>${escapeHtml(recipient.street)}<br>${escapeHtml(recipient.postalCode)} ${escapeHtml(recipient.city)}</p><p class="tracking">${escapeHtml(snapshot.fulfillment.carrier ?? 'INTERNO')} · ${escapeHtml(snapshot.fulfillment.trackingNumber ?? snapshot.order.number)}</p></section><p class="notice">Uso interno de preparación y expedición. Documento no fiscal.</p>`);
}

export function renderOrderDocument(snapshot: OrderDocumentSnapshot): string {
  if (snapshot.document.type === 'packing_slip') return packingSlip(snapshot);
  return internalLabel(snapshot);
}

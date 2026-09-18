import { mkdirSync, writeFileSync } from 'node:fs';

// Catálogo original creado para esta demo. Sin marcas, fotografías ni textos de terceros.
const categories = [
  ['facial', 'Nuvéa Lab', '#d9b2a0', [
    ['Sérum facial Daily Glow', '30 ml', 2290, 2890, 18, 'dropper'],
    ['Crema facial Soft Ritual', '50 ml', 1890, 2490, 24, 'jar'],
    ['Gel limpiador Pure Balance', '200 ml', 1290, 1590, 32, 'pump'],
    ['Agua micelar Fresh Moment', '400 ml', 1090, 1390, 42, 'bottle'],
    ['Bálsamo labial Velvet', '15 ml', 690, 890, 36, 'tube'],
  ]],
  ['dermocosmetica', 'Olva Studio', '#bdd0b5', [
    ['Crema corporal Botanical', '250 ml', 1690, 1990, 27, 'jar'],
    ['Aceite corporal Golden Hour', '100 ml', 1990, 2390, 16, 'dropper'],
    ['Loción corporal Everyday', '400 ml', 1490, 1790, 30, 'pump'],
    ['Crema de manos Cotton', '75 ml', 790, 990, 48, 'tube'],
    ['Manteca corporal Calm Texture', '200 ml', 1790, 2190, 20, 'jar'],
  ]],
  ['capilar', 'Dermohaus', '#c3c6dc', [
    ['Champú Dermocare', '250 ml', 1290, 1590, 18, 'bottle'],
    ['Acondicionador Silk Routine', '200 ml', 1190, 1490, 21, 'tube'],
    ['Mascarilla capilar Sunday', '200 ml', 1590, 1990, 25, 'jar'],
    ['Aceite de puntas Gloss', '50 ml', 1390, 1790, 12, 'dropper'],
    ['Champú sólido Fresh Leaf', '75 g', 990, 1290, 35, 'box'],
  ]],
  ['higiene', 'Savia Daily', '#bcd3cf', [
    ['Gel de ducha Citrus', '500 ml', 890, 1090, 54, 'pump'],
    ['Jabón de manos Green Tea', '300 ml', 650, 790, 44, 'pump'],
    ['Pasta dental Fresh Mint', '75 ml', 490, 590, 62, 'tube'],
    ['Desodorante Clean Roll', '50 ml', 790, 990, 28, 'bottle'],
    ['Pack cepillos Soft Touch', '2 unidades', 590, 750, 39, 'box'],
  ]],
  ['bebe', 'Petit Nido', '#e5c6b5', [
    ['Gel de baño Little Cloud', '400 ml', 1090, 1390, 26, 'pump'],
    ['Loción infantil Sweet Moments', '250 ml', 1290, 1590, 22, 'bottle'],
    ['Bálsamo de pañal Baby Soft', '75 ml', 990, 1190, 31, 'tube'],
    ['Toallitas Cotton Cloud', '60 unidades', 390, 490, 75, 'box'],
    ['Cepillo infantil Soft Wood', '1 unidad', 850, 1090, 18, 'box'],
  ]],
  ['nutricion', 'Verdea', '#cdd6ad', [
    ['Infusión Rooibos & Naranja', '20 bolsitas', 590, 750, 45, 'box'],
    ['Granola Avena & Cacao', '300 g', 690, 850, 29, 'box'],
    ['Infusión de frutos del bosque', '20 bolsitas', 550, 690, 38, 'box'],
    ['Mix de semillas Natural', '200 g', 490, 650, 33, 'box'],
    ['Té verde Everyday', '20 bolsitas', 590, 790, 41, 'box'],
  ]],
  ['bienestar', 'Casa Calma', '#c9c3d5', [
    ['Almohadilla de semillas Linen', '1 unidad', 1990, 2490, 16, 'box'],
    ['Aceite de masaje Slow Living', '100 ml', 1690, 1990, 24, 'dropper'],
    ['Antifaz de descanso Soft Night', '1 unidad', 1190, 1490, 19, 'box'],
    ['Sales de baño Evening', '300 g', 990, 1290, 30, 'jar'],
    ['Neceser de viaje Essential', '1 unidad', 1490, 1890, 20, 'box'],
  ]],
  ['ortopedia', 'Movea', '#bfcbd7', [
    ['Plantillas de confort Daily', 'Talla M', 1490, 1890, 23, 'box'],
    ['Cojín de asiento Comfort', '1 unidad', 2490, 2990, 11, 'box'],
    ['Banda elástica Easy Move', 'Resistencia suave', 1190, 1590, 17, 'box'],
    ['Rodillera textil Active', 'Talla M', 1890, 2290, 14, 'box'],
    ['Pelota de masaje Soft Move', '1 unidad', 890, 1090, 26, 'box'],
  ]],
  ['solares', 'Brisa Sun', '#e7c38a', [
    ['Loción solar Daily Sun', '200 ml', 1990, 2490, 34, 'tube'],
    ['Fluido facial Sun Ritual', '50 ml', 1790, 2290, 28, 'bottle'],
    ['After Sun Golden Days', '200 ml', 1390, 1790, 19, 'pump'],
    ['Stick solar Pocket Sun', '20 g', 1190, 1490, 0, 'bottle'],
    ['Bálsamo labial Sunny', '15 ml', 690, 890, 32, 'tube'],
  ]],
];
const slugify = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const insert = (table, row) => `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sql).join(',')});`;

function packageShape(kind, color, brand, name, size, index) {
  const gradient = `p${index}`;
  const shape = {
    dropper: '<rect x="160" y="67" width="80" height="44" rx="10" fill="#344838"/><path d="M184 35h32v43h-32z" fill="#344838"/><rect x="146" y="108" width="108" height="198" rx="22" fill="url(#BODY)"/><rect x="152" y="169" width="96" height="110" rx="3" fill="#fffdf3"/>',
    jar: '<rect x="108" y="154" width="184" height="150" rx="25" fill="url(#BODY)"/><rect x="102" y="132" width="196" height="48" rx="12" fill="#eeeae2"/><path d="M114 151h170" stroke="#fff" stroke-width="2"/><rect x="117" y="187" width="166" height="92" rx="3" fill="#fffdf3"/>',
    pump: '<rect x="179" y="71" width="42" height="35" fill="#eeeae2"/><path d="M170 74v-20h95v12h-64v8z" fill="#3a483b"/><rect x="132" y="104" width="136" height="208" rx="23" fill="url(#BODY)"/><rect x="138" y="169" width="124" height="116" rx="3" fill="#fffdf3"/>',
    tube: '<path d="M129 85h142l-18 216H147z" fill="url(#BODY)"/><path d="M129 85h142v14H129z" fill="#e6e6dc"/><rect x="147" y="296" width="106" height="27" rx="4" fill="#344838"/><path d="M137 165h126l-8 112H145z" fill="#fffdf3"/>',
    bottle: '<rect x="158" y="60" width="84" height="42" rx="9" fill="#eeebe3"/><rect x="137" y="97" width="126" height="216" rx="26" fill="url(#BODY)"/><rect x="142" y="167" width="116" height="115" rx="3" fill="#fffdf3"/>',
    box: '<path d="M119 94l145-12 22 16v207l-145 12-22-15z" fill="url(#BODY)"/><path d="M264 82l22 16v207l-22-13z" fill="#000" opacity=".08"/><path d="M119 94l145-12 22 16-144 12z" fill="#fff" opacity=".35"/><rect x="131" y="162" width="124" height="122" fill="#fffdf3"/>',
  }[kind];
  return `<g><defs><linearGradient id="${gradient}" x1="0" x2="1"><stop stop-color="${color}"/><stop offset=".4" stop-color="#ffffff" stop-opacity=".6"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><ellipse cx="202" cy="330" rx="98" ry="12" fill="#26382b" opacity=".10"/>${shape.replaceAll('BODY',gradient)}<g text-anchor="middle" fill="#364739" font-family="Arial, sans-serif"><text x="200" y="190" font-size="10" letter-spacing="2">${xml(brand.toUpperCase())}</text><path d="M188 206q12-22 24 0-12 16-24 0" fill="${color}"/><path d="M200 199v19" stroke="#57705d" stroke-width="1"/><text x="200" y="234" font-size="12">${xml(name.split(' ').slice(0,2).join(' '))}</text><text x="200" y="250" font-size="10">${xml(name.split(' ').slice(2).join(' ').slice(0,24))}</text><text x="200" y="268" font-size="8" letter-spacing="1">${xml(size.toUpperCase())}</text></g></g>`;
}

mkdirSync('public/images/products',{recursive:true});
mkdirSync('seed',{recursive:true});
let id = 0;
const products = categories.flatMap(([category,brand,color,items]) => items.map(([name,size,price,pvp,stock,kind]) => {
  id++;
  const slug = slugify(name);
  const base = `200${String(id).padStart(9,'0')}`;
  const checksum = (10-[...base].reduce((sum,n,i)=>sum+Number(n)*(i%2===0?1:3),0)%10)%10;
  const product = {id,slug,name,description:`${name}, ${size.toLowerCase()}. Una propuesta de ${brand} para completar tu rutina diaria. Producto ficticio creado exclusivamente para esta demostración, sin propiedades médicas ni venta real.`,price_cents:price,compare_at_price_cents:pvp,stock,image:`/images/products/${slug}.svg`,category,active:1,collection:'farmahouse',subtitle:size,sku:`FH-${String(id).padStart(4,'0')}`,supplier_sku:`PRV-${String(id).padStart(5,'0')}`,ean:base+checksum,brand,vat:21};
  writeFileSync(`public/images/products/${slug}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="${xml(name)} — envase ficticio"><rect width="400" height="400" fill="#f3f3ee"/>${packageShape(kind,color,brand,name,size,id)}</svg>`);
  return product;
}));
const statements=['-- Datos ficticios y reproducibles. INSERT OR IGNORE no sobrescribe pedidos ni sincronizaciones existentes.'];
for (const p of products) {
  statements.push(insert('products',p));
  statements.push(`UPDATE products SET last_synced_at = COALESCE(last_synced_at,datetime('now')) WHERE id=${p.id};`);
  statements.push(insert('product_variants',{id:p.id,product_id:p.id,sku:p.sku,gtin:p.ean,title:p.subtitle,price_cents:p.price_cents,compare_at_price_cents:p.compare_at_price_cents,status:'active',is_default:1}));
  statements.push(insert('inventory_balances',{variant_id:p.id,on_hand:p.stock,reserved:0,version:1}));
  statements.push(`INSERT OR IGNORE INTO inventory_movements (variant_id,delta,reason,balance_after,version_after,actor_kind,actor_id,reference_type,reference_id,idempotency_key,correlation_id,occurred_at) VALUES (${p.id},${p.stock},'legacy_opening_balance',${p.stock},1,'system','demo-seed','seed','farmahouse','farmahouse:opening:${p.id}','inventory:variant:${p.id}',datetime('now'));`);
  statements.push(insert('supplier_products',{code:p.supplier_sku,slug:p.slug,name:p.name,description:p.description,price_cents:p.price_cents,pvp_cents:p.compare_at_price_cents,discount:0,brand:p.brand,vat:p.vat,category:p.category,image:p.image,ean:p.ean,sku:p.sku,active:1,stock:p.stock,backup_stock:p.id%3===0?12:0}));
}
for (const [id,zone,label,price,free] of [[1,'peninsula','Envío demo · Península',490,4900],[2,'baleares','Envío demo · Baleares',890,8000],[3,'canarias','Envío demo · Canarias',1490,null],[4,'ceuta-melilla','Envío demo · Ceuta y Melilla',1490,null]]) {
  statements.push(insert('shipping_rates',{id,zone,label,price_cents:price,free_over_cents:free,active:1}));
}
statements.push(insert('integration_settings',{key:'dispatch_mode',value:'grouped'}));
statements.push("INSERT OR IGNORE INTO integration_runs(id,integration,processed,updated,errors) VALUES (1,'supplier',45,45,0),(2,'lighthouse',45,45,0);");
for (const channel of ['AMAZON','MIRAVIA','CARREFOUR','EBAY']) statements.push(insert('marketplace_publications',{channel,published:45}));
statements.push("INSERT OR IGNORE INTO integration_events(id,kind,title,detail) VALUES (1,'sync','Catálogo preparado','45 referencias ficticias listas para la demostración omnicanal.');");
writeFileSync('seed/demo.sql',statements.join('\n')+'\n');
writeFileSync('seed/catalog.json',JSON.stringify(products,null,2)+'\n');

const scene = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 820" role="img" aria-label="Bodegón ilustrado de productos de cuidado personal ficticios"><defs><linearGradient id="wall" x2="1" y2="1"><stop stop-color="#f0eadb"/><stop offset="1" stop-color="#d4d9bc"/></linearGradient><linearGradient id="plinth"><stop stop-color="#ede9d8"/><stop offset="1" stop-color="#cecdb8"/></linearGradient></defs><rect width="1000" height="820" fill="url(#wall)"/><circle cx="620" cy="320" r="285" fill="#f9f5e5" opacity=".45"/><path d="M850 0L300 820H150L710 0z" fill="#fff" opacity=".18"/><path d="M965 0L415 820H380L930 0z" fill="#fff" opacity=".18"/><path d="M0 655h1000v165H0z" fill="#e4e1ce"/><ellipse cx="500" cy="706" rx="353" ry="48" fill="#374a2e" opacity=".12"/><path d="M260 586h500v151H260z" fill="url(#plinth)"/><ellipse cx="510" cy="586" rx="250" ry="52" fill="#f7f3e2"/><g transform="translate(310 115) scale(1.65)">${packageShape('pump','#b9c8a1','Olva Studio','Loción corporal Everyday','400 ml','hero1')}</g><g transform="translate(92 232) scale(1.25) rotate(-10 200 250)">${packageShape('tube','#dfc29b','Brisa Sun','Loción solar Daily Sun','200 ml','hero2')}</g><g transform="translate(415 350) scale(1.05)">${packageShape('jar','#e2bfa8','Nuvéa Lab','Crema facial Soft Ritual','50 ml','hero3')}</g><g transform="translate(236 356) scale(.93) rotate(7 200 250)">${packageShape('dropper','#c0c89d','Nuvéa Lab','Sérum facial Daily Glow','30 ml','hero4')}</g><g fill="#638052" opacity=".85"><path d="M879 740q-18-164 84-278-20 166-84 278"/><path d="M875 670q-128-24-135-117 109 8 135 117"/><path d="M902 605q30-151 98-146-13 125-98 146"/></g><path d="M867 813q7-220 108-343" fill="none" stroke="#4b6843" stroke-width="5"/></svg>`;
writeFileSync('public/images/hero-products.svg',scene);
console.log(`Generated ${products.length} fictional products, SVG illustrations and seed/demo.sql.`);

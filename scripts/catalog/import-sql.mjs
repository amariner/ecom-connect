import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const sql=value=>value===null?'NULL':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
const insert=(table,row)=>`INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sql).join(',')});`;
export function catalogImportSql(products) {
  const seen=new Set();
  const statements=['-- Catálogo público: operaciones y existencias exclusivamente de demostración.','-- Repetir la carga conserva pedidos, precios e inventario de referencias existentes.'];
  for(const p of products) {
    if(!Number.isSafeInteger(p.source_id)||p.source_id<1||p.source_id>10000000||seen.has(p.source_id))throw Error('Invalid or duplicate source id');
    seen.add(p.source_id);
    if(!Number.isSafeInteger(p.price_cents)||p.price_cents<=0||p.price_cents>100000000)throw Error('Invalid price');
    if(!Number.isSafeInteger(p.demo_stock)||p.demo_stock<0||p.demo_stock>1000)throw Error('Invalid demo stock');
    if(!p.name||!p.brand||!/^fh-[a-z0-9-]+$/.test(p.slug)||!p.category||!Array.isArray(p.categories)||p.categories.some(c=>typeof c!=='string'))throw Error('Invalid product identity');
    const url=new URL(p.source_url);
    if(url.origin!=='https://farmahouse.com'||url.username||url.password||!url.pathname.endsWith('.html'))throw Error('Invalid source URL');
    if(!/^\/images\/products\/farmahouse\/\d+\.(jpg|png|webp)$/.test(p.image)||!Number.isFinite(Date.parse(p.fetched_at)))throw Error('Invalid provenance');
    const id=1000000+p.source_id, sku=`FH-REAL-${p.source_id}`, code=`DEMO-FH-${p.source_id}`;
    const description=`${p.name}. Referencia ${p.source_reference} del catálogo público de ${p.brand}. Precio observado en FarmaHouse; existencias y compra simuladas en este entorno.`;
    const row={id,slug:p.slug,name:p.name,description,price_cents:p.price_cents,compare_at_price_cents:null,stock:p.demo_stock,image:p.image,category:p.category,active:1,collection:'farmahouse',subtitle:p.source_reference,sku,supplier_sku:code,ean:p.ean,brand:p.brand,vat:21,source_url:p.source_url,source_product_id:String(p.source_id),source_reference:p.source_reference,source_fetched_at:p.fetched_at,source_availability:p.source_availability,source_categories:JSON.stringify(p.categories)};
    statements.push(insert('products',row));
    statements.push(insert('product_variants',{id,product_id:id,sku,gtin:p.ean,title:p.source_reference,price_cents:p.price_cents,compare_at_price_cents:null,status:'active',is_default:1}));
    statements.push(insert('inventory_balances',{variant_id:id,on_hand:p.demo_stock,reserved:0,version:1}));
    statements.push(insert('inventory_movements',{variant_id:id,delta:p.demo_stock,reason:'legacy_opening_balance',balance_after:p.demo_stock,version_after:1,actor_kind:'system',actor_id:'public-catalog-demo',reference_type:'seed',reference_id:String(p.source_id),idempotency_key:`farmahouse:public:opening:${id}`,correlation_id:`inventory:variant:${id}`,occurred_at:p.fetched_at}));
    statements.push(insert('supplier_products',{code,slug:p.slug,name:p.name,description,price_cents:p.price_cents,pvp_cents:null,discount:0,brand:p.brand,vat:21,category:p.category,image:p.image,ean:p.ean,sku,active:1,stock:p.demo_stock,backup_stock:0}));
  }
  return statements.join('\n')+'\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const snapshot=JSON.parse(readFileSync('seed/farmahouse-catalog.json','utf8'));
 if(snapshot.products.length<500||snapshot.count!==snapshot.products.length)throw Error('Expected at least 500 verified public products');
 writeFileSync('seed/farmahouse.sql',catalogImportSql(snapshot.products));
 console.log(`Prepared ${snapshot.count} public products with demo inventory.`);
}

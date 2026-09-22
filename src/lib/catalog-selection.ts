import { z } from 'zod';
export { selectionAllows } from './catalog-selection-policy';
import { DemoError } from './demo';
export const selectionScopes = ['lighthouse','google','meta','AMAZON','MIRAVIA','CARREFOUR','EBAY'] as const;
export type SelectionScope = typeof selectionScopes[number];
export type CatalogSelection = { scope: SelectionScope; codes: string[] | null; revision: number };
export type SelectionProduct = { code:string; slug:string; name:string; brand:string; category:string; source_categories:string; image:string; sku:string; ean:string; price_cents:number; stock:number; linked:number; loaded:number; source_url:string|null };
export async function readSelections(db:D1Database):Promise<CatalogSelection[]> {
  const rows = await db.prepare('SELECT * FROM catalog_selections').all<{scope:SelectionScope;codes_json:string;revision:number}>();
  return rows.results.map(row=>({scope:row.scope,codes:JSON.parse(row.codes_json),revision:row.revision}));
}
export async function selectionCatalog(db:D1Database) {
  type SupplierRow = Omit<SelectionProduct,'source_categories'|'loaded'|'source_url'>;
  type StoreRow = {supplier_sku:string;source_categories:string|null;active:number;source_url:string|null};
  const [catalog,selections]=await Promise.all([
    // The partial supplier_sku index cannot support an unrestricted LEFT JOIN.
    // Read each catalogue once, in one snapshot, instead of scanning every store
    // product for each supplier reference (695 × 695 rows in the original query).
    db.batch([
      db.prepare(`SELECT s.code,s.slug,s.name,s.brand,s.category,s.image,s.sku,s.ean,
        s.price_cents,s.stock,COALESCE(l.linked,1) AS linked FROM supplier_products s
        LEFT JOIN supplier_catalog_links l ON l.code=s.code ORDER BY s.name`),
      db.prepare('SELECT supplier_sku,source_categories,active,source_url FROM products ORDER BY id'),
    ]),
    readSelections(db),
  ]);
  const storeByCode = new Map<string,StoreRow[]>();
  for (const product of catalog[1]!.results as StoreRow[]) {
    const matches=storeByCode.get(product.supplier_sku);
    if(matches) matches.push(product);
    else storeByCode.set(product.supplier_sku,[product]);
  }
  // Preserve LEFT JOIN semantics, including legacy products with empty codes.
  const products=(catalog[0]!.results as SupplierRow[]).flatMap((supplier):SelectionProduct[] => {
    const matches=storeByCode.get(supplier.code) ?? [null];
    return matches.map(product=>({...supplier,source_categories:product?.source_categories ?? '[]',
      loaded:product?.active ?? 0,source_url:product?.source_url ?? null}));
  });
  return {products,selections};
}
const codesSchema=z.array(z.string().min(1).max(120)).max(10000).transform(codes=>[...new Set(codes)].sort());
const saveSchema=z.discriminatedUnion('scope',[
  z.object({scope:z.literal('supplier'),codes:codesSchema}),
  z.object({scope:z.enum(selectionScopes),codes:codesSchema.nullable(),revision:z.number().int().nonnegative()}),
]);
export async function saveSelection(db:D1Database,raw:unknown) {
  const input=saveSchema.parse(raw);
  if(input.codes?.length) {
    const count=await db.prepare('SELECT COUNT(*) AS total FROM supplier_products WHERE code IN (SELECT value FROM json_each(?))').bind(JSON.stringify(input.codes)).first<number>('total');
    if(count!==input.codes.length) throw new DemoError('Hay referencias que no pertenecen al proveedor.',400);
  }
  if(input.scope==='supplier') {
    // Additive and idempotent: linking never publishes until a supplier sync.
    await db.prepare(`INSERT INTO supplier_catalog_links(code,linked)
      SELECT value,1 FROM json_each(?) WHERE true ON CONFLICT(code) DO UPDATE SET linked=1`)
      .bind(JSON.stringify(input.codes)).run();
    return {linked:input.codes.length};
  }
  const json=JSON.stringify(input.codes);
  const result=await db.prepare(`UPDATE catalog_selections SET codes_json=?,revision=revision+1
    WHERE scope=? AND revision=? AND codes_json<>?`).bind(json,input.scope,input.revision,json).run();
  const saved=(await readSelections(db)).find(s=>s.scope===input.scope)!;
  if(!result.meta.changes && JSON.stringify(saved.codes)!==json) throw new DemoError('La selección ha cambiado en otra ventana. Recarga el selector antes de guardar.',409);
  return saved;
}

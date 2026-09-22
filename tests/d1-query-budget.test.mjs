import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {migratedDatabase,d1Adapter} from './helpers/d1.mjs';
import {catalogImportSql} from '../scripts/catalog/import-sql.mjs';
import {selectionCatalog} from '../src/lib/catalog-selection';
import {getSupplierStockSnapshot,syncSupplier} from '../src/lib/demo';

const snapshot=JSON.parse(readFileSync(new URL('../seed/farmahouse-catalog.json',import.meta.url),'utf8')).products;
const originalSelectionSql=`SELECT s.code,s.slug,s.name,s.brand,s.category,COALESCE(p.source_categories,'[]') AS source_categories,
  s.image,s.sku,s.ean,s.price_cents,s.stock,COALESCE(l.linked,1) AS linked,
  COALESCE(p.active,0) AS loaded,p.source_url FROM supplier_products s
  LEFT JOIN products p ON p.supplier_sku=s.code LEFT JOIN supplier_catalog_links l ON l.code=s.code ORDER BY s.name`;
let sqlite,db,queries;
beforeEach(()=>{
  sqlite=migratedDatabase();sqlite.exec(catalogImportSql(snapshot));queries=[];
  const base=d1Adapter(sqlite);
  db={...base,prepare(sql){queries.push(sql);return base.prepare(sql);}};
});
afterEach(()=>sqlite.close());

describe('bounded D1 catalogue reads without an additional migration',()=>{
  it('returns the same complete selector while reading the store table only once',async()=>{
    const expected=sqlite.prepare(originalSelectionSql).all();
    const result=await selectionCatalog(db);
    expect(result.products).toEqual(expected);
    expect(result.products).toHaveLength(650);
    const plans=queries.flatMap(sql=>sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
    const storeReads=plans.filter(row=>/\b(?:SCAN|SEARCH) (?:products|p)\b/.test(row.detail));
    // Regression guard for the former correlated 650 × 650 LEFT JOIN scan.
    expect(storeReads).toHaveLength(1);
    expect(storeReads[0].detail).toMatch(/^SCAN products$/);
    expect(plans.some(row=>/SCAN p LEFT-JOIN/.test(row.detail))).toBe(false);
  });

  it('preserves unmatched references, loaded state and legacy empty-code join semantics',async()=>{
    sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,brand,category,image,ean,sku,stock)
      VALUES ('ORPHAN','orphan','Orphan demo','Demo',100,'Demo','facial','','','ORPHAN',1),
        ('','empty-code','Empty demo','Demo',100,'Demo','facial','','','',1);
      INSERT INTO products(slug,name,description,price_cents,stock,image,category,supplier_sku)
      VALUES ('legacy-a','Legacy A','Demo',100,1,'','facial',''),('legacy-b','Legacy B','Demo',100,1,'','facial','');`);
    const expected=sqlite.prepare(originalSelectionSql).all();
    const result=await selectionCatalog(db);
    expect(result.products).toEqual(expected);
    expect(result.products.find(product=>product.code==='ORPHAN')).toMatchObject({loaded:0,source_categories:'[]',source_url:null});
    expect(result.products.filter(product=>product.code==='')).toHaveLength(2);
  });

  it('uses the existing supplier index for stock snapshots and retains stock values',async()=>{
    const code=`DEMO-FH-${snapshot[0].source_id}`;
    const result=await getSupplierStockSnapshot(db,code);
    const query=queries.find(sql=>sql.includes('WITH selected AS'));
    const plan=sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(code);
    expect(plan.some(row=>/SEARCH p USING INDEX idx_product_supplier_sku/.test(row.detail))).toBe(true);
    expect(plan.some(row=>/SCAN p LEFT-JOIN/.test(row.detail))).toBe(false);
    expect(result).toMatchObject({code,reserved_units:0,stock_difference:0});
  });

  it('keeps supplier synchronization atomic and uses indexed product matches at catalogue scale',async()=>{
    const code=`DEMO-FH-${snapshot[0].source_id}`;
    sqlite.prepare('UPDATE supplier_products SET stock=stock+2 WHERE code=?').run(code);
    const result=await syncSupplier(db);
    expect(result).toMatchObject({processed:500,updated:1,errors:0});
    const snapshotResult=await getSupplierStockSnapshot(db,code);
    expect(snapshotResult.stock_difference).toBe(0);
    const query=queries.find(sql=>sql.includes('SELECT COUNT(*) AS processed'));
    const plan=sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    expect(plan.some(row=>/SEARCH products USING COVERING INDEX idx_product_supplier_sku/.test(row.detail))).toBe(true);
    expect(plan.some(row=>/SCAN p LEFT-JOIN/.test(row.detail))).toBe(false);
    expect(sqlite.prepare('SELECT count(*) AS total FROM products').get().total).toBe(650);
  });
});

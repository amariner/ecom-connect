#!/usr/bin/env python3
"""Import public product facts only; no customer data, login or external mutations.
Install parser: python3 -m pip install -r scripts/catalog/requirements.txt
Cached/resumable: python3 scripts/catalog/scrape-farmahouse.py --limit 650
"""
import argparse, hashlib, json, re, subprocess, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'tmp/farmahouse'
IMAGES = ROOT / 'public/images/products/farmahouse'
CACHE.mkdir(parents=True, exist_ok=True)
IMAGES.mkdir(parents=True, exist_ok=True)

def fetch(url, binary=False):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname != 'farmahouse.com':
        raise ValueError('Only public HTTPS resources on farmahouse.com are allowed')
    key = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ('.bin' if binary else '.html'))
    if key.exists(): return key.read_bytes() if binary else key.read_text()
    for attempt in range(3):
        result = subprocess.run(['curl','--fail','--silent','--show-error','--max-time','25',url],capture_output=True)
        if result.returncode == 0:
            key.write_bytes(result.stdout)
            time.sleep(.2)
            return result.stdout if binary else result.stdout.decode('utf-8')
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'Cannot fetch {url}')

def listing(item):
    group, child = item
    try:
        soup = BeautifulSoup(fetch(child['sourceUrl']), 'html.parser')
        found = []
        for card in soup.select('article.product-miniature[data-id-product]'):
            link = card.select_one('.product-title a')
            if link:
                found.append(dict(id=int(card['data-id-product']),url=link['href'],group=group['id'],subcategory=child['id']))
        return found
    except Exception as error:
        print('Listing skipped:', child['id'],str(error),flush=True)
        return []

def cents(value):
    amount = Decimal(str(value)) * 100
    if not amount.is_finite() or amount != amount.to_integral_value() or amount < 0 or amount > 100000000:
        raise ValueError('Invalid price')
    return int(amount)

def detail(item):
    try:
        soup = BeautifulSoup(fetch(item['url']), 'html.parser')
        product = None
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                data = json.loads(script.string or script.get_text())
                if data.get('@type') == 'Product': product = data
            except (ValueError, AttributeError): pass
        if not product: raise ValueError('Missing Product schema')
        offers = product.get('offers',{})
        if offers.get('priceCurrency') != 'EUR': raise ValueError('Not EUR')
        price = cents(offers['price'])
        if price <= 0: raise ValueError('Missing nonzero price')
        name = BeautifulSoup(product['name'],'html.parser').get_text(' ',strip=True)
        brand = product.get('brand',{})
        brand = brand.get('name','') if isinstance(brand,dict) else str(brand)
        if not brand: raise ValueError('Missing brand')
        image = product['image']
        if isinstance(image,list): image = image[0]
        if isinstance(image,dict): image = image.get('url')
        raw = fetch(image,True)
        extension = 'png' if raw.startswith(b'\x89PNG') else 'jpg' if raw.startswith(b'\xff\xd8') else 'webp' if raw[8:12] == b'WEBP' else None
        if not extension: raise ValueError('Invalid image format')
        local_image = IMAGES / f"{item['id']}.{extension}"
        local_image.write_bytes(raw)
        reference = str(product.get('sku') or item['id'])
        source_slug = urlparse(item['url']).path.rsplit('/',1)[-1].removesuffix('.html')
        return dict(source_id=item['id'],name=name,brand=brand,source_reference=reference,
                    ean=str(product.get('gtin13') or product.get('gtin') or ''),
                    slug='fh-'+re.sub(r'[^a-z0-9-]+','-',source_slug.lower()).strip('-'),price_cents=price,category=item['group'],
                    categories=item['categories'],source_url=item['url'],source_image=image,
                    image='/images/products/farmahouse/'+local_image.name,
                    source_availability=str(offers.get('availability','')).rsplit('/',1)[-1],
                    fetched_at=datetime.fromtimestamp((CACHE/(hashlib.sha256(item['url'].encode()).hexdigest()+'.html')).stat().st_mtime,timezone.utc).isoformat(),
                    demo_stock=24)
    except Exception as error:
        print('Product skipped:',item['id'],str(error),flush=True)
        return None

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--limit',type=int,default=650)
    args=parser.parse_args()
    if not 500 <= args.limit <= 1000: parser.error('--limit must be between 500 and 1000')
    taxonomy=json.loads((ROOT/'src/data/catalog-taxonomy.json').read_text())
    tasks=[(g,c) for g in taxonomy for c in g['children']]
    with ThreadPoolExecutor(max_workers=3) as pool: batches=list(pool.map(listing,tasks))
    catalog={}
    # Round-robin gives all families representation, including small categories.
    for index in range(32):
        for batch in batches:
            if index>=len(batch):continue
            item=batch[index]
            if item['id'] not in catalog:catalog[item['id']]={**item,'categories':[]}
            for cat in [item['group'],item['subcategory']]:
                if cat not in catalog[item['id']]['categories']:catalog[item['id']]['categories'].append(cat)
    candidates=list(catalog.values())[:args.limit+100]
    print('Discovered:',len(catalog),'unique products;',len(candidates),'candidates',flush=True)
    products=[]
    with ThreadPoolExecutor(max_workers=3) as pool:
        for product in pool.map(detail,candidates):
            if product:products.append(product)
            if len(products)%50==0:print('Captured:',len(products),flush=True)
    products=products[:args.limit]
    if len(products)<500:raise RuntimeError(f'Only {len(products)} valid products; snapshot not replaced')
    snapshot=dict(source='https://farmahouse.com/',captured_at=datetime.now(timezone.utc).isoformat(),
                  count=len(products),stock_policy='24 unidades ficticias por referencia. No representa disponibilidad real.',products=products)
    (ROOT/'seed/farmahouse-catalog.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n')
    retained={Path(p['image']).name for p in products}
    for path in IMAGES.iterdir():
        if path.name not in retained:path.unlink()
    print('Saved:',len(products),'products with local original images',flush=True)
if __name__=='__main__':main()

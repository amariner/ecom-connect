/** A quota failure is terminal until the next UTC day; never retry it in a loop. */
export class D1ReadLimitError extends Error {
  readonly code = 'D1_READ_LIMIT';
  constructor() { super('Las operaciones de la demo están pausadas hasta que se restablezca la cuota diaria de D1.'); }
}

export function isD1QuotaError(error: unknown): boolean {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  while (error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof D1ReadLimitError) return true;
    messages.push(error instanceof Error ? error.message : String(error));
    error = error instanceof Error ? error.cause : undefined;
  }
  const message = messages.join(' ');
  return /D1/i.test(message) && /(?:daily.*limit|quota|exceeded.*(?:row|read|write).*limit|(?:row|read|write).*limit.*exceeded)/i.test(message);
}

export class D1QuotaCircuit {
  private pausedUntil = 0;
  private proxies = new WeakMap<object, object>();
  private originals = new WeakMap<object, object>();
  constructor(private now: () => number = Date.now) {}

  until(configured?: string): number {
    const configuredTime = configured ? Date.parse(configured) : 0;
    const until = Math.max(this.pausedUntil, Number.isFinite(configuredTime) ? configuredTime : 0);
    return until > this.now() ? until : 0;
  }

  observe(error: unknown) {
    if (isD1QuotaError(error)) {
      const date = new Date(this.now());
      this.pausedUntil = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    }
  }

  /** Stable identity preserves the public catalog cache; batch receives native statements. */
  protect<T extends object>(original: T): T {
    if (this.originals.has(original)) return original;
    const existing = this.proxies.get(original);
    if (existing) return existing as T;
    const proxy = new Proxy(original, { get: (target, key) => {
      const member: unknown = Reflect.get(target, key, target);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (this.until()) throw new D1ReadLimitError();
        const unwrap = (value: unknown): unknown => value && typeof value === 'object' ? this.originals.get(value) ?? value : value;
        const parameters = key === 'batch' ? args.map(arg => Array.isArray(arg) ? arg.map(unwrap) : unwrap(arg)) : args;
        try {
          const result: unknown = Reflect.apply(member, target, parameters);
          if (['prepare', 'bind', 'withSession'].includes(String(key)) && result && typeof result === 'object') return this.protect(result);
          if (result instanceof Promise) return result.catch((error: unknown) => { this.observe(error); throw error; });
          return result;
        } catch (error) { this.observe(error); throw error; }
      };
    }});
    this.proxies.set(original, proxy);
    this.originals.set(proxy, original);
    return proxy;
  }
}

export const d1QuotaCircuit = new D1QuotaCircuit();

export const PANEL_READ_PATHS = new Set(['/api/demo/state', '/api/demo/catalog-selection', '/api/demo/sync-control']);

/** Retired panel bundles poll every 15 seconds. Require the manual refresh client before touching D1. */
export function outdatedPanelResponse(request: Request): Response | undefined {
  if (request.method !== 'GET' || !PANEL_READ_PATHS.has(new URL(request.url).pathname) || request.headers.get('X-Demo-Read') === 'manual-v1') return;
  return Response.json({
    error: 'Recarga esta página para usar la versión de la demo sin consultas automáticas.',
    code: 'CLIENT_REFRESH_REQUIRED',
  }, { status: 409, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

export function needsDatabase(path: string): boolean {
  return !(/^\/(?:admin\/documentacion(?:\/|$)|images\/|fonts\/|_astro\/|favicon\.|robots\.txt$)/.test(path) || path === '/api/demo/scheduler');
}

export function d1PausedResponse(request: Request, until: number, now = Date.now()): Response {
  const retryAfter = String(Math.max(1, Math.ceil((until - now) / 1000)));
  const headers = { 'Retry-After': retryAfter, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  if (new URL(request.url).pathname.startsWith('/api/')) return Response.json({
    error: new D1ReadLimitError().message, code: 'D1_READ_LIMIT', resume_at: new Date(until).toISOString(),
  }, { status: 503, headers });
  const resume = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(until);
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Demo en pausa · FarmaHouse</title><style>*{box-sizing:border-box}body{margin:0;background:#f7faf4;color:#2e3c28;font:16px/1.7 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:650px;background:white;border:1px solid #dfe8d6;border-radius:20px;padding:clamp(24px,6vw,52px)}small{color:#527335;letter-spacing:1.5px}h1{font-size:clamp(28px,5vw,40px);line-height:1.2;margin:20px 0}p{color:#5c6b51}strong{color:#354c27}.status{padding:16px 20px;background:#eef5e6;border-radius:10px}nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:28px}a{color:#3f6526;padding:10px 0;font-weight:600}a:focus-visible{outline:3px solid #80ac4d;outline-offset:4px}</style></head><body><main><small>FARMAHOUSE · DEMOSTRACIÓN</small><h1>La demo está temporalmente en pausa.</h1><p>Hemos alcanzado el límite diario de lecturas de la base de datos. Los datos se conservan; el catálogo y las operaciones estarán disponibles cuando se restablezca la cuota.</p><p class="status"><strong>Reanudación prevista: ${resume}, hora de Madrid.</strong><br>No hay tareas programadas ni reintentos automáticos.</p><nav><a href="/">Volver a comprobar</a><a href="/admin/documentacion/uso-d1">Qué está pasando ↗</a></nav></main></body></html>`, { status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

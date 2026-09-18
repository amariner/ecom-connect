/**
 * Rate limiting best-effort en memoria (ventana fija por clave).
 *
 * Sin bindings ni servicios: el estado vive en el isolate del Worker, así que
 * el límite es por PoP/isolate y se pierde en cada reinicio. Suficiente como
 * freno de abuso barato para la demo (spam de pedidos, scraping del quote);
 * el límite duro de plataforma (WAF/Rate Limiting de Cloudflare) se configura
 * aparte en el dashboard y no sustituye a esto en coste 0.
 */

type Bucket = { windowStart: number; count: number };

export type RateLimitRule = {
  /** Peticiones permitidas por ventana. */
  limit: number;
  /** Tamaño de la ventana en ms. */
  windowMs: number;
};

/** Nº máximo de claves retenidas; al superarlo se purgan las ventanas caducadas. */
const MAX_KEYS = 5000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /** true = dentro del límite; false = bloquear con 429. */
  check(key: string, rule: RateLimitRule, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= rule.windowMs) {
      if (this.buckets.size >= MAX_KEYS) this.evictExpired(rule.windowMs, now);
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count++;
    return bucket.count <= rule.limit;
  }

  /** Segundos hasta que la clave vuelve a tener hueco (para Retry-After). */
  retryAfterSeconds(key: string, rule: RateLimitRule, now: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    return Math.max(1, Math.ceil((bucket.windowStart + rule.windowMs - now) / 1000));
  }

  private evictExpired(windowMs: number, now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= windowMs) this.buckets.delete(key);
    }
    // Si todo está vivo (ataque distribuido), vaciar: mejor perder contadores
    // que crecer sin techo.
    if (this.buckets.size >= MAX_KEYS) this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

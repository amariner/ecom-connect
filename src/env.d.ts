/// <reference types="astro/client" />

type D1Database = import('@cloudflare/workers-types').D1Database;
type D1PreparedStatement = import('@cloudflare/workers-types').D1PreparedStatement;
type D1Result<T = unknown> = import('@cloudflare/workers-types').D1Result<T>;
type RateLimit = import('@cloudflare/workers-types').RateLimit;

type Env = {
  DB: D1Database;
  DEMO_MODE: string;
  OMNICHANNEL_DEMO: string;
  GROUPED_CRON_ENABLED?: string;
  /** Rollout R2.3: legacy | shadow (por defecto) | variant. */
  CATALOG_READ_MODE?: string;
  /** Assets estáticos del Worker (dist/). Puede faltar en `astro dev`. */
  ASSETS?: { fetch: (req: Request | string) => Promise<Response> };
  /** Si falta, el checkout simula el pago (demo). Con clave → Stripe real. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** HMAC R5.1 por despliegue; si falta, checkout conserva el modo invitado. */
  CUSTOMER_PROFILE_HMAC_SECRET?: string;
  /** HMAC exclusivo de cookies/CSRF de cuenta; nunca reutiliza ADMIN_COOKIE_SECRET. */
  CUSTOMER_AUTH_CSRF_SECRET?: string;
  /** Binding Cloudflare de límite por IP. Obligatorio solo con CUS-003 active. */
  CUSTOMER_AUTH_RATE_LIMIT?: RateLimit;
  /** Referencias operativas no secretas exigidas por el preflight de CUS-003. */
  CUSTOMER_AUTH_RATE_LIMIT_ATTESTATION?: string;
  CUSTOMER_AUTH_RESEND_TRACKING_ATTESTATION?: string;
  /** Identificador del dominio emisor verificado en Resend; no es una credencial. */
  CUSTOMER_AUTH_RESEND_DOMAIN_ID?: string;
  ADMIN_COOKIE_SECRET: string;
  /** Solo producción: si falta (o DEMO_MODE=true), los emails se quedan en la outbox. */
  RESEND_API_KEY?: string;
};

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}

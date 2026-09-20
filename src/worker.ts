/**
 * Entry point personalizado del Worker (ver `workerEntryPoint` en astro.config.mjs).
 *
 * Envuelve el handler `fetch` estándar de Astro y añade un handler `scheduled`
 * para procesar pedidos ficticios pendientes cuando se habiliten el flag
 * GROUPED_CRON_ENABLED y un trigger cron (desactivados en este despliegue). Cada ejecución
 * queda registrada y respeta la pausa del panel. No activa el
 * dispatcher de integraciones externas del proyecto original.
 */
import type {
  ExecutionContext,
  ExportedHandlerFetchHandler,
  ScheduledController,
} from '@cloudflare/workers-types';
import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { runScheduledDispatch } from './lib/demo';

type WorkerEnv = Env & {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
};

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  return {
    default: {
      async fetch(
        request: Parameters<ExportedHandlerFetchHandler>[0],
        env: WorkerEnv,
        context: ExecutionContext,
      ) {
        return handle(manifest, app, request, env, context);
      },
      async scheduled(_controller: ScheduledController, env: WorkerEnv, context: ExecutionContext) {
        if (env.DEMO_MODE === 'true' && env.OMNICHANNEL_DEMO === 'true' && env.GROUPED_CRON_ENABLED === 'true') {
          context.waitUntil(runScheduledDispatch(env.DB).then(() => undefined));
        }
      },
    },
  };
}

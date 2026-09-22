/**
 * Entry point personalizado del Worker (ver `workerEntryPoint` en astro.config.mjs).
 *
 * Demo manual: ningún evento programado consulta o modifica D1.
 * La configuración elimina los triggers y el handler permanece inerte incluso
 * si se recibiera un evento antiguo. Los horarios se conservan solo como ajustes.
 */
import type {
  ExecutionContext,
  ExportedHandlerFetchHandler,
  ScheduledController,
} from '@cloudflare/workers-types';
import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';

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
      async scheduled(_controller: ScheduledController, _env: WorkerEnv, _context: ExecutionContext) {},
    },
  };
}

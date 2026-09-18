import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  build: { format: 'file' },
  adapter: cloudflare({
    platformProxy: { enabled: true },
    workerEntryPoint: { path: 'src/worker.ts' },
    imageService: 'passthrough',
  }),
  vite: { plugins: [tailwindcss()] },
});

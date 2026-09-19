import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,mjs}'],
    passWithNoTests: false,
    // Cada prueba de integración aplica todas las migraciones: margen para máquinas cargadas.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

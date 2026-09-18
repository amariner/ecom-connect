import { createPublicDemoManifest } from './src/platform/configuration';

/**
 * Fuente de capacidades de este despliegue. Es configuración del motor interno
 * reutilizable; no representa un SaaS ni una plantilla comercial. El manifest mantiene deshabilitados los efectos comerciales heredados.
 * La composición src/lib/demo.ts activa exclusivamente persistencia ficticia
 * y adaptadores locales bajo el doble flag de la demo omnicanal.
 */
export const platformManifest = createPublicDemoManifest({
  id: 'ecom-connect',
  environment: 'production',
});

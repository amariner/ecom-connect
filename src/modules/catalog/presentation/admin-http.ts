import { CatalogAdminError } from '../application/product-variant-admin';

type MutationOutcome = 'applied' | 'unchanged' | 'not-found' | 'conflict' | 'invalid';

export function catalogAdminMutationResponse(outcome: MutationOutcome): Response {
  if (outcome === 'not-found') {
    return Response.json({ error: 'Recurso de catálogo no encontrado.' }, { status: 404 });
  }
  if (outcome === 'conflict') {
    return Response.json(
      { error: 'El catálogo cambió mientras se procesaba; recarga la página.' },
      { status: 409 },
    );
  }
  if (outcome === 'invalid') {
    return Response.json({ error: 'La operación dejaría el catálogo en un estado inválido.' }, { status: 400 });
  }
  return Response.json({ ok: true, unchanged: outcome === 'unchanged' });
}

export function catalogAdminErrorResponse(error: unknown): Response | null {
  if (error instanceof CatalogAdminError) {
    const status = error.code === 'invalid-selection' || error.code === 'missing-options' ? 400 : 409;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    return Response.json({ error: 'Ese nombre, valor, SKU o combinación ya existe.' }, { status: 409 });
  }
  if (error instanceof Error && /(?:CHECK|FOREIGN KEY) constraint failed/i.test(error.message)) {
    return Response.json({ error: 'La operación no respeta la configuración actual del producto.' }, { status: 409 });
  }
  return null;
}

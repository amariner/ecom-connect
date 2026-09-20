/** Cliente del área de cliente: una respuesta de error siempre llega como texto legible. */
export class AccountError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function postAccount<T>(path: string, body: Record<string,unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path,{ method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify(body), credentials:'same-origin' });
  } catch {
    throw new AccountError('No hemos podido conectar. Revisa tu conexión y vuelve a intentarlo.',0);
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* Una respuesta sin JSON se trata por su estado. */ }
  const message = payload && typeof payload === 'object' && typeof (payload as {error?:unknown}).error === 'string'
    ? (payload as {error:string}).error : null;
  if (!response.ok) {
    if (response.status === 401) throw new AccountError(message ?? 'Tu sesión ha caducado. Vuelve a entrar en tu cuenta.',401);
    throw new AccountError(message ?? 'No hemos podido completar la operación.',response.status);
  }
  return payload as T;
}

/** Un mensaje de error en pantalla, con su foco, sin repetir la misma plantilla. */
export function showMessage(element: HTMLElement, message: string, tone: 'error' | 'ok'): void {
  element.textContent = message;
  element.className = tone === 'error' ? 'form-error' : 'demo-notice account-feedback';
  element.hidden = false;
}
export function hideMessage(element: HTMLElement): void { element.hidden = true; element.textContent = ''; }

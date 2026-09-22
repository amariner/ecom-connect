export class ReadRequestError extends Error {
  readonly retryAt: number;
  readonly temporarilyLimited: boolean;

  constructor(message: string, response: Response, code?: string) {
    super(message);
    const retry = response.headers.get('retry-after');
    const seconds = retry === null ? NaN : Number(retry);
    this.retryAt = retry === null ? 0 : Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1000
      : Date.parse(retry) || 0;
    // A quota/maintenance response must not become another background retry loop.
    this.temporarilyLimited = response.status === 503 || /D1.*(?:LIMIT|QUOTA)|READ_LIMIT/i.test(code ?? '');
  }
}

/** Only explicit reads: no timer, interval or automatic retry is created. */
export function createReadRefresh(load: (signal: AbortSignal) => Promise<void>, options: {
  visible?: boolean;
  canRefresh?: () => boolean;
  onError: (error: unknown) => void;
  onLoading?: (loading: boolean) => void;
}) {
  const controller = new AbortController();
  let visible = options.visible ?? true;
  let loading = false;
  let retryAt = 0;
  let lastError: unknown;

  async function refresh() {
    if (loading || controller.signal.aborted || !visible) return;
    if (Date.now() < retryAt) { options.onError(lastError); return; }
    if (options.canRefresh && !options.canRefresh()) return;
    loading = true;
    options.onLoading?.(true);
    try {
      await load(controller.signal);
      if (controller.signal.aborted) return;
      retryAt = 0;
    } catch (error) {
      if (controller.signal.aborted) return;
      lastError = error;
      if (error instanceof ReadRequestError) {
        retryAt = error.retryAt;
      }
      options.onError(error);
    } finally {
      loading = false;
      if (!controller.signal.aborted) options.onLoading?.(false);
    }
  }
  return {
    refresh,
    setVisible(value: boolean) { visible = value; },
    stop() { controller.abort(); },
  };
}

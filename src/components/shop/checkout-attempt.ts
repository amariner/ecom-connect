type Attempt = { key: string; payload: string };
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'farmahouse:checkout-attempt';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A lost response must reuse the same attempt, including when sessionStorage fails. */
export function createCheckoutAttemptKey(storage: () => AttemptStorage, randomId = () => crypto.randomUUID()) {
  let current: Attempt | null = null;
  return (payload: string): string => {
    if (current?.payload === payload) return current.key;
    try {
      const saved: unknown = JSON.parse(storage().getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object' && 'payload' in saved && saved.payload === payload
        && 'key' in saved && typeof saved.key === 'string' && UUID.test(saved.key)) {
        current = { payload, key: saved.key };
        return current.key;
      }
    } catch { /* The in-memory attempt remains available without browser storage. */ }
    current = { payload, key: randomId() };
    try { storage().setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* Retry in this page still uses current. */ }
    return current.key;
  };
}

export const ORDER_HISTORY_PAGE_SIZE = 10;

/** The API supplies the complete history in insertion order, including equal timestamps. */
export function orderHistoryWindow<T>(events: readonly T[], visible = ORDER_HISTORY_PAGE_SIZE) {
  const limit = Number.isSafeInteger(visible) && visible > 0 ? visible : ORDER_HISTORY_PAGE_SIZE;
  const items = [...events].reverse().slice(0, limit);
  const remaining = events.length - items.length;
  return { items, total: events.length, shown: items.length, remaining, nextCount: Math.min(ORDER_HISTORY_PAGE_SIZE, remaining) };
}

export function orderHistoryDate(value: string): { label: string; datetime: string } {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) return { label: 'Fecha no disponible', datetime: '' };
  return { label: date.toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }), datetime: date.toISOString() };
}

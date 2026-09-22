/** Deterministic samples keep release checks small as the catalog grows. */
export function sampleEvenly(items, limit) {
  const values = [...items];
  if (values.length <= limit) return values;
  return Array.from({length:limit},(_,index) => values[Math.floor(index * (values.length - 1) / (limit - 1 || 1))]);
}

export function createRequestBudget(exhaustive = false) {
  const limit = exhaustive ? 2500 : 150;
  let requests = 0;
  return {
    get requests() { return requests; },
    limit,
    take() {
      if (requests >= limit) throw new Error(`Presupuesto de ${limit} solicitudes agotado. Revisa la muestra; el recorrido completo requiere --exhaustive.`);
      requests++;
    },
  };
}

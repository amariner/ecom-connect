/** Configuración compartida del motor Logic2B para esta demo independiente. */
export type ShippingZone = { id: string; label: string; postalPrefixes: string[] };
export type PartialRefundShippingPolicy = 'merchandise-only' | 'full-on-final-cancellation';
export type ShopConfig = typeof shopConfig;
export const shopConfig = {
  name: 'FarmaHouse Demo',
  legalName: 'FarmaHouse Demo (tienda ficticia de demostración)',
  backofficeName: 'Logic2B · Ecom Connect',
  email: 'demo@example.invalid',
  baseUrl: '', // Las URLs públicas se construyen desde el origen de cada solicitud.
  currency: 'eur' as const,
  orderNumberPrefix: 'FH',
  refunds: { partialShippingPolicy: 'merchandise-only' as PartialRefundShippingPolicy },
  brand: { color: '#314b36', colorDark: '#233a2b' },
  shipping: {
    zones: [
      { id: 'peninsula', label: 'Península', postalPrefixes: [
        '01','02','03','04','05','06','08','09','10','11','12','13','14','15',
        '16','17','18','19','20','21','22','23','24','25','26','27','28','29',
        '30','31','32','33','34','36','37','39','40','41','42','43','44','45',
        '46','47','48','49','50',
      ] },
      { id: 'baleares', label: 'Illes Balears', postalPrefixes: ['07'] },
      { id: 'canarias', label: 'Canarias', postalPrefixes: ['35','38'] },
      { id: 'ceuta-melilla', label: 'Ceuta y Melilla', postalPrefixes: ['51','52'] },
    ] satisfies ShippingZone[],
    seedRates: [
      { zone: 'peninsula', label: 'Envío demo · Península', price_cents: 490, free_over_cents: 4900 },
      { zone: 'baleares', label: 'Envío demo · Baleares', price_cents: 890, free_over_cents: 8000 },
      { zone: 'canarias', label: 'Envío demo · Canarias', price_cents: 1490, free_over_cents: null },
      { zone: 'ceuta-melilla', label: 'Envío demo · Ceuta y Melilla', price_cents: 1490, free_over_cents: null },
    ],
  },
  analytics: { cfBeaconToken: '' },
  legal: {
    shippingNote: 'No se realizan envíos. Tarifas y plazos exclusivamente de demostración.',
    returnsNote: 'Esta tienda ficticia no vende productos ni tramita devoluciones reales.',
  },
};

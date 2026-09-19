import { describe, expect, it, vi } from 'vitest';
import { submitCheckoutAttempt } from '../src/components/shop/checkout-controller';
import type { CheckoutAttempt } from '../src/components/shop/checkout-attempt';

const attempt: CheckoutAttempt = {key:'11111111-1111-4111-8111-111111111111',payload:{lines:[{slug:'ultima-unidad',qty:1}],customer:{name:'Cliente Demo',email:'demo@example.test',street:'Calle Demo 1',city:'Madrid',postal_code:'28001'}}};
const confirmation = {url:`/gracias?session=demo_${'a'.repeat(64)}`,order_id:12,order_number:'DEMO-12'};

describe('checkout submission recovery',() => {
  it('retries the original payload and key after a lost response without requiring a quote',async () => {
    const frozen = {...attempt,lineage:{'ultima-unidad':'original-line'}};
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce(Response.json(confirmation));
    await expect(submitCheckoutAttempt(frozen,fetcher)).rejects.toMatchObject({definitive:false});
    expect(await submitCheckoutAttempt(frozen,fetcher)).toEqual(confirmation);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = fetcher.mock.calls[0]!;
    const second = fetcher.mock.calls[1]!;
    expect(first[0]).toBe('/api/checkout/session');
    expect(second[0]).toBe(first[0]);
    expect(first[1]?.body).toBe(second[1]?.body);
    expect(JSON.parse(String(first[1]?.body))).toEqual({...attempt.payload,idempotency_key:attempt.key});
  });
  it.each([400,409,413,415])('allows correction after an explicit API rejection (%s)',async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({error:'Revisa los datos de tu pedido.'},{status}));
    await expect(submitCheckoutAttempt(attempt,fetcher)).rejects.toMatchObject({definitive:true,message:'Revisa los datos de tu pedido.'});
  });
  it.each([403,404,408,429,500,503])('preserves uncertainty when HTTP %s cannot prove the earlier outcome',async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({error:'Servicio no disponible.'},{status}));
    await expect(submitCheckoutAttempt(attempt,fetcher)).rejects.toMatchObject({definitive:false});
  });
  it.each([
    {url:'https://other.example/gracias',order_id:12},
    {url:confirmation.url+'&extra=1',order_id:12},
    {url:confirmation.url,order_id:0},
    {url:confirmation.url},
    null,
  ])('does not retire an attempt on a malformed success response',async result => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    await expect(submitCheckoutAttempt(attempt,fetcher)).rejects.toMatchObject({definitive:false});
  });
  it('keeps the attempt when JSON cannot be decoded, including a proxy error page',async () => {
    for (const status of [200,400,502]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Proxy error</html>',{status}));
      await expect(submitCheckoutAttempt(attempt,fetcher)).rejects.toMatchObject({definitive:false});
    }
  });
});

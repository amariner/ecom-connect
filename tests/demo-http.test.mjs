import { describe, expect, it, vi } from 'vitest';
import { MAX_DEMO_BODY_BYTES, readJson } from '../src/lib/demo-http';

function jsonRequest(body, headers = {}) {
  return new Request('https://demo.test/api/demo/action',{
    method:'POST',headers:{'Content-Type':'application/json',...headers},body,
    ...(body instanceof ReadableStream ? {duplex:'half'} : {}),
  });
}

describe('bounded demo JSON requests',() => {
  it('accepts JSON media types with parameters and rejects misleading types',async () => {
    expect(await readJson(jsonRequest('{"action":"sync"}',{'Content-Type':'Application/JSON; charset=utf-8'}))).toEqual({action:'sync'});
    await expect(readJson(jsonRequest('{}',{'Content-Type':'application/jsonp'}))).rejects.toMatchObject({status:415});
    await expect(readJson(jsonRequest('{}',{'Content-Type':'text/plain; application/json'}))).rejects.toMatchObject({status:415});
  });
  it('reports invalid and empty JSON as a client error',async () => {
    await expect(readJson(jsonRequest('{'))).rejects.toMatchObject({status:400});
    await expect(readJson(jsonRequest(null))).rejects.toMatchObject({status:400});
  });
  it('enforces the byte limit for Unicode without relying on Content-Length',async () => {
    const ascii = JSON.stringify('a'.repeat(MAX_DEMO_BODY_BYTES-2));
    expect(await readJson(jsonRequest(ascii))).toHaveLength(MAX_DEMO_BODY_BYTES-2);
    const unicode = JSON.stringify('é'.repeat(MAX_DEMO_BODY_BYTES/2));
    expect(unicode.length).toBeLessThan(MAX_DEMO_BODY_BYTES);
    await expect(readJson(jsonRequest(unicode))).rejects.toMatchObject({status:413});
  });
  it('stops consuming a chunked body as soon as its byte limit is exceeded',async () => {
    let consumed = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) { consumed++; controller.enqueue(new Uint8Array(16_000)); },
      cancel,
    },{highWaterMark:0});
    await expect(readJson(jsonRequest(body,{'Content-Length':'1'}))).rejects.toMatchObject({status:413});
    expect(consumed).toBe(5);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects an oversized declared body before reading it',async () => {
    const request = jsonRequest('{}',{'Content-Length':String(MAX_DEMO_BODY_BYTES+1)});
    await expect(readJson(request)).rejects.toMatchObject({status:413});
    expect(request.bodyUsed).toBe(false);
  });
});

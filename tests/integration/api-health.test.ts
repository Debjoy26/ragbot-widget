import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../api/src/server.ts';
import { fakeDb, testConfig } from '../unit/api/helpers.ts';

/**
 * Real HTTP against a really listening server on loopback.
 * The database probe is a labelled FAKE: this proves HTTP behaviour only, not the DB.
 */
describe('API over real HTTP (loopback, fake DbPing)', () => {
  let app: FastifyInstance;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    app = buildServer({
      config: testConfig({
        LOG_LEVEL: 'silent',
        BODY_LIMIT_BYTES: '128',
        CONNECTION_TIMEOUT_MS: '400',
        READY_TIMEOUT_MS: '150',
        DB_TIMEOUT_MS: '1000',
      }),
      db: fakeDb(async () => true),
    });
    app.post('/echo', async (req) => req.body);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves /health/live and /health/ready', async () => {
    const live = await fetch(`${base()}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${base()}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok' });
    expect(live.headers.get('x-content-type-options')).toBe('nosniff');
    expect(live.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects an oversized body with 413 and the error envelope', async () => {
    const res = await fetch(`${base()}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filler: 'x'.repeat(1000) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'request_id']);
    expect(body['code']).toBe('INVALID_REQUEST');
  });

  it('rejects a wrong content type with INVALID_REQUEST', async () => {
    for (const type of ['text/plain', 'application/xml', 'application/x-www-form-urlencoded']) {
      const res = await fetch(`${base()}/echo`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: 'a=1',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_REQUEST');
    }
  });

  it('refuses a cross-origin request without CORS headers and answers a preflight', async () => {
    const evil = await fetch(`${base()}/health/live`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(`${base()}/echo`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://client.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://client.example.com');
  });

  it('ignores X-Request-Id sent over the wire', async () => {
    const res = await fetch(`${base()}/health/live`, {
      headers: { 'x-request-id': 'client-chosen' },
    });
    expect(res.headers.get('x-request-id')).not.toBe('client-chosen');
  });

  it('drops a connection that stalls mid-request after CONNECTION_TIMEOUT_MS', async () => {
    const closedAfterMs = await new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const socket = connect({ port, host: '127.0.0.1' }, () => {
        // Headers promise a body that never arrives.
        socket.write(
          'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"a":',
        );
      });
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(Date.now() - started));
      setTimeout(() => {
        socket.destroy();
        reject(new Error('server did not drop the stalled connection'));
      }, 4000);
    });
    expect(closedAfterMs).toBeLessThan(3500);
  });
});

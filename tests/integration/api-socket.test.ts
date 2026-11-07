import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fakeDb, testConfig, buildTestServer } from '../unit/api/helpers.ts';

/**
 * Raw `node:net` sockets against a really listening server on loopback (P4-D1, A-3 and B-3).
 * These are the requests a normal HTTP client cannot or will not send: a malformed URL escape,
 * a broken request line, oversized headers and an over-limit chunked body. The database probe
 * is a labelled FAKE; this proves HTTP behaviour only.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

interface RawResponse {
  readonly text: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly closed: boolean;
}

function parse(text: string, closed: boolean): RawResponse {
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 4);
  const [statusLine = '', ...lines] = head.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { text, status: Number(statusLine.split(' ')[1]), headers, body, closed };
}

/** Sends the bytes, then reads until the server closes the socket or `waitMs` has passed. */
function raw(
  port: number,
  chunks: readonly (string | Buffer)[],
  waitMs = 1500,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    let text = '';
    let closed = false;
    socket.on('data', (d: Buffer) => (text += d.toString('latin1')));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      resolve(parse(text, closed));
    });
    const timer = setTimeout(() => {
      socket.destroy();
      if (!closed) resolve(parse(text, false));
    }, waitMs);
    socket.on('timeout', () => reject(new Error('socket timeout')));
  });
}

describe('API over raw sockets (loopback, fake DbPing)', () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = buildTestServer({
      config: testConfig({
        LOG_LEVEL: 'silent',
        BODY_LIMIT_BYTES: '64',
        CONNECTION_TIMEOUT_MS: '2000',
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

  it('answers a bad URL escape (/%zz) with the envelope, x-request-id and nosniff', async () => {
    const res = await raw(port, ['GET /%zz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n']);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      code: 'INVALID_REQUEST',
      request_id: res.headers['x-request-id'],
    });
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    // Nothing the client sent is echoed back.
    expect(res.text).not.toContain('%zz');
    expect(res.body).not.toMatch(/FST_ERR|not a valid url/i);
  });

  it('does not echo a bad URL carrying a secret-looking value', async () => {
    const urlSecret = randomBytes(12).toString('hex');
    const res = await raw(port, [
      `GET /%zz?token=${urlSecret} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    ]);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(urlSecret);
  });

  it('answers a bad request line with a static response that echoes nothing, then closes', async () => {
    const res = await raw(port, ['NOT-AN-HTTP-REQUEST secret-garbage-456\r\n\r\n']);
    expect(res.status).toBe(400);
    expect(res.closed).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(Object.keys(JSON.parse(res.body) as object).sort()).toEqual(['code', 'request_id']);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).not.toContain('secret-garbage-456');
    expect(res.text).not.toContain('NOT-AN-HTTP-REQUEST');
    expect(res.body).not.toMatch(/Client Error|Bad Request/);
  });

  it('answers oversized headers with 431 and a static response, then closes', async () => {
    const res = await raw(port, [
      `GET /health/live HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(40_000)}\r\n\r\n`,
    ]);
    expect(res.status).toBe(431);
    expect(res.closed).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).not.toContain('aaaaaaaa');
    expect(res.body).not.toMatch(/Exceeded maximum/);
  });

  it('rejects an over-limit chunked body with 413 and the envelope', async () => {
    const chunk = 'x'.repeat(40);
    const frame = `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
    const res = await raw(port, [
      'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
      frame, // 40 bytes
      frame, // 80 bytes in total: over the 64-byte limit
      '0\r\n\r\n',
    ]);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      code: 'INVALID_REQUEST',
      request_id: res.headers['x-request-id'],
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers HEAD for a GET route with headers and no body', async () => {
    const res = await raw(port, [
      'HEAD /health/live HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('answers HEAD for an unknown route with 404, headers and no body', async () => {
    const res = await raw(port, ['HEAD /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n']);
    expect(res.status).toBe(404);
    expect(res.body).toBe('');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps serving after the malformed requests', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(res.status).toBe(200);
  });
});

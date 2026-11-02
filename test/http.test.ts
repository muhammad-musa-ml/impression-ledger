import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createTestDb, dbAvailable, type TestDb } from './helpers/db.js';

const available = await dbAvailable();
const ALPHA = 'Bearer key-alpha-for-tests';
const BRAVO = 'Bearer key-bravo-for-tests';

let db: TestDb;
let server: http.Server;
let base = '';
let webRoot = '';

beforeAll(async () => {
  if (!available) return;
  db = await createTestDb();
  webRoot = await mkdtemp(path.join(os.tmpdir(), 'il-web-'));
  await mkdir(path.join(webRoot, 'assets'));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>report</title>');
  await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  const config: Config = loadConfig({
    DATABASE_URL: db.url,
    TENANT_KEYS: JSON.stringify({ 'key-alpha-for-tests': 'alpha', 'key-bravo-for-tests': 'bravo' }),
    LOG_REQUESTS: '0',
    WEB_ROOT: webRoot,
  });
  server = createApp({ pool: db.pool, config });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!available) return;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await db.drop();
  await rm(webRoot, { recursive: true, force: true });
});

const batch = (viewId: string) => ({
  events: [
    { eventId: `${viewId}.0`, viewId, adId: 'ad-1', type: 'first_token', tsMs: 0, seq: 0 },
    { eventId: `${viewId}.1`, viewId, adId: 'ad-1', type: 'visibility', tsMs: 0, seq: 1, visibleFraction: 1 },
    { eventId: `${viewId}.2`, viewId, adId: 'ad-1', type: 'view_end', tsMs: 1500, seq: 2 },
  ],
});

const post = (body: unknown, auth: string | null = ALPHA, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe.skipIf(!available)('HTTP API', () => {
  it('answers the health checks', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ status: 'ready' });
  });

  it('requires a known bearer key on both endpoints', async () => {
    const noKey = await post(batch('x'), null);
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get('www-authenticate')).toBe('Bearer');
    expect((await post(batch('x'), 'Bearer nope')).status).toBe(401);
    expect((await fetch(`${base}/v1/report`)).status).toBe(401);
  });

  it('accepts a batch, says so again as duplicates on a retry, and reports the count', async () => {
    const first = await post(batch('http-1'));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: 3, duplicates: 0, conflicts: [], rejected: [] });
    const retry = await post(batch('http-1'));
    expect(await retry.json()).toMatchObject({ accepted: 0, duplicates: 3 });

    const report = await (await fetch(`${base}/v1/report`, { headers: { authorization: ALPHA } })).json();
    expect(report.tenant).toBe('alpha');
    expect(report.ads).toEqual([{ adId: 'ad-1', views: 1, counted: { 'first-token': 1, 'fully-rendered': 0 } }]);
  });

  it('shows each tenant only its own ads', async () => {
    await post(batch('http-2'), BRAVO);
    const bravo = await (await fetch(`${base}/v1/report`, { headers: { authorization: BRAVO } })).json();
    expect(bravo.tenant).toBe('bravo');
    expect(bravo.ads[0].views).toBe(1);
    const alpha = await (await fetch(`${base}/v1/report`, { headers: { authorization: ALPHA } })).json();
    expect(alpha.ads[0].views).toBe(1);
  });

  it('rejects a malformed batch with the reason', async () => {
    const bad = { events: [{ eventId: 'e', viewId: 'v', adId: 'a', type: 'visibility', tsMs: 0, seq: 0 }] };
    const res = await post(bad);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_batch');
    expect(body.error.issues.length).toBeGreaterThan(0);
  });

  it('rejects unknown fields, empty batches, bad JSON and the wrong content type', async () => {
    const extra = { events: [{ ...batch('v').events[0], tenant: 'bravo' }] };
    expect((await post(extra)).status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(batch('v'), ALPHA, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('rejects a body over the size limit', async () => {
    const res = await post('{"events":[' + 'x'.repeat(1024 * 1024 + 10) + ']}');
    expect(res.status).toBe(413);
  });

  it('answers a wrong method with 405 and an Allow header', async () => {
    const res = await fetch(`${base}/v1/events`, { headers: { authorization: ALPHA } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('serves the report page and its assets, and nothing outside the web root', async () => {
    expect((await fetch(`${base}/`)).headers.get('content-type')).toContain('text/html');
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(traversal.status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/package.json`)).status).toBe(404);
  });
});

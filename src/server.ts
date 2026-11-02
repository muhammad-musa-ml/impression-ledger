import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { ingestBatch } from './ingest.js';
import { buildReport } from './report.js';
import { BatchSchema } from './schema.js';

const MAX_BODY_BYTES = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', `body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function tenantOf(req: http.IncomingMessage, config: Config): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  const tenant = match ? config.tenantKeys.get(match[1]!) : undefined;
  if (!tenant) throw new HttpError(401, 'unauthorized', 'a valid bearer key is required');
  return tenant;
}

async function serveStatic(res: http.ServerResponse, webRoot: string, urlPath: string): Promise<boolean> {
  const root = path.resolve(webRoot);
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  const type = CONTENT_TYPES[path.extname(file)];
  if (!type) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': type, 'content-length': body.length });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(deps: { pool: Pool; config: Config }): http.Server {
  const { pool, config } = deps;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (url.pathname === '/readyz') {
      await pool.query('SELECT 1');
      return sendJson(res, 200, { status: 'ready' });
    }

    if (url.pathname === '/v1/events') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'use POST', { allow: 'POST' });
      const tenant = tenantOf(req, config);
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
      }
      let json: unknown;
      try {
        json = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'invalid_json', 'body is not valid JSON');
      }
      const parsed = BatchSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((i: z.core.$ZodIssue) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        throw new HttpError(400, 'invalid_batch', 'the batch does not match the schema', { issues });
      }
      const result = await ingestBatch(pool, tenant, parsed.data.events, {
        strategies: config.strategies,
        holdBeforeCommitMs: config.holdBeforeCommitMs,
        holdAfterCommitMs: config.holdAfterCommitMs,
        ...(config.holdBeforeCommitMs > 0 || config.holdAfterCommitMs > 0
          ? {
              onTxnOpen: (info) => console.log(JSON.stringify({ msg: 'txn-open', ...info })),
              onTxnEnd: (info, outcome) => console.log(JSON.stringify({ msg: 'txn-end', outcome, txn: info.txn })),
            }
          : {}),
      });
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/v1/report') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'use GET', { allow: 'GET' });
      const tenant = tenantOf(req, config);
      return sendJson(res, 200, await buildReport(pool, tenant, config.strategies));
    }

    if (method === 'GET' && (await serveStatic(res, config.webRoot, url.pathname))) return;
    throw new HttpError(404, 'not_found', 'no such route');
  }

  const server = http.createServer((req, res) => {
    const started = performance.now();
    handle(req, res)
      .catch((err: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (err instanceof HttpError) {
          const headers: http.OutgoingHttpHeaders = {};
          if (err.status === 401) headers['www-authenticate'] = 'Bearer';
          if (err.status === 405) headers['allow'] = String(err.extra['allow']);
          const { allow: _allow, ...extra } = err.extra;
          sendJson(res, err.status, { error: { code: err.code, message: err.message, ...extra } }, headers);
        } else {
          console.error(JSON.stringify({ msg: 'unhandled', error: err instanceof Error ? err.message : String(err) }));
          sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
        }
      })
      .finally(() => {
        if (config.logRequests) {
          console.log(
            JSON.stringify({
              msg: 'request',
              method: req.method,
              path: (req.url ?? '').split('?')[0],
              status: res.statusCode,
              ms: Math.round(performance.now() - started),
            }),
          );
        }
      });
  });
  return server;
}

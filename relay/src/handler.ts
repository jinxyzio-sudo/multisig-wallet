/**
 * Relay protocol. Everything that passes through here is public data (unsigned transaction bytes
 * and signatures that are only valid for those exact bytes), so the relay is trusted for
 * availability only. Tampering is caught by the clients: the phone verifies the desktop signature and
 * shows its own simulation; the desktop verifies the phone signature before combining.
 *
 *   PUT    /v1/session/:id         create a session (409 if it exists)
 *   GET    /v1/session/:id         read it
 *   PUT    /v1/session/:id/phone   attach the phone signature (409 if already attached)
 *   GET    /v1/session/:id/phone   read the phone signature
 *   DELETE /v1/session/:id         drop the session
 */

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 256 * 1024;
const ID_RE = /^[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface Stored<T> {
  value: T;
  expiresAt: number;
}

export interface SessionStore {
  get<T>(key: string): Promise<Stored<T> | undefined>;
  put<T>(key: string, value: Stored<T>): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SessionBody {
  network: string;
  mode: 'sign' | 'execute';
  txBytes: string;
  desktopSignature: string;
  multisig: unknown;
}

export interface PhoneBody {
  signature: string;
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...CORS } });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isBase64(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && BASE64_RE.test(value);
}

function parseSession(body: unknown): SessionBody {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.network !== 'string' || b.network.length > 16) throw new HttpError(400, 'invalid network');
  if (b.mode !== 'sign' && b.mode !== 'execute') throw new HttpError(400, 'invalid mode');
  if (!isBase64(b.txBytes, MAX_BODY_BYTES)) throw new HttpError(400, 'invalid txBytes');
  if (!isBase64(b.desktopSignature, 4096)) throw new HttpError(400, 'invalid desktopSignature');
  if (typeof b.multisig !== 'object' || b.multisig === null) throw new HttpError(400, 'invalid multisig');
  return { network: b.network, mode: b.mode, txBytes: b.txBytes, desktopSignature: b.desktopSignature, multisig: b.multisig };
}

function parsePhone(body: unknown): PhoneBody {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be an object');
  const signature = (body as Record<string, unknown>).signature;
  if (!isBase64(signature, 4096)) throw new HttpError(400, 'invalid signature');
  return { signature };
}

async function live<T>(store: SessionStore, key: string, now: number): Promise<T | undefined> {
  const hit = await store.get<T>(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    await store.delete(key);
    return undefined;
  }
  return hit.value;
}

export async function handle(request: Request, store: SessionStore, now: number = Date.now()): Promise<Response> {
  if (request.method === 'OPTIONS') return empty(204);
  const url = new URL(request.url);
  const match = /^\/v1\/session\/([^/]+)(\/phone)?$/.exec(url.pathname);
  if (!match) return json(404, { error: 'not found' });
  const id = match[1] ?? '';
  if (!ID_RE.test(id)) return json(400, { error: 'invalid session id' });
  const sessionKey = `session:${id}`;
  const phoneKey = `phone:${id}`;
  const isPhone = match[2] === '/phone';

  try {
    if (!isPhone && request.method === 'PUT') {
      const body = parseSession(await readJson(request));
      if (await live(store, sessionKey, now)) return json(409, { error: 'session exists' });
      await store.put(sessionKey, { value: body, expiresAt: now + SESSION_TTL_MS });
      return json(201, { id, expiresAt: now + SESSION_TTL_MS });
    }
    if (!isPhone && request.method === 'GET') {
      const session = await live<SessionBody>(store, sessionKey, now);
      return session ? json(200, session) : json(404, { error: 'no such session' });
    }
    if (!isPhone && request.method === 'DELETE') {
      await store.delete(sessionKey);
      await store.delete(phoneKey);
      return empty(204);
    }
    if (isPhone && request.method === 'PUT') {
      const body = parsePhone(await readJson(request));
      const session = await store.get<SessionBody>(sessionKey);
      if (!session || session.expiresAt <= now) return json(404, { error: 'no such session' });
      if (await live(store, phoneKey, now)) return json(409, { error: 'phone signature already attached' });
      await store.put(phoneKey, { value: body, expiresAt: session.expiresAt });
      return json(201, { ok: true });
    }
    if (isPhone && request.method === 'GET') {
      const phone = await live<PhoneBody>(store, phoneKey, now);
      return phone ? json(200, phone) : json(404, { error: 'no phone signature yet' });
    }
    return json(405, { error: 'method not allowed' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    throw e;
  }
}

export class MemoryStore implements SessionStore {
  readonly data = new Map<string, Stored<unknown>>();
  async get<T>(key: string) {
    return this.data.get(key) as Stored<T> | undefined;
  }
  async put<T>(key: string, value: Stored<T>) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

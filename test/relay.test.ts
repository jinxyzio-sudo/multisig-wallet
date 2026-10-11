import { describe, expect, it } from 'vitest';
import { handle, MAX_BODY_BYTES, MemoryStore, SESSION_TTL_MS } from '../relay/src/handler.js';
import { parsePhoneHash, phonePageUrl, walletDeepLink } from '../src/shared/relay-client.js';

const ID = '0123456789abcdef0123456789abcdef';
const NOW = 1_760_000_000_000;
const BASE = 'https://relay.test';
const session = { network: 'mainnet', mode: 'execute', txBytes: 'AAEC', desktopSignature: 'AJk=', multisig: { threshold: 2, members: [] } };

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('relay handler', () => {
  it('runs a full session lifecycle', async () => {
    const store = new MemoryStore();
    const created = await handle(req('PUT', `/v1/session/${ID}`, session), store, NOW);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: ID, expiresAt: NOW + SESSION_TTL_MS });
    expect(created.headers.get('access-control-allow-origin')).toBe('*');

    const read = await handle(req('GET', `/v1/session/${ID}`), store, NOW + 1000);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(session);

    const noSig = await handle(req('GET', `/v1/session/${ID}/phone`), store, NOW + 1000);
    expect(noSig.status).toBe(404);

    const sig = await handle(req('PUT', `/v1/session/${ID}/phone`, { signature: 'AKs=' }), store, NOW + 2000);
    expect(sig.status).toBe(201);
    const readSig = await handle(req('GET', `/v1/session/${ID}/phone`), store, NOW + 3000);
    expect(await readSig.json()).toEqual({ signature: 'AKs=' });

    const del = await handle(req('DELETE', `/v1/session/${ID}`), store, NOW + 4000);
    expect(del.status).toBe(204);
    expect([...store.data.keys()]).toEqual([]);
  });

  it('refuses to overwrite a session or a phone signature', async () => {
    const store = new MemoryStore();
    await handle(req('PUT', `/v1/session/${ID}`, session), store, NOW);
    const again = await handle(req('PUT', `/v1/session/${ID}`, { ...session, txBytes: 'BBBB' }), store, NOW);
    expect(again.status).toBe(409);
    await handle(req('PUT', `/v1/session/${ID}/phone`, { signature: 'AKs=' }), store, NOW);
    const second = await handle(req('PUT', `/v1/session/${ID}/phone`, { signature: 'AKw=' }), store, NOW);
    expect(second.status).toBe(409);
    const read = await handle(req('GET', `/v1/session/${ID}/phone`), store, NOW);
    expect(await read.json()).toEqual({ signature: 'AKs=' });
  });

  it('expires sessions after the TTL and cleans them up', async () => {
    const store = new MemoryStore();
    await handle(req('PUT', `/v1/session/${ID}`, session), store, NOW);
    const expired = await handle(req('GET', `/v1/session/${ID}`), store, NOW + SESSION_TTL_MS);
    expect(expired.status).toBe(404);
    expect(store.data.has(`session:${ID}`)).toBe(false);
  });

  it('rejects a phone signature without a live session', async () => {
    const store = new MemoryStore();
    const res = await handle(req('PUT', `/v1/session/${ID}/phone`, { signature: 'AKs=' }), store, NOW);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such session' });
  });

  it('validates ids and bodies', async () => {
    const store = new MemoryStore();
    expect((await handle(req('GET', '/v1/session/xyz'), store, NOW)).status).toBe(400);
    expect((await handle(req('GET', '/v1/other'), store, NOW)).status).toBe(404);
    const badMode = await handle(req('PUT', `/v1/session/${ID}`, { ...session, mode: 'steal' }), store, NOW);
    expect(await badMode.json()).toEqual({ error: 'invalid mode' });
    const badJson = await handle(req('PUT', `/v1/session/${ID}`, '{nope'), store, NOW);
    expect(badJson.status).toBe(400);
    const badSig = await handle(req('PUT', `/v1/session/${ID}`, { ...session, desktopSignature: 'not base64!' }), store, NOW);
    expect(await badSig.json()).toEqual({ error: 'invalid desktopSignature' });
    const big = await handle(req('PUT', `/v1/session/${ID}`, { ...session, txBytes: 'A'.repeat(MAX_BODY_BYTES) }), store, NOW);
    expect(big.status).toBe(413);
    expect(store.data.size).toBe(0);
  });

  it('answers CORS preflight', async () => {
    const res = await handle(req('OPTIONS', `/v1/session/${ID}`), new MemoryStore(), NOW);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, PUT, DELETE, OPTIONS');
  });
});

describe('phone links', () => {
  const pageUrl = phonePageUrl({ phoneUrl: 'https://me.github.io/multisig-wallet/', relayUrl: 'https://relay.example.dev', sessionId: ID, network: 'mainnet' });

  it('puts everything in the fragment so it never reaches the page host', () => {
    expect(pageUrl).toBe(`https://me.github.io/multisig-wallet/#s=${ID}&r=https%3A%2F%2Frelay.example.dev&n=mainnet`);
    expect(parsePhoneHash(new URL(pageUrl).hash)).toEqual({ sessionId: ID, relayUrl: 'https://relay.example.dev', network: 'mainnet' });
  });

  it('wraps the page in wallet deep links', () => {
    expect(walletDeepLink('slush', pageUrl)).toBe(`https://my.slush.app/browse/${encodeURIComponent(pageUrl)}`);
    expect(walletDeepLink('okx', pageUrl)).toBe(pageUrl);
    expect(walletDeepLink('plain', pageUrl)).toBe(pageUrl);
  });

  it('rejects malformed fragments', () => {
    expect(parsePhoneHash('#s=short&r=https%3A%2F%2Fx&n=mainnet')).toBe(null);
    expect(parsePhoneHash(`#s=${ID}&r=javascript%3Aalert(1)&n=mainnet`)).toBe(null);
    expect(parsePhoneHash('')).toBe(null);
  });
});

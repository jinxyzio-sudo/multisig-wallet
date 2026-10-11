import { toHex } from '@mysten/sui/utils';
import type { MultisigConfig, Network, PhoneWallet } from './config.js';

export interface SessionPayload {
  network: Network;
  mode: 'sign' | 'execute';
  /** Base64 BCS TransactionData. */
  txBytes: string;
  /** Base64 signature by the desktop member over txBytes. */
  desktopSignature: string;
  multisig: MultisigConfig;
}

export function newSessionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function sessionUrl(relayUrl: string, id: string, suffix = ''): string {
  return `${relayUrl.replace(/\/+$/, '')}/v1/session/${id}${suffix}`;
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    // body was not json
  }
  throw new Error(`${what} failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
}

export async function createSession(relayUrl: string, id: string, payload: SessionPayload): Promise<void> {
  const res = await fetch(sessionUrl(relayUrl, id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await expectOk(res, 'create relay session');
}

export async function getSession(relayUrl: string, id: string): Promise<SessionPayload> {
  const res = await fetch(sessionUrl(relayUrl, id), { cache: 'no-store' });
  await expectOk(res, 'load relay session');
  return (await res.json()) as SessionPayload;
}

export async function putPhoneSignature(relayUrl: string, id: string, signature: string): Promise<void> {
  const res = await fetch(sessionUrl(relayUrl, id, '/phone'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signature }),
  });
  await expectOk(res, 'send phone signature');
}

/** Returns null while the phone has not signed yet. */
export async function getPhoneSignature(relayUrl: string, id: string): Promise<string | null> {
  const res = await fetch(sessionUrl(relayUrl, id, '/phone'), { cache: 'no-store' });
  if (res.status === 404) return null;
  await expectOk(res, 'poll phone signature');
  return ((await res.json()) as { signature: string }).signature;
}

export async function deleteSession(relayUrl: string, id: string): Promise<void> {
  await fetch(sessionUrl(relayUrl, id), { method: 'DELETE' }).catch(() => undefined);
}

export interface PhoneLinkParams {
  phoneUrl: string;
  relayUrl: string;
  sessionId: string;
  network: Network;
}

export function phonePageUrl(p: PhoneLinkParams): string {
  const hash = new URLSearchParams({ s: p.sessionId, r: p.relayUrl, n: p.network }).toString();
  return `${p.phoneUrl.split('#')[0]}#${hash}`;
}

/** Wraps the phone page URL in a deep link that opens it inside the wallet's in-app browser. */
export function walletDeepLink(wallet: PhoneWallet, pageUrl: string): string {
  switch (wallet) {
    case 'slush':
      return `https://my.slush.app/browse/${encodeURIComponent(pageUrl)}`;
    case 'okx':
      return `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(pageUrl)}`;
    case 'plain':
      return pageUrl;
  }
}

export function parsePhoneHash(hash: string): { sessionId: string; relayUrl: string; network: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const sessionId = params.get('s');
  const relayUrl = params.get('r');
  const network = params.get('n');
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId) || !relayUrl || !network) return null;
  if (!/^https?:\/\//.test(relayUrl)) return null;
  return { sessionId, relayUrl, network };
}

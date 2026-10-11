// Approval window. Builds and reviews the transaction, gets the desktop signature through the page,
// hands the signed bytes to the phone through the relay, then combines and executes.
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';
import qrcode from 'qrcode-generator';
import { analyzeTransaction, type Report } from '../shared/analyze.js';
import { combineSignatures, loadMultisig, verifyMemberSignature } from '../shared/multisig.js';
import { createSession, deleteSession, getPhoneSignature, newSessionId, phonePageUrl, walletDeepLink } from '../shared/relay-client.js';
import { coinInfoLookup, createClient, simulate } from '../shared/rpc.js';
import { h, hasDanger, renderReport, shortAddress } from '../shared/ui.js';
import type { BackgroundToWindow, Mode, SignResult, WindowToBackground } from './messages.js';

const config = __WALLET_CONFIG__;
const multisig = loadMultisig(config.multisig);
const desktopMember = multisig.memberByRole('desktop');
const phoneMember = multisig.memberByRole('phone');
const client = createClient(config.network);
const coinInfo = coinInfoLookup(client);
const PHONE_TIMEOUT_MS = 9 * 60 * 1000;
const POLL_MS = 1500;

const requestId = new URLSearchParams(location.search).get('r') ?? '';
const port = chrome.runtime.connect({ name: 'approve' });
const app = document.getElementById('app')!;
const statusEl = h('div', { class: 'status' }, 'Connecting…');
const body = h('div');
let finished = false;
let sessionId: string | null = null;

app.append(
  h('h1', {}, `Sui Multisig ${multisig.threshold}/${multisig.members.length}`),
  h('div', { class: 'addr muted' }, `${multisig.address} · ${config.network}`),
  statusEl,
  body,
);

function setStatus(text: string, kind: '' | 'error' | 'done' = ''): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function send(message: WindowToBackground): void {
  port.postMessage(message);
}

function finish(result: { ok: true; result: SignResult } | { ok: false; message: string }): void {
  if (finished) return;
  finished = true;
  send(result.ok ? { type: 'done', requestId, ok: true, result: result.result } : { type: 'done', requestId, ok: false, message: result.message });
  if (sessionId) void deleteSession(config.relayUrl, sessionId);
}

function cancelButton(): HTMLElement {
  const b = h('button', { class: 'secondary' }, 'Reject');
  b.addEventListener('click', () => {
    finish({ ok: false, message: 'User rejected the request' });
    window.close();
  });
  return b;
}

function waitForClick(button: HTMLElement): Promise<void> {
  return new Promise((resolve) => button.addEventListener('click', () => resolve(), { once: true }));
}

let desktopWaiter: { resolve: (v: { bytes: string; signature: string }) => void; reject: (e: Error) => void } | null = null;

function requestDesktopSignature(txBytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
  return new Promise((resolve, reject) => {
    desktopWaiter = { resolve, reject };
    send({ type: 'desktop-sign', requestId, txBytes: toBase64(txBytes), desktopAddress: desktopMember.address });
  });
}

async function review(txBytes: Uint8Array): Promise<Report> {
  const simulation = await simulate(client, txBytes);
  return analyzeTransaction({
    txBytes,
    multisigAddress: multisig.address,
    ownAddresses: multisig.members.map((m) => m.address),
    simulation,
    knownPackages: config.knownPackages,
    coinInfo,
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderQr(link: string, plainUrl: string): HTMLElement {
  const make = (text: string) => {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(4, 2);
  };
  const img = h('img', { src: make(link), alt: 'Scan with your phone' }) as HTMLImageElement;
  let hint: HTMLElement;
  if (link === plainUrl) {
    // A plain URL scanned with the phone camera opens the system browser, which has no wallet.
    hint = h('p', { class: 'small muted' }, "Scan with the wallet app's own scanner, not the phone camera.");
  } else {
    const toggle = h('a', { href: '#' }, 'QR does not open the wallet? Show a plain link instead');
    let plain = false;
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      plain = !plain;
      img.src = make(plain ? plainUrl : link);
      toggle.textContent = plain ? 'Show the wallet deep link QR again' : 'QR does not open the wallet? Show a plain link instead';
    });
    hint = h('p', { class: 'small muted' }, toggle);
  }
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, `Scan with your phone (${phoneMember.label})`),
    h('div', { class: 'qr' }, img),
    hint,
    h('p', { class: 'small muted' }, 'Or open on the phone: ', h('a', { id: 'phone-link', href: plainUrl, target: '_blank', rel: 'noreferrer' }, plainUrl)),
  );
}

async function runConnect(origin: string): Promise<void> {
  setStatus('Connection request');
  const approve = h('button', {}, 'Connect');
  const deny = h('button', { class: 'secondary' }, 'Reject');
  body.append(
    h('div', { class: 'card' },
      h('p', {}, 'This site wants to see your multisig address:'),
      h('p', { class: 'addr' }, origin),
      approve,
      deny),
  );
  approve.addEventListener('click', () => {
    send({ type: 'connect-decision', requestId, approved: true });
    finished = true;
    window.close();
  });
  deny.addEventListener('click', () => {
    send({ type: 'connect-decision', requestId, approved: false });
    finished = true;
    window.close();
  });
}

async function runTransaction(origin: string, mode: Mode, txJson: string): Promise<void> {
  body.append(h('p', { class: 'small muted' }, `Request from ${origin}`));
  setStatus('Building transaction…');
  const tx = Transaction.from(txJson);
  const declared = tx.getData().sender;
  if (declared && normalizeSuiAddress(declared) !== normalizeSuiAddress(multisig.address)) {
    throw new Error(`The dApp set sender ${declared}, which is not this multisig`);
  }
  tx.setSenderIfNotSet(multisig.address);
  const built = await tx.build({ client });

  setStatus('Simulating…');
  let report = await review(built);
  const reportSlot = h('div', { class: 'card' }, renderReport(report));
  const actions = h('div');
  body.append(reportSlot, actions);

  if (hasDanger(report) || !report.simulationOk) {
    setStatus('Review the warnings before signing', 'error');
    const go = h('button', { class: 'danger' }, `I understand, sign with ${config.desktopWallet}`);
    actions.replaceChildren(go, cancelButton());
    await waitForClick(go);
  }
  actions.replaceChildren(cancelButton());

  setStatus(`Approve in ${config.desktopWallet} (${desktopMember.label})…`);
  const desktop = await requestDesktopSignature(built);
  const canonical = fromBase64(desktop.bytes);
  if (!sameBytes(canonical, built)) {
    // The wallet rebuilt the transaction. Review what it actually signed.
    report = await review(canonical);
    reportSlot.replaceChildren(
      h('p', { class: 'finding warn' }, `${config.desktopWallet} changed the transaction bytes; showing what was signed.`),
      renderReport(report),
    );
    if (normalizeSuiAddress(Transaction.from(canonical).getData().sender ?? '') !== normalizeSuiAddress(multisig.address)) {
      throw new Error('Signed transaction has a different sender');
    }
  }
  await verifyMemberSignature(canonical, desktop.signature, desktopMember);

  setStatus('Sending to phone…');
  sessionId = newSessionId();
  await createSession(config.relayUrl, sessionId, {
    network: config.network,
    mode,
    txBytes: toBase64(canonical),
    desktopSignature: desktop.signature,
    multisig: config.multisig,
  });
  const pageUrl = phonePageUrl({ phoneUrl: config.phoneUrl, relayUrl: config.relayUrl, sessionId, network: config.network });
  actions.before(renderQr(walletDeepLink(config.phoneWallet, pageUrl), pageUrl));
  setStatus(`Waiting for ${phoneMember.label}…`);

  const deadline = Date.now() + PHONE_TIMEOUT_MS;
  let phoneSignature: string | null = null;
  while (!phoneSignature) {
    if (finished) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the phone signature');
    try {
      phoneSignature = await getPhoneSignature(config.relayUrl, sessionId);
    } catch {
      // transient relay error, keep polling
    }
    if (!phoneSignature) await sleep(POLL_MS);
  }
  await verifyMemberSignature(canonical, phoneSignature, phoneMember);
  const signature = await combineSignatures(multisig, canonical, [desktop.signature, phoneSignature]);
  let result: SignResult = { bytes: toBase64(canonical), signature };

  if (mode === 'execute') {
    setStatus('Submitting…');
    const executed = await client.core.executeTransaction({
      transaction: canonical,
      signatures: [signature],
      include: { effects: true },
    });
    const t = executed.$kind === 'Transaction' ? executed.Transaction : executed.FailedTransaction;
    let effects = t.effects.bcs;
    if (!effects) {
      const fetched = await client.core.waitForTransaction({ digest: t.digest, include: { effects: true } });
      effects = (fetched.$kind === 'Transaction' ? fetched.Transaction : fetched.FailedTransaction).effects.bcs;
    }
    if (!effects) throw new Error(`Executed ${t.digest} but could not load its effects`);
    result = { ...result, digest: t.digest, effects: toBase64(effects) };
    const ok = t.status.success;
    setStatus(ok ? `Done · ${shortAddress(t.digest)}` : `Executed but failed on chain: ${t.status.error?.message}`, ok ? 'done' : 'error');
  } else {
    setStatus('Signed. The dApp will submit it.', 'done');
  }
  finish({ ok: true, result });
  setTimeout(() => window.close(), 2500);
}

port.onMessage.addListener((message: BackgroundToWindow) => {
  switch (message.type) {
    case 'connect-request':
      void runConnect(message.origin);
      return;
    case 'transaction-request':
      runTransaction(message.origin, message.mode, message.txJson).catch((e: unknown) => {
        const text = e instanceof Error ? e.message : String(e);
        setStatus(text, 'error');
        finish({ ok: false, message: text });
      });
      return;
    case 'desktop-signed':
      desktopWaiter?.resolve({ bytes: message.bytes, signature: message.signature });
      desktopWaiter = null;
      return;
    case 'desktop-failed':
      desktopWaiter?.reject(new Error(message.message));
      desktopWaiter = null;
      return;
  }
});

port.onDisconnect.addListener(() => {
  if (!finished) setStatus('Extension restarted; close this window and retry.', 'error');
});

window.addEventListener('beforeunload', () => {
  if (!finished && sessionId) void deleteSession(config.relayUrl, sessionId);
});

send({ type: 'hello', requestId });

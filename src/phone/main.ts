// Phone signer. Opened from the QR code inside the mobile wallet's in-app browser. Everything it
// shows is computed here, with a fullnode chosen by this page, never by the computer or the relay.
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { getWallets, signTransaction, type StandardConnectFeature, type SuiWalletFeatures, type WalletAccount, type WalletWithFeatures } from '@mysten/wallet-standard';
import { analyzeTransaction } from '../shared/analyze.js';
import { chainOf, isNetwork, type MultisigConfig } from '../shared/config.js';
import { loadMultisig, verifyMemberSignature, type Multisig } from '../shared/multisig.js';
import { getSession, parsePhoneHash, putPhoneSignature } from '../shared/relay-client.js';
import { coinInfoLookup, createClient, simulate } from '../shared/rpc.js';
import { h, hasDanger, renderReport } from '../shared/ui.js';

const app = document.getElementById('app')!;
const statusEl = h('div', { class: 'status' }, 'Loading…');
const body = h('div');
app.append(h('h1', {}, 'Multisig signer'), statusEl, body);

function setStatus(text: string, kind: '' | 'error' | 'done' = ''): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

interface Pinned {
  address: string;
  multisig: MultisigConfig;
}

function pinKey(network: string): string {
  return `multisig-wallet/pinned/${network}`;
}

function readPin(network: string): Pinned | null | 'unavailable' {
  try {
    const raw = localStorage.getItem(pinKey(network));
    return raw ? (JSON.parse(raw) as Pinned) : null;
  } catch {
    return 'unavailable';
  }
}

function writePin(network: string, pin: Pinned): boolean {
  try {
    localStorage.setItem(pinKey(network), JSON.stringify(pin));
    return true;
  } catch {
    return false;
  }
}

function waitForClick(button: HTMLElement): Promise<void> {
  return new Promise((resolve) => button.addEventListener('click', () => resolve(), { once: true }));
}

/**
 * Trust on first use: the first time, you compare the address against the one you wrote down at
 * setup. Afterwards any change of the multisig configuration blocks signing.
 */
async function checkTrust(network: string, ms: Multisig, config: MultisigConfig): Promise<void> {
  const pin = readPin(network);
  if (pin !== null && pin !== 'unavailable') {
    if (normalizeSuiAddress(pin.address) === normalizeSuiAddress(ms.address)) return;
    body.append(
      h('div', { class: 'card' },
        h('p', { class: 'finding danger' }, '⛔ This request is for a different multisig than the one this phone trusts.'),
        h('p', { class: 'addr' }, `Trusted: ${pin.address}`),
        h('p', { class: 'addr' }, `Request: ${ms.address}`)),
    );
    throw new Error('Multisig address mismatch. Not signing.');
  }
  const confirm = h('button', {}, 'This is my multisig, trust it');
  const card = h('div', { class: 'card' },
    h('p', {}, pin === 'unavailable'
      ? 'This browser cannot remember the address. Check it against your setup notes every time:'
      : 'First use on this phone. Check this address against your setup notes:'),
    h('p', { class: 'addr' }, ms.address),
    confirm);
  body.append(card);
  setStatus('Confirm the multisig address');
  await waitForClick(confirm);
  if (pin !== 'unavailable') writePin(network, { address: ms.address, multisig: config });
  card.remove();
}

type SigningWallet = WalletWithFeatures<Partial<SuiWalletFeatures> & StandardConnectFeature>;

async function findSigner(address: string): Promise<{ wallet: SigningWallet; account: WalletAccount }> {
  const wanted = normalizeSuiAddress(address);
  const wallets = getWallets()
    .get()
    .filter((w) => 'standard:connect' in w.features && ('sui:signTransaction' in w.features || 'sui:signTransactionBlock' in w.features)) as SigningWallet[];
  if (wallets.length === 0) throw new Error('No Sui wallet found. Open this page inside your wallet app browser.');
  for (const wallet of wallets) {
    let account = wallet.accounts.find((a) => normalizeSuiAddress(a.address) === wanted);
    if (!account) {
      try {
        const connected = await wallet.features['standard:connect'].connect();
        account = connected.accounts.find((a) => normalizeSuiAddress(a.address) === wanted);
      } catch {
        continue;
      }
    }
    if (account) return { wallet, account };
  }
  throw new Error(`None of the wallets here exposes the phone key account ${wanted}. Switch to it in your wallet and retry.`);
}

async function main(): Promise<void> {
  const params = parsePhoneHash(location.hash);
  if (!params) {
    setStatus('Open this page by scanning the QR code shown by the browser extension.');
    return;
  }
  if (!isNetwork(params.network)) throw new Error(`Unknown network ${params.network}`);
  const network = params.network;
  const client = createClient(network);

  const session = await getSession(params.relayUrl, params.sessionId);
  if (session.network !== network) throw new Error('Network in the request does not match the link');
  const ms = loadMultisig(session.multisig);
  await checkTrust(network, ms, session.multisig);

  const txBytes = fromBase64(session.txBytes);
  const desktopMember = ms.memberByRole('desktop');
  const phoneMember = ms.memberByRole('phone');
  await verifyMemberSignature(txBytes, session.desktopSignature, desktopMember);

  setStatus('Simulating on this phone…');
  const report = await analyzeTransaction({
    txBytes,
    multisigAddress: ms.address,
    ownAddresses: ms.members.map((m) => m.address),
    simulation: await simulate(client, txBytes),
    knownPackages: {},
    // The package list lives in the desktop config, which this page does not trust. Calls are listed instead.
    flagUnknownPackages: false,
    coinInfo: coinInfoLookup(client),
  });
  const danger = hasDanger(report) || !report.simulationOk;
  body.append(
    h('div', { class: 'card' },
      h('p', { class: 'small muted' }, `✓ ${desktopMember.label} already signed exactly these bytes`),
      h('p', { class: 'addr muted' }, `${ms.address} · ${network} · ${session.mode === 'execute' ? 'Computer submits after you sign' : 'dApp submits after you sign'}`),
      renderReport(report)),
  );

  const sign = h('button', { class: danger ? 'danger' : '' }, danger ? 'I understand, sign anyway' : `Sign with ${phoneMember.label}`);
  body.append(sign);
  setStatus(danger ? 'Review the warnings before signing' : 'Review and sign', danger ? 'error' : '');
  await waitForClick(sign);
  sign.setAttribute('disabled', 'true');

  setStatus('Approve in your wallet…');
  const { wallet, account } = await findSigner(phoneMember.address);
  const tx = Transaction.from(txBytes);
  const signed = await signTransaction(wallet, { transaction: { toJSON: () => tx.toJSON() }, account, chain: chainOf(network) });
  if (signed.bytes !== session.txBytes) {
    throw new Error('The wallet changed the transaction, so the two signatures would not match. Not sending.');
  }
  await verifyMemberSignature(txBytes, signed.signature, phoneMember);
  await putPhoneSignature(params.relayUrl, params.sessionId, signed.signature);
  sign.remove();
  setStatus('Signed. Your computer will finish the transaction.', 'done');
}

main().catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e), 'error'));

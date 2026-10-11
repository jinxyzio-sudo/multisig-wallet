// Minimal "send SUI" page for the multisig. Served on 127.0.0.1 by `npm run send`, where the
// extension injects its wallet. Also handy to move funds out without a dApp.
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  getWallets,
  type StandardConnectFeature,
  type SuiSignAndExecuteTransactionFeature,
  type WalletAccount,
  type WalletWithFeatures,
} from '@mysten/wallet-standard';
import { formatUnits } from '../shared/analyze.js';
import { GRPC_URLS, isNetwork, type Network } from '../shared/config.js';
import { h } from '../shared/ui.js';

type MultisigWallet = WalletWithFeatures<StandardConnectFeature & SuiSignAndExecuteTransactionFeature>;

const app = document.getElementById('app')!;
const status = h('div', { class: 'status' }, 'Looking for the Sui Multisig extension…');
const body = h('div');
app.append(h('h1', {}, 'Send SUI from the multisig'), status, body);

function setStatus(text: string, kind: '' | 'error' | 'done' = ''): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function findWallet(): MultisigWallet | undefined {
  return getWallets()
    .get()
    .find((w) => w.name.startsWith('Sui Multisig')) as MultisigWallet | undefined;
}

function parseSui(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text.trim());
  if (!m) throw new Error('Amount must be a number with at most 9 decimals');
  return BigInt(m[1]!) * 1_000_000_000n + BigInt((m[2] ?? '').padEnd(9, '0') || '0');
}

async function connected(wallet: MultisigWallet, account: WalletAccount): Promise<void> {
  const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';
  const network = chain.slice(4);
  if (!isNetwork(network)) throw new Error(`Unsupported chain ${chain}`);
  const client = new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network as Network] });
  const balanceEl = h('p', { class: 'addr' }, 'Balance: …');
  const refresh = async () => {
    const { balance } = await client.core.getBalance({ owner: account.address, coinType: '0x2::sui::SUI' });
    balanceEl.textContent = `Balance: ${formatUnits(BigInt(balance.balance), 9)} SUI`;
  };
  const to = h('input', { placeholder: 'Recipient 0x…', style: 'width:100%;padding:10px;border-radius:8px' }) as HTMLInputElement;
  const amount = h('input', { placeholder: 'Amount in SUI, e.g. 0.05', style: 'width:100%;padding:10px;border-radius:8px;margin-top:8px' }) as HTMLInputElement;
  const send = h('button', {}, 'Send');
  const result = h('div');
  send.addEventListener('click', async () => {
    result.replaceChildren();
    try {
      const recipient = to.value.trim();
      if (!isValidSuiAddress(recipient)) throw new Error('Recipient is not a valid Sui address');
      const mist = parseSui(amount.value);
      if (mist <= 0n) throw new Error('Amount must be above zero');
      const tx = new Transaction();
      tx.setSender(account.address);
      const [coin] = tx.splitCoins(tx.gas, [mist]);
      tx.transferObjects([coin!], normalizeSuiAddress(recipient));
      send.setAttribute('disabled', 'true');
      setStatus('Approve in the extension window…');
      const out = await wallet.features['sui:signAndExecuteTransaction'].signAndExecuteTransaction({ transaction: tx, account, chain });
      setStatus('Sent', 'done');
      result.append(h('p', { class: 'addr' }, 'Digest: ', h('a', { href: `https://suiscan.xyz/${network}/tx/${out.digest}`, target: '_blank', rel: 'noreferrer' }, out.digest)));
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      send.removeAttribute('disabled');
    }
  });
  body.replaceChildren(
    h('div', { class: 'card' }, h('h3', {}, `Multisig (${network})`), h('p', { class: 'addr' }, account.address), balanceEl),
    h('div', { class: 'card' }, to, amount, send, result),
  );
  setStatus('Connected');
  await refresh();
}

function start(): void {
  const wallet = findWallet();
  if (!wallet) return;
  setStatus('Extension found');
  const connect = h('button', {}, 'Connect Sui Multisig');
  connect.addEventListener('click', async () => {
    try {
      const { accounts } = await wallet.features['standard:connect'].connect();
      const account = accounts[0];
      if (!account) throw new Error('Connection was rejected');
      await connected(wallet, account);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), 'error');
    }
  });
  body.replaceChildren(connect);
}

start();
getWallets().on('register', start);

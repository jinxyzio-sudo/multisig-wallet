// Setup helper: open inside a wallet (Slush extension, OKX app...) to read the public key of an
// account, which the config needs. Wallet UIs show addresses, not public keys.
import { toHex } from '@mysten/sui/utils';
import { getWallets, type StandardConnectFeature, type WalletAccount, type WalletWithFeatures } from '@mysten/wallet-standard';
import { h } from '../shared/ui.js';
import { accountPublicKey, isSuiAccount, isSuiWallet, schemeName } from '../shared/wallets.js';

const app = document.getElementById('app')!;
const list = h('div');
app.append(
  h('h1', {}, 'Read a Sui public key'),
  h('p', { class: 'muted' }, 'Connect the wallet, then copy the public key of the account you want in the multisig.'),
  list,
);

function copyButton(label: string, text: string): HTMLElement {
  const b = h('button', {}, label);
  b.addEventListener('click', () => {
    void navigator.clipboard.writeText(text).then(() => {
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = label), 1500);
    });
  });
  return b;
}

function accountCard(account: WalletAccount): HTMLElement {
  const pk = accountPublicKey(account);
  if (pk) {
    return h('div', { class: 'card' },
      h('h3', {}, 'Address'),
      h('p', { class: 'addr' }, account.address),
      h('h3', {}, `Public key (${schemeName(pk)})`),
      h('p', { class: 'addr' }, pk.toSuiPublicKey()),
      copyButton('Copy public key', pk.toSuiPublicKey()));
  }
  const raw = new Uint8Array(account.publicKey);
  return h('div', { class: 'card' },
    h('h3', {}, 'Address'),
    h('p', { class: 'addr' }, account.address),
    h('p', { class: 'finding warn' }, 'This wallet did not hand out a public key that matches this address.'),
    h('p', { class: 'small' }, 'Get it from the chain instead: send 0.001 SUI from this account to itself, then send the address over. The key is read from that transaction.'),
    copyButton('Copy address', account.address),
    h('p', { class: 'small muted' }, `Wallet returned ${raw.length} bytes${raw.length ? `: ${toHex(raw).slice(0, 80)}` : ''}`));
}

function render(): void {
  list.replaceChildren();
  const wallets = getWallets()
    .get()
    .filter((w) => isSuiWallet(w) && !w.name.startsWith('Sui Multisig')) as WalletWithFeatures<StandardConnectFeature>[];
  if (wallets.length === 0) {
    list.append(h('p', { class: 'status' }, 'No Sui wallet found. Open this page inside your wallet app, or install the extension.'));
    return;
  }
  for (const wallet of wallets) {
    const button = h('button', { class: 'secondary' }, `Connect ${wallet.name}`);
    const out = h('div');
    button.addEventListener('click', async () => {
      out.replaceChildren(h('p', { class: 'muted small' }, 'Waiting for the wallet…'));
      try {
        const { accounts } = await wallet.features['standard:connect'].connect();
        const sui = accounts.filter(isSuiAccount);
        out.replaceChildren(...(sui.length ? sui.map(accountCard) : [h('p', { class: 'status' }, 'The wallet returned no Sui account.')]));
      } catch (e) {
        out.replaceChildren(h('p', { class: 'status error' }, e instanceof Error ? e.message : String(e)));
      }
    });
    list.append(button, out);
  }
}

render();
getWallets().on('register', render);

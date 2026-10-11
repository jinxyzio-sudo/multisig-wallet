// Setup helper: open inside a wallet (Slush extension, Slush app, OKX...) to read the public key of
// an account, which the config needs. Wallet UIs show addresses, not public keys.
import { SIGNATURE_FLAG_TO_SCHEME, type SignatureScheme } from '@mysten/sui/cryptography';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { publicKeyFromRawBytes } from '@mysten/sui/verify';
import { getWallets, type StandardConnectFeature, type WalletAccount, type WalletWithFeatures } from '@mysten/wallet-standard';
import { h } from '../shared/ui.js';

const SCHEMES = Object.values(SIGNATURE_FLAG_TO_SCHEME).filter((s): s is SignatureScheme => s === 'ED25519' || s === 'Secp256k1' || s === 'Secp256r1');

function suiPublicKey(account: WalletAccount): { scheme: string; base64: string } | null {
  for (const scheme of SCHEMES) {
    try {
      const pk = publicKeyFromRawBytes(scheme, new Uint8Array(account.publicKey));
      if (normalizeSuiAddress(pk.toSuiAddress()) === normalizeSuiAddress(account.address)) return { scheme, base64: pk.toSuiPublicKey() };
    } catch {
      // wrong length for this scheme
    }
  }
  return null;
}

const app = document.getElementById('app')!;
const list = h('div');
app.append(h('h1', {}, 'Read a public key'), h('p', { class: 'muted' }, 'Pick the wallet, approve the connection, copy the key of the account you want in the multisig.'), list);

function render(): void {
  list.replaceChildren();
  const wallets = getWallets().get().filter((w) => 'standard:connect' in w.features && !w.name.startsWith('Sui Multisig'));
  if (wallets.length === 0) list.append(h('p', { class: 'status' }, 'No wallet found. Open this page inside your wallet app, or install the extension.'));
  for (const wallet of wallets as WalletWithFeatures<StandardConnectFeature>[]) {
    const button = h('button', { class: 'secondary' }, `Connect ${wallet.name}`);
    const out = h('div');
    button.addEventListener('click', async () => {
      out.replaceChildren();
      try {
        const { accounts } = await wallet.features['standard:connect'].connect();
        for (const account of accounts) {
          const key = suiPublicKey(account);
          const copy = h('button', {}, 'Copy public key');
          copy.addEventListener('click', () => void navigator.clipboard.writeText(key?.base64 ?? ''));
          out.append(
            h('div', { class: 'card' },
              h('p', { class: 'addr' }, `Address ${account.address}`),
              key
                ? h('div', {}, h('p', { class: 'addr' }, `${key.scheme} public key: ${key.base64}`), copy)
                : h('p', { class: 'finding warn' }, 'This account type (e.g. zkLogin) cannot be a plain multisig member here.')),
          );
        }
      } catch (e) {
        out.append(h('p', { class: 'status error' }, e instanceof Error ? e.message : String(e)));
      }
    });
    list.append(button, out);
  }
}
render();
getWallets().on('register', render);

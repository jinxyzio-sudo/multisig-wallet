// Runs in the page's MAIN world. Registers the multisig as a Wallet Standard wallet and asks the
// browser wallet that holds the desktop key to sign. It holds no keys and makes no network calls.
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  getWallets,
  ReadonlyWalletAccount,
  registerWallet,
  signTransaction,
  type StandardConnectFeature,
  type StandardConnectMethod,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
  type StandardEventsListeners,
  type StandardEventsOnMethod,
  type SuiSignAndExecuteTransactionFeature,
  type SuiSignAndExecuteTransactionInput,
  type SuiSignPersonalMessageFeature,
  type SuiSignTransactionFeature,
  type SuiSignTransactionInput,
  type Wallet,
  type WalletAccount,
  type WalletWithFeatures,
  type SuiWalletFeatures,
} from '@mysten/wallet-standard';
import { chainOf } from '../shared/config.js';
import { loadMultisig } from '../shared/multisig.js';
import { isSuiWallet } from '../shared/wallets.js';
import { CHANNEL, type Envelope, type Mode, type PageEvent, type PageRequest, type SignResult } from './messages.js';

const config = __WALLET_CONFIG__;
const multisig = loadMultisig(config.multisig);
const chain = chainOf(config.network);

const ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f2a44"/>' +
    '<path d="M32 10l18 7v13c0 12-8 20-18 24-10-4-18-12-18-24V17z" fill="#4da2ff"/>' +
    '<text x="32" y="38" font-family="Arial" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">' +
    `${config.multisig.threshold}/${config.multisig.members.length}</text></svg>`,
)}` as const;

let counter = 0;
function requestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}

function post(message: PageRequest): void {
  const envelope: Envelope<PageRequest> = { channel: CHANNEL, direction: 'to-extension', message };
  window.postMessage(envelope, '*');
}

type Waiter = { resolve: (event: PageEvent) => void };
const waiters = new Map<string, Waiter>();
/** Request ids this page started; desktop-sign events for any other id are ignored. */
const ownTransactions = new Set<string>();

function send(message: PageRequest): Promise<PageEvent> {
  return new Promise((resolve) => {
    waiters.set(message.requestId, { resolve });
    post(message);
  });
}

type SigningWallet = WalletWithFeatures<Partial<SuiWalletFeatures> & StandardConnectFeature>;

/**
 * Finds a browser wallet account that is a member of the multisig. Accounts the wallet already
 * shares with this site are used without a prompt; otherwise the configured wallet is asked.
 */
async function findDesktopSigner(memberAddresses: string[]): Promise<{ wallet: SigningWallet; account: WalletAccount }> {
  const members = new Set(memberAddresses.map((a) => normalizeSuiAddress(a)));
  const pick = (accounts: readonly WalletAccount[]) => accounts.find((a) => members.has(normalizeSuiAddress(a.address)));
  const wallets = getWallets()
    .get()
    .filter((w) => isSuiWallet(w) && !w.name.startsWith('Sui Multisig')) as SigningWallet[];
  const preferred = wallets.filter((w) => w.name === config.desktopWallet);
  for (const wallet of [...preferred, ...wallets.filter((w) => w.name !== config.desktopWallet)]) {
    const account = pick(wallet.accounts);
    if (account) return { wallet, account };
  }
  for (const wallet of preferred.length > 0 ? preferred : wallets) {
    try {
      const account = pick((await wallet.features['standard:connect'].connect()).accounts);
      if (account) return { wallet, account };
    } catch {
      // wallet refused or failed; try the next one
    }
  }
  throw new Error(`No browser wallet shares a member account of this multisig. Connect one in ${config.desktopWallet} for this site, then retry.`);
}

async function desktopSign(id: string, txBytes: string, memberAddresses: string[]): Promise<void> {
  try {
    const { wallet, account } = await findDesktopSigner(memberAddresses);
    const tx = Transaction.from(fromBase64(txBytes));
    const signed = await signTransaction(wallet, { transaction: { toJSON: () => tx.toJSON() }, account, chain });
    post({ type: 'desktop-signed', requestId: id, bytes: signed.bytes, signature: signed.signature });
  } catch (e) {
    post({ type: 'desktop-failed', requestId: id, message: e instanceof Error ? e.message : String(e) });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Envelope<PageEvent> | undefined;
  if (data?.channel !== CHANNEL || data.direction !== 'to-page') return;
  const message = data.message;
  if (message.type === 'desktop-sign') {
    if (ownTransactions.has(message.requestId)) void desktopSign(message.requestId, message.txBytes, message.memberAddresses);
    return;
  }
  const waiter = waiters.get(message.requestId);
  if (!waiter) return;
  waiters.delete(message.requestId);
  waiter.resolve(message);
});

class MultisigWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = `Sui Multisig ${config.multisig.threshold}/${config.multisig.members.length}`;
  readonly icon = ICON;
  readonly chains = [chain] as const;
  #accounts: ReadonlyWalletAccount[] = [];
  #listeners: StandardEventsListeners['change'][] = [];
  readonly #account = new ReadonlyWalletAccount({
    address: multisig.address,
    publicKey: multisig.publicKey.toRawBytes(),
    chains: [chain],
    features: ['sui:signTransaction', 'sui:signAndExecuteTransaction'],
  });

  get accounts() {
    return this.#accounts;
  }

  get features(): StandardConnectFeature &
    StandardDisconnectFeature &
    StandardEventsFeature &
    SuiSignTransactionFeature &
    SuiSignAndExecuteTransactionFeature &
    SuiSignPersonalMessageFeature {
    return {
      'standard:connect': { version: '1.0.0', connect: this.#connect },
      'standard:disconnect': { version: '1.0.0', disconnect: this.#disconnect },
      'standard:events': { version: '1.0.0', on: this.#on },
      'sui:signTransaction': { version: '2.0.0', signTransaction: (input) => this.#transaction(input, 'sign') },
      'sui:signAndExecuteTransaction': {
        version: '2.0.0',
        signAndExecuteTransaction: (input) =>
          this.#transaction(input, 'execute') as Promise<Required<SignResult>>,
      },
      'sui:signPersonalMessage': {
        version: '1.1.0',
        signPersonalMessage: async () => {
          throw new Error('Sui Multisig does not sign personal messages yet');
        },
      },
    };
  }

  #emit(): void {
    for (const listener of this.#listeners) listener({ accounts: this.accounts });
  }

  #on: StandardEventsOnMethod = (event, listener) => {
    if (event !== 'change') return () => {};
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #connect: StandardConnectMethod = async (input) => {
    if (this.#accounts.length === 0) {
      const reply = await send({ type: 'connect', requestId: requestId(), silent: input?.silent ?? false });
      if (reply.type === 'connect-result' && reply.approved) {
        this.#accounts = [this.#account];
        this.#emit();
      }
    }
    return { accounts: this.accounts };
  };

  #disconnect = async () => {
    this.#accounts = [];
    this.#emit();
  };

  async #transaction(input: SuiSignTransactionInput | SuiSignAndExecuteTransactionInput, mode: Mode): Promise<SignResult> {
    if (this.#accounts.length === 0) throw new Error('Sui Multisig is not connected to this site');
    if (input.chain !== chain) throw new Error(`Sui Multisig is configured for ${chain}, dApp asked for ${input.chain}`);
    if (normalizeSuiAddress(input.account.address) !== normalizeSuiAddress(multisig.address)) {
      throw new Error(`Unknown account ${input.account.address}`);
    }
    const txJson = await input.transaction.toJSON();
    const id = requestId();
    ownTransactions.add(id);
    try {
      const reply = await send({ type: 'transaction', requestId: id, mode, txJson });
      if (reply.type !== 'transaction-result') throw new Error('unexpected reply from extension');
      if (!reply.ok) throw new Error(reply.message);
      return reply.result;
    } finally {
      ownTransactions.delete(id);
    }
  }
}

registerWallet(new MultisigWallet());

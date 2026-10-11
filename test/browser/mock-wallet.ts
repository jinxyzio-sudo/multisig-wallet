// Test-only Wallet Standard wallet backed by a deterministic key. Stands in for Slush in the
// browser e2e test. Bundled twice: once as the desktop wallet, once as the phone wallet.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { ReadonlyWalletAccount, registerWallet, type Wallet } from '@mysten/wallet-standard';

declare const __MOCK_SEED__: number;
declare const __MOCK_NAME__: string;
/** When true, account.publicKey is garbage, like OKX hands out. */
declare const __MOCK_BAD_PK__: boolean;

const key = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(__MOCK_SEED__));
const account = new ReadonlyWalletAccount({
  address: key.toSuiAddress(),
  publicKey: __MOCK_BAD_PK__ ? new Uint8Array(32).fill(7) : key.getPublicKey().toRawBytes(),
  chains: ['sui:localnet'],
  features: ['sui:signTransaction', 'sui:signPersonalMessage'],
});
const signed: string[] = [];
(window as unknown as { __mockSigned: string[] }).__mockSigned = signed;

const wallet: Wallet = {
  version: '1.0.0',
  name: __MOCK_NAME__,
  icon: 'data:image/svg+xml;base64,PHN2Zy8+',
  chains: ['sui:localnet'],
  accounts: [account],
  features: {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
    'standard:events': { version: '1.0.0', on: () => () => {} },
    'sui:signTransaction': {
      version: '2.0.0',
      signTransaction: async (input: { transaction: { toJSON(): Promise<string> } }) => {
        // A real wallet rebuilds from JSON; a fully resolved transaction must come out identical.
        const bytes = await Transaction.from(await input.transaction.toJSON()).build();
        const { signature } = await key.signTransaction(bytes);
        signed.push(toBase64(bytes));
        return { bytes: toBase64(bytes), signature };
      },
    },
    'sui:signPersonalMessage': {
      version: '1.1.0',
      signPersonalMessage: async (input: { message: Uint8Array }) => key.signPersonalMessage(input.message),
    },
  },
};
registerWallet(wallet);

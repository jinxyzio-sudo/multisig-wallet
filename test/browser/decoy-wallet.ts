// Mimics OKX: extra Wallet Standard entries under the same name for other chains, one of which
// crashes on connect. The extension and the pages must ignore them.
import { registerWallet, type Wallet } from '@mysten/wallet-standard';

declare const __MOCK_NAME__: string;

const solanaOnly: Wallet = {
  version: '1.0.0',
  name: __MOCK_NAME__,
  icon: 'data:image/svg+xml;base64,PHN2Zy8+',
  chains: ['solana:mainnet'],
  accounts: [],
  features: {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [] }) },
    'standard:events': { version: '1.0.0', on: () => () => {} },
    'solana:signTransaction': { version: '1.0.0', signTransaction: async () => [] },
  },
};
const broken: Wallet = {
  version: '1.0.0',
  name: __MOCK_NAME__,
  icon: 'data:image/svg+xml;base64,PHN2Zy8+',
  chains: ['bitcoin:mainnet'],
  accounts: [],
  features: {
    'standard:connect': {
      version: '1.0.0',
      connect: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'requestWallets')");
      },
    },
    'standard:events': { version: '1.0.0', on: () => () => {} },
  },
};
registerWallet(solanaOnly);
registerWallet(broken);

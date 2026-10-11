import type { WalletConfig } from './shared/config.js';

declare global {
  /** Injected at build time from config/wallet.json. */
  const __WALLET_CONFIG__: WalletConfig;
}

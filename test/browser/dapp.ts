// Minimal dApp: connects to whatever wallet starts with "Sui Multisig" and sends SUI.
import { Transaction } from '@mysten/sui/transactions';
import { getWallets, type StandardConnectFeature, type SuiSignAndExecuteTransactionFeature, type WalletWithFeatures } from '@mysten/wallet-standard';

type W = WalletWithFeatures<StandardConnectFeature & SuiSignAndExecuteTransactionFeature>;

function multisigWallet(): W {
  const w = getWallets().get().find((x) => x.name.startsWith('Sui Multisig'));
  if (!w) throw new Error('multisig wallet not registered');
  return w as W;
}

const api = {
  walletNames: () => getWallets().get().map((w) => w.name),
  connect: async () => (await multisigWallet().features['standard:connect'].connect()).accounts.map((a) => a.address),
  send: async (recipient: string, amount: string) => {
    const wallet = multisigWallet();
    const account = wallet.accounts[0];
    if (!account) throw new Error('not connected');
    const tx = new Transaction();
    tx.setSender(account.address);
    const [coin] = tx.splitCoins(tx.gas, [BigInt(amount)]);
    tx.transferObjects([coin!], recipient);
    return wallet.features['sui:signAndExecuteTransaction'].signAndExecuteTransaction({ transaction: tx, account, chain: 'sui:localnet' });
  },
};
(window as unknown as { dapp: typeof api }).dapp = api;

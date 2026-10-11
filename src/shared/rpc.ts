import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import type { CoinInfo } from './analyze.js';
import { GRPC_URLS, type Network } from './config.js';

export function createClient(network: Network, baseUrl: string = GRPC_URLS[network]): SuiGrpcClient {
  return new SuiGrpcClient({ network, baseUrl });
}

export function coinInfoLookup(client: SuiGrpcClient): (coinType: string) => Promise<CoinInfo | null> {
  const cache = new Map<string, Promise<CoinInfo | null>>();
  return (coinType) => {
    const key = normalizeStructTag(coinType);
    let hit = cache.get(key);
    if (!hit) {
      hit = client.core
        .getCoinMetadata({ coinType: key })
        .then((r) => (r.coinMetadata ? { symbol: r.coinMetadata.symbol, decimals: r.coinMetadata.decimals } : null))
        .catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

export async function simulate(client: SuiGrpcClient, txBytes: Uint8Array) {
  return client.core.simulateTransaction({
    transaction: txBytes,
    include: { balanceChanges: true, effects: true, objectTypes: true },
  });
}

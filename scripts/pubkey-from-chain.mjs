// Reads an account's public key from a transaction it already sent, so no web page has to
// connect to the wallet. The account must have sent at least one transaction (e.g. 0.001 SUI to
// itself). Usage: node scripts/pubkey-from-chain.mjs 0xADDRESS [network]
import { parseSerializedSignature } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { publicKeyFromRawBytes } from '@mysten/sui/verify';

const address = normalizeSuiAddress(process.argv[2] ?? '');
const network = process.argv[3] ?? 'mainnet';
const client = new SuiGrpcClient({ network, baseUrl: `https://fullnode.${network}.sui.io:443` });

const page = await client.core.listTransactions({ filter: { sender: address }, limit: 5 });
const txs = page.transactions.map((t) => t.Transaction ?? t.FailedTransaction).filter(Boolean);
if (txs.length === 0) {
  console.error(`No transaction sent by ${address} yet. Send 0.001 SUI to yourself from that account, then retry.`);
  process.exit(1);
}
for (const tx of txs) {
  const digest = tx.digest;
  for (const signature of tx.signatures ?? []) {
    const parsed = parseSerializedSignature(signature);
    if (!('publicKey' in parsed) || !parsed.publicKey) continue;
    if (!['ED25519', 'Secp256k1', 'Secp256r1'].includes(parsed.signatureScheme)) continue;
    const pk = publicKeyFromRawBytes(parsed.signatureScheme, parsed.publicKey);
    if (normalizeSuiAddress(pk.toSuiAddress()) !== address) continue;
    console.log(`address    ${address}`);
    console.log(`scheme     ${parsed.signatureScheme}`);
    console.log(`publicKey  ${pk.toSuiPublicKey()}   (from tx ${digest})`);
    process.exit(0);
  }
}
console.error(`Found transactions from ${address}, but none signed with a plain key (zkLogin or multisig accounts cannot be members here).`);
process.exit(1);

// Prints the multisig address for config/wallet.json and the sui CLI command that derives it
// independently. Write the address down on paper next to the backup seed.
import { readFileSync } from 'node:fs';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';

const config = JSON.parse(readFileSync(process.argv[2] ?? 'config/wallet.json', 'utf8'));
const { threshold, members } = config.multisig;
const ms = MultiSigPublicKey.fromPublicKeys({
  threshold,
  publicKeys: members.map((m) => ({ publicKey: publicKeyFromSuiBytes(m.publicKey), weight: m.weight })),
});
console.log(`multisig address: ${ms.toSuiAddress()}  (${threshold}-of-${members.length}, ${config.network})\n`);
for (const m of members) console.log(`  ${m.role.padEnd(6)} w=${m.weight}  ${publicKeyFromSuiBytes(m.publicKey).toSuiAddress()}  ${m.label}`);
console.log('\nCross-check with the sui CLI (must print the same multisigAddress):');
console.log(`sui keytool multi-sig-address --pks ${members.map((m) => m.publicKey).join(' ')} --weights ${members.map((m) => m.weight).join(' ')} --threshold ${threshold}`);

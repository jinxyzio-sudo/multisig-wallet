# sui-multisig-wallet

Use a Sui native 2-of-3 multisig from any dApp, like a normal browser wallet.

- **Desktop key**: an account in your browser wallet (Slush or OKX extension).
- **Phone key**: an account in your phone wallet (Slush or OKX app).
- **Backup key**: a recovery phrase on paper. Only used when a device is lost.

On a dApp you pick **Sui Multisig 2/3** in the wallet list. When the dApp asks for a signature:

1. An approval window opens, builds the transaction and simulates it. Your browser wallet asks you to approve the desktop key.
2. The window shows a QR code. Scan it with the phone, and the phone wallet's in-app browser opens the signer page. The phone simulates the transaction itself, shows what it does, and you sign with the phone key.
3. The window combines both signatures, submits the transaction and hands the result back to the dApp.

## Security model

This repo holds **no keys**. The keys stay in Slush or OKX on two different devices. The code here only carries transactions and signatures between them.

| If this is compromised | What an attacker gets | What stops them |
|---|---|---|
| The dApp website | Can propose a malicious transaction | Both devices simulate it and show where funds go |
| This extension | Can show you wrong information | It cannot sign. Both wallets show the real transaction, and the phone simulates it independently |
| The relay | Can swap the bytes | Signatures over different bytes do not combine. The phone checks the desktop signature |
| The phone page host (GitHub) | Can serve a fake page | Only matters if the computer is compromised at the same time |
| The computer | The desktop key, and anything shown on the computer | The phone simulates on its own and shows the real recipients |
| The phone | The phone key | The desktop side |

Stealing funds takes **two** devices or services compromised at the same time.

Hardening:

- The extension is loaded unpacked and never published, so nobody can push you an update.
- Manifest V3 forbids remote code. The extension may only connect to the configured fullnode and relay (CSP).
- Fullnode URLs are fixed per network. The phone never takes an RPC URL from the QR code.
- The phone pins the multisig address the first time it is used. A different multisig blocks signing.
- Every recipient other than the multisig is shown in red, including withdrawals from lending positions that never touch your wallet balance.
- The build is deterministic: `npm run build && git diff --exit-code docs` proves the published phone page matches the source.

Not covered: you signing a red warning anyway, or both devices compromised at once.

## Setup

### 1. Create the three keys

Use **fresh** recovery phrases. Do not reuse the old single-signature wallet.

- **Desktop**: in the Slush (or OKX) extension, create a new wallet with a new recovery phrase.
- **Phone**: in the Slush (or OKX) app, create a new wallet. Generate the phrase **on the phone**, never on the computer.
- **Backup**: generate it on a **third** device, not the computer and not this phone. A spare old phone works (install Slush, create a wallet, write the phrase on paper, then factory reset it), or `sui keytool generate ed25519` on another computer. If one device ever sees two phrases, it becomes a single point of failure.

### 2. Read the public keys

Wallets show addresses, not public keys. Open the setup page inside each wallet and copy the key:

- Desktop: open `https://jinxyzio-sudo.github.io/multisig-wallet/setup.html` in Chrome with the extension installed.
- Phone: open the same URL inside the wallet app's browser.
- Backup: open the same page on the third device.

### 3. Config

```bash
cp config/wallet.example.json config/wallet.json
```

Fill in the three public keys. Keep the member order: it is part of the address. `config/wallet.json` is gitignored.

```bash
npm run address
```

The command prints the multisig address and a `sui keytool multi-sig-address` command. Run that command and check it prints the same address. Write the address, the three public keys and their order on the paper with the backup phrase.

### 4. Relay (Cloudflare Workers, free tier)

```bash
cd relay
npx wrangler@4.142.0 login
npx wrangler@4.142.0 deploy
```

Put the printed `https://sui-multisig-relay.<you>.workers.dev` into `relayUrl`.

### 5. Phone page (GitHub Pages)

```bash
npm run build -- --phone
```

Commit `docs/`. Then enable GitHub Pages: repository Settings → Pages → Deploy from a branch → `main`, folder `/docs`.

### 6. Extension

```bash
npm install
npm run build
```

In Chrome, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose `extension/dist`. After changing the config, run `npm run build` again and click reload on the extension card.

### 7. Try it with a small amount

1. Send 0.1 SUI to the multisig address.
2. Open any Sui dApp and connect **Sui Multisig 2/3**. Also connect the desktop key account in Slush to the same site once.
3. Send 0.05 SUI from the multisig to yourself through the dApp. On first use the phone asks you to confirm the address: compare it with your paper.
4. Test the recovery path once: follow `FALLBACK_CLI.txt` with the desktop key and the backup key and send 0.01 SUI.

Only after both work, move the rest. Coins, StakedSui, NFTs, LP positions and kiosk caps transfer directly. Lending positions recorded by address have to be withdrawn, moved and deposited again.

## Recovery

See `FALLBACK_CLI.txt`: the sui CLI and any two keys, no dependency on this repo. A lost phone means a new phone key, and therefore a new multisig address. Move everything to it with the desktop key and the backup key.

## Development

```bash
npm run typecheck
npm test                 # unit tests
sui start --force-regenesis --with-faucet     # in another terminal
npm run test:e2e         # localnet: real chain, relay, combine, execute
npm run test:browser     # Chromium with the real extension, mock wallets, real phone page
```

Dependencies are pinned to exact versions that were at least two weeks old when added. Upgrade deliberately, not automatically.

Known gaps:

- `signPersonalMessage` (login signatures) is not supported yet.
- Legacy `signTransactionBlock` dApps are not supported.
- The Slush deep link path (`my.slush.app/browse/...`) and OKX's `okx://wallet/dapp/url` link are not verified on a device yet. The approval window always shows a plain link as a fallback.

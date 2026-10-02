import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WalletAccountStore } from '../src/wallets.js';
import { syncReplacementWallet } from '../src/wallet-replacement.js';

const accountId = '610911604';
const oldAddress = `0:${'aa'.repeat(32)}`;

test('replacement pending menyimpan secret dan tidak ditimpa wallet server lama', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-wallet-replace-'));
  const filePath = path.join(root, 'wallets-accounts.json');
  const store = new WalletAccountStore(filePath);
  store.recordServerWallet(accountId, { wallet_address: oldAddress, wallet_verified: '1' });

  const replacement = await store.getOrCreateReplacementManaged(accountId, oldAddress);
  const replacementAddress = replacement.address;
  replacement.secretKey.fill(0);
  assert.equal(store.hasManagedSecrets(accountId), true);
  assert.equal(store.get(accountId).replacement_pending, true);

  store.recordServerWallet(accountId, { wallet_address: oldAddress, wallet_verified: '1' });
  assert.equal(store.get(accountId).address, replacementAddress);
  assert.equal(store.get(accountId).server_wallet_address, oldAddress);
  assert.equal(store.get(accountId).mnemonic.split(' ').length, 24);

  const resumed = await new WalletAccountStore(filePath).getOrCreateReplacementManaged(accountId, oldAddress);
  assert.equal(resumed.address, replacementAddress);
  assert.equal(resumed.replacementResumed, true);
  resumed.secretKey.fill(0);
});

test('sync replacement menerima busy lalu memverifikasi wallet baru tanpa membuat ulang mnemonic', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-wallet-replace-sync-'));
  const store = new WalletAccountStore(path.join(root, 'wallets-accounts.json'));
  store.recordServerWallet(accountId, { wallet_address: oldAddress, wallet_verified: '1' });
  let calls = 0;
  let replacementAddress = '';
  const client = {
    webappUrl: new URL('https://atfminers.asloni.online/miner/index.html'),
    async getWalletProofPayload() {
      return { payload: `nonce-${calls}`, expires_at: Math.floor(Date.now() / 1000) + 120 };
    },
    async syncWallet({ wallet }) {
      calls += 1;
      replacementAddress = wallet;
      if (calls === 1) {
        return { status: 'busy', user: { wallet_address: oldAddress, wallet_verified: '1' } };
      }
      return { status: 'success', user: { wallet_address: wallet, wallet_verified: '1' } };
    },
    async login() {
      return { status: 'success', user: { wallet_address: oldAddress, wallet_verified: '1' } };
    }
  };

  const result = await syncReplacementWallet({
    client,
    user: { wallet_address: oldAddress, wallet_verified: '1' },
    accountId,
    walletStore: store,
    busyRetrySeconds: 0,
    busyMaxRetries: 1,
    signal: new AbortController().signal
  });

  assert.equal(calls, 2);
  assert.equal(result.ready, true);
  assert.equal(store.get(accountId).address, replacementAddress);
  assert.equal(store.get(accountId).wallet_verified, true);
  assert.equal(store.get(accountId).replacement_pending, false);
  assert.equal(store.get(accountId).mnemonic.split(' ').length, 24);
});

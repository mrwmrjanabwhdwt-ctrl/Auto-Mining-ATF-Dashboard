import { buildTonProof } from './wallets.js';
import {
  isExpectedWalletVerified,
  isTransientWalletSync,
  mergeWalletUser
} from './wallet-sync-state.js';
import { sleep } from './utils.js';

export class WalletReplacementBusyError extends Error {
  constructor(message, retries) {
    super(message);
    this.name = 'WalletReplacementBusyError';
    this.retries = retries;
  }
}

export async function syncReplacementWallet({
  client,
  user,
  accountId,
  walletStore,
  busyRetrySeconds,
  busyMaxRetries,
  signal,
  onCreated = () => {},
  onResumed = () => {},
  onRetry = () => {}
}) {
  const oldAddress = String(user?.wallet_address || '').trim();
  const wallet = await walletStore.getOrCreateReplacementManaged(accountId, oldAddress);
  if (wallet.replacementCreated) onCreated(wallet);
  else onResumed(wallet);

  try {
    let nextUser = user;
    let busyRetries = 0;
    while (!signal.aborted) {
      const payload = await client.getWalletProofPayload(true);
      const proof = buildTonProof({
        address: wallet.address,
        payload: payload.payload,
        domain: client.webappUrl.hostname,
        secretKey: wallet.secretKey
      });
      const response = await client.syncWallet({
        wallet: wallet.address,
        publicKey: wallet.publicKey,
        walletStateInit: wallet.walletStateInit,
        network: wallet.network,
        proof
      });

      nextUser = mergeWalletUser(nextUser, response);
      if (isExpectedWalletVerified(nextUser, wallet.address)) {
        walletStore.markVerified(accountId, wallet.address);
        return { ready: true, user: nextUser, wallet };
      }

      const transient = isTransientWalletSync(response);
      if (transient || response?.status === 'success') {
        const refreshed = await client.login();
        nextUser = mergeWalletUser(nextUser, refreshed);
        if (isExpectedWalletVerified(nextUser, wallet.address)) {
          walletStore.markVerified(accountId, wallet.address);
          return { ready: true, user: nextUser, wallet };
        }
      }

      if (!transient) {
        throw new Error(response?.message || response?.reason || 'Server belum mengonfirmasi perpindahan wallet');
      }
      if (busyRetries >= busyMaxRetries) {
        throw new WalletReplacementBusyError(
          `Replacement wallet masih busy/cached setelah ${busyMaxRetries} retry`,
          busyMaxRetries
        );
      }
      busyRetries += 1;
      onRetry({ retry: busyRetries, maxRetries: busyMaxRetries, delaySeconds: busyRetrySeconds });
      await sleep(busyRetrySeconds * 1000, signal);
    }
    throw new Error('Penggantian wallet dibatalkan');
  } finally {
    wallet.secretKey.fill(0);
  }
}

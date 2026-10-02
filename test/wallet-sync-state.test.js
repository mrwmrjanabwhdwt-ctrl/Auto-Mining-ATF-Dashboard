import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasVerifiedWallet,
  isCachedWalletSync,
  isExpectedWalletVerified,
  isTransientWalletSync,
  mergeWalletUser
} from '../src/wallet-sync-state.js';

const wallet = '0:b93ac855a0e4e0eadfb2831bcc224f7a9b9ee1cf9370fbb31878e5fd8e9f85da';

test('busy response can already contain an authoritative verified wallet', () => {
  const response = {
    status: 'busy',
    busy: true,
    user: { wallet_address: wallet, wallet_verified: '1' }
  };
  const user = mergeWalletUser({}, response);

  assert.equal(isTransientWalletSync(response), true);
  assert.equal(isExpectedWalletVerified(user, wallet), true);
});

test('cached and deduplicated responses are transient', () => {
  const response = { status: 'cached', cached: true, dedup: true };

  assert.equal(isCachedWalletSync(response), true);
  assert.equal(isTransientWalletSync(response), true);
});

test('verified wallet must match the managed wallet address', () => {
  const user = { wallet_address: '0:different', wallet_verified: true };

  assert.equal(hasVerifiedWallet(user), true);
  assert.equal(isExpectedWalletVerified(user, wallet), false);
});

test('mergeWalletUser preserves existing fields while accepting refreshed wallet state', () => {
  const user = mergeWalletUser(
    { username: 'fabian', wallet_verified: '0' },
    { user: { wallet_address: wallet, wallet_verified: '1' } }
  );

  assert.equal(user.username, 'fabian');
  assert.equal(isExpectedWalletVerified(user, wallet.toUpperCase()), true);
});

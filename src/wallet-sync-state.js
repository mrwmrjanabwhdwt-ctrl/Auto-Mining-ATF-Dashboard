export function hasVerifiedWallet(user) {
  return Boolean(String(user?.wallet_address || '').trim()) &&
    (user?.wallet_verified === true || Number.parseInt(user?.wallet_verified || '0', 10) === 1);
}

export function walletAddressMatches(user, expectedAddress) {
  const serverAddress = String(user?.wallet_address || '').trim().toLowerCase();
  const localAddress = String(expectedAddress || '').trim().toLowerCase();
  return Boolean(serverAddress && localAddress && serverAddress === localAddress);
}

export function mergeWalletUser(currentUser, response) {
  if (!response?.user || typeof response.user !== 'object') return currentUser;
  return { ...currentUser, ...response.user };
}

export function isCachedWalletSync(response) {
  const status = String(response?.status || '').trim().toLowerCase();
  return status === 'cached' || response?.cached === true || response?.dedup === true;
}

export function isTransientWalletSync(response) {
  const status = String(response?.status || '').trim().toLowerCase();
  return status === 'busy' || response?.busy === true || isCachedWalletSync(response);
}

export function isExpectedWalletVerified(user, expectedAddress) {
  return hasVerifiedWallet(user) && walletAddressMatches(user, expectedAddress);
}

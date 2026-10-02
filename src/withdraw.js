export const MIN_WITHDRAW_ATF = 500;
export const WITHDRAW_FEE_ATF = 70;

export const CAPTCHA_RETRY_REASONS = new Set([
  'puzzle_required', 'puzzle_incomplete', 'challenge_missing', 'puzzle_incorrect',
  'trace_invalid', 'challenge_expired', 'challenge_used', 'challenge_not_found',
  'captcha_incorrect', 'captcha_incomplete', 'captcha_expired', 'captcha_missing',
  'captcha_not_found', 'captcha_used', 'captcha_mismatch', 'captcha_failed'
]);

export function isKycRequired(value) {
  const status = String(value?.status || '').trim().toLowerCase();
  const code = String(value?.code || value?.reason || '').trim().toLowerCase();
  return status === 'verify' || code === 'needs_verify' || value?.needs_verify === true || value?.needs_verify === 1;
}

export function findSubmittedWithdrawal(history, withdrawId = null) {
  const items = Array.isArray(history?.items) ? history.items : [];
  if (withdrawId != null) {
    const expected = String(withdrawId);
    const exact = items.find((item) => String(item?.id || '') === expected);
    if (exact) return exact;
  }
  return items[0] || null;
}

export function isMaskedAutoFraud(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.masked_auto_fraud === true || item.masked_auto_fraud === 1 || item.masked_auto_fraud === '1') return true;
  const status = String(item.status || '').trim().toLowerCase();
  const reason = String(item.error_message || '').trim();
  return status === 'fraud' && /^AUTO-FRAUD\s*:/i.test(reason);
}

export function withdrawRetryState(value, fallbackAttempts = 3) {
  const fallback = Math.max(0, Number.parseInt(fallbackAttempts || '0', 10) || 0);
  const rawAttempts = value?.attempts_left;
  const parsedAttempts = Number.parseInt(rawAttempts, 10);
  const attemptsLeft = rawAttempts === undefined || rawAttempts === null || rawAttempts === '' || !Number.isFinite(parsedAttempts)
    ? fallback
    : Math.max(0, parsedAttempts);
  const retryAfterSeconds = Math.max(0, Number.parseInt(value?.retry_after_seconds || '0', 10) || 0);
  return { attemptsLeft, retryAfterSeconds };
}

export function withdrawSubmitJitterMs(random = Math.random) {
  const sample = Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  return 1200 + Math.floor(sample * 801);
}

export function classifyWithdrawalStatus(withdrawResponse, history = null) {
  if (isKycRequired(withdrawResponse)) return { status: 'kyc', item: null };
  const item = findSubmittedWithdrawal(history, withdrawResponse?.withdraw_id);
  if (isKycRequired(item)) return { status: 'kyc', item };
  if (isMaskedAutoFraud(item)) return { status: 'pending', item };
  const rawStatus = String(item?.status || withdrawResponse?.review_status || '').trim().toLowerCase();
  if (['pending', 'processing', 'submitting', 'submitted'].includes(rawStatus)) return { status: 'pending', item };
  if (rawStatus === 'approved') return { status: 'approved', item };
  if (['fraud', 'rejected', 'failed', 'cancelled'].includes(rawStatus)) return { status: 'failed', item };
  if (withdrawResponse?.status === 'success') return { status: 'pending', item };
  return { status: 'failed', item };
}

export function summarizeWithdrawalHistory(history) {
  const item = findSubmittedWithdrawal(history);
  if (!item) return { status: 'none', amount: 0, maskedAutoFraud: null, item: null };
  const classified = classifyWithdrawalStatus({
    withdraw_id: item.id,
    review_status: item.status
  }, history);
  const parsedAmount = Number(item.amount ?? item.requested_amount ?? 0);
  return {
    status: classified.status,
    amount: Number.isFinite(parsedAmount) ? Math.max(0, parsedAmount) : 0,
    maskedAutoFraud: isMaskedAutoFraud(item),
    item: classified.item || item
  };
}

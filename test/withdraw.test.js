import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWithdrawalStatus,
  findSubmittedWithdrawal,
  isKycRequired,
  summarizeWithdrawalHistory,
  withdrawRetryState,
  withdrawSubmitJitterMs
} from '../src/withdraw.js';

test('status withdrawal pending ditemukan berdasarkan withdraw_id', () => {
  const history = {
    status: 'success',
    items: [
      { id: '100', status: 'approved' },
      { id: '99', status: 'pending', amount: '500.0000' }
    ]
  };
  assert.equal(findSubmittedWithdrawal(history, 99).id, '99');
  assert.equal(classifyWithdrawalStatus({ status: 'success', withdraw_id: 99 }, history).status, 'pending');
});

test('status verify dan needs_verify diklasifikasikan sebagai KYC', () => {
  assert.equal(isKycRequired({ code: 'needs_verify' }), true);
  assert.equal(classifyWithdrawalStatus(
    { status: 'success', withdraw_id: 77 },
    { items: [{ id: '77', status: 'verify', needs_verify: 1 }] }
  ).status, 'kyc');
});

test('status rejected diklasifikasikan gagal', () => {
  assert.equal(classifyWithdrawalStatus(
    { status: 'success', withdraw_id: 55 },
    { items: [{ id: '55', status: 'rejected', error_message: 'rejected' }] }
  ).status, 'failed');
});

test('masked auto-fraud mengikuti frontend dan tetap ditampilkan pending', () => {
  assert.equal(classifyWithdrawalStatus(
    { status: 'success', withdraw_id: 56 },
    { items: [{ id: '56', status: 'fraud', masked_auto_fraud: true, error_message: 'AUTO-FRAUD: queued' }] }
  ).status, 'pending');
});

test('retry CAPTCHA mengikuti attempts_left dan retry_after_seconds server', () => {
  assert.deepEqual(withdrawRetryState({ attempts_left: 1, retry_after_seconds: 45 }, 3), {
    attemptsLeft: 1,
    retryAfterSeconds: 45
  });
  assert.deepEqual(withdrawRetryState({}, 2), { attemptsLeft: 2, retryAfterSeconds: 0 });
});

test('jeda submit withdraw mengikuti jitter frontend 1200 sampai 2000 ms', () => {
  assert.equal(withdrawSubmitJitterMs(() => 0), 1200);
  assert.equal(withdrawSubmitJitterMs(() => 0.999999), 2000);
});

test('ringkasan history stats mengenali withdraw terbaru yang wajib KYC', () => {
  const summary = summarizeWithdrawalHistory({
    status: 'success',
    items: [
      { id: '88', status: 'verify', needs_verify: 1, amount: '765.2998' },
      { id: '77', status: 'approved', amount: '500.0000' }
    ]
  });
  assert.equal(summary.status, 'kyc');
  assert.equal(summary.amount, 765.2998);
  assert.equal(summary.maskedAutoFraud, false);
});

test('ringkasan history kosong menampilkan status none', () => {
  assert.deepEqual(summarizeWithdrawalHistory({ status: 'success', items: [] }), {
    status: 'none', amount: 0, maskedAutoFraud: null, item: null
  });
});

test('fraud mask dan status verify tetap merupakan sinyal terpisah', () => {
  const verify = summarizeWithdrawalHistory({
    status: 'success',
    items: [{ id: '90', status: 'verify', needs_verify: 1, amount: '902.4508', masked_auto_fraud: false }]
  });
  const masked = summarizeWithdrawalHistory({
    status: 'success',
    items: [{ id: '91', status: 'fraud', amount: '500.0000', masked_auto_fraud: true }]
  });
  assert.equal(verify.status, 'kyc');
  assert.equal(verify.maskedAutoFraud, false);
  assert.equal(masked.status, 'pending');
  assert.equal(masked.maskedAutoFraud, true);
});

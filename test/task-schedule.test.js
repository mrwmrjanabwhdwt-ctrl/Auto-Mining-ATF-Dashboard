import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseNextAutomationRun, nextRepeatableTaskEpoch } from '../src/task-schedule.js';

const TASKS = [
  { id: 'repeat_a', cooldown: 7200, minSeconds: 30 },
  { id: 'repeat_b', cooldown: 7200, minSeconds: 0 },
  { id: 'once', cooldown: 0, minSeconds: 0 }
];

test('nextRepeatableTaskEpoch menandai task tanpa cooldown aktif sebagai Ready', () => {
  assert.equal(nextRepeatableTaskEpoch({ task_cooldowns: {} }, TASKS, 1_000), 1_000);
});

test('nextRepeatableTaskEpoch memakai cooldown server paling awal', () => {
  const login = { task_cooldowns: { repeat_a: 8_200, repeat_b: 8_500 } };
  assert.equal(nextRepeatableTaskEpoch(login, TASKS, 1_000), 8_200);
});

test('nextRepeatableTaskEpoch menghormati minimum wait task yang sudah dimulai', () => {
  const login = {
    task_cooldowns: { repeat_b: 8_500 },
    task_starts: { repeat_a: 990 }
  };
  assert.equal(nextRepeatableTaskEpoch(login, TASKS, 1_000), 1_020);
});

test('scheduler bangun pada task dua jam sebelum siklus reguler tiga jam', () => {
  const nowMs = 1_000_000;
  const taskEpoch = Math.floor(nowMs / 1000) + 7200;
  const result = chooseNextAutomationRun({ nowMs, loopIntervalHours: 3, taskEpochs: [taskEpoch] });
  assert.equal(result.reason, 'task');
  assert.equal(result.at, taskEpoch * 1000);
});

test('scheduler memberi jeda minimum untuk task Ready agar tidak tight loop', () => {
  const nowMs = 1_000_000;
  const result = chooseNextAutomationRun({
    nowMs,
    loopIntervalHours: 3,
    taskEpochs: [Math.floor(nowMs / 1000)],
    readyRetrySeconds: 60
  });
  assert.equal(result.reason, 'task');
  assert.equal(result.at, nowMs + 60_000);
});

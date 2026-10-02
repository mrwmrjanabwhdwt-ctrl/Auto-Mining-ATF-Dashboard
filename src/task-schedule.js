function epoch(value) {
  return Math.max(0, Number.parseInt(value || '0', 10) || 0);
}

export function nextRepeatableTaskEpoch(loginData, taskDefinitions, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(taskDefinitions) || taskDefinitions.length === 0) return 0;
  const cooldowns = loginData?.task_cooldowns && typeof loginData.task_cooldowns === 'object'
    ? loginData.task_cooldowns
    : {};
  const starts = loginData?.task_starts && typeof loginData.task_starts === 'object'
    ? loginData.task_starts
    : {};
  const candidates = [];

  for (const task of taskDefinitions) {
    const cooldown = epoch(task?.cooldown);
    if (cooldown <= 0 || !task?.id) continue;

    const availableAt = epoch(cooldowns[task.id]);
    if (availableAt > nowSeconds) {
      candidates.push(availableAt);
      continue;
    }

    const startedAt = epoch(starts[task.id]);
    const claimReadyAt = startedAt + epoch(task.minSeconds);
    candidates.push(startedAt > 0 && claimReadyAt > nowSeconds ? claimReadyAt : nowSeconds);
  }

  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

export function chooseNextAutomationRun({
  nowMs = Date.now(),
  loopIntervalHours,
  taskEpochs = [],
  readyRetrySeconds = 60
}) {
  const regularAt = nowMs + Number(loopIntervalHours) * 3600 * 1000;
  const validTaskEpochs = taskEpochs.map(epoch).filter((value) => value > 0);
  if (validTaskEpochs.length === 0) return { at: regularAt, reason: 'regular' };

  const earliestTaskEpoch = Math.min(...validTaskEpochs);
  const taskAt = Math.max(nowMs + Number(readyRetrySeconds) * 1000, earliestTaskEpoch * 1000);
  return taskAt < regularAt
    ? { at: taskAt, reason: 'task', taskEpoch: earliestTaskEpoch }
    : { at: regularAt, reason: 'regular', taskEpoch: earliestTaskEpoch };
}

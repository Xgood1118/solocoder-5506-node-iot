const config = require('./config');
const { logger, writeDeadLetter } = require('./logger');
const { checkDeviceStatuses } = require('./state');
const {
  flushOldDeadLetters,
  clearExpiredLRU,
  deadLetterQueue,
} = require('./store');

let cleanupTimer = null;
const stats = {
  lastRunAt: null,
  lastDurationMs: 0,
  nextRunAt: null,
  runCount: 0,
  lastResult: null,
  lastError: null,
  intervalMs: config.cleanupIntervalMs,
};

function runCleanup() {
  const start = Date.now();
  stats.nextRunAt = start + config.cleanupIntervalMs;
  let result = null;
  let runError = null;
  try {
    const statusResult = checkDeviceStatuses();
    const flushed = flushOldDeadLetters();
    if (flushed.length > 0) {
      for (const item of flushed) {
        writeDeadLetter(item);
      }
      logger.info({ flushed: flushed.length }, 'Dead-letter entries flushed to disk');
    }
    clearExpiredLRU();
    result = {
      offlineCount: statusResult.offlineCount,
      lostCount: statusResult.lostCount,
      flushedCount: flushed.length,
      deadLetterRemaining: deadLetterQueue.length,
    };
    logger.debug(result, 'Cleanup job completed');
  } catch (err) {
    runError = err.message;
    logger.error({ err: err.message }, 'Cleanup job error');
  } finally {
    const duration = Date.now() - start;
    stats.lastRunAt = start;
    stats.lastDurationMs = duration;
    stats.runCount++;
    stats.lastResult = result;
    stats.lastError = runError;
  }
}

function startCleanupJob() {
  if (cleanupTimer) return;
  stats.nextRunAt = Date.now() + config.cleanupIntervalMs;
  cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMs);
  cleanupTimer.unref();
  logger.info(
    { intervalMs: config.cleanupIntervalMs, nextRunAt: new Date(stats.nextRunAt).toISOString() },
    'Cleanup job started'
  );
}

function stopCleanupJob() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    stats.nextRunAt = null;
    logger.info('Cleanup job stopped');
  }
}

function getCleanupStats() {
  return {
    ...stats,
    nextRunAtIso: stats.nextRunAt ? new Date(stats.nextRunAt).toISOString() : null,
    lastRunAtIso: stats.lastRunAt ? new Date(stats.lastRunAt).toISOString() : null,
  };
}

module.exports = {
  startCleanupJob,
  stopCleanupJob,
  getCleanupStats,
};

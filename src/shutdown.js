const config = require('./config');
const { logger, writeDeadLetter } = require('./logger');
const { stopCleanupJob } = require('./cleanup');
const { flushInFlight, getInFlightCount } = require('./downstream');
const { deadLetterQueue } = require('./store');

let shuttingDown = false;

function isShuttingDown() {
  return shuttingDown;
}

function shutdownMiddleware(req, res, next) {
  if (shuttingDown) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({ error: 'Service shutting down' });
  }
  next();
}

async function gracefulShutdown(server) {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  logger.info('Graceful shutdown initiated');

  stopCleanupJob();

  if (deadLetterQueue.length > 0) {
    logger.info({ count: deadLetterQueue.length }, 'Flushing remaining dead-letter queue');
    const snapshot = deadLetterQueue.splice(0, deadLetterQueue.length);
    for (const item of snapshot) writeDeadLetter(item);
  }

  let forceTimer = null;
  const forcePromise = new Promise((resolve) => {
    forceTimer = setTimeout(() => {
      logger.error(
        { elapsedMs: Date.now() - startedAt, inFlight: getInFlightCount() },
        'Graceful shutdown timeout, forcing exit'
      );
      resolve('force');
    }, config.gracefulShutdownTimeoutMs);
  });

  const closePromise = new Promise((resolve) => {
    server.close((err) => {
      if (err) logger.error({ err: err.message }, 'Server close error');
      resolve('closed');
    });
    for (const socket of server._sockets || []) {
      socket.end();
    }
  });

  const flushPromise = (async () => {
    await flushInFlight();
    return 'flushed';
  })();

  await Promise.race([forcePromise, Promise.all([closePromise, flushPromise])]);
  if (forceTimer) clearTimeout(forceTimer);

  logger.info(
    { elapsedMs: Date.now() - startedAt, inFlight: getInFlightCount() },
    'Graceful shutdown complete'
  );
  process.exit(0);
}

function setupGracefulShutdown(server) {
  const trackSockets = () => {
    server._sockets = new Set();
    server.on('connection', (socket) => {
      server._sockets.add(socket);
      socket.on('close', () => server._sockets.delete(socket));
    });
  };
  trackSockets();

  const onSignal = (signal) => {
    logger.info({ signal }, `Received ${signal}`);
    gracefulShutdown(server).catch((err) => {
      logger.error({ err: err.message }, 'gracefulShutdown error, forcing exit');
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
    gracefulShutdown(server).catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'Unhandled rejection');
  });
}

module.exports = {
  setupGracefulShutdown,
  gracefulShutdown,
  shutdownMiddleware,
  isShuttingDown,
};

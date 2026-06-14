const config = require('./config');
const { logger } = require('./logger');
const { replayCache, idempotentCache } = require('./store');

function antiReplayMiddleware(req, res, next) {
  const deviceId = req.device?.id || 'unknown';
  const timestamp = req.requestTimestamp;
  const nonce = req.requestNonce;

  const now = Date.now();
  const tsDiff = Math.abs(now - timestamp);
  if (tsDiff > config.replayWindowMs) {
    logger.warn({ deviceId, timestamp, now, diff: tsDiff }, 'Request timestamp out of replay window');
    return res.status(401).json({ error: 'Timestamp out of acceptable window' });
  }

  const key = `${deviceId}:${timestamp}:${nonce}`;
  if (replayCache.has(key)) {
    logger.info({ deviceId, key }, 'Duplicate request dropped (replay)');
    return res.status(200).json({ status: 'dropped', reason: 'replay' });
  }
  replayCache.set(key, 1);
  next();
}

function idempotentMiddlewareFactory(extractKey) {
  return function idempotentMiddleware(req, res, next) {
    const key = extractKey(req);
    if (!key) return next();
    if (idempotentCache.has(key)) {
      logger.info({ key }, 'Idempotent duplicate request, returning 200');
      return res.status(200).json({ status: 'ok', idempotent: true });
    }
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        idempotentCache.set(key, 1);
      }
    });
    next();
  };
}

module.exports = {
  antiReplayMiddleware,
  idempotentMiddlewareFactory,
};

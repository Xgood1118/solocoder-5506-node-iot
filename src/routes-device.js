const express = require('express');
const { logger } = require('./logger');
const { hmacAuthMiddleware, verifyTelemetrySignature } = require('./auth');
const { antiReplayMiddleware, idempotentMiddlewareFactory } = require('./dedupe');
const { isValidDataType, TelemetryDataType } = require('./store');
const { recordHeartbeat, recordData } = require('./state');
const { forwardWithRetry } = require('./downstream');

const router = express.Router();

const telemetryIdempotent = idempotentMiddlewareFactory((req) => {
  const { device_id, timestamp, data_type } = req.body || {};
  if (!device_id || !timestamp || !data_type) return null;
  return `${device_id}:${timestamp}:${data_type}`;
});

router.post(
  '/telemetry',
  express.json({ limit: '1mb' }),
  hmacAuthMiddleware,
  antiReplayMiddleware,
  telemetryIdempotent,
  async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Invalid body' });
      }
      const { device_id, timestamp, data_type, value, extra, signature } = body;
      if (!/^[A-Za-z0-9]{20}$/.test(device_id)) {
        return res.status(400).json({ error: 'Invalid device_id' });
      }
      if (!Number.isInteger(timestamp)) {
        return res.status(400).json({ error: 'Invalid timestamp' });
      }
      if (!isValidDataType(data_type)) {
        return res
          .status(400)
          .json({ error: 'Invalid data_type', allowed: Object.values(TelemetryDataType) });
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return res.status(400).json({ error: 'Invalid value' });
      }
      if (extra !== undefined && typeof extra !== 'object') {
        return res.status(400).json({ error: 'extra must be object' });
      }
      if (typeof signature !== 'string') {
        return res.status(400).json({ error: 'Missing data signature' });
      }

      const device = req.device;
      const telemetryCore = { device_id, timestamp, data_type, value, extra };
      try {
        if (!verifyTelemetrySignature(device.presharedKey, telemetryCore, signature)) {
          logger.warn({ deviceId: device_id, ip: req.ip }, 'Telemetry data signature verification failed');
          return res.status(401).json({ error: 'Invalid telemetry signature' });
        }
      } catch (_err) {
        return res.status(401).json({ error: 'Invalid telemetry signature' });
      }

      recordData(device_id);

      const telemetry = {
        device_id,
        timestamp,
        data_type,
        value,
        extra: extra || null,
        signature,
        receivedAt: Date.now(),
        gatewayEnv: process.env.NODE_ENV,
      };

      setImmediate(() => {
        forwardWithRetry(telemetry).catch((err) => {
          logger.error({ err: err.message }, 'forwardWithRetry unexpected error');
        });
      });

      return res.status(200).json({ status: 'accepted', receivedAt: telemetry.receivedAt });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/heartbeat',
  express.json({ limit: '64kb' }),
  hmacAuthMiddleware,
  antiReplayMiddleware,
  (req, res) => {
    const device = req.device;
    recordHeartbeat(device.id);
    return res.status(200).json({
      status: 'ok',
      heartbeatInterval: require('./config').heartbeatInterval,
      serverTime: Date.now(),
    });
  }
);

module.exports = router;

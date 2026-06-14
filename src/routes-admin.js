const express = require('express');
const { logger } = require('./logger');
const {
  jwtAuthMiddleware,
  issueToken,
  verifyAdminLogin,
} = require('./auth');
const {
  createDevice,
  getDevice,
  updateDevice,
  deleteDevice,
  listDevices,
  subscribe,
  getStats,
  deadLetterQueue,
  TelemetryDataType,
  DeviceModel,
  DeviceStatus,
  isValidModel,
  clearExpiredLRU,
  flushOldDeadLetters,
} = require('./store');
const { checkDeviceStatuses } = require('./state');
const { getInFlightCount } = require('./downstream');
const { getCleanupStats } = require('./cleanup');

const router = express.Router();

router.post('/login', express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (!verifyAdminLogin(username, password)) {
    logger.warn({ username, ip: req.ip }, 'Admin login failed');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = issueToken(username);
  logger.info({ username, ip: req.ip }, 'Admin login success');
  return res.json({ token });
});

router.get('/health', (_req, res) => {
  const stats = getStats();
  return res.json({
    status: 'ok',
    uptime: process.uptime(),
    inFlight: getInFlightCount(),
    ...stats,
    cleanup: getCleanupStats(),
  });
});

router.get('/meta', (_req, res) => {
  return res.json({
    dataTypes: Object.values(TelemetryDataType),
    deviceModels: Object.values(DeviceModel),
    deviceStatuses: Object.values(DeviceStatus),
  });
});

router.use(jwtAuthMiddleware);

router.get('/devices', (req, res) => {
  const { projectId, status } = req.query;
  const list = listDevices({ projectId, status }).map((d) => ({
    ...d,
    presharedKey: undefined,
  }));
  return res.json({ total: list.length, items: list });
});

router.post('/devices', express.json(), (req, res) => {
  try {
    const { id, model, projectId } = req.body || {};
    const device = createDevice({ id, model, projectId });
    return res.status(201).json({
      ...device,
      presharedKey: device.presharedKey,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'Create device failed');
    return res.status(400).json({ error: err.message });
  }
});

router.get('/devices/:id', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const out = { ...d };
  delete out.presharedKey;
  return res.json(out);
});

router.put('/devices/:id', express.json(), (req, res) => {
  const { model, projectId } = req.body || {};
  const updates = { projectId };
  if (model !== undefined) {
    if (!isValidModel(model)) {
      return res.status(400).json({
        error: 'Invalid model',
        allowed: Object.values(DeviceModel),
      });
    }
    updates.model = model;
  }
  const d = updateDevice(req.params.id, updates);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const out = { ...d };
  delete out.presharedKey;
  return res.json(out);
});

router.delete('/devices/:id', (req, res) => {
  const ok = deleteDevice(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  return res.status(204).send();
});

router.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`: connected ${Date.now()}\n\n`);
  const unsub = subscribe((evt) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
});

router.get('/dead-letter', (_req, res) => {
  return res.json({ total: deadLetterQueue.length, items: deadLetterQueue });
});

router.post('/status/refresh', (_req, res) => {
  const result = checkDeviceStatuses();
  return res.json(result);
});

module.exports = router;

const { LRUCache } = require('lru-cache');
const crypto = require('crypto');
const config = require('./config');
const { logger } = require('./logger');

const DeviceStatus = {
  OFFLINE: 'offline',
  ONLINE: 'online',
  LOST: 'lost',
};

const DeviceModel = {
  TEMP_HUMI_SENSOR: 'temp_humi_sensor',
  ELECTRIC_METER: 'electric_meter',
  WATER_METER: 'water_meter',
  GAS_METER: 'gas_meter',
  PRESSURE_SENSOR: 'pressure_sensor',
  SMOKE_DETECTOR: 'smoke_detector',
  DOOR_SENSOR: 'door_sensor',
  GATEWAY: 'gateway',
  UNKNOWN: 'unknown',
};

const TelemetryDataType = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  ELECTRIC_METER: 'electric_meter',
  WATER_METER: 'water_meter',
  GAS_METER: 'gas_meter',
  PRESSURE: 'pressure',
  VOLTAGE: 'voltage',
  CURRENT: 'current',
  POWER: 'power',
  CUSTOM: 'custom',
};

const devices = new Map();
const deadLetterQueue = [];
const subscribers = new Set();

const replayCache = new LRUCache({
  max: config.lruMax,
  ttl: config.replayWindowMs,
  updateAgeOnGet: false,
});

const idempotentCache = new LRUCache({
  max: config.lruMax,
  ttl: config.idempotentWindowMs,
  updateAgeOnGet: false,
});

function generatePresharedKey() {
  return crypto.randomBytes(32).toString('hex');
}

function createDevice({ id, model, projectId }) {
  if (!/^[A-Za-z0-9]{20}$/.test(id)) {
    throw new Error('Device ID must be exactly 20 alphanumeric characters');
  }
  if (devices.has(id)) {
    throw new Error('Device already exists');
  }
  const finalModel = model || DeviceModel.UNKNOWN;
  if (!isValidModel(finalModel)) {
    throw new Error(`Invalid device model, allowed: ${Object.values(DeviceModel).join(', ')}`);
  }
  const now = Date.now();
  const device = {
    id,
    model: finalModel,
    presharedKey: generatePresharedKey(),
    projectId: projectId || null,
    status: DeviceStatus.OFFLINE,
    lastHeartbeat: null,
    lastDataAt: null,
    createdAt: now,
    updatedAt: now,
  };
  devices.set(id, device);
  logger.info({ deviceId: id, model: finalModel, projectId }, 'Device created');
  return device;
}

function getDevice(id) {
  return devices.get(id) || null;
}

function updateDevice(id, updates) {
  const device = devices.get(id);
  if (!device) return null;
  Object.assign(device, updates, { updatedAt: Date.now() });
  return device;
}

function deleteDevice(id) {
  return devices.delete(id);
}

function listDevices({ projectId, status } = {}) {
  const result = [];
  for (const device of devices.values()) {
    if (projectId && device.projectId !== projectId) continue;
    if (status && device.status !== status) continue;
    result.push(device);
  }
  return result;
}

function isValidDataType(type) {
  return Object.values(TelemetryDataType).includes(type);
}

function isValidModel(model) {
  return Object.values(DeviceModel).includes(model);
}

function addDeadLetter(item) {
  deadLetterQueue.push({
    ...item,
    addedAt: Date.now(),
  });
}

function flushOldDeadLetters() {
  const cutoff = Date.now() - config.deadLetterFlushMs;
  const toFlush = deadLetterQueue.filter((x) => x.addedAt <= cutoff);
  const kept = deadLetterQueue.filter((x) => x.addedAt > cutoff);
  deadLetterQueue.length = 0;
  deadLetterQueue.push(...kept);
  return toFlush;
}

function clearExpiredLRU() {
  replayCache.purgeStale();
  idempotentCache.purgeStale();
}

function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function emit(event) {
  for (const cb of subscribers) {
    try {
      cb(event);
    } catch (err) {
      logger.error({ err: err.message }, 'Event subscriber error');
    }
  }
}

function getStats() {
  return {
    deviceCount: devices.size,
    deadLetterSize: deadLetterQueue.length,
    replayCacheSize: replayCache.size,
    idempotentCacheSize: idempotentCache.size,
    subscriberCount: subscribers.size,
  };
}

module.exports = {
  DeviceStatus,
  DeviceModel,
  TelemetryDataType,
  devices,
  replayCache,
  idempotentCache,
  deadLetterQueue,
  subscribers,
  createDevice,
  getDevice,
  updateDevice,
  deleteDevice,
  listDevices,
  isValidDataType,
  isValidModel,
  addDeadLetter,
  flushOldDeadLetters,
  clearExpiredLRU,
  subscribe,
  emit,
  getStats,
  generatePresharedKey,
};

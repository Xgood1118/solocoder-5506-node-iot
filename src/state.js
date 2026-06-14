const config = require('./config');
const { logger } = require('./logger');
const {
  DeviceStatus,
  devices,
  updateDevice,
  emit,
} = require('./store');

function transitionStatus(device, newStatus, reason) {
  const prev = device.status;
  if (prev === newStatus) return false;
  updateDevice(device.id, { status: newStatus });
  const event = {
    type: 'device_status_change',
    deviceId: device.id,
    projectId: device.projectId,
    from: prev,
    to: newStatus,
    reason,
    timestamp: Date.now(),
  };
  logger.info(event, 'Device status changed');
  emit(event);
  return true;
}

function recordHeartbeat(deviceId) {
  const device = devices.get(deviceId);
  if (!device) return;
  const now = Date.now();
  const prevStatus = device.status;
  updateDevice(deviceId, { lastHeartbeat: now, lastDataAt: now });
  if (prevStatus !== DeviceStatus.ONLINE) {
    transitionStatus(device, DeviceStatus.ONLINE, 'heartbeat_received');
  }
}

function recordData(deviceId) {
  const device = devices.get(deviceId);
  if (!device) return;
  const now = Date.now();
  updateDevice(deviceId, { lastDataAt: now });
  if (device.status !== DeviceStatus.ONLINE) {
    transitionStatus(device, DeviceStatus.ONLINE, 'data_received');
  }
}

function checkDeviceStatuses() {
  const now = Date.now();
  let offlineCount = 0;
  let lostCount = 0;
  for (const device of devices.values()) {
    if (device.status === DeviceStatus.ONLINE) {
      if (device.lastHeartbeat && now - device.lastHeartbeat > config.offlineThresholdMs) {
        transitionStatus(device, DeviceStatus.OFFLINE, 'heartbeat_timeout');
        offlineCount++;
      }
    }
    if (
      (device.status === DeviceStatus.ONLINE || device.status === DeviceStatus.OFFLINE) &&
      device.lastDataAt &&
      now - device.lastDataAt > config.lostThresholdMs
    ) {
      transitionStatus(device, DeviceStatus.LOST, 'data_timeout');
      lostCount++;
    }
  }
  if (offlineCount > 0 || lostCount > 0) {
    logger.info({ offlineCount, lostCount }, 'Status sweep completed');
  }
  return { offlineCount, lostCount };
}

module.exports = {
  transitionStatus,
  recordHeartbeat,
  recordData,
  checkDeviceStatuses,
};

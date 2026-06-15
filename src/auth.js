const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { logger } = require('./logger');
const { getDevice } = require('./store');

const adminCredentials = {
  username: 'admin',
  password: null,
};

function setAdminPassword(pwd) {
  adminCredentials.password = pwd;
}

function computeHmac(key, payload) {
  return crypto
    .createHmac('sha256', key)
    .update(payload, 'utf8')
    .digest('hex');
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => stableStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => {
    const v = obj[k];
    return JSON.stringify(k) + ':' + stableStringify(v);
  });
  return '{' + parts.join(',') + '}';
}

function buildCanonicalString({ method, path, timestamp, nonce, body }) {
  const bodyStr =
    body === undefined || body === null
      ? ''
      : typeof body === 'string'
      ? body
      : stableStringify(body);
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyStr}`;
}

function buildTelemetryCanonical({ device_id, timestamp, data_type, value, extra }) {
  const parts = [
    `device_id=${device_id}`,
    `timestamp=${timestamp}`,
    `data_type=${data_type}`,
    `value=${typeof value === 'number' ? String(value) : value}`,
  ];
  if (extra !== undefined && extra !== null) {
    parts.push(`extra=${stableStringify(extra)}`);
  }
  return parts.join('&');
}

function safeHmacEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyTelemetrySignature(presharedKey, telemetry, signature) {
  const canonical = buildTelemetryCanonical(telemetry);
  const expected = computeHmac(presharedKey, canonical);
  return safeHmacEqual(signature, expected);
}

function hmacAuthMiddleware(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const timestamp = req.headers['x-timestamp'];
  const nonce = req.headers['x-nonce'];
  const signature = req.headers['x-signature'];

  if (!deviceId || !timestamp || !nonce || !signature) {
    logger.warn({ deviceId, ip: req.ip }, 'HMAC auth headers missing');
    return res.status(401).json({ error: 'Missing authentication headers' });
  }

  const tsNum = parseInt(timestamp, 10);
  if (Number.isNaN(tsNum)) {
    return res.status(401).json({ error: 'Invalid timestamp' });
  }

  const device = getDevice(deviceId);
  if (!device) {
    logger.warn({ deviceId }, 'HMAC auth: device not found');
    return res.status(401).json({ error: 'Device not registered' });
  }

  const canonical = buildCanonicalString({
    method: req.method,
    path: req.originalUrl,
    timestamp,
    nonce,
    body: req.rawBody,
  });

  const expected = computeHmac(device.presharedKey, canonical);
  if (!safeHmacEqual(signature, expected)) {
    logger.warn({ deviceId, ip: req.ip }, 'HMAC signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  req.device = device;
  req.requestTimestamp = tsNum;
  req.requestNonce = nonce;
  next();
}

function issueToken(username) {
  return jwt.sign(
    { username, role: 'admin', iat: Math.floor(Date.now() / 1000) },
    config.jwtSecret,
    { expiresIn: '24h' }
  );
}

function verifyAdminLogin(username, password) {
  return (
    username === adminCredentials.username &&
    adminCredentials.password &&
    safeHmacEqual(password, adminCredentials.password)
  );
}

function jwtAuthMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.adminUser = payload;
    next();
  } catch (err) {
    logger.warn({ err: err.message }, 'JWT verification failed');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  hmacAuthMiddleware,
  jwtAuthMiddleware,
  computeHmac,
  stableStringify,
  buildCanonicalString,
  buildTelemetryCanonical,
  verifyTelemetrySignature,
  safeHmacEqual,
  issueToken,
  verifyAdminLogin,
  setAdminPassword,
  adminCredentials,
};

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { logger, writeDeadLetter } = require('./logger');
const { addDeadLetter } = require('./store');

const inFlight = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function doHttpPost(url, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: data });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function forwardWithRetry(payload) {
  const id = `${payload.device_id}:${payload.timestamp}:${payload.data_type}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  inFlight.add(id);
  let lastError = null;
  for (let attempt = 0; attempt < config.retryDelays.length; attempt++) {
    try {
      await doHttpPost(config.downstreamUrl, payload);
      logger.debug({ id, attempt: attempt + 1 }, 'Downstream forward succeeded');
      inFlight.delete(id);
      return { ok: true, attempt: attempt + 1 };
    } catch (err) {
      lastError = err;
      logger.warn(
        { id, attempt: attempt + 1, max: config.retryDelays.length, err: err.message },
        'Downstream forward failed, will retry'
      );
      if (attempt < config.retryDelays.length - 1) {
        await sleep(config.retryDelays[attempt]);
      }
    }
  }
  const dead = {
    id,
    payload,
    lastError: lastError?.message,
    attempts: config.retryDelays.length,
    failedAt: Date.now(),
  };
  addDeadLetter(dead);
  logger.error({ id }, 'Downstream forward exhausted, moved to dead-letter queue');
  inFlight.delete(id);
  return { ok: false, dead };
}

async function flushInFlight() {
  if (inFlight.size === 0) return;
  logger.info({ inFlight: inFlight.size }, 'Waiting for in-flight downstream requests');
  const start = Date.now();
  while (inFlight.size > 0 && Date.now() - start < config.gracefulShutdownTimeoutMs) {
    await sleep(100);
  }
  if (inFlight.size > 0) {
    logger.error({ remaining: inFlight.size }, 'Graceful flush timed out');
  }
}

function getInFlightCount() {
  return inFlight.size;
}

module.exports = {
  forwardWithRetry,
  flushInFlight,
  getInFlightCount,
  writeDeadLetter,
};

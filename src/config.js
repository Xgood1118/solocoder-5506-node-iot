require('dotenv').config();

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  downstreamUrl: process.env.DOWNSTREAM_URL || 'http://localhost:4000/telemetry',
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 60,
  lruMax: parseInt(process.env.LRU_MAX, 10) || 100000,
  replayWindowMs: 5 * 60 * 1000,
  idempotentWindowMs: 5 * 60 * 1000,
  offlineThresholdMs: 3 * 60 * 1000,
  lostThresholdMs: 30 * 60 * 1000,
  retryDelays: [1000, 2000, 4000, 8000, 16000],
  deadLetterFlushMs: 24 * 60 * 60 * 1000,
  cleanupIntervalMs: 60 * 1000,
  gracefulShutdownTimeoutMs: 10 * 1000,
};

module.exports = config;

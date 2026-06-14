const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStream } = require('rotating-file-stream');
const config = require('./config');

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const rotatingStream = createStream('iot-gateway.log', {
  interval: '1h',
  path: logDir,
  compress: 'gzip',
  maxFiles: 24 * 7,
});

const deadLetterStream = createStream('dead-letter.log', {
  interval: '1h',
  path: logDir,
  compress: 'gzip',
  maxFiles: 24 * 7,
});

const deadLetterLogger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { type: 'dead-letter' },
  },
  deadLetterStream
);

const transport = config.nodeEnv === 'development'
  ? pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    })
  : undefined;

const streams = [
  { stream: rotatingStream, level: 'info' },
];
if (transport) {
  streams.push({ stream: transport, level: 'debug' });
}

const logger = pino(
  {
    level: config.nodeEnv === 'development' ? 'debug' : 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid, env: config.nodeEnv },
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
  },
  pino.multistream(streams)
);

function generateAdminPassword() {
  return crypto.randomBytes(16).toString('hex');
}

function writeDeadLetter(entry) {
  deadLetterLogger.info({ entry, flushedAt: Date.now() });
}

module.exports = {
  logger,
  deadLetterLogger,
  generateAdminPassword,
  writeDeadLetter,
};

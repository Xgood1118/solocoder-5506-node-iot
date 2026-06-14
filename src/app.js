const express = require('express');
const config = require('./config');
const { logger, generateAdminPassword } = require('./logger');
const { setAdminPassword } = require('./auth');
const deviceRoutes = require('./routes-device');
const adminRoutes = require('./routes-admin');
const { startCleanupJob } = require('./cleanup');
const { setupGracefulShutdown, shutdownMiddleware } = require('./shutdown');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '1mb' }));

  app.use(shutdownMiddleware);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', env: config.nodeEnv, uptime: process.uptime() });
  });

  app.use('/device', deviceRoutes);
  app.use('/admin', adminRoutes);

  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled request error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function bootstrap() {
  const adminPwd = generateAdminPassword();
  setAdminPassword(adminPwd);
  logger.warn(
    { adminUsername: 'admin', adminPassword: adminPwd },
    '===================================================='
  );
  logger.warn(
    { adminUsername: 'admin', adminPassword: adminPwd },
    'FIRST LAUNCH: Admin credentials generated - SAVE THIS PASSWORD'
  );
  logger.warn(
    { adminUsername: 'admin', adminPassword: adminPwd },
    '===================================================='
  );

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, pid: process.pid },
      'IoT Gateway server started'
    );
  });

  setupGracefulShutdown(server);
  startCleanupJob();

  return { app, server };
}

if (require.main === module) {
  bootstrap();
}

module.exports = { createApp, bootstrap };

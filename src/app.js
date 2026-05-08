'use strict';

const express = require('express');
const cors = require('cors');
const healthRouter = require('./routes/health');
const deviceRouter = require('./routes/device');
const printRouter = require('./routes/print');
const scanRouter = require('./routes/scan');
const printersRouter = require('./routes/printers');
const posDevicesRouter = require('./routes/pos-devices');
const huginRouter = require('./routes/hugin');
const posVendorMiddleware = require('./middleware/posVendor');
const credentialsRouter = require('./routes/credentials');
const updateRouter = require('./routes/update');
const panelRouter = require('./routes/panel');
const notFoundHandler = require('./middleware/notFound');

function createApp() {
  const app = express();

  /**
   * Chrome / Chromium: https://merchant… gibi public HTTPS sayfadan http://127.0.0.1:17888
   * çağrılarında preflight, Access-Control-Allow-Private-Network: true ister (Private Network Access).
   * Yoksa /health ve yazıcı API’leri sessizce bloklanır; Helper açık olsa da panel listelemez.
   */
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '512kb' }));

  app.use(healthRouter);
  app.use(deviceRouter);
  app.use(printRouter);
  app.use(scanRouter);
  app.use(printersRouter);
  app.use(posDevicesRouter);
  app.use('/v1/hugin', huginRouter);
  app.use('/v1/pos', posVendorMiddleware, huginRouter);
  app.use(credentialsRouter);
  app.use(updateRouter);
  app.use(panelRouter);
  app.use(notFoundHandler);

  return app;
}

module.exports = { createApp };

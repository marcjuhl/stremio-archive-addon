'use strict';

require('dotenv').config();
const path = require('path');
const querystring = require('querystring');
const express = require('express');
const cors = require('cors');

const { builder } = require('./addon');
const { archiveClient } = require('./archive');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 7000;
const HOST = process.env.HOST || '0.0.0.0';

// Obtain the Addon Interface from stremio-addon-sdk builder
const addonInterface = builder.getInterface();

// CORS is mandatory for the Stremio protocol across desktop, web, and mobile
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept']
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Serve static assets from public/
app.use('/public', express.static(path.join(__dirname, 'public')));

/**
 * Safely decodes and parses user configuration from URL parameter.
 * Supports standard Base64, URL-safe Base64, and URL-encoded JSON.
 *
 * @param {string} rawConfig
 * @returns {Object} Decoded configuration object or empty object
 */
function parseConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'string') return {};

  // Ignore reserved route keywords
  if (['manifest.json', 'configure', 'api', 'health', 'public'].includes(rawConfig)) {
    return {};
  }

  // 1. Try URL-safe Base64 / Standard Base64
  try {
    let normalized = rawConfig.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) {
      normalized += '=';
    }
    const decodedStr = Buffer.from(normalized, 'base64').toString('utf8');
    if (decodedStr.startsWith('{') && decodedStr.endsWith('}')) {
      const parsed = JSON.parse(decodedStr);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {
    // Continue to next parsing strategy
  }

  // 2. Try URL-encoded JSON
  try {
    const decodedUri = decodeURIComponent(rawConfig);
    if (decodedUri.startsWith('{') && decodedUri.endsWith('}')) {
      const parsed = JSON.parse(decodedUri);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {
    // Not valid JSON
  }

  return {};
}

// ==========================================
// User Configuration Page & API Routes
// ==========================================

// Root redirects to configuration page
app.get('/', (req, res) => {
  res.redirect('/configure');
});

// User configuration UI
app.get(['/configure', '/:config/configure'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Credentials validation API endpoint
app.post('/api/validate-auth', async (req, res) => {
  try {
    const result = await archiveClient.validateCredentials(req.body || {});
    res.json(result);
  } catch (err) {
    console.error('[API] Validate auth error:', err.message);
    res.status(500).json({ valid: false, message: `Validation error: ${err.message}` });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// Stremio v3 Manifest Endpoints
// ==========================================

// Configured Manifest: /:config/manifest.json
app.get('/:config/manifest.json', (req, res) => {
  const config = parseConfig(req.params.config);
  const manifestClone = JSON.parse(JSON.stringify(addonInterface.manifest));

  // Once configured, configurationRequired is false
  if (manifestClone.behaviorHints) {
    delete manifestClone.behaviorHints.configurationRequired;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'max-age=3600, public');
  res.json(manifestClone);
});

// Unconfigured Root Manifest: /manifest.json
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'max-age=3600, public');
  res.json(addonInterface.manifest);
});

// ==========================================
// Stremio v3 Resource Endpoints
// ==========================================

// Configured Resource with extra query parameters (e.g. /:config/catalog/movie/archive_movies/skip=24.json)
app.get('/:config/:resource/:type/:id/:extra.json', async (req, res, next) => {
  const { resource, type, id, config: rawConfig, extra: rawExtra } = req.params;
  if (!['catalog', 'stream'].includes(resource)) return next();

  const config = parseConfig(rawConfig);
  let extra = {};
  if (rawExtra) {
    extra = querystring.parse(rawExtra);
  }

  try {
    const resp = await addonInterface.get(resource, type, id, extra, config);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=1800, stale-while-revalidate=300, public');
    res.json(resp);
  } catch (err) {
    console.error(`[Addon] Error servicing ${resource}/${type}/${id}:`, err.message);
    res.status(500).json({ err: 'Handler error' });
  }
});

// Configured Resource without extra (e.g. /:config/stream/movie/Night.Of.The.Living.Dead_1080p.json)
app.get('/:config/:resource/:type/:id.json', async (req, res, next) => {
  const { resource, type, id, config: rawConfig } = req.params;
  if (!['catalog', 'stream'].includes(resource)) return next();

  const config = parseConfig(rawConfig);

  try {
    const resp = await addonInterface.get(resource, type, id, {}, config);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=1800, stale-while-revalidate=300, public');
    res.json(resp);
  } catch (err) {
    console.error(`[Addon] Error servicing ${resource}/${type}/${id}:`, err.message);
    res.status(500).json({ err: 'Handler error' });
  }
});

// Unconfigured Resource with extra (e.g. /catalog/movie/archive_movies/search=charade.json)
app.get('/:resource/:type/:id/:extra.json', async (req, res, next) => {
  const { resource, type, id, extra: rawExtra } = req.params;
  if (!['catalog', 'stream'].includes(resource)) return next();

  let extra = {};
  if (rawExtra) {
    extra = querystring.parse(rawExtra);
  }

  try {
    const resp = await addonInterface.get(resource, type, id, extra, {});
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=1800, stale-while-revalidate=300, public');
    res.json(resp);
  } catch (err) {
    console.error(`[Addon] Error servicing unconfigured ${resource}/${type}/${id}:`, err.message);
    res.status(500).json({ err: 'Handler error' });
  }
});

// Unconfigured Resource without extra (e.g. /stream/movie/Night.Of.The.Living.Dead_1080p.json)
app.get('/:resource/:type/:id.json', async (req, res, next) => {
  const { resource, type, id } = req.params;
  if (!['catalog', 'stream'].includes(resource)) return next();

  try {
    const resp = await addonInterface.get(resource, type, id, {}, {});
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=1800, stale-while-revalidate=300, public');
    res.json(resp);
  } catch (err) {
    console.error(`[Addon] Error servicing unconfigured ${resource}/${type}/${id}:`, err.message);
    res.status(500).json({ err: 'Handler error' });
  }
});

// Catch-all 404 handler for undefined endpoints
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[HTTP] Unhandled exception:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

let server = null;

/**
 * Starts the HTTP server on specified port and host.
 *
 * @param {number} port
 * @param {string} host
 * @returns {Promise<import('http').Server>}
 */
function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    if (server && server.listening) {
      return resolve(server);
    }
    server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      console.log(`====================================================`);
      console.log(` Internet Archive Stremio Addon v${addonInterface.manifest.version} running!`);
      console.log(` Listening on: http://${host}:${actualPort}`);
      console.log(` Manifest URL: http://${host}:${actualPort}/manifest.json`);
      console.log(` Configuration: http://${host}:${actualPort}/configure`);
      console.log(`====================================================`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Automatically start server when executed directly as entrypoint
if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Server] Failed to start server:', err);
    process.exit(1);
  });
}

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed. Process exiting.');
      process.exit(0);
    });
    // Force close if still hanging after 5s
    setTimeout(() => {
      console.error('[Server] Could not close connections in time, forcefully shutting down.');
      process.exit(1);
    }, 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { app, startServer, parseConfig };

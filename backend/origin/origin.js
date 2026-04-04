/**
 * ============================================================
 *  LiteCDN – Origin Server
 * ============================================================
 *  The Origin Server is the **source of truth** for all
 *  content.  In a production CDN this would be the customer's
 *  web-server.  Here it simply serves static files from the
 *  `static/` directory and a handful of JSON mock endpoints.
 *
 *  Endpoints
 *  ---------
 *  GET /content/:filename   →  Serves a file from ./static/
 *  GET /mock/api            →  Returns a small JSON payload
 *  GET /health              →  Health-check endpoint
 * ============================================================
 */

const express = require('express');
const path    = require('path');
const cors    = require('cors');
const config  = require('../config');

// ── Create Express App ───────────────────────────────────────
const app  = express();

// Manually ensure CORS preflight and access control
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});
app.use(cors()); // Fallback standard CORS

const PORT = config.origin.port;

// ── Logging Middleware ───────────────────────────────────────
let isOffline = false;

app.use(express.json({ limit: '50mb' })); // Support JSON bodies for upload
app.use((req, res, next) => {
  if (isOffline && !req.url.startsWith('/admin') && !req.url.startsWith('/config')) {
    return res.status(503).json({ error: 'Origin server is offline' });
  }
  console.log(`[OriginServer] 📥  ${req.method} ${req.url}`);
  next();
});

/**
 * Serve static content files from the ./static/ directory
 * @returns {express.Router} Configured router for static file serving
 */
function serveStaticContent() {
  console.log('[OriginServer] 📂 Static content handler initialized');
  return express.static(path.join(__dirname, 'static'), {
    fallthrough: false,
  });
}
/**
 * Handle mock JSON API requests
 * @param {object} _req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
function serveMockAPI(_req, res) {
  console.log('[OriginServer] 📤 Serving mock JSON data');
  res.json({
    source: 'OriginServer',
    timestamp: new Date().toISOString(),
    data: {
      message: 'Hello from the Origin!  This is mock API data.',
      items: ['alpha', 'beta', 'gamma'],
    },
  });
}

/**
 * Handle health check requests
 * @param {object} _req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
function handleHealthCheck(_req, res) {
  console.log('[OriginServer] 💚 Health check requested');
  res.json({ status: 'UP', server: 'OriginServer', port: PORT });
}

/**
 * Handle static file errors (e.g., 404 for missing files)
 * @param {object} err - Error object
 * @param {object} _req - Express request object
 * @param {object} res - Express response object
 * @param {object} _next - Express next function
 * @returns {void}
 */

function handleStaticError(err, _req, res, _next) {
  if (err.status === 404 || err.statusCode === 404) {
    console.log('[OriginServer] ⚠️  File not found');
    return res.status(404).json({ error: 'File not found on Origin' });
  }
  return res.status(500).json({ error: 'Internal Origin error' });
}

/**
 * Handle catch-all 404 requests
 * @param {object} _req - Express request object
 * @param {object} res - Express response object
 * @returns {void}
 */
function handleNotFound(_req, res) {
  console.log('[OriginServer] ❌ Endpoint not found');
  res.status(404).json({ error: 'Not found on Origin' });
}

// ────────────────────────────────────────────────────────────
// ── Express Routes ───────────────────────────────────────────
// ────────────────────────────────────────────────────────────

// ── Serve Static Files ───────────────────────────────────────
//    Any file placed inside ./static/ can be requested via
//    GET /content/<filename>
app.use('/content', serveStaticContent());
app.use('/content', handleStaticError);app.get('/api/data', serveMockAPI);app.get('/mock/api', serveMockAPI);
app.get('/health', handleHealthCheck);

// ── Dashboard Endpoints ─────────────────────────────────────
app.post('/admin/stop', (req, res) => {
  isOffline = true;
  console.log('[OriginServer] 🛑 Server stopped (Offline mode)');
  res.json({ message: 'Origin server is now offline' });
});

app.post('/admin/start', (req, res) => {
  isOffline = false;
  console.log('[OriginServer] 🟢 Server started (Online mode)');
  res.json({ message: 'Origin server is now online' });
});

app.get('/config', (req, res) => {
  res.json(config.origin);
});

app.post('/upload', (req, res) => {
  const fs = require('fs');
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'Missing filename or content in JSON body' });
  }
  try {
    const filePath = path.join(__dirname, 'static', filename);
    const isBase64 = content.startsWith('data:');
    if (isBase64) {
      const base64Data = content.split(';base64,').pop();
      fs.writeFileSync(filePath, base64Data, { encoding: 'base64' });
    } else {
      fs.writeFileSync(filePath, content);
    }
    console.log(`[OriginServer] 📤  Uploaded new file: ${filename}`);
    res.json({ message: 'File uploaded successfully', filename });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload file to origin' });
  }
});

app.use(handleNotFound);

// ── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('='.repeat(56));
  console.log(`  [OriginServer] ✅  Running on http://localhost:${PORT}`);
  console.log('='.repeat(56));
});

module.exports = app;   // export for testing if needed

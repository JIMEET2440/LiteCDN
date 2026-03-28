/**
 * ============================================================
 *  LiteCDN – CDN System / Gateway Router
 * ============================================================
 *  This is the **main entry-point** that clients hit.
 *  It acts as a reverse-proxy: for every incoming request it
 *  uses the RoutingService to pick an Edge Server via
 *  round-robin, then proxies the request to that edge and
 *  streams the response back to the client.
 *
 *  Endpoints
 *  ---------
 *  GET /cdn/*      →  Routed to an Edge Server
 *  GET /health     →  Gateway health-check
 *  GET /status     →  Shows edge list & current RR index
 *
 *  Flow: Client → CDNSystem → EdgeServer → (cache / Origin)
 * ============================================================
 */

const express        = require('express');
const axios          = require('axios');
const cors           = require('cors');
const config         = require('../config');
const RoutingService = require('./routing');
const testAPI        = require('./testAPI');
const { runAllTests  } = require('../../testing/unitTests');

// ── Initialise ───────────────────────────────────────────────
const app     = express();
const PORT    = config.cdn.port;
const router  = new RoutingService();    // uses config.edges by default

// Enable CORS so the frontend (if any) can call the gateway
app.use(cors({
  exposedHeaders: ['X-Cache', 'X-Edge-Id', 'X-CDN', 'X-Response-Time'],
}));

// ── Serve Frontend (Dashboard) ───────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, '../../frontend')));

// ── Handler Functions ────────────────────────────────────────

/**
 * Logs incoming requests for debugging purposes
 */
function logRequestMiddleware(req, _res, next) {
  console.log(`\n[CDNSystem] ════════════════════════════════════`);
  console.log(`[CDNSystem] 📥  Request received: ${req.method} ${req.url}`);
  next();
}

/**
 * Main CDN request handler
 * Routes requests to edge servers and proxies responses back
 */
async function handleCDNRequest(req, res) {
  const startTime = Date.now();

  // 1. Determine the origin-style path from the URL
  const resourcePath = req.params[0];          // e.g. "content/hello.txt"

  // 2. Use RoutingService to pick the next Edge Server
  const edge = router.selectEdge();
  console.log(`[CDNSystem] 🔀 Routed to ${edge.id} (${edge.url})`);

  // 3. Build the URL to the Edge Server's /fetch endpoint
  const edgeURL = `${edge.url}/fetch/${resourcePath}`;
  console.log(`[CDNSystem] ➡️  Forwarding to: ${edgeURL}`);

  try {
    // 4. Proxy the request to the Edge Server
    const edgeResponse = await axios.get(edgeURL, {
      responseType: 'arraybuffer',
      validateStatus: (status) => status < 500,
    });

    // 5. Relay headers back to the client
    const contentType = edgeResponse.headers['content-type'] || 'application/octet-stream';
    const cacheStatus = edgeResponse.headers['x-cache'] || 'UNKNOWN';
    const edgeId      = edgeResponse.headers['x-edge-id'] || edge.id;
    const elapsed     = Date.now() - startTime;

    res.set('Content-Type', contentType);
    res.set('X-Cache', cacheStatus);
    res.set('X-Edge-Id', edgeId);
    res.set('X-CDN', 'LiteCDN');
    res.set('X-Response-Time', `${elapsed}ms`);

    console.log(`[CDNSystem] ✅  Response from ${edgeId} | Cache: ${cacheStatus} | Served in ${elapsed}ms`);

    // Update router metrics (simple latency reporting). Load can be
    // updated by a separate poller if implemented later.
    try {
      router.updateLatency(edge.id, elapsed);
    } catch (err) {
      // non-fatal
    }

    return res.status(edgeResponse.status).send(edgeResponse.data);

  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[CDNSystem] 🚨 Error contacting ${edge.id}:`, err.message, `| ${elapsed}ms`);
    return res.status(502).json({
      error: `Bad Gateway – could not reach ${edge.id}`,
      details: err.message,
    });
  }
}

/**
 * Health check endpoint
 */
function handleHealthCheck(_req, res) {
  res.json({ status: 'UP', server: 'CDNSystem', port: PORT });
}

/**
 * Status endpoint for debugging
 */
function handleStatusRequest(_req, res) {
  res.json({
    server: 'CDNSystem',
    port: PORT,
    routingStrategy: router.getMode() === 'round-robin' ? 'Round-Robin' : 'Alpha-Beta (latency·alpha + load·beta)',
    routingParams: {
      alpha: router.alpha,
      beta: router.beta,
      epsilon: router.epsilon,
      mode: router.getMode(),
    },
    currentIndex: router.getCurrentIndex(),
    edges: router.getEdgeList(),
  });
}
// ── Test API Endpoints ───────────────────────────────────────
//    Dashboard endpoints to run tests and return JSON results

app.get('/api/tests/run-all', async (_req, res) => {
  try {
    const result = await runAllTests();
    res.json(result);
  } catch (err) {
    console.error('Error running tests:', err);
    res.status(500).json({ 
      error: 'Failed to run tests', 
      message: err.message,
      summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
      results: { passed: [], failed: [] }
    });
  }
});

app.get('/api/tests/load', async (_req, res) => {
  const gatewayBase = `http://localhost:${PORT}`;
  const result = await testAPI.runLoadTestAPI(gatewayBase);
  res.json(result);
});

app.get('/api/tests/cache', async (_req, res) => {
  const gatewayBase = `http://localhost:${PORT}`;
  const result = await testAPI.runCacheTestAPI(gatewayBase);
  res.json(result);
});

app.get('/api/tests/routing', async (_req, res) => {
  const gatewayBase = `http://localhost:${PORT}`;
  const mode = _req.query.mode;
  const result = mode
    ? await testAPI.runRoutingTestByModeAPI(gatewayBase, mode)
    : await testAPI.runRoutingTestAPI(gatewayBase);
  res.json(result);
});

app.get('/api/tests/routing/compare', async (_req, res) => {
  const gatewayBase = `http://localhost:${PORT}`;
  const result = await testAPI.runRoutingCompareAPI(gatewayBase);
  res.json(result);
});

app.get('/api/routing/mode', (req, res) => {
  const mode = req.query.mode;

  if (mode) {
    const ok = router.setMode(mode);
    if (!ok) {
      return res.status(400).json({
        error: 'Invalid routing mode',
        allowed: ['round-robin', 'alpha-beta'],
      });
    }
  }

  return res.json({
    mode: router.getMode(),
    alpha: router.alpha,
    beta: router.beta,
    epsilon: router.epsilon,
  });
});

app.get('/api/routing/modes', (_req, res) => {
  res.json({
    available: ['round-robin', 'alpha-beta'],
    default: 'alpha-beta',
  });
});

// ── Route Registrations ───────────────────────────────────────

app.use(logRequestMiddleware);
app.get('/cdn/*', handleCDNRequest);
app.get('/health', handleHealthCheck);
app.get('/status', handleStatusRequest);

// ── Catch-All 404 ────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found – use /cdn/<path> to fetch content' });
});

// ── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('='.repeat(56));
  console.log(`  [CDNSystem] ✅  Gateway running on http://localhost:${PORT}`);
  console.log(`  [CDNSystem] 🔗  Edges: ${router.getEdgeList().map(e => e.id).join(', ')}`);
  console.log('='.repeat(56));
});

module.exports = app;
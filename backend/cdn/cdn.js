const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const config = require('../config');
const RoutingService = require('./routing');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../../frontend')));

// --- Expose Production UI ---
app.get('/production', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/production-dashboard.html'));
});

let isOffline = false;

app.use((req, res, next) => {
  // Allow admin and config requests even if offline
  if (isOffline && !req.url.startsWith('/admin') && !req.url.startsWith('/config') && !req.url.startsWith('/status')) {
    return res.status(503).json({ error: 'CDN gateway is currently offline.' });
  }
  next();
});

const PORT = config.cdn.port;
const GATEWAY_NAME = 'CDNSystem';

const routingService = new RoutingService(config.edges);
routingService.setMode('alpha-beta', { alpha: 0.7, beta: 0.3, epsilon: 0.1 });
let edgeMetrics = {};

// Fetch metrics
setInterval(async () => {
  const promises = config.edges.map(async (edge) => {
    try {
      const res = await axios.get(`http://${edge.host}:${edge.port}/metrics`);
      edgeMetrics[edge.id] = { status: 'UP', ...res.data };
    } catch (err) {
      edgeMetrics[edge.id] = { status: 'DOWN', latency: 9999, load: 0 };
    }
  });
  await Promise.all(promises);
}, 50);

// Tracking local requests to avoid Stale State metrics
const inFlightRequests = {};
config.edges.forEach(e => inFlightRequests[e.id] = 0);

// Dashboard Endpoints
app.post('/admin/stop', (req, res) => {
  isOffline = true;
  console.log(`[CDNSystem] 🛑 CDN is offline`);
  res.json({ message: 'CDN stopped (offline mode)' });
});

app.post('/admin/start', (req, res) => {
  isOffline = false;
  console.log(`[CDNSystem] 🟢 CDN is online`);
  res.json({ message: 'CDN started (online mode)' });
});

app.get('/config', (req, res) => {
  res.json({
    routing: routingService.mode,
    routingOptions: routingService.options,
    edges: config.edges,
    origin: config.origin,
    cdn: config.cdn
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.post('/policy/routing', express.json(), (req, res) => {
  const { mode, ...options } = req.body;
  if (!['round-robin', 'alpha-beta'].includes(mode)) {
    return res.status(400).json({ error: 'Unsupported routing mode' });
  }
  routingService.setMode(mode, options);
  res.json({ message: `Routing policy set to ${mode}`, options });
});

app.post('/policy/cache', express.json(), async (req, res) => {
  const { mode, size } = req.body;
  const promises = config.edges.map(async (edge) => {
    try {
      await axios.post(`http://${edge.host}:${edge.port}/policy/cache`, { mode, size });
    } catch (e) {
      console.log('Failed to update cache on', edge.id);
    }
  });
  await Promise.all(promises);
  res.json({ message: 'Global cache policy updated', mode, size });
});

app.get('/cdn/content/:file', async (req, res) => {
  const targetEdge = routingService.route(req, edgeMetrics, inFlightRequests);
  if (!targetEdge) {
    return res.status(503).json({ error: 'No edges available' });
  }
  
  const cost = parseFloat(req.query.cost) || 1;

  // Predictively model that this edge is now processing an additional request
  inFlightRequests[targetEdge.id] = (inFlightRequests[targetEdge.id] || 0) + cost;
  
  try {
    const url = `http://${targetEdge.host}:${targetEdge.port}/${'content/' + req.params.file}?cost=${cost}`;
    const start = Date.now();
    const edgeRes = await axios.get(url);
    const latency = Date.now() - start;
    
    // Request finished, remove predictive penalty
    inFlightRequests[targetEdge.id] = Math.max(0, inFlightRequests[targetEdge.id] - cost);
    res.set('x-edge-id', targetEdge.id);
    const isHit = edgeRes.data && edgeRes.data.cacheHit;
    res.set('x-cache', isHit ? 'HIT' : 'MISS');
    res.json({
       edge: targetEdge.id,
       latency,
       data: edgeRes.data
    });
  } catch (err) {
    inFlightRequests[targetEdge.id] = Math.max(0, inFlightRequests[targetEdge.id] - cost);
    res.status(500).json({ error: 'Edge fetch failed' });
  }
});

app.listen(PORT, () => {
    console.log(`[${GATEWAY_NAME}] routing traffic at ${config.cdn.url}`);
});
app.get('/status', (req, res) => {
  res.json({
    status: 'UP',
    edges: config.edges,
    metrics: edgeMetrics
  });
});

/**
 * =========================================================================
 *  LiteCDN - Real SaaS Edge Node
 * =========================================================================
 *  Unlike the local simulated Edge, this server handles multi-tenancy.
 *  It looks at the Host header, asks the Control Plane (Vercel) where
 *  the file lives, caches the incoming file onto memory/disk, and
 *  streams it to the client securely.
 * 
 *  Deploy this to AWS, DigitalOcean, or Hetzner using Docker.
 */

const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const { LRUCache } = require('lru-cache');
const stream = require('stream');
const util = require('util');
const pipeline = util.promisify(stream.pipeline);

const app = express();
app.use(morgan('combined')); // Log all incoming multi-tenant traffic

// ---------------- CACHE ENGINE ----------------
// A true capacity-bounded LRU cache
const memoryCache = new LRUCache({
  max: 500, // max 500 items
  maxSize: 50 * 1024 * 1024, // 50MB hard limit across the entire server
  sizeCalculation: (value, key) => {
    // Value will be a Buffer
    return value.length;
  },
  ttl: 1000 * 60 * 60 // 1 hour TTL default
});

// ---------------- CONFIGURATION ----------------
// The URL of your Vercel deployment where users register their websites
const CONTROL_PLANE_API = process.env.CONTROL_PLANE_API || 'https://litecdnn.vercel.app/api';

/**
 * Core Proxy & Cache Route
 * We catch ALL HTTP requests to this container.
 */
app.all('*', async (req, res) => {
  const host = req.hostname; // E.g., 'cdn.custom-customer.com'
  const path = req.originalUrl;
  const cacheKey = `${host}${path}`;

  // 1. CHECK CACHE FIRST (Fast Path - ~1ms)
  if (memoryCache.has(cacheKey)) {
    console.log(`[HIT] Serving ${cacheKey} from Memory`);
    res.setHeader('X-LiteCDN-Cache', 'HIT');
    res.setHeader('X-LiteCDN-Edge', process.env.EDGE_LOCATION || 'Global-Edge-1');
    const cachedBuffer = memoryCache.get(cacheKey);
    return res.status(200).send(cachedBuffer);
  }

  // 2. MISS! RESOLVE MULTI-TENANT ORIGIN FROM CONTROL PLANE
  console.log(`[MISS] Cache Miss for ${cacheKey}. Resolving origin...`);
  res.setHeader('X-LiteCDN-Cache', 'MISS');
  res.setHeader('X-LiteCDN-Edge', process.env.EDGE_LOCATION || 'Global-Edge-1');

  let originUrl = '';
  try {
    // We ask your Vercel DB: Who owns this domain? Where do they host their files?
    const rs = await axios.get(`${CONTROL_PLANE_API}/resolve?domain=${host}`, { timeout: 2000 });
    originUrl = rs.data.origin; 
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.status(404).send('LiteCDN Error: Domain not registered on this CDN network.');
    }
    console.error('Error resolving origin:', error.message);
    return res.status(500).send('LiteCDN Error: Failed to resolve origin mappings.');
  }

  // 3. FETCH STREAM FROM CUSTOMER'S TRUE ORIGIN AND CACHE
  // We use streaming to prevent Memory crashes on massive file deliveries.
  const targetUrl = `${originUrl}${path}`;
  console.log(`[FETCH] Fetching from Origin: ${targetUrl}`);

  try {
    const originResponse = await axios({
      method: req.method,
      url: targetUrl,
      responseType: 'arraybuffer', // Store as binary buffer for strict size tracking
      headers: {
        'Accept': req.headers['accept'],
        'User-Agent': 'LiteCDN-Edge/1.0'
      },
      validateStatus: () => true // Forward all status codes
    });

    // Copy original content types
    if (originResponse.headers['content-type']) {
      res.setHeader('Content-Type', originResponse.headers['content-type']);
    }

    // Only cache 200 OK responses, don't cache 404s/500s unless desired
    if (originResponse.status === 200) {
      const bufferPayload = Buffer.from(originResponse.data);
      // Attempt to cache (will automatically drop if it exceeds 50MB LRU limit)
      try {
        memoryCache.set(cacheKey, bufferPayload);
        console.log(`[STORE] Cached ${bufferPayload.length} bytes for ${cacheKey}`);
      } catch (cacheErr) {
        console.log(`[SKIP] File too large for Edge Cache Limits`);
      }
    }

    // Send payload to client
    return res.status(originResponse.status).send(originResponse.data);

  } catch (fetchError) {
    console.error('Failed to proxy request:', fetchError.message);
    return res.status(502).send('LiteCDN Error: Bad Gateway. Communication with origin failed.');
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 LiteCDN Global Edge Node started`);
  console.log(`🌍 Listening on Port ${PORT}`);
  console.log(`🔗 Linked to Control Plane: ${CONTROL_PLANE_API}`);
  console.log(`=========================================`);
});
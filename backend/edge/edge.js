/**
 * ============================================================
 *  LiteCDN – Edge Server
 * ============================================================
 *  An Edge Server sits close to the end-user. It maintains a
 *  **segmented in-memory cache** and tries to serve requests
 *  from cache before reaching back to the Origin Server.
 *
 *  Current features:
 *    • Segmented cache: New (35%), Popular (60%), Miss-Aware (5%).
 *    • Sliding TTL and LRU eviction within segments.
 *    • Prioritized inter-segment eviction: New -> Miss-Aware -> Popular.
 *
 *  Environment Variables (set before starting):
 *    PORT     – port this edge listens on  (default 3001)
 *    EDGE_ID  – human-readable name        (default "Edge-X")
 *
 *  Endpoints
 *  ---------
 *  GET /fetch/*   →  Cache-aware proxy to the Origin Server
 *  GET /health    →  Health-check
 *  GET /cache     →  Dump current cache keys (debug helper)
 * ============================================================
 */

const express = require('express');
const axios   = require('axios');
const config  = require('../config');

// ── Configuration ────────────────────────────────────────────
// Default to the first edge port from shared config so the
// file stays in sync with `backend/config.js` when no
// `PORT` env var is provided.
const PORT    = process.env.PORT    || config.edges[0].port;
const EDGE_ID = process.env.EDGE_ID || `Edge-${PORT}`;

const ORIGIN_URL = config.origin.url;   // e.g. http://localhost:4000

// ── Segmented Cache Configuration (35-60-5) ──────────────────────
const SEGMENTS = {
  NEW: 'new',
  POPULAR: 'popular',
  MISS_AWARE: 'missAware',
};

const CACHE_CAPACITY = Number(process.env.CACHE_CAPACITY || 10);

const TTL_MS = {
  [SEGMENTS.NEW]: 5 * 60 * 1000,
  [SEGMENTS.POPULAR]: 60 * 60 * 1000,
  [SEGMENTS.MISS_AWARE]: 60 * 1000,
};

const POPULAR_HARD_CEILING_MS = 12 * 60 * 60 * 1000;
const NEW_TO_POPULAR_THRESHOLD = 2;
const MISS_AWARE_PROMOTION_THRESHOLD = 2;

// Just the math to give proper Capacities
function resolveSegmentCapacities(total) {
  if (!Number.isFinite(total) || total <= 0) {
    return {
      [SEGMENTS.NEW]: 1,
      [SEGMENTS.POPULAR]: 1,
      [SEGMENTS.MISS_AWARE]: 1,
    };
  }

  let newCap = Math.max(1, Math.floor(total * 0.35));
  let popularCap = Math.max(1, Math.floor(total * 0.60));
  let missAwareCap = total - newCap - popularCap;

  if (missAwareCap < 1) {
    missAwareCap = 1;
  }

  while (newCap + popularCap + missAwareCap > total) {
    if (popularCap > newCap && popularCap > 1) {
      popularCap -= 1;
    } else if (newCap > 1) {
      newCap -= 1;
    } else if (missAwareCap > 1) {
      missAwareCap -= 1;
    } else {
      break;
    }
  }

  while (newCap + popularCap + missAwareCap < total) {
    popularCap += 1;
  }

  return {
    [SEGMENTS.NEW]: newCap,
    [SEGMENTS.POPULAR]: popularCap,
    [SEGMENTS.MISS_AWARE]: missAwareCap,
  };
}

const SEGMENT_CAPACITY = resolveSegmentCapacities(CACHE_CAPACITY);

// Each segment is an LRU map (insertion order updated on hit).
const cacheSegments = {
  [SEGMENTS.NEW]: new Map(),
  [SEGMENTS.POPULAR]: new Map(),
  [SEGMENTS.MISS_AWARE]: new Map(),
};

// Tracks consecutive edge misses per key for miss-aware admission.
const missCounters = new Map();

// ── Create Express App ───────────────────────────────────────
const app = express();

// ── Runtime Load Metrics ──────────────────────────────────────
const EDGE_MAX_INFLIGHT = Number(process.env.EDGE_MAX_INFLIGHT || 100);
const EDGE_MAX_RPS = Number(process.env.EDGE_MAX_RPS || 80);
const EDGE_LOAD_ALPHA = 0.2; // EWMA smoothing for load signal

let activeRequests = 0;
let totalRequests = 0;
let windowRequestCount = 0;
let avgResponseTimeMs = 0;
let smoothedLoadNormalized = 0;
let requestsPerSecond = 0;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function computeLoadComponents() {
  const capacityRatio = CACHE_CAPACITY > 0 ? getTotalCacheSize() / CACHE_CAPACITY : 0;
  const inflightRatio = EDGE_MAX_INFLIGHT > 0 ? activeRequests / EDGE_MAX_INFLIGHT : 0;
  const requestRateRatio = EDGE_MAX_RPS > 0 ? requestsPerSecond / EDGE_MAX_RPS : 0;

  // Weighted pressure model. We keep cache pressure lighter than active load.
  const rawLoad = (0.5 * inflightRatio) + (0.35 * requestRateRatio) + (0.15 * capacityRatio);
  return {
    inflightRatio: clamp01(inflightRatio),
    requestRateRatio: clamp01(requestRateRatio),
    capacityRatio: clamp01(capacityRatio),
    rawLoad: clamp01(rawLoad),
  };
}

setInterval(() => {
  requestsPerSecond = windowRequestCount;
  windowRequestCount = 0;

  const components = computeLoadComponents();
  smoothedLoadNormalized =
    EDGE_LOAD_ALPHA * components.rawLoad
    + (1 - EDGE_LOAD_ALPHA) * smoothedLoadNormalized;
}, 1000);

// ── Logging Middleware ───────────────────────────────────────
app.use((req, res, next) => {
  const reqStart = Date.now();
  activeRequests += 1;
  totalRequests += 1;
  windowRequestCount += 1;

  res.on('finish', () => {
    activeRequests = Math.max(0, activeRequests - 1);
    const duration = Date.now() - reqStart;
    if (!avgResponseTimeMs || avgResponseTimeMs === 0) {
      avgResponseTimeMs = duration;
    } else {
      avgResponseTimeMs = EDGE_LOAD_ALPHA * duration + (1 - EDGE_LOAD_ALPHA) * avgResponseTimeMs;
    }
  });

  console.log(`[${EDGE_ID}] 📥  ${req.method} ${req.url}`);
  next();
});

/**
 * Check if a resource exists in cache and return it
 * @param {string} path - Cache key (normalized path)
 * @returns {object|null} Cache entry if found, null otherwise
 */
function getTotalCacheSize() {
  return (
    cacheSegments[SEGMENTS.NEW].size
    + cacheSegments[SEGMENTS.POPULAR].size
    + cacheSegments[SEGMENTS.MISS_AWARE].size
  );
}

function removeFromAllSegments(path) {
  for (const segmentName of Object.values(SEGMENTS)) {
    cacheSegments[segmentName].delete(path);
  }
}

// check the existance of the data in already present cache
function findSegmentEntry(path) {
  for (const segmentName of [SEGMENTS.POPULAR, SEGMENTS.MISS_AWARE, SEGMENTS.NEW]) {
    const segmentMap = cacheSegments[segmentName];
    if (segmentMap.has(path)) {
      return { segmentName, entry: segmentMap.get(path) };
    }
  }
  return null;
}

function remainingTtl(entry, segmentName, now) {
  const rollingRemaining = entry.expiresAt - now;
  if (segmentName === SEGMENTS.POPULAR) {
    return Math.min(rollingRemaining, entry.hardExpiresAt - now);
  }
  return rollingRemaining;
}

//Check if expired or not.
function isExpired(entry, segmentName, now) {
  if (remainingTtl(entry, segmentName, now) <= 0) {
    return true;
  }
  return false;
}

// What it does?
function pickEvictionKey(segmentName) {
  const segmentMap = cacheSegments[segmentName];
  const now = Date.now();

  let candidatePath = null;
  let candidateEntry = null;

  for (const [path, entry] of segmentMap.entries()) {
    if (!candidateEntry) {
      candidatePath = path;
      candidateEntry = entry;
      continue;
    }

    if (entry.lastAccessedAt < candidateEntry.lastAccessedAt) {
      candidatePath = path;
      candidateEntry = entry;
      continue;
    }

    if (entry.lastAccessedAt === candidateEntry.lastAccessedAt) {
      const currentRemaining = remainingTtl(entry, segmentName, now);
      const candidateRemaining = remainingTtl(candidateEntry, segmentName, now);
      if (currentRemaining < candidateRemaining) {
        candidatePath = path;
        candidateEntry = entry;
      }
    }
  }

  return candidatePath;
}

function evictOneFromSegment(segmentName, reason) {
  const keyToEvict = pickEvictionKey(segmentName);
  if (!keyToEvict) {
    return false;
  }

  cacheSegments[segmentName].delete(keyToEvict);
  console.log(`[${EDGE_ID}] 🧹 Evicted from ${segmentName}: "${keyToEvict}" (${reason})`);
  return true;
}

function evictByPriority(reason) {
  const order = [SEGMENTS.NEW, SEGMENTS.MISS_AWARE, SEGMENTS.POPULAR];
  for (const segmentName of order) {
    if (cacheSegments[segmentName].size > 0) {
      return evictOneFromSegment(segmentName, reason);
    }
  }
  return false;
}

function enforceSegmentCapacity(segmentName) {
  const segmentMap = cacheSegments[segmentName];
  const segmentCap = SEGMENT_CAPACITY[segmentName];

  while (segmentMap.size > segmentCap) {
    const beforeSize = segmentMap.size;
    evictByPriority(`capacity pressure for ${segmentName}`);

    // Ensure this segment actually shrinks even if higher-priority
    // segments are being drained first.
    if (segmentMap.size === beforeSize) {
      evictOneFromSegment(segmentName, `segment cap exceeded for ${segmentName}`);
    }
  }

  while (getTotalCacheSize() > CACHE_CAPACITY) {
    if (!evictByPriority('global capacity pressure')) {
      break;
    }
  }
}

function createCacheEntry(path, body, contentType, segmentName, initialHits = 0) {
  const now = Date.now();
  const expiresAt = now + TTL_MS[segmentName];

  return {
    path,
    body,
    contentType,
    segmentName,
    hits: initialHits,
    firstCachedAt: now,
    lastAccessedAt: now,
    expiresAt,
    hardExpiresAt: segmentName === SEGMENTS.POPULAR ? now + POPULAR_HARD_CEILING_MS : null,
  };
}

function putInSegment(path, body, contentType, segmentName, initialHits = 0) {
  removeFromAllSegments(path);

  const entry = createCacheEntry(path, body, contentType, segmentName, initialHits);
  cacheSegments[segmentName].set(path, entry);
  enforceSegmentCapacity(segmentName);

  console.log(`[${EDGE_ID}] 💾 Stored in ${segmentName}: "${path}"`);
  return entry;
}

function promoteToPopular(path, entry) {
  const promotedEntry = putInSegment(path, entry.body, entry.contentType, SEGMENTS.POPULAR, entry.hits);
  console.log(`[${EDGE_ID}] 🚀 Promoted to popular: "${path}"`);
  return promotedEntry;
}

// Changes the cache_file(entry)'s properties upon accessation
function touchEntry(segmentName, path, entry) {
  const now = Date.now();
  entry.lastAccessedAt = now;
  entry.expiresAt = now + TTL_MS[segmentName];
  cacheSegments[segmentName].delete(path);
  cacheSegments[segmentName].set(path, entry);
}

function serveFromCache(path) {
  const found = findSegmentEntry(path);
  if (!found) {
    console.log(`[${EDGE_ID}] ❌ CACHE MISS → "${path}"`);
    return null;
  }

  const { segmentName, entry } = found;
  const now = Date.now();

  // Bruh what? if present inside cache but expiry time passed then remove it 
  // first then return null T_T T_T ?
  if (isExpired(entry, segmentName, now)) {
    cacheSegments[segmentName].delete(path);
    console.log(`[${EDGE_ID}] ⌛ TTL EXPIRED (${segmentName}) → "${path}"`);
    return null;
  }

  entry.hits += 1;
  touchEntry(segmentName, path, entry); // Changes entry(cache file)'s properties upon accessation

  if (segmentName === SEGMENTS.NEW && entry.hits >= NEW_TO_POPULAR_THRESHOLD) {
    const promoted = promoteToPopular(path, entry);
    return { segmentName: SEGMENTS.POPULAR, entry: promoted };
  }

  if (segmentName === SEGMENTS.MISS_AWARE && entry.hits >= NEW_TO_POPULAR_THRESHOLD) {
    const promoted = promoteToPopular(path, entry);
    return { segmentName: SEGMENTS.POPULAR, entry: promoted };
  }

  console.log(`[${EDGE_ID}] ⚡ CACHE HIT (${segmentName}) → "${path}"`);
  return { segmentName, entry };
}

/**
 * Fetch a resource from the Origin Server
 * @param {string} path - Normalized cache key (normalized path)
 * @returns {object|null} { body, contentType, status } or null on error
 */
async function fetchFromOrigin(path) {
  try {
    const originURL = `${ORIGIN_URL}${path}`;
    console.log(`[${EDGE_ID}] 🔄 Fetching from Origin: ${originURL}`);

    const originResponse = await axios.get(originURL, {
      responseType: 'arraybuffer',
      validateStatus: (status) => status < 500,
    });

    const contentType = originResponse.headers['content-type'] || 'application/octet-stream';
    const body        = originResponse.data;

    return {
      body,
      contentType,
      status: originResponse.status,
    };
  } catch (err) {
    console.error(`[${EDGE_ID}] 🚨 Error fetching from Origin:`, err.message);
    return null;
  }
}

/**
 * Store an entry in the cache
 * @param {object} entry - Cache entry { path, body, contentType }
 * @returns {boolean} True if stored successfully
 */
function putCache(entry, segmentName) {
  if (!entry || !entry.path) {
    console.warn(`[${EDGE_ID}] Invalid cache entry`);
    return false;
  }

  putInSegment(entry.path, entry.body, entry.contentType, segmentName, entry.hits || 0);
  return true;
}

/**
 * Handle TTL expiration for cached entries
 * (Currently a placeholder for future TTL implementation)
 * @returns {void}
 */
function expireTTL() {
  const now = Date.now();
  let expiredCount = 0;

  for (const segmentName of Object.values(SEGMENTS)) {
    for (const [path, entry] of cacheSegments[segmentName].entries()) {
      if (isExpired(entry, segmentName, now)) {
        cacheSegments[segmentName].delete(path);
        expiredCount += 1;
      }
    }
  }

  if (expiredCount > 0) {
    console.log(`[${EDGE_ID}] ⏰ Expired ${expiredCount} entries by TTL`);
  }
}
// ── Main Fetch Route ─────────────────────────────────────────
//    Anything under /fetch/* is treated as a cacheable request.
//    The part after /fetch is forwarded to the Origin Server as-is.
//    Example: GET /fetch/content/hello.txt
//         →   Origin GET /content/hello.txt
app.get('/fetch/*', async (req, res) => {
  const startTime = Date.now();
  expireTTL();

  // Strip the leading "/fetch" to get the origin path
  const originPath = req.params[0];          // e.g. "content/hello.txt"
  const cacheKey   = `/${originPath}`;       // normalised key

  // ── Step 1: Check Cache ──────────────────────────────────
  const cacheResult = serveFromCache(cacheKey);
  // if not null then return as usual
  if (cacheResult) {
    missCounters.delete(cacheKey);
    const elapsed = Date.now() - startTime;
    res.set('Content-Type', cacheResult.entry.contentType);
    res.set('X-Cache', 'HIT');// Response headers are setted here
    res.set('X-Cache-Segment', cacheResult.segmentName);
    res.set('X-Edge-Id', EDGE_ID);
    res.set('X-Response-Time', `${elapsed}ms`);
    console.log(`[${EDGE_ID}] ⚡ Served from cache in ${elapsed}ms (${cacheResult.segmentName})`);
    return res.send(cacheResult.entry.body);
  }

  // ── Step 2: Fetch from Origin ────────────────────────────
  const originResponse = await fetchFromOrigin(cacheKey);
  if (!originResponse) {
    const elapsed = Date.now() - startTime;
    console.error(`[${EDGE_ID}] 🚨 Failed to fetch from Origin | ${elapsed}ms`);
    return res.status(502).json({
      error: 'Bad Gateway – could not reach Origin Server',
      edge: EDGE_ID,
    });
  }

  // If Origin returns 404, forward that to the client
  if (originResponse.status === 404) {
    const elapsed = Date.now() - startTime;
    console.log(`[${EDGE_ID}] ⚠️  Origin returned 404 for "${cacheKey}" | ${elapsed}ms`);
    return res.status(404).json({ error: 'Not found on Origin', edge: EDGE_ID });
  }

  const currentMisses = (missCounters.get(cacheKey) || 0) + 1;
  missCounters.set(cacheKey, currentMisses);

  const destinationSegment =
    currentMisses >= MISS_AWARE_PROMOTION_THRESHOLD ? SEGMENTS.MISS_AWARE : SEGMENTS.NEW;

  // ── Step 3: Store in Cache ─────────────────────────────
  putCache({
    path: cacheKey,
    body: originResponse.body,
    contentType: originResponse.contentType,
    hits: 0,
  }, destinationSegment);

  // ── Step 4: Return to Client ───────────────────────────
  const elapsed = Date.now() - startTime;
  console.log(`[${EDGE_ID}] ❌ CACHE MISS → "${cacheKey}" | Served in ${elapsed}ms (fetched from Origin)`);
  res.set('Content-Type', originResponse.contentType);
  res.set('X-Cache', 'MISS');
  res.set('X-Cache-Segment', destinationSegment);
  res.set('X-Edge-Id', EDGE_ID);
  res.set('X-Response-Time', `${elapsed}ms`);
  return res.send(originResponse.body);
});

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const components = computeLoadComponents();

  res.json({
    status: 'UP',
    server: EDGE_ID,
    port: Number(PORT),
    cacheSize: getTotalCacheSize(),
    cacheCapacity: CACHE_CAPACITY,
    segments: {
      [SEGMENTS.NEW]: cacheSegments[SEGMENTS.NEW].size,
      [SEGMENTS.POPULAR]: cacheSegments[SEGMENTS.POPULAR].size,
      [SEGMENTS.MISS_AWARE]: cacheSegments[SEGMENTS.MISS_AWARE].size,
    },
    metrics: {
      activeRequests,
      requestsPerSecond,
      avgResponseTimeMs: Number(avgResponseTimeMs.toFixed(2)),
      loadNormalized: Number(smoothedLoadNormalized.toFixed(4)),
      components,
    },
  });
});

app.get('/metrics', (_req, res) => {
  const components = computeLoadComponents();

  res.json({
    edgeId: EDGE_ID,
    activeRequests,
    totalRequests,
    requestsPerSecond,
    avgResponseTimeMs: Number(avgResponseTimeMs.toFixed(2)),
    cacheSize: getTotalCacheSize(),
    cacheCapacity: CACHE_CAPACITY,
    loadNormalized: Number(smoothedLoadNormalized.toFixed(4)),
    components,
    timestamp: Date.now(),
  });
});

// ── Debug: Dump Cache Keys ───────────────────────────────────
app.get('/cache', (_req, res) => {
  expireTTL();
  const keys = {
    [SEGMENTS.NEW]: [...cacheSegments[SEGMENTS.NEW].keys()],
    [SEGMENTS.POPULAR]: [...cacheSegments[SEGMENTS.POPULAR].keys()],
    [SEGMENTS.MISS_AWARE]: [...cacheSegments[SEGMENTS.MISS_AWARE].keys()],
  };

  res.json({
    edge: EDGE_ID,
    cacheSize: getTotalCacheSize(),
    cacheCapacity: CACHE_CAPACITY,
    segmentCapacity: SEGMENT_CAPACITY,
    keys,
  });
});

// ── Catch-All 404 ────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found', edge: EDGE_ID });
});

// ── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('='.repeat(56));
  console.log(`  [${EDGE_ID}] ✅  Running on http://localhost:${PORT}`);
  console.log(`  [${EDGE_ID}] 🔗  Origin URL: ${ORIGIN_URL}`);
  console.log('='.repeat(56));
});

module.exports = app;

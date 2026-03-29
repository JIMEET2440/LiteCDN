/**
 * =============================================================
 *  Test Results API Handler
 * =============================================================
 *  Provides endpoints to run tests and return JSON results
 *  for the GUI dashboard.
 * =============================================================
 */

const axios = require('axios');

/**
 * Run Load Test and return results
 */
async function runLoadTestAPI(gatewayBase) {
  try {
    const STATUS_URL = `${gatewayBase}/status`;
    const CDN_CONTENT_BASE = `${gatewayBase}/cdn/content`;
    const NUM_REQUESTS = 100;
    const CONCURRENCY = 12;

    // Get status
    const statusRes = await axios.get(STATUS_URL, { timeout: 3000, validateStatus: () => true });
    if (statusRes.status !== 200) {
      return { error: 'Cannot reach gateway /status endpoint' };
    }

    const status = statusRes.data;
    const edges = status.edges || [];
    if (!Array.isArray(edges) || edges.length === 0) {
      return { error: 'No edges available' };
    }

    // Run requests
    const tasks = [];
    for (let i = 0; i < NUM_REQUESTS; i++) {
      tasks.push(async () => {
        try {
          const res = await axios.get(`${CDN_CONTENT_BASE}/hello.txt`, { 
            timeout: 5000, 
            validateStatus: () => true 
          });
          return { 
            status: 'ok', 
            edgeId: res.headers['x-edge-id'] || 'UNKNOWN' 
          };
        } catch (err) {
          return { status: 'error', error: err.message };
        }
      });
    }

    // Promise pool
    const results = [];
    let i = 0;
    const workers = new Array(CONCURRENCY).fill(null).map(async () => {
      while (i < tasks.length) {
        const idx = i++;
        try {
          results[idx] = await tasks[idx]();
        } catch (err) {
          results[idx] = { error: err };
        }
      }
    });
    await Promise.all(workers);

    // Analyze results
    const distribution = {};
    let success = 0;
    let failure = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.status === 'ok') {
        distribution[r.edgeId] = (distribution[r.edgeId] || 0) + 1;
        success++;
      } else {
        failure++;
      }
    }

    // Fill zeros
    for (const e of edges) {
      if (!distribution[e.id]) distribution[e.id] = 0;
    }

    const total = success;
    const counts = Object.values(distribution);
    const avg = total / counts.length || 1;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const imbalancePercent = (((max - min) / (avg || 1)) * 100).toFixed(2);

    return {
      distribution,
      summary: {
        totalRequests: NUM_REQUESTS,
        successRequests: success,
        failureRequests: failure,
        successPercent: ((success / NUM_REQUESTS) * 100).toFixed(1),
        avgPerEdge: avg.toFixed(2),
        min,
        max,
        imbalancePercent: parseFloat(imbalancePercent),
      }
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Run Cache Test and return results
 */
async function runCacheTestAPI(gatewayBase) {
  try {
    const STATUS_URL = `${gatewayBase}/status`;
    const CDN_CONTENT_BASE = `${gatewayBase}/cdn/content`;
    const REQUESTS_PER_EDGE = 3;
    const TEST_FILE = 'hello.txt';

    // Get status
    const statusRes = await axios.get(STATUS_URL, { timeout: 3000, validateStatus: () => true });
    if (statusRes.status !== 200) {
      return { error: 'Cannot reach gateway /status endpoint' };
    }

    const status = statusRes.data;
    const edges = status.edges || [];
    if (!Array.isArray(edges) || edges.length === 0) {
      return { error: 'No edges available' };
    }

    const n = edges.length;
    const totalRequests = n * REQUESTS_PER_EDGE;
    const records = [];
    let hits = 0;
    let misses = 0;

    for (let i = 1; i <= totalRequests; i++) {
      try {
        const res = await axios.get(`${CDN_CONTENT_BASE}/${TEST_FILE}`, { 
          timeout: 5000, 
          validateStatus: () => true 
        });
        const edgeId = res.headers['x-edge-id'] || 'UNKNOWN';
        const cacheStatus = (res.headers['x-cache'] || 'UNKNOWN').toUpperCase();
        
        if (cacheStatus === 'HIT') hits++;
        if (cacheStatus === 'MISS') misses++;
        
        records.push({ idx: i, edgeId, cacheStatus });
      } catch (err) {
        records.push({ idx: i, edgeId: 'ERR', cacheStatus: 'ERR' });
      }
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return {
      records,
      summary: {
        totalRequests,
        hits,
        misses,
        hitRate: ((hits / (hits + misses || 1)) * 100).toFixed(1),
      }
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Run Routing Test and return results
 */
async function runRoutingTestAPI(gatewayBase) {
  let previousMode = 'alpha-beta';
  let modeApplied = false;

  try {
    const previousModeRes = await axios.get(`${gatewayBase}/api/routing/mode`, {
      timeout: 3000,
      validateStatus: () => true,
    });
    previousMode = previousModeRes.status === 200 ? previousModeRes.data?.mode : 'alpha-beta';

    const mode = 'round-robin';
    const modeRes = await axios.get(`${gatewayBase}/api/routing/mode`, {
      params: { mode },
      timeout: 3000,
      validateStatus: () => true,
    });
    if (modeRes.status !== 200) {
      return { error: 'Could not set routing mode for routing test' };
    }
    modeApplied = true;

    const STATUS_URL = `${gatewayBase}/status`;
    const CDN_CONTENT_BASE = `${gatewayBase}/cdn/content`;
    const NUM_REQUESTS = 12;

    // Get status
    const statusRes = await axios.get(STATUS_URL, { timeout: 3000, validateStatus: () => true });
    if (statusRes.status !== 200) {
      return { error: 'Cannot reach gateway /status endpoint' };
    }

    const status = statusRes.data;
    const edges = status.edges || [];
    if (!Array.isArray(edges) || edges.length === 0) {
      return { error: 'No edges available' };
    }

    const currentIndex = Number.isFinite(status.currentIndex) ? status.currentIndex : -1;

    // Compute expected sequence
    const n = edges.length;
    const expected = [];
    for (let i = 1; i <= NUM_REQUESTS; i++) {
      const idx = (currentIndex + i) % n;
      expected.push(edges[idx].id);
    }

    // Send requests
    const observed = [];
    for (let i = 0; i < NUM_REQUESTS; i++) {
      try {
        const res = await axios.get(`${CDN_CONTENT_BASE}/hello.txt`, { 
          timeout: 5000, 
          validateStatus: () => true 
        });
        const edgeId = res.headers['x-edge-id'] || 'UNKNOWN';
        observed.push(edgeId);
      } catch (err) {
        observed.push('ERR');
      }
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Compare
    let correctCount = 0;
    for (let i = 0; i < NUM_REQUESTS; i++) {
      if (observed[i] === expected[i]) {
        correctCount++;
      }
    }

    const result = {
      mode,
      expected,
      observed,
      summary: {
        totalRequests: NUM_REQUESTS,
        correctCount,
        accuracy: ((correctCount / NUM_REQUESTS) * 100).toFixed(1),
      }
    };

    return result;
  } catch (err) {
    return { error: err.message };
  } finally {
    if (modeApplied) {
      try {
        await axios.get(`${gatewayBase}/api/routing/mode`, {
          params: { mode: previousMode },
          timeout: 3000,
          validateStatus: () => true,
        });
      } catch (_restoreErr) {
        // best-effort restore only
      }
    }
  }
}

/**
 * Run Routing Test for an explicit mode.
 */
async function runRoutingTestByModeAPI(gatewayBase, mode) {
  let previousMode = 'alpha-beta';
  let modeApplied = false;

  try {
    if (mode !== 'round-robin' && mode !== 'alpha-beta') {
      return { error: 'Invalid mode. Use round-robin or alpha-beta' };
    }

    const previousModeRes = await axios.get(`${gatewayBase}/api/routing/mode`, {
      timeout: 3000,
      validateStatus: () => true,
    });
    previousMode = previousModeRes.status === 200 ? previousModeRes.data?.mode : 'alpha-beta';

    const modeRes = await axios.get(`${gatewayBase}/api/routing/mode`, {
      params: { mode },
      timeout: 3000,
      validateStatus: () => true,
    });
    if (modeRes.status !== 200) {
      return { error: `Could not set routing mode to ${mode}` };
    }
    modeApplied = true;

    const STATUS_URL = `${gatewayBase}/status`;
    const CDN_CONTENT_BASE = `${gatewayBase}/cdn/content`;
    const NUM_REQUESTS = 24;

    const statusRes = await axios.get(STATUS_URL, { timeout: 3000, validateStatus: () => true });
    if (statusRes.status !== 200) {
      return { error: 'Cannot reach gateway /status endpoint' };
    }

    const status = statusRes.data;
    const edges = status.edges || [];
    if (!Array.isArray(edges) || edges.length === 0) {
      return { error: 'No edges available' };
    }

    const observed = [];
    for (let i = 0; i < NUM_REQUESTS; i++) {
      try {
        const res = await axios.get(`${CDN_CONTENT_BASE}/hello.txt`, {
          timeout: 5000,
          validateStatus: () => true,
        });
        observed.push(res.headers['x-edge-id'] || 'UNKNOWN');
      } catch (_err) {
        observed.push('ERR');
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const distribution = {};
    for (const e of edges) {
      distribution[e.id] = 0;
    }
    for (const edgeId of observed) {
      if (distribution[edgeId] !== undefined) {
        distribution[edgeId] += 1;
      }
    }

    if (mode === 'round-robin') {
      const currentIndex = Number.isFinite(status.currentIndex) ? status.currentIndex : -1;
      const expected = [];
      const n = edges.length;
      for (let i = 1; i <= NUM_REQUESTS; i++) {
        const idx = (currentIndex + i) % n;
        expected.push(edges[idx].id);
      }

      let correctCount = 0;
      for (let i = 0; i < NUM_REQUESTS; i++) {
        if (observed[i] === expected[i]) {
          correctCount += 1;
        }
      }

      const result = {
        mode,
        expected,
        observed,
        distribution,
        summary: {
          totalRequests: NUM_REQUESTS,
          correctCount,
          accuracy: ((correctCount / NUM_REQUESTS) * 100).toFixed(1),
        },
      };

      return result;
    }

    // Alpha-beta does not have a fixed deterministic sequence.
    const counts = Object.values(distribution);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const uniqueEdgesUsed = counts.filter((c) => c > 0).length;

    const result = {
      mode,
      observed,
      distribution,
      summary: {
        totalRequests: NUM_REQUESTS,
        uniqueEdgesUsed,
        min,
        max,
        spread: max - min,
      },
    };

    return result;
  } catch (err) {
    return { error: err.message };
  } finally {
    if (modeApplied) {
      try {
        await axios.get(`${gatewayBase}/api/routing/mode`, {
          params: { mode: previousMode },
          timeout: 3000,
          validateStatus: () => true,
        });
      } catch (_restoreErr) {
        // best-effort restore only
      }
    }
  }
}

async function runRoutingCompareAPI(gatewayBase) {
  const roundRobin = await runRoutingTestByModeAPI(gatewayBase, 'round-robin');
  const alphaBeta = await runRoutingTestByModeAPI(gatewayBase, 'alpha-beta');

  if (roundRobin.error || alphaBeta.error) {
    return {
      error: roundRobin.error || alphaBeta.error,
      roundRobin,
      alphaBeta,
    };
  }

  return {
    roundRobin,
    alphaBeta,
    comparison: {
      rrAccuracy: roundRobin.summary.accuracy,
      alphaBetaUniqueEdges: alphaBeta.summary.uniqueEdgesUsed,
      alphaBetaSpread: alphaBeta.summary.spread,
    },
  };
}

module.exports = {
  runLoadTestAPI,
  runCacheTestAPI,
  runRoutingTestAPI,
  runRoutingTestByModeAPI,
  runRoutingCompareAPI,
};

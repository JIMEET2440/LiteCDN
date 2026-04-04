const axios = require('axios');
const fs = require('fs');

const GATEWAY = process.env.GATEWAY_BASE || 'http://localhost:3000';
const NUM_REQUESTS = 400; // 400 is enough to show structural stability but not take 10 minutes realistically. Wait, script takes ~5ms * 400 = 2 seconds per mode. 
// Total states: 8 * 2 = 16 seconds. Lets do 1000 requests per mode.

const totalFiles = 200;
const alphaParam = 1.3;
const weights = [];
let maxWeight = 0;
for (let i = 1; i <= totalFiles; i++) {
  const w = 1.0 / Math.pow(i, alphaParam);
  weights.push({ name: `file_${i}.txt`, weight: w });
  maxWeight += w;
}

function getUniformFile() {
  const index = Math.floor(Math.random() * totalFiles) + 1;
  return `file_${index}.txt`;
}

async function setRouting(policy) {
  try {
    await axios.post(`${GATEWAY}/policy/routing`, policy);
  } catch (e) {
    console.error('Failed to set routing', e.message);
  }
}

async function setCache(policy) {
  try {
    await axios.post(`${GATEWAY}/policy/cache`, policy);
  } catch (e) {
    console.error('Failed to set cache', e.message);
  }
}

async function sweepCache() {
  try {
    await axios.get(`${GATEWAY}/purge`); // actually we need to hit all edges?
    // /policy/cache resets empty implicitly.
  } catch (e) {}
}

const routingStrategies = [
  { label: 'Round Robin', config: { mode: 'round-robin' } },
  { label: 'Normal Alpha-Beta', config: { mode: 'alpha-beta', alpha: 0.5, beta: 0.5, epsilon: 0, perturb: false } },
  { label: 'Alpha-Beta + Epsilon', config: { mode: 'alpha-beta', alpha: 0.5, beta: 0.5, epsilon: 0.25, perturb: false } },
  { label: 'Alpha-Beta + Eps + Perturb', config: { mode: 'alpha-beta', alpha: 0.5, beta: 0.5, epsilon: 0.25, perturb: true } }
];

const cachingStrategies = [
  { label: 'LRU', config: { mode: 'lru', size: 15 } },
  { label: 'Segmented (35-60-5)', config: { mode: 'segmented', size: 15 } }
];

async function run() {
  const results = [];
  
  // Wait for servers to start well
  await new Promise(r => setTimeout(r, 2000));

  for (const cache of cachingStrategies) {
    for (const route of routingStrategies) {
      console.log(`Testing Route: ${route.label}, Cache: ${cache.label}`);
      
      // Apply Policies (resets cache size also clears it)
      await setCache(cache.config);
      await setRouting(route.config);
      
      let latencies = [];
      let hits = 0;
      let misses = 0;
      let evictions = 0;
      let edgeLoads = {};
      
      const REQUESTS = 3000;
      const CONCURRENCY = 10;
      let currentIndex = 0;
      
      const fireRequest = async () => {
        const i = currentIndex++;
        if (i >= REQUESTS) return false;
        
        const file = getUniformFile();
        const start = Date.now();
        try {
          const res = await axios.get(`${GATEWAY}/cdn/content/${file}`);
          const duration = Date.now() - start;
          latencies.push(duration);
          
          if (res.data.data && res.data.data.cacheHit) hits++;
          else misses++;
          
          const eId = res.data.edge;
          edgeLoads[eId] = (edgeLoads[eId] || 0) + 1;
        } catch(e) {
          // Ignore failures to keep tests moving
        }
        await new Promise(r => setTimeout(r, 1));
        return true;
      };

      const workers = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        workers.push((async () => {
          while (currentIndex < REQUESTS) {
             await fireRequest();
          }
        })());
      }
      await Promise.all(workers);
      
      const avgLat = latencies.reduce((a,b)=>a+b, 0) / (latencies.length || 1);
      
      const allLoads = [];
      for(let k=1; k<=6; k++) allLoads.push(edgeLoads['Edge-'+k] || 0);
      const totalResponses = hits + misses || 1;
      const mean = totalResponses / 6;
      const stddev = Math.sqrt(allLoads.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / 6);
      
      const hitRatio = hits / ((hits+misses) || 1) * 100;
      
      // Query metrics from gateway
      try {
        const statusRes = await axios.get(`${GATEWAY}/status`);
        for (const e of statusRes.data.edges) {
          const m = statusRes.data.metrics[e.id];
          if (m && m.cache) {
            evictions += (m.cache.evictions || 0);
          }
        }
      } catch(e) {}
      
      results.push({
        Caching: cache.label,
        Routing: route.label,
        AvgLatency: avgLat.toFixed(2),
        LoadVariance: stddev.toFixed(2),
        HitRatio: hitRatio.toFixed(2),
        EvictionTotal: evictions
      });
      
      console.log(`-> Latency: ${avgLat.toFixed(2)}ms, Var: ${stddev.toFixed(2)}, Hit: ${hitRatio.toFixed(2)}%, Evictions: ${evictions}`);
    }
  }
  
  const csvRows = ['Caching,Routing,AvgLatency,LoadVariance,HitRatio,EvictionTotal'];
  results.forEach(r => {
    csvRows.push(`${r.Caching},${r.Routing},${r.AvgLatency},${r.LoadVariance},${r.HitRatio},${r.EvictionTotal}`);
  });
  fs.writeFileSync('metrics_uniform.csv', csvRows.join('\n'));
  console.log('Saved real metrics to metrics_uniform.csv');
  process.exit(0);
}

run();

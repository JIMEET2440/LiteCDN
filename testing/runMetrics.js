const axios = require('axios');
const fs = require('fs');

const GATEWAY = process.env.GATEWAY_BASE || 'http://localhost:3000';
const NUM_REQUESTS = 3000;
const CONCURRENCY = 10;

// Zipf Distribution setup (alpha = 1.1, 400 objects)
const totalFiles = 400;
const alphaParam = 1.1;
const weights = [];
let maxWeight = 0;

for (let i = 1; i <= totalFiles; i++) {
  const w = 1.0 / Math.pow(i, alphaParam);
  weights.push({ name: `file_${i}.txt`, weight: w });
  maxWeight += w;
}

function getZipfFile() {
  let r = Math.random() * maxWeight;
  for (const f of weights) {
    r -= f.weight;
    if (r <= 0) return f.name;
  }
  return weights[weights.length - 1].name;
}

// Box-Muller transform for Log-Normal Distribution
// mu = 0 (log scale), sigma = 1.0
function generateCost() {
  let u = 0, v = 0;
  while(u === 0) u = Math.random(); //Converting [0,1) to (0,1)
  while(v === 0) v = Math.random();
  const z = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
  // X = exp(mu + sigma * Z) = exp(0 + 1 * Z)
  const cost = Math.exp(z);
  return Math.max(0.1, cost); // ensure cost is inherently positive
}

async function setRouting(policy) {
  try {
    await axios.post(`${GATEWAY}/policy/routing`, policy);
  } catch (e) {}
}

async function setCache(policy) {
  try {
    await axios.post(`${GATEWAY}/policy/cache`, policy);
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
  await new Promise(r => setTimeout(r, 2000));

  for (const cache of cachingStrategies) {
    for (const route of routingStrategies) {
      console.log(`Testing Route: ${route.label}, Cache: ${cache.label}`);

      await setCache(cache.config);
      await setRouting(route.config);
      
      let latencies = [];
      let hits = 0;
      let misses = 0;
      let evictions = 0;
      let edgeLoads = {};
      
      let currentIndex = 0;
      
      const fireRequest = async () => {
        const i = currentIndex++;
        if (i >= NUM_REQUESTS) return false;
        
        const file = getZipfFile();
        const cost = generateCost();
        
        const start = Date.now();
        try {
          const res = await axios.get(`${GATEWAY}/cdn/content/${file}?cost=${cost}`);
          const duration = Date.now() - start;
          latencies.push(duration);
          
          if (res.data.data && res.data.data.cacheHit) hits++;
          else misses++;
          
          const eId = res.data.edge;
          edgeLoads[eId] = (edgeLoads[eId] || 0) + cost; 
        } catch(e) {}
        await new Promise(r => setTimeout(r, 1));
        return true;
      };

      const workers = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        workers.push((async () => {
          while (currentIndex < NUM_REQUESTS) {
             await fireRequest();
          }
        })());
      }
      await Promise.all(workers);
      
      const avgLat = latencies.reduce((a,b)=>a+b, 0) / (latencies.length || 1);
      
      const allLoads = [];
      for(let k=1; k<=6; k++) {
          // aggregate the continuous loads
          allLoads.push(edgeLoads[`Edge-300${k}`] || edgeLoads[`Edge-${3000+k}`] || edgeLoads[`Edge-${k}`] || 0);
      }
      const totalResponses = allLoads.reduce((a, b) => a + b, 0);
      const mean = totalResponses / 6;
      const stddev = Math.sqrt(allLoads.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / 6);
      const hitRatio = hits / ((hits+misses) || 1) * 100;
      
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
  fs.writeFileSync('metrics.csv', csvRows.join('\n'));
  console.log('Saved real metrics to metrics.csv');
  process.exit(0);
}

run();

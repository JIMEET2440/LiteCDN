const axios = require('axios');
const fs = require('fs');

const GATEWAY = 'http://localhost:3000';
const edges = [3001, 3002, 3003, 3004, 3005, 3006];

const NUM_REQUESTS = 3000;
const ALPHA = 1.3;
const NUM_OBJECTS = 400;

// Generate Zipf frequencies
const frequencies = [];
let sum = 0;
for (let i = 1; i <= NUM_OBJECTS; i++) {
  const f = 1 / Math.pow(i, ALPHA);
  frequencies.push(f);
  sum += f;
}
const probabilities = frequencies.map(f => f / sum);
const cumulative = [];
let acc = 0;
for (let p of probabilities) {
  acc += p;
  cumulative.push(acc);
}

function getRandomZipfFile() {
  const r = Math.random();
  for (let i = 0; i < NUM_OBJECTS; i++) {
    if (r <= cumulative[i]) {
      return `obj_${i}.txt`;
    }
  }
  return `obj_${NUM_OBJECTS - 1}.txt`;
}

const architectures = [
  { routing: 'round-robin', routingOpts: {}, caching: 'lru' },
  { routing: 'round-robin', routingOpts: {}, caching: 'segmented' },
  { routing: 'alpha-beta', routingOpts: { alpha: 0.5, beta: 0.5, epsilon: 0, perturb: false }, caching: 'lru' },
  { routing: 'alpha-beta', routingOpts: { alpha: 0.5, beta: 0.5, epsilon: 0, perturb: false }, caching: 'segmented' },
  { routing: 'alpha-beta', routingOpts: { alpha: 0.5, beta: 0.5, epsilon: 0.25, perturb: false }, caching: 'lru' },
  { routing: 'alpha-beta', routingOpts: { alpha: 0.5, beta: 0.5, epsilon: 0.25, perturb: false }, caching: 'segmented' },
  { routing: 'alpha-beta', routingOpts: { alpha: 0.5, beta: 0.5, epsilon: 0.25, perturb: true }, caching: 'lru' },
  { routing: 'alpha-beta', routingOpts: { alpha: 0.5, beta: 0.5, epsilon: 0.25, perturb: true }, caching: 'segmented' },
];

async function runTest(arch) {
  console.log(`Setting policies: routing=${arch.routing}, caching=${arch.caching} (epsilon=${arch.routingOpts?.epsilon}, perturb=${arch.routingOpts?.perturb})`);
  await axios.post(`${GATEWAY}/policy/routing`, { mode: arch.routing, ...arch.routingOpts });
  await axios.post(`${GATEWAY}/policy/cache`, { mode: arch.caching, size: 100 });
  
  // clear cache arrays via edges directly
  for (let p of edges) {
    try { await axios.get(`http://localhost:${p}/purge`); } catch(e){}
  }
  
  await new Promise(r => setTimeout(r, 1000));

  let totalLatency = 0;
  const edgeLoad = {};
  
  for (let i = 0; i < NUM_REQUESTS; i++) {
    const file = getRandomZipfFile();
    try {
      const res = await axios.get(`${GATEWAY}/${file}`);
      totalLatency += res.data.latency;
      const edge = res.data.edge;
      edgeLoad[edge] = (edgeLoad[edge] || 0) + 1;
    } catch (e) { }
    // small delay to prevent port exhaustion
    await new Promise(r => setTimeout(r, 5));
  }
  
  // Fetch metrics from all edges
  let totalHits = 0;
  let totalMisses = 0;
  let totalEvictions = 0;
  
  const loads = Object.values(edgeLoad);
  const avgL = loads.reduce((a,b)=>a+b, 0) / (loads.length||1);
  const variance = loads.reduce((a,b) => a + Math.pow(b - avgL, 2), 0) / (loads.length||1);
  
  for (let p of edges) {
    try { 
      const res = await axios.get(`http://localhost:${p}/metrics`); 
      totalHits += res.data.cache.hits;
      totalMisses += res.data.cache.misses;
      totalEvictions += res.data.cache.evictions;
      } catch(e){}
  }
  
  const hitRatio = (totalHits + totalMisses) === 0 ? 0 : totalHits / (totalHits + totalMisses);
  const avgLatency = (totalLatency / NUM_REQUESTS).toFixed(2);
  
  return {
    routing: arch.routing + (arch.routingOpts.epsilon ? '+eps' : '') + (arch.routingOpts.perturb ? '+perturb' : ''),
    caching: arch.caching,
    avgLatency: avgLatency,
    loadVariance: variance.toFixed(2),
    hitRatio: (hitRatio * 100).toFixed(2),
    evictions: totalEvictions
  };
}

(async () => {
   const csvHeader = "Routing,Caching,AvgLatency,LoadVariance,HitRatio_PCT,Evictions\n";
   let csvContent = csvHeader;
   for (let arch of architectures) {
     const results = await runTest(arch);
     csvContent += `${results.routing},${results.caching},${results.avgLatency},${results.loadVariance},${results.hitRatio},${results.evictions}\n`;
     console.log(results);
   }
   fs.writeFileSync('metrics.csv', csvContent);
   console.log("Wrote metrics.csv");
})();

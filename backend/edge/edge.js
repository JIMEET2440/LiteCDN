const express = require('express');
const axios = require('axios');
const cors = require('cors');
const config = require('../config');

class CacheManager {
  constructor(size = 100, mode = 'lru') {
    this.maxSize = size;
    this.mode = mode;
    this.lru = new Map();
    // Segmented: 35% new, 60% popular, 5% miss-aware
    this.segs = {
      new: new Map(),
      pop: new Map(),
      miss: new Map()
    };
    this.counts = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  setPolicy(mode, size) {
    if (size) this.maxSize = size;
    this.mode = mode;
    this.lru.clear();
    this.segs.new.clear();
    this.segs.pop.clear();
    this.segs.miss.clear();
    this.counts = { hits: 0, misses: 0, evictions: 0 };
  }

  get(key) {
    if (this.mode === 'lru') {
      if (!this.lru.has(key)) {
        this.counts.misses++;
        return null;
      }
      const val = this.lru.get(key);
      this.lru.delete(key);
      this.lru.set(key, val);
      this.counts.hits++;
      return val;
    } else {
      // segmented
      for (const seg of [this.segs.new, this.segs.pop, this.segs.miss]) {
        if (seg.has(key)) {
          const val = seg.get(key);
          seg.delete(key);
          if (seg === this.segs.new) this.segs.pop.set(key, val); // promote to popular
          else this.segs.pop.set(key, val); // keep in popular or promote to popular
          this.counts.hits++;
          return val;
        }
      }
      this.counts.misses++;
      return null;
    }
  }

  set(key, val) {
    if (this.mode === 'lru') {
      if (this.lru.size >= this.maxSize) {
        const firstKey = this.lru.keys().next().value;
        this.lru.delete(firstKey);
        this.counts.evictions++;
      }
      this.lru.set(key, val);
    } else {
      // check if we need to evict in segmented
      // 35-60-5 = 35 new, 60 pop, 5 miss
      const nSize = Math.floor(this.maxSize * 0.35);
      const pSize = Math.floor(this.maxSize * 0.60);
      const mSize = Math.floor(this.maxSize * 0.05);

      if (this.segs.new.size >= nSize) {
        if (this.segs.new.size > 0) {
           const firstN = this.segs.new.keys().next().value;
           this.segs.new.delete(firstN);
           this.counts.evictions++;
        }
      }
      this.segs.new.set(key, val);
    }
  }

  getStats() {
    return {
      size: this.mode === 'lru' ? this.lru.size : (this.segs.new.size + this.segs.pop.size + this.segs.miss.size),
      hits: this.counts.hits,
      misses: this.counts.misses,
      evictions: this.counts.evictions,
      hitRatio: this.counts.hits + this.counts.misses > 0 
        ? this.counts.hits / (this.counts.hits + this.counts.misses) : 0
    };
  }
}

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const EDGE_ID = process.env.EDGE_ID || `Edge-${PORT}`;

let baseline = 100;
if (PORT === 3001 || PORT === 3002 || PORT === '3001' || PORT === '3002') baseline = 60;
else if (PORT === 3003 || PORT === 3004 || PORT === '3003' || PORT === '3004') baseline = 100;
else if (PORT === 3005 || PORT === 3006 || PORT === '3005' || PORT === '3006') baseline = 140;

let activeLoad = 0;
const cache = new CacheManager();
cache.setPolicy('segmented', 50 * 1024 * 1024); // 50MB default for segmented

app.post('/policy/cache', express.json(), (req, res) => {
  const { mode, size } = req.body;
  if (!['lru', 'segmented'].includes(mode)) {
    return res.status(400).json({ error: 'Unsupported cache mode' });
  }
  cache.setPolicy(mode, size);
  console.log(`[${EDGE_ID}] Cache policy updated to ${mode} (Size: ${cache.maxSize})`);
  res.json({ message: 'Policy updated', mode, size: cache.maxSize });
});

app.get('/metrics', (req, res) => {
  res.json({
    status: 'UP',
    id: EDGE_ID,
    load: activeLoad,
    latency: baseline + (activeLoad * 80),
    cache: cache.getStats()
  });
});

app.get('/purge', (req, res) => {
  cache.setPolicy(cache.mode, cache.maxSize);
  res.json({ message: 'Cache purged' });
});

app.get('/content/:file', async (req, res) => {
  const cost = parseFloat(req.query.cost) || 1;
  activeLoad += cost;
  try {
    const file = 'content/' + req.params.file;
    const cached = cache.get(file);

    // Simulate load delay plus the base latency simulation via activeLoad cost
    await new Promise(r => setTimeout(r, activeLoad * 10));

    if (cached) {
      activeLoad -= cost;
      activeLoad = Math.max(0, activeLoad);
      return res.json({ source: 'edge-cache', data: cached, cacheHit: true });
    }

    const oRes = await axios.get(`${config.origin.url}/${file}`);
    cache.set(file, oRes.data);
    activeLoad -= cost;
    activeLoad = Math.max(0, activeLoad);
    return res.json({ source: 'origin', data: oRes.data, cacheHit: false });
  } catch (err) {
    activeLoad -= cost;
    activeLoad = Math.max(0, activeLoad);
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => {
  console.log(`[${EDGE_ID}] Edge Server up on port ${PORT}`);
});

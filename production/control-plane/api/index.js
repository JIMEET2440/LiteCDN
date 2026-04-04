const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// In a real production app, this would be MongoDB or PostgreSQL
// Example MongoDB connection (commented out for your future use):
// const mongoose = require('mongoose');
// mongoose.connect(process.env.MONGODB_URI);
// const Site = mongoose.model('Site', new mongoose.Schema({ domain: String, origin: String }));

// Temporary In-Memory Database (will reset when Vercel spins down the serverless function, 
// YOU MUST REPLACE THIS WITH MONGODB BEFORE LAUNCH)
let sitesDB = [
  // Example dummy record: if someone visits 'cdn.mysite.com', fetch from 'https://mysite.com'
  { domain: 'test.litecdnn.vercel.app', origin: 'https://example.com' }
];

// --- SaaS UI Endpoints (Dashboard uses these) ---

// 1. Get all registered sites for a user
app.get('/api/sites', (req, res) => {
  res.json(sitesDB);
});

// 2. Register a new website to the CDN
app.post('/api/sites', (req, res) => {
  const { domain, origin } = req.body;
  if (!domain || !origin) {
    return res.status(400).json({ error: 'Domain and Origin are required.' });
  }

  // Prevent duplicates
  if (sitesDB.find(s => s.domain === domain)) {
    return res.status(409).json({ error: 'Domain already registered.' });
  }

  const newSite = { domain, origin, id: Date.now().toString() };
  sitesDB.push(newSite);
  
  res.status(201).json({ message: 'Site registered successfully', site: newSite });
});

// 3. Delete a site from the CDN
app.delete('/api/sites/:domain', (req, res) => {
  const { domain } = req.params;
  sitesDB = sitesDB.filter(s => s.domain !== domain);
  res.json({ message: 'Site deleted' });
});


// --- EDGE SERVER ENDPOINTS (The global worker nodes call this) ---

// 4. Resolve a Host header to an Origin URL
app.get('/api/resolve', (req, res) => {
  const host = req.query.domain;
  
  if (!host) {
    return res.status(400).json({ error: 'Missing domain parameter' });
  }

  const site = sitesDB.find(s => s.domain === host);
  
  if (!site) {
    return res.status(404).json({ error: 'Domain not found in global CDN registry.' });
  }

  // Tell the Edge server where to fetch the files from
  res.json({ origin: site.origin });
});

// Export the express app to Vercel Serverless
module.exports = app;
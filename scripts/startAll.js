/**
 * ============================================================
 *  LiteCDN – Start All Servers
 * ============================================================
 *  Convenience script that spawns the Origin Server, three
 *  Edge Servers, and the CDN Gateway as child processes.
 *
 *  Usage:  node scripts/startAll.js
 *          npm run start:all
 * ============================================================
 */

const { spawn } = require('child_process');
const path      = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Helper – spawn a Node process with coloured prefix logging.
 */
function startServer(label, scriptPath, env = {}) {
  const fullPath = path.join(ROOT, scriptPath);
  const merged   = { ...process.env, ...env };

  const child = spawn('node', [fullPath], {
    env: merged,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => {
      console.log(`[${label}] ${line}`);
    });
  });

  child.stderr.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => {
      console.error(`[${label}] ${line}`);
    });
  });

  child.on('close', (code) => {
    console.log(`[${label}] Process exited with code ${code}`);
  });

  return child;
}

// ── Spawn all servers ────────────────────────────────────────
console.log('='.repeat(60));
console.log('  LiteCDN – Starting all servers …');
console.log('='.repeat(60));

const children = [];

// 1. Origin Server  (port 4000)
children.push(startServer('Origin', 'backend/origin/origin.js'));

// 2. Edge Servers (ports 3001, 3002, 3003)
children.push(startServer('Edge-1', 'backend/edge/edge.js', { PORT: '3001', EDGE_ID: 'Edge-1' }));
children.push(startServer('Edge-2', 'backend/edge/edge.js', { PORT: '3002', EDGE_ID: 'Edge-2' }));
children.push(startServer('Edge-3', 'backend/edge/edge.js', { PORT: '3003', EDGE_ID: 'Edge-3' }));
children.push(startServer('Edge-4', 'backend/edge/edge.js', { PORT: '3004', EDGE_ID: 'Edge-4' }));
children.push(startServer('Edge-5', 'backend/edge/edge.js', { PORT: '3005', EDGE_ID: 'Edge-5' }));
children.push(startServer('Edge-6', 'backend/edge/edge.js', { PORT: '3006', EDGE_ID: 'Edge-6' }));

// 3. CDN Gateway (port 3000) – start slightly delayed so edges are ready
setTimeout(() => {
  children.push(startServer('CDN', 'backend/cdn/cdn.js'));
}, 1000);

// ── Graceful Shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down all servers …');
  children.forEach((c) => c.kill());
  process.exit(0);
});

process.on('SIGTERM', () => {
  children.forEach((c) => c.kill());
  process.exit(0);
});

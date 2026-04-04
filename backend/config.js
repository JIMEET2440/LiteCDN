/**
 * ============================================================
 *  LiteCDN – Shared Configuration
 * ============================================================
 */

const config = {
  origin: {
    host: process.env.ORIGIN_HOST || 'localhost',
    port: parseInt(process.env.ORIGIN_PORT) || 4000,
    get url() {
      return `http://${this.host}:${this.port}`;
    },
  },
  // Parse edges from process.env.EDGES string: "host1:port1,host2:port2"
  // Example: "edge-1:3001,edge-2:3002"
  edges: process.env.EDGES ? process.env.EDGES.split(',').map((e, idx) => {
    const parts = e.split(':');
    return { id: `Edge-${idx+1}`, host: parts[0], port: parseInt(parts[1]) };
  }) : [
    { id: 'Edge-1', host: 'localhost', port: 3001 },
    { id: 'Edge-2', host: 'localhost', port: 3002 },
    { id: 'Edge-3', host: 'localhost', port: 3003 },
    { id: 'Edge-4', host: 'localhost', port: 3004 },
    { id: 'Edge-5', host: 'localhost', port: 3005 },
    { id: 'Edge-6', host: 'localhost', port: 3006 },
  ],
  cdn: {
    host: process.env.CDN_HOST || 'localhost',
    port: parseInt(process.env.PORT) || 3000,
    get url() {
      return `http://${this.host}:${this.port}`;
    },
  },
};

module.exports = config;

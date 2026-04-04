/**
 * ============================================================
 *  LiteCDN – Shared Configuration
 * ============================================================
 */

const config = {
  origin: {
    host: 'localhost',
    port: 4000,
    get url() {
      return `http://${this.host}:${this.port}`;
    },
  },
  edges: [
    { id: 'Edge-1', host: 'localhost', port: 3001 },
    { id: 'Edge-2', host: 'localhost', port: 3002 },
    { id: 'Edge-3', host: 'localhost', port: 3003 },
    { id: 'Edge-4', host: 'localhost', port: 3004 },
    { id: 'Edge-5', host: 'localhost', port: 3005 },
    { id: 'Edge-6', host: 'localhost', port: 3006 },
  ],
  cdn: {
    host: 'localhost',
    port: 3000,
    get url() {
      return `http://${this.host}:${this.port}`;
    },
  },
};

module.exports = config;

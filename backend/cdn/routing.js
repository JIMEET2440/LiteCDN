/**
 * ============================================================
 *  LiteCDN – Routing Service
 * ============================================================
 *  Implements a **stateful Round-Robin** strategy to distribute
 *  incoming requests across the registered Edge Servers.
 *
 *  Current features:
 *    • Pure round-robin with scoring (latency and load).
 *    • Edge list is static (loaded from config at startup).
 *    • Uses alpha and beta weighting for score calculation.
 *
 *  Public API
 *  ----------
 *  routeRequest(url : String)          →  Main request handler, returns EdgeServer
 *  selectEdge(epsilon : float)          →  Selects edge via round-robin strategy
 *  selectEdgeServer(region : String)    →  Selects edge for a specific region
 *  validateRequest(url : String)        →  Validates request URL
 *  getEdgeList()                        →  Returns the full edge list
 *  getCurrentIndex()                    →  Returns current RR index (debug)
 * ============================================================
 */

const config = require('../config');

class RoutingService {
  /**
   * @param {Array} edges – array of { id, host, port } objects.
   *                        Defaults to the list in config.js.
   */
  constructor(edges = config.edges) {
    this.edges = edges.map((e) => ({
      ...e,
      url: `http://${e.host}:${e.port}`,
      latency: 0,    // Track latency for scoring
      load: 0,       // Track load for scoring
    }));

    // ── Weighting Parameters ───────────────────────────────
    // Production default: alpha-beta routing. Values fixed per request.
    this.alpha = 0.5;  // Weight for latency in score calculation
    this.beta = 0.5;   // Weight for load in score calculation
    this.epsilon = 0.25; // epsilon-greedy exploration probability
    this._mode = (process.env.ROUTING_MODE || 'alpha-beta'); // 'alpha-beta' or 'round-robin'

    // Stagnation/perturbation bookkeeping
    this._lastSelectedId = null;
    this._stagnationCount = 0;
    this._stagnationThreshold = 10; // after this, perturb alpha/beta slightly
    this._perturbMagnitude = 0.05; // bounded perturbation amount

    // ── Round-Robin Index ──────────────────────────────────
    //    Points to the *last* edge that was selected.
    //    selectEdge() advances it before returning.
    this._currentIndex = -1;

    console.log('[RoutingService] Initialised with edges:');
    this.edges.forEach((e) => console.log(`  → ${e.id}  ${e.url}`));
  }

  /**
   * Validate the incoming request URL
   * @param {string} url - Request URL to validate
   * @returns {boolean} True if URL is valid
   */
  validateRequest(url) {
    if (!url || typeof url !== 'string') {
      console.warn('[RoutingService] Invalid request URL:', url);
      return false;
    }
    return true;
  }

  /**
   * Select an edge server for a specific region
   * @param {string} region - Target region (optional, not yet used)
   * @returns {{ id: string, host: string, port: number, url: string }}
   */
  selectEdgeServer(region = null) {
    // Currently just uses round-robin; can be extended for region-awareness
    return this.selectEdge();
  }

  /**
   * Select the next Edge Server using round-robin strategy.
   * @param {number} epsilon - Epsilon parameter (not used in current round-robin)
   * @returns {{ id: string, host: string, port: number, url: string }}
   */
  /**
   * Primary selection entrypoint. Uses mode to decide which algorithm
   * to apply. In 'alpha-beta' mode uses Score = alpha*latency + beta*load
   * with epsilon-greedy exploration. In 'round-robin' mode behaves as before.
   *
   * @param {number} overrideEpsilon - optional epsilon to override default
   */
  selectEdge(overrideEpsilon = undefined) {
    if (this._mode === 'round-robin') {
      // Advance index, wrapping around to 0 at the end
      this._currentIndex = (this._currentIndex + 1) % this.edges.length;
      const selected = this.edges[this._currentIndex];
      console.log(`[RoutingService] 🔀 Round-Robin → selected ${selected.id} (${selected.url})`);
      // stagnation accounting
      this._updateStagnation(selected.id);
      return selected;
    }

    // Alpha-Beta scoring mode
    const eps = (typeof overrideEpsilon === 'number') ? overrideEpsilon : this.epsilon;

    // Compute scores (lower is better)
    const scored = this.edges.map((e) => ({
      edge: e,
      score: this.alpha * (e.latency || 0) + this.beta * (e.load || 0),
    }));

    // Sort ascending (best first)
    scored.sort((a, b) => a.score - b.score);

    // Epsilon-greedy: with probability eps pick second-best (if exists)
    let pickIndex = 0;
    if (scored.length > 1 && Math.random() < eps) {
      pickIndex = 1;
    }

    const selected = scored[pickIndex].edge;
    console.log(`[RoutingService] 🔎 Alpha-Beta → chosen ${selected.id} (score=${scored[pickIndex].score.toFixed(2)})`);

    // Stagnation handling and bounded perturbation
    this._updateStagnation(selected.id);

    return selected;
  }

  _updateStagnation(selectedId) {
    if (this._lastSelectedId === selectedId) {
      this._stagnationCount += 1;
    } else {
      this._stagnationCount = 1;
      this._lastSelectedId = selectedId;
    }

    if (this._stagnationCount >= this._stagnationThreshold) {
      // Perturb alpha slightly within bounds [0.05 .. 0.95]
      const delta = (Math.random() * 2 - 1) * this._perturbMagnitude; // in [-mag, mag]
      let newAlpha = this.alpha + delta;
      newAlpha = Math.max(0.05, Math.min(0.95, newAlpha));
      this.alpha = newAlpha;
      this.beta = 1 - this.alpha;
      console.log(`[RoutingService] ⚖️  Perturbed weights due to stagnation: alpha=${this.alpha.toFixed(2)}, beta=${this.beta.toFixed(2)}`);
      this._stagnationCount = 0; // reset
    }
  }

  /**
   * Main request routing handler
   * @param {string} url - Client request URL
   * @returns {{ id: string, host: string, port: number, url: string } | null}
   */
  routeRequest(url) {
    if (!this.validateRequest(url)) {
      return null;
    }
    return this.selectEdge();
  }

  /**
   * Update latency metric for an edge (exponential moving average)
   * @param {string} edgeId
   * @param {number} latencyMs
   */
  updateLatency(edgeId, latencyMs) {
    const e = this.edges.find((x) => x.id === edgeId);
    if (!e) return false;
    const alpha = 0.2; // EMA smoothing factor for latency
    if (!e.latency || e.latency === 0) {
      e.latency = latencyMs;
    } else {
      e.latency = alpha * latencyMs + (1 - alpha) * e.latency;
    }
    return true;
  }

  /**
   * Update load metric for an edge. Load should be a normalized [0..1]
   * indicator (higher = more loaded). Called by external pollers or
   * via health checks. Returns false if edge not found.
   */
  updateLoad(edgeId, loadValue) {
    const e = this.edges.find((x) => x.id === edgeId);
    if (!e) return false;
    e.load = Math.max(0, Math.min(1, loadValue));
    return true;
  }

  /**
   * Set routing mode at runtime.
   * @param {string} mode - 'alpha-beta' or 'round-robin'
   */
  setMode(mode) {
    if (mode !== 'alpha-beta' && mode !== 'round-robin') {
      return false;
    }

    this._mode = mode;

    // Reset RR index so deterministic tests can compute expected sequence.
    if (mode === 'round-robin') {
      this._currentIndex = -1;
    }

    return true;
  }

  /** @returns {'alpha-beta' | 'round-robin'} */
  getMode() {
    return this._mode;
  }

  /** @returns {Array} full list of registered edges */
  getEdgeList() {
    return this.edges;
  }

  /** @returns {number} current round-robin index */
  getCurrentIndex() {
    return this._currentIndex;
  }
}

module.exports = RoutingService;

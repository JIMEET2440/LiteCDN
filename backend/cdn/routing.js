class RoutingService {
  constructor(edges) {
    this.edges = edges;
    this.mode = 'round-robin';
    this.options = { alpha: 1, beta: 0, epsilon: 0, perturb: false };
    this.currentIndex = 0;
  }

  setMode(mode, options = {}) {
    if (!['round-robin', 'alpha-beta'].includes(mode)) {
      throw new Error(`Unsupported mode: ${mode}`);
    }
    this.mode = mode;
    this.options = { ...this.options, ...options };
    this.currentIndex = 0;
  }

  route(req, edgeMetrics, inFlight = {}) {
    const available = this.edges.filter((e) => edgeMetrics[e.id]?.status === 'UP');
    if (available.length === 0) return null;

    if (this.mode === 'round-robin') {
      const edge = available[this.currentIndex % available.length];
      this.currentIndex++;
      return edge;
    }

    if (this.mode === 'alpha-beta') {
      const { alpha, beta, epsilon, perturb } = this.options;

      let a = alpha;
      let b = beta;

      if (perturb) {
        a += (Math.random() - 0.5) * 0.1;
        b += (Math.random() - 0.5) * 0.1;
      }

      const scoredEdges = available.map(edge => {
        const metrics = edgeMetrics[edge.id];
        const lat = metrics.latency || 100;
        
        // Predictive Local Tracking: Combine polled load with in-flight requests 
        // to immediately penalize edges before the next polling tick
        const effectiveLoad = (metrics.load || 0) + (inFlight[edge.id] || 0);
        
        const score = (a * lat) + (b * effectiveLoad * 80); // Using standard weight adjustments
        return { edge, score };
      });

      scoredEdges.sort((x, y) => x.score - y.score);

      if (epsilon > 0 && Math.random() < epsilon) {
        if (scoredEdges.length > 1) {
          const randomIndex = 1 + Math.floor(Math.random() * (scoredEdges.length - 1));
          return scoredEdges[randomIndex].edge;
        }
      }

      return scoredEdges[0].edge;
    }
  }
}

module.exports = RoutingService;

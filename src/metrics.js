const client = require('prom-client');

client.collectDefaultMetrics({
  prefix: 'bank_demo_'
});

const httpRequests = new client.Counter({
  name: 'bank_demo_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const httpDuration = new client.Histogram({
  name: 'bank_demo_http_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5]
});

const logins = new client.Counter({
  name: 'bank_demo_logins_total',
  help: 'Successful logins'
});

const signups = new client.Counter({
  name: 'bank_demo_signups_total',
  help: 'Successful signups'
});

const transactions = new client.Counter({
  name: 'bank_demo_transactions_total',
  help: 'Completed transactions',
  labelNames: ['type']
});

const chaosModeGauge = new client.Gauge({
  name: 'bank_demo_chaos_mode_active',
  help: 'Whether a chaos mode is active',
  labelNames: ['mode']
});

function trackRequest(req, res, next) {
  const end = httpDuration.startTimer();

  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode)
    };

    httpRequests.inc(labels);
    end(labels);
  });

  next();
}

module.exports = {
  client,
  trackRequest,
  counters: {
    logins,
    signups,
    transactions
  },
  gauges: {
    chaosModeGauge
  }
};
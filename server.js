const express = require('express');
const session = require('express-session');
const pinoHttp = require('pino-http');
const { v4: uuidv4 } = require('uuid');
const logger = require('./src/logger');
const metrics = require('./src/metrics');
const ChaosManager = require('./src/chaosManager');
const { verifyPassword } = require('./src/auth');
const {
  createUser,
  getUserByUsername,
  getUserById,
  getAccountByUserId,
  addTransaction,
  getStocks,
  sanitizeUser
} = require('./src/store');

const app = express();
const port = Number(process.env.PORT || 3000);
const chaosManager = new ChaosManager({ logger, gauges: metrics.gauges });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'banking-demo-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      const requestId = existing || uuidv4();
      res.setHeader('x-request-id', requestId);
      return requestId;
    },
    customProps: (req) => ({
      sessionUserId: req.session && req.session.userId ? req.session.userId : null
    })
  })
);

app.use(metrics.trackRequest);

app.use((req, res, next) => {
  req.log.info(
    {
      event: 'request.received',
      path: req.path,
      method: req.method,
      query: req.query
    },
    'Processing request'
  );
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    req.log.warn({ event: 'auth.unauthorized', path: req.path }, 'Unauthorized request blocked');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = getUserById(req.session.userId);
  if (!user) {
    req.log.warn({ event: 'auth.session.invalid' }, 'Session user was not found');
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session expired' });
  }

  req.user = user;
  return next();
}

function injectChaosErrors(req, res, next) {
  if (!chaosManager.shouldInjectError()) {
    return next();
  }

  req.log.error(
    {
      event: 'chaos.error.injected',
      path: req.path,
      userId: req.session.userId || null
    },
    'Chaos error injected into request path'
  );
  return res.status(500).json({ error: 'Chaos mode injected an application error' });
}

app.get('/healthz', (req, res) => {
  req.log.info({ event: 'probe.health' }, 'Health probe succeeded');
  res.json({ status: 'ok' });
});

app.get('/readyz', (req, res) => {
  const status = chaosManager.getStatus();
  const degraded = status.saturation || status.errorInjection;
  req.log.info({ event: 'probe.ready', degraded, status }, 'Readiness probe evaluated');

  if (degraded) {
    return res.status(503).json({ status: 'degraded', chaos: status });
  }

  return res.json({ status: 'ready', chaos: status });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.client.register.contentType);
  res.end(await metrics.client.register.metrics());
});

app.post('/api/client-logs', (req, res) => {
  const { level = 'info', event = 'client.event', message = 'Client event', details = {} } = req.body || {};
  const logMethod = typeof req.log[level] === 'function' ? req.log[level].bind(req.log) : req.log.info.bind(req.log);
  logMethod({ event, details, source: 'browser-ui' }, message);
  res.status(202).json({ accepted: true });
});

app.post('/api/auth/signup', (req, res) => {
  const { username, password, fullName } = req.body;
  req.log.info({ event: 'auth.signup.request', username }, 'Signup requested');

  if (!username || !password || !fullName) {
    req.log.warn({ event: 'auth.signup.invalid' }, 'Signup payload was incomplete');
    return res.status(400).json({ error: 'username, password and fullName are required' });
  }

  if (getUserByUsername(username)) {
    req.log.warn({ event: 'auth.signup.conflict', username }, 'Signup rejected because username exists');
    return res.status(409).json({ error: 'Username already exists' });
  }

  const user = createUser({ username, password, fullName });
  req.session.userId = user.id;
  metrics.counters.signups.inc();
  req.log.info({ event: 'auth.signup.success', userId: user.id, username }, 'User signup completed');
  return res.status(201).json({ user });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  req.log.info({ event: 'auth.login.request', username }, 'Login requested');

  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    req.log.warn({ event: 'auth.login.failed', username }, 'Login failed');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  metrics.counters.logins.inc();
  req.log.info({ event: 'auth.login.success', userId: user.id }, 'Login succeeded');
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.log.info({ event: 'auth.logout', userId: req.user.id }, 'Logout requested');
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/session', (req, res) => {
  const user = req.session.userId ? getUserById(req.session.userId) : null;
  req.log.info({ event: 'auth.session.check', authenticated: Boolean(user) }, 'Session status checked');
  res.json({ user: user ? sanitizeUser(user) : null });
});

app.get('/api/account', requireAuth, injectChaosErrors, (req, res) => {
  const account = getAccountByUserId(req.user.id);
  req.log.info({ event: 'account.view', userId: req.user.id }, 'Account overview returned');
  res.json({
    user: sanitizeUser(req.user),
    account
  });
});

app.post('/api/transactions', requireAuth, injectChaosErrors, (req, res) => {
  const { type, amount, description } = req.body;
  const parsedAmount = Number(amount);

  req.log.info(
    { event: 'transaction.request', userId: req.user.id, type, amount: parsedAmount, description },
    'Transaction requested'
  );

  if (!['credit', 'debit'].includes(type) || !Number.isFinite(parsedAmount) || parsedAmount <= 0 || !description) {
    req.log.warn({ event: 'transaction.invalid', payload: req.body }, 'Transaction payload invalid');
    return res.status(400).json({ error: 'Provide valid type, amount and description' });
  }

  const account = getAccountByUserId(req.user.id);
  if (type === 'debit' && parsedAmount > account.balance) {
    req.log.warn({ event: 'transaction.insufficient_funds', balance: account.balance, amount: parsedAmount }, 'Debit rejected');
    return res.status(400).json({ error: 'Insufficient simulated funds' });
  }

  const transaction = addTransaction(req.user.id, {
    type,
    amount: parsedAmount,
    description
  });

  metrics.counters.transactions.inc({ type });
  req.log.info({ event: 'transaction.success', transactionId: transaction.id, userId: req.user.id }, 'Transaction completed');

  return res.status(201).json({
    transaction,
    account: getAccountByUserId(req.user.id)
  });
});

app.get('/api/stocks', requireAuth, injectChaosErrors, (req, res) => {
  const stocks = getStocks();
  req.log.info({ event: 'stocks.view', userId: req.user.id, symbols: stocks.map((stock) => stock.symbol) }, 'Stocks returned');
  res.json({ stocks, asOf: new Date().toISOString() });
});

app.get('/api/chaos/status', requireAuth, (req, res) => {
  const status = chaosManager.getStatus();
  req.log.info({ event: 'chaos.status.view', userId: req.user.id, status }, 'Chaos status returned');
  res.json(status);
});

app.post('/api/chaos/saturation', requireAuth, (req, res) => {
  const status = chaosManager.activateSaturation();
  req.log.warn({ event: 'chaos.saturation.triggered', userId: req.user.id, status }, 'Immediate saturation chaos triggered');
  res.json(status);
});

app.post('/api/chaos/ramp', requireAuth, (req, res) => {
  const status = chaosManager.activateRamp();
  req.log.warn({ event: 'chaos.ramp.triggered', userId: req.user.id, status }, 'Slow ramp chaos triggered');
  res.json(status);
});

app.post('/api/chaos/errors', requireAuth, (req, res) => {
  const status = chaosManager.activateErrors();
  req.log.error({ event: 'chaos.errors.triggered', userId: req.user.id, status }, 'Error injection chaos triggered');
  res.json(status);
});

app.post('/api/chaos/remediate', requireAuth, (req, res) => {
  const status = chaosManager.remediateAll();
  req.log.info({ event: 'chaos.remediation.triggered', userId: req.user.id, status }, 'Chaos remediation triggered');
  res.json(status);
});

app.use(express.static('public'));

app.use((error, req, res, next) => {
  req.log.error({ event: 'app.error', error: error.message, stack: error.stack }, 'Unhandled application error');
  res.status(500).json({ error: 'Unexpected server error' });
});

const server = app.listen(port, () => {
  logger.info({ event: 'server.started', port }, 'Banking observability demo started');
});

function shutdown(signal) {
  logger.warn({ event: 'server.shutdown', signal }, 'Shutdown signal received');
  chaosManager.shutdown();
  server.close(() => {
    logger.info({ event: 'server.stopped' }, 'Server stopped cleanly');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
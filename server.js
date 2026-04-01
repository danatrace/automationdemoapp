const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const pinoHttp = require('pino-http');
const { v4: uuidv4 } = require('uuid');
const logger = require('./src/logger');
const metrics = require('./src/metrics');
const ChaosManager = require('./src/chaosManager');
const LoadGenerator = require('./src/loadGenerator');
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
const isProduction = process.env.NODE_ENV === 'production';
const configuredSessionSecret = process.env.SESSION_SECRET;
if (!configuredSessionSecret && isProduction) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');

if (!configuredSessionSecret) {
  logger.warn(
    { event: 'security.session_secret.ephemeral' },
    'SESSION_SECRET not set; using ephemeral secret for this process'
  );
}

const chaosManager = new ChaosManager({ logger, gauges: metrics.gauges });
const loadGenerator = new LoadGenerator({ logger });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false }));

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' }
});

const chaosRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAOS_RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many control requests. Please slow down.' }
});

app.use(
  session({
    secret: sessionSecret,
    name: 'banking.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/signup', authRateLimiter);
app.use('/api/chaos', chaosRateLimiter);
app.use('/api/load', chaosRateLimiter);

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

function parseChaosMode(req, res, next) {
  const mode = req.params.mode;

  if (!chaosManager.isValidMode(mode)) {
    req.log.warn({ event: 'chaos.mode.invalid', mode }, 'Unsupported chaos mode requested');
    return res.status(404).json({ error: 'Unsupported chaos mode' });
  }

  req.chaosMode = mode;
  return next();
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
  const expectedMetricsToken = process.env.METRICS_TOKEN;
  if (expectedMetricsToken) {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (token !== expectedMetricsToken) {
      return res.status(401).json({ error: 'Unauthorized metrics access' });
    }
  }

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

  if (String(username).length > 64 || String(fullName).length > 128 || String(password).length < 8) {
    req.log.warn({ event: 'auth.signup.invalid_constraints' }, 'Signup payload failed constraints');
    return res.status(400).json({ error: 'Invalid signup values or password too short' });
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

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

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

app.get('/api/chaos/modes', requireAuth, (req, res) => {
  const modes = ChaosManager.VALID_MODES.map((mode) => ({
    mode,
    active:
      mode === 'saturation'
        ? chaosManager.getStatus().saturation
        : mode === 'ramp'
          ? chaosManager.getStatus().ramp
          : chaosManager.getStatus().errorInjection
  }));

  req.log.info({ event: 'chaos.modes.list', userId: req.user.id, modes }, 'Chaos modes returned');
  res.json({ modes, status: chaosManager.getStatus() });
});

app.post('/api/chaos/saturation', requireAuth, (req, res) => {
  const status = chaosManager.activateSaturation();
  req.log.warn({ event: 'chaos.saturation.triggered', userId: req.user.id, status }, 'Immediate saturation chaos triggered');
  res.json(status);
});

app.delete('/api/chaos/saturation', requireAuth, (req, res) => {
  const status = chaosManager.deactivateSaturation();
  req.log.info({ event: 'chaos.saturation.cleared', userId: req.user.id, status }, 'Immediate saturation chaos deactivated');
  res.json(status);
});

app.post('/api/chaos/ramp', requireAuth, (req, res) => {
  const status = chaosManager.activateRamp();
  req.log.warn({ event: 'chaos.ramp.triggered', userId: req.user.id, status }, 'Slow ramp chaos triggered');
  res.json(status);
});

app.delete('/api/chaos/ramp', requireAuth, (req, res) => {
  const status = chaosManager.deactivateRamp();
  req.log.info({ event: 'chaos.ramp.cleared', userId: req.user.id, status }, 'Slow ramp chaos deactivated');
  res.json(status);
});

app.post('/api/chaos/errors', requireAuth, (req, res) => {
  const status = chaosManager.activateErrors();
  req.log.error({ event: 'chaos.errors.triggered', userId: req.user.id, status }, 'Error injection chaos triggered');
  res.json(status);
});

app.delete('/api/chaos/errors', requireAuth, (req, res) => {
  const status = chaosManager.deactivateErrors();
  req.log.info({ event: 'chaos.errors.cleared', userId: req.user.id, status }, 'Error injection chaos deactivated');
  res.json(status);
});

app.post('/api/chaos/remediate', requireAuth, (req, res) => {
  const status = chaosManager.remediateAll();
  req.log.info({ event: 'chaos.remediation.triggered', userId: req.user.id, status }, 'Chaos remediation triggered');
  res.json(status);
});

app.post('/api/chaos/:mode', requireAuth, parseChaosMode, (req, res) => {
  const status = chaosManager.activateMode(req.chaosMode);
  req.log.warn(
    { event: 'chaos.mode.activated', userId: req.user.id, mode: req.chaosMode, status },
    'Chaos mode activated through REST API'
  );
  res.json({ mode: req.chaosMode, action: 'activated', status });
});

app.delete('/api/chaos/:mode', requireAuth, parseChaosMode, (req, res) => {
  const status = chaosManager.deactivateMode(req.chaosMode);
  req.log.info(
    { event: 'chaos.mode.deactivated', userId: req.user.id, mode: req.chaosMode, status },
    'Chaos mode deactivated through REST API'
  );
  res.json({ mode: req.chaosMode, action: 'deactivated', status });
});

app.get('/api/load/status', requireAuth, (req, res) => {
  const status = loadGenerator.getStatus();
  req.log.info({ event: 'load.status.view', userId: req.user.id, status }, 'Load generator status returned');
  res.json(status);
});

app.post('/api/load/start', requireAuth, (req, res) => {
  const { userCount = 1 } = req.body || {};
  const status = loadGenerator.start(userCount);
  req.log.warn(
    { event: 'load.start.triggered', userId: req.user.id, userCount, status },
    'Load generator started through REST API'
  );
  res.json({ action: 'started', status });
});

app.post('/api/load/stop', requireAuth, (req, res) => {
  const status = loadGenerator.stop();
  req.log.info({ event: 'load.stop.triggered', userId: req.user.id, status }, 'Load generator stopped through REST API');
  res.json({ action: 'stopped', status });
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
  loadGenerator.shutdown();
  server.close(() => {
    logger.info({ event: 'server.stopped' }, 'Server stopped cleanly');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
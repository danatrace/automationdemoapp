const http = require('http');

class LoadGenerator {
  constructor({ logger }) {
    this.logger = logger;
    this.state = {
      active: false,
      userCount: 0,
      requestsGenerated: 0,
      startedAt: null
    };
    this.intervals = [];
  }

  getStatus() {
    return { ...this.state };
  }

  start(userCount) {
    if (this.state.active) {
      this.logger.warn(
        { event: 'load.already_active', userCount, currentUserCount: this.state.userCount },
        'Load generator already active'
      );
      return this.getStatus();
    }

    const parsedUserCount = Math.min(Math.max(Number(userCount) || 1, 1), 100000);

    this.logger.warn(
      { event: 'load.start', userCount: parsedUserCount },
      'Load generator starting'
    );

    this.state.active = true;
    this.state.userCount = parsedUserCount;
    this.state.requestsGenerated = 0;
    this.state.startedAt = new Date().toISOString();

    for (let i = 0; i < parsedUserCount; i += 1) {
      this.spawnVirtualUser(i);
    }

    return this.getStatus();
  }

  stop() {
    if (!this.state.active) {
      return this.getStatus();
    }

    this.logger.info(
      { event: 'load.stop', requestsGenerated: this.state.requestsGenerated, userCount: this.state.userCount },
      'Load generator stopping'
    );

    this.intervals.forEach((interval) => clearInterval(interval));
    this.intervals = [];

    this.state.active = false;
    this.state.userCount = 0;
    this.state.startedAt = null;

    return this.getStatus();
  }

  spawnVirtualUser(userId) {
    const makeRequest = () => {
      const endpoints = [
        { path: '/api/account', method: 'GET' },
        { path: '/api/stocks', method: 'GET' },
        {
          path: '/api/transactions',
          method: 'POST',
          body: JSON.stringify({
            type: Math.random() > 0.7 ? 'debit' : 'credit',
            amount: Math.floor(Math.random() * 1000) + 1,
            description: `Load test txn ${userId}-${Date.now()}`
          })
        }
      ];

      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

      const options = {
        hostname: 'localhost',
        port: 3000,
        path: endpoint.path,
        method: endpoint.method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: `demo-load-user-${userId}=true`
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          this.state.requestsGenerated += 1;
        });
      });

      req.on('error', (error) => {
        this.logger.warn(
          { event: 'load.request.error', userId, error: error.message, path: endpoint.path },
          'Load generator request failed'
        );
      });

      if (endpoint.body) {
        req.write(endpoint.body);
      }

      req.end();
    };

    const delay = Math.random() * 5000;
    setTimeout(() => {
      makeRequest();
      const interval = setInterval(makeRequest, 2000 + Math.random() * 3000);
      this.intervals.push(interval);
    }, delay);
  }

  shutdown() {
    this.stop();
  }
}

module.exports = LoadGenerator;

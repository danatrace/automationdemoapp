const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

class ChaosManager {
  constructor({ logger, gauges }) {
    this.logger = logger;
    this.gauges = gauges;
    this.state = {
      saturation: false,
      ramp: false,
      errorInjection: false,
      workerCount: 0,
      remediationCount: 0,
      lastActionAt: null
    };
    this.workers = [];
    this.rampInterval = null;
  }

  getStatus() {
    return { ...this.state };
  }

  activateSaturation() {
    if (this.state.saturation) {
      return this.getStatus();
    }

    this.logger.warn({ event: 'chaos.activate', mode: 'saturation' }, 'Immediate CPU saturation chaos activated');
    this.state.saturation = true;
    this.state.lastActionAt = new Date().toISOString();
    this.gauges.chaosModeGauge.set({ mode: 'saturation' }, 1);

    const targetWorkers = Math.max(2, os.cpus().length * 2);
    for (let index = 0; index < targetWorkers; index += 1) {
      this.spawnWorker(200000);
    }

    return this.getStatus();
  }

  activateRamp() {
    if (this.state.ramp) {
      return this.getStatus();
    }

    this.logger.warn({ event: 'chaos.activate', mode: 'ramp' }, 'Gradual CPU ramp chaos activated');
    this.state.ramp = true;
    this.state.lastActionAt = new Date().toISOString();
    this.gauges.chaosModeGauge.set({ mode: 'ramp' }, 1);

    this.spawnWorker(70000);
    let burst = 90000;
    this.rampInterval = setInterval(() => {
      if (this.workers.length >= Math.max(2, os.cpus().length * 2)) {
        clearInterval(this.rampInterval);
        this.rampInterval = null;
        return;
      }

      burst += 15000;
      this.spawnWorker(burst);
      this.logger.warn(
        { event: 'chaos.ramp.step', workerCount: this.workers.length, burst },
        'Gradual CPU ramp increased'
      );
    }, 5000);

    return this.getStatus();
  }

  activateErrors() {
    this.logger.error({ event: 'chaos.activate', mode: 'errors' }, 'Error injection chaos activated');
    this.state.errorInjection = true;
    this.state.lastActionAt = new Date().toISOString();
    this.gauges.chaosModeGauge.set({ mode: 'errors' }, 1);
    return this.getStatus();
  }

  remediateAll() {
    if (this.rampInterval) {
      clearInterval(this.rampInterval);
      this.rampInterval = null;
    }

    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];

    this.state.saturation = false;
    this.state.ramp = false;
    this.state.errorInjection = false;
    this.state.workerCount = 0;
    this.state.remediationCount += 1;
    this.state.lastActionAt = new Date().toISOString();

    this.gauges.chaosModeGauge.set({ mode: 'saturation' }, 0);
    this.gauges.chaosModeGauge.set({ mode: 'ramp' }, 0);
    this.gauges.chaosModeGauge.set({ mode: 'errors' }, 0);

    this.logger.info({ event: 'chaos.remediate', remediationCount: this.state.remediationCount }, 'All chaos conditions remediated');
    return this.getStatus();
  }

  shouldInjectError() {
    return this.state.errorInjection && Math.random() < 0.65;
  }

  shutdown() {
    this.remediateAll();
  }

  spawnWorker(burst) {
    const worker = new Worker(path.join(__dirname, 'chaosWorker.js'), {
      workerData: { burst }
    });

    worker.on('message', (message) => {
      if (message.type === 'heartbeat') {
        this.logger.warn(
          {
            event: 'chaos.worker.heartbeat',
            iterations: message.iterations,
            burst,
            workerCount: this.workers.length
          },
          'Chaos worker heartbeat'
        );
      }
    });

    worker.on('error', (error) => {
      this.logger.error({ event: 'chaos.worker.error', error: error.message }, 'Chaos worker crashed');
    });

    worker.on('exit', (code) => {
      this.workers = this.workers.filter((entry) => entry !== worker);
      this.state.workerCount = this.workers.length;
      this.logger.warn({ event: 'chaos.worker.exit', code, workerCount: this.workers.length }, 'Chaos worker exited');
    });

    this.workers.push(worker);
    this.state.workerCount = this.workers.length;
  }
}

module.exports = ChaosManager;
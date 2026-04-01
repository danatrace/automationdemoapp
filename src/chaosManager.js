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

  static get VALID_MODES() {
    return ['saturation', 'ramp', 'errors'];
  }

  getStatus() {
    return { ...this.state };
  }

  isValidMode(mode) {
    return ChaosManager.VALID_MODES.includes(mode);
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
      this.spawnWorker('saturation', 200000);
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

    this.spawnWorker('ramp', 70000);
    let burst = 90000;
    this.rampInterval = setInterval(() => {
      if (this.getWorkersByMode('ramp').length >= Math.max(2, os.cpus().length * 2)) {
        clearInterval(this.rampInterval);
        this.rampInterval = null;
        return;
      }

      burst += 15000;
      this.spawnWorker('ramp', burst);
      this.logger.warn(
        { event: 'chaos.ramp.step', workerCount: this.getWorkersByMode('ramp').length, burst },
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

  deactivateSaturation() {
    if (!this.state.saturation) {
      return this.getStatus();
    }

    const workerCount = this.stopWorkersByMode('saturation');
    this.state.saturation = false;
    this.state.lastActionAt = new Date().toISOString();
    this.gauges.chaosModeGauge.set({ mode: 'saturation' }, 0);

    this.logger.info(
      { event: 'chaos.deactivate', mode: 'saturation', terminatedWorkers: workerCount },
      'Immediate CPU saturation chaos deactivated'
    );
    return this.getStatus();
  }

  deactivateRamp() {
    if (this.rampInterval) {
      clearInterval(this.rampInterval);
      this.rampInterval = null;
    }

    if (!this.state.ramp) {
      return this.getStatus();
    }

    const workerCount = this.stopWorkersByMode('ramp');
    this.state.ramp = false;
    this.state.lastActionAt = new Date().toISOString();
    this.gauges.chaosModeGauge.set({ mode: 'ramp' }, 0);

    this.logger.info(
      { event: 'chaos.deactivate', mode: 'ramp', terminatedWorkers: workerCount },
      'Gradual CPU ramp chaos deactivated'
    );
    return this.getStatus();
  }

  deactivateErrors() {
    if (!this.state.errorInjection) {
      return this.getStatus();
    }

    this.state.errorInjection = false;
    this.state.lastActionAt = new Date().toISOString();
    this.gauges.chaosModeGauge.set({ mode: 'errors' }, 0);
    this.logger.info({ event: 'chaos.deactivate', mode: 'errors' }, 'Error injection chaos deactivated');
    return this.getStatus();
  }

  activateMode(mode) {
    if (mode === 'saturation') {
      return this.activateSaturation();
    }

    if (mode === 'ramp') {
      return this.activateRamp();
    }

    if (mode === 'errors') {
      return this.activateErrors();
    }

    throw new Error(`Unsupported chaos mode: ${mode}`);
  }

  deactivateMode(mode) {
    if (mode === 'saturation') {
      return this.deactivateSaturation();
    }

    if (mode === 'ramp') {
      return this.deactivateRamp();
    }

    if (mode === 'errors') {
      return this.deactivateErrors();
    }

    throw new Error(`Unsupported chaos mode: ${mode}`);
  }

  remediateAll() {
    this.deactivateSaturation();
    this.deactivateRamp();
    this.deactivateErrors();
    this.state.remediationCount += 1;
    this.state.lastActionAt = new Date().toISOString();

    this.logger.info({ event: 'chaos.remediate', remediationCount: this.state.remediationCount }, 'All chaos conditions remediated');
    return this.getStatus();
  }

  shouldInjectError() {
    return this.state.errorInjection && Math.random() < 0.65;
  }

  shutdown() {
    this.remediateAll();
  }

  getWorkersByMode(mode) {
    return this.workers.filter((entry) => entry.mode === mode);
  }

  stopWorkersByMode(mode) {
    const matchingWorkers = this.getWorkersByMode(mode);
    matchingWorkers.forEach(({ worker }) => worker.terminate());
    this.workers = this.workers.filter((entry) => entry.mode !== mode);
    this.state.workerCount = this.workers.length;
    return matchingWorkers.length;
  }

  spawnWorker(mode, burst) {
    const worker = new Worker(path.join(__dirname, 'chaosWorker.js'), {
      workerData: { burst }
    });
    const workerEntry = { worker, mode };

    worker.on('message', (message) => {
      if (message.type === 'heartbeat') {
        this.logger.warn(
          {
            event: 'chaos.worker.heartbeat',
            mode,
            iterations: message.iterations,
            burst,
            workerCount: this.workers.length
          },
          'Chaos worker heartbeat'
        );
      }
    });

    worker.on('error', (error) => {
      this.logger.error({ event: 'chaos.worker.error', mode, error: error.message }, 'Chaos worker crashed');
    });

    worker.on('exit', (code) => {
      this.workers = this.workers.filter((entry) => entry.worker !== worker);
      this.state.workerCount = this.workers.length;
      this.logger.warn({ event: 'chaos.worker.exit', mode, code, workerCount: this.workers.length }, 'Chaos worker exited');
    });

    this.workers.push(workerEntry);
    this.state.workerCount = this.workers.length;
  }
}

module.exports = ChaosManager;
const { parentPort, workerData } = require('worker_threads');

let iterations = 0;
const burst = workerData.burst || 150000;

function burnCpu() {
  let accumulator = 0;

  for (let index = 0; index < burst; index += 1) {
    accumulator += Math.sqrt(index * Math.random());
  }

  iterations += 1;

  if (iterations % 100 === 0) {
    parentPort.postMessage({
      type: 'heartbeat',
      iterations,
      accumulator
    });
  }

  setImmediate(burnCpu);
}

burnCpu();
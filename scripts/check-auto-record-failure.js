const assert = require('assert');
const { AutoRecordManager } = require('../src/auto/AutoRecordManager');

const detector = {
  start: async () => {},
  stop: async () => {},
  getLatestFrame: async () => null,
};

async function checkStopFailureIsPreserved() {
  const recorder = {
    startRecording: async () => ({ filename: 'test.mp4' }),
    stopRecording: async () => {
      throw new Error('empty video');
    },
    isRecording: () => true,
  };
  const manager = new AutoRecordManager({ recorder, detector });
  await manager.start();
  manager.transitionTo('recording');

  const status = await manager.stop('test');
  assert.equal(status.state, 'failed');
  assert.equal(status.lastError, 'empty video');
}

async function checkUnexpectedExitIsPreserved() {
  const recorder = {
    startRecording: async () => ({ filename: 'test.mp4' }),
    stopRecording: async () => ({ filename: 'test.mp4' }),
    isRecording: () => false,
  };
  const manager = new AutoRecordManager({ recorder, detector });
  await manager.start();
  manager.handleRecorderError(new Error('recorder exited'));

  const status = manager.getStatus();
  assert.equal(status.state, 'failed');
  assert.equal(status.lastError, 'recorder exited');
}

async function checkStopDuringStart() {
  let finishStart;
  let detectorRunning = false;
  const slowDetector = {
    start: () => new Promise((resolve) => { finishStart = () => { detectorRunning = true; resolve(); }; }),
    stop: async () => { detectorRunning = false; },
    getLatestFrame: async () => null,
  };
  const recorder = { startRecording: async () => ({ filename: 'test.mp4' }), stopRecording: async () => ({ filename: 'test.mp4' }), isRecording: () => false };
  const manager = new AutoRecordManager({ recorder, detector: slowDetector });
  const starting = manager.start();
  await Promise.resolve();
  assert.equal(manager.getStatus().state, 'arming');
  await assert.rejects(manager.start(), /already running/);
  const stopping = manager.stop();
  finishStart();
  await starting;
  assert.equal((await stopping).state, 'idle');
  assert.equal(detectorRunning, false);
}

async function checkStopDuringRecorderStart() {
  let finishStart;
  let recording = false;
  const recorder = {
    startRecording: () => new Promise((resolve) => { finishStart = () => { recording = true; resolve({ filename: 'test.mp4' }); }; }),
    stopRecording: async () => { recording = false; return { filename: 'test.mp4' }; },
    isRecording: () => recording,
  };
  const manager = new AutoRecordManager({ recorder, detector });
  await manager.start();
  manager.enterAddressLocked();
  const stopping = manager.stop();
  finishStart();
  assert.equal((await stopping).state, 'idle');
  assert.equal(recording, false);
}

Promise.all([checkStopFailureIsPreserved(), checkUnexpectedExitIsPreserved(), checkStopDuringStart(), checkStopDuringRecorderStart()])
  .then(() => console.log('auto-record failure regression checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

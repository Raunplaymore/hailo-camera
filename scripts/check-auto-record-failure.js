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

Promise.all([checkStopFailureIsPreserved(), checkUnexpectedExitIsPreserved()])
  .then(() => console.log('auto-record failure regression checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

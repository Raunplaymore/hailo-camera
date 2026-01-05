const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_SHM_PATHS = {
  preview: '/tmp/hailo_camera_preview.shm',
  record: '/tmp/hailo_camera_record.shm',
  inference: '/tmp/hailo_camera_infer.shm',
};

class SharedPipeline {
  constructor(options = {}) {
    this.gstCmd = options.gstCmd || 'gst-launch-1.0';
    this.socketPaths = options.socketPaths || DEFAULT_SHM_PATHS;
    this.shmSize = options.shmSize || 64 * 1024 * 1024;
    this.logger = options.logger || (() => {});
    this.pipelineProc = null;
    this.pipelineConfig = null;
    this.lastConfig = null;
    this.starting = null;
    this.lastError = null;
    this.users = { preview: 0, session: 0 };
    this.restarting = false;
    this.intentionalStop = false;
    this.restartDelayMs = options.restartDelayMs || 1000;
  }

  getSocketPaths() {
    return { ...this.socketPaths };
  }

  getConfig() {
    return this.pipelineConfig;
  }

  isRunning() {
    return Boolean(this.pipelineProc && this.pipelineProc.exitCode === null);
  }

  async retain(type, config) {
    if (this.users[type] === undefined) {
      this.users[type] = 0;
    }
    await this.ensureRunning(config);
    this.users[type] += 1;
  }

  release(type) {
    if (this.users[type] === undefined) {
      this.users[type] = 0;
    }
    this.users[type] = Math.max(0, this.users[type] - 1);
    this.maybeStop();
  }

  async ensureRunning(config) {
    if (this.isRunning()) {
      if (!this.isConfigCompatible(config)) {
        const err = new Error('Pipeline already running with different settings');
        err.status = 409;
        throw err;
      }
      return;
    }
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = this.startPipeline(config).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  isConfigCompatible(config) {
    if (!this.pipelineConfig || !config) return true;
    return (
      Number(this.pipelineConfig.width) === Number(config.width) &&
      Number(this.pipelineConfig.height) === Number(config.height) &&
      Number(this.pipelineConfig.fps) === Number(config.fps)
    );
  }

  async startPipeline(config) {
    if (!config) {
      const err = new Error('Pipeline config is required');
      err.status = 500;
      throw err;
    }
    this.intentionalStop = false;
    this.pipelineConfig = { ...config };
    this.lastConfig = { ...config };
    Object.values(this.socketPaths).forEach((socketPath) => {
      try {
        fs.unlinkSync(socketPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          this.logger('shm socket cleanup failed', err.message);
        }
      }
    });
    const args = buildSharedPipelineArgs({
      width: config.width,
      height: config.height,
      fps: config.fps,
      socketPaths: this.socketPaths,
      shmSize: this.shmSize,
    });
    this.logger(`Starting shared pipeline: ${this.gstCmd} ${args.join(' ')}`);

    const child = spawn(this.gstCmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.pipelineProc = child;
    let stderr = '';
    const stderrLimit = 2000;

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (stderr.length > stderrLimit) {
        stderr = stderr.slice(-stderrLimit);
      }
      this.logger('pipeline stderr:', chunk.trim());
    });

    child.on('error', (err) => {
      this.lastError = err.message;
      this.logger('shared pipeline spawn error', err.message);
    });

    child.on('close', (code, signal) => {
      this.logger('shared pipeline exited', code, signal || '');
      this.pipelineProc = null;
      this.pipelineConfig = null;
      if (code && code !== 0) {
        this.lastError = stderr || `Pipeline exited with code ${code}`;
      }
      if (!this.intentionalStop) {
        this.maybeRestart();
      }
    });

    await waitForHealthy(child);
  }

  stopPipeline(reason = 'idle') {
    if (!this.pipelineProc || this.pipelineProc.exitCode !== null) return;
    this.logger(`Stopping shared pipeline (${reason})`);
    this.intentionalStop = true;
    try {
      this.pipelineProc.kill('SIGINT');
    } catch (_) {
      // ignore
    }
  }

  maybeStop() {
    const total = Object.values(this.users).reduce((sum, value) => sum + value, 0);
    if (total === 0) {
      this.stopPipeline('idle');
    }
  }

  maybeRestart() {
    const total = Object.values(this.users).reduce((sum, value) => sum + value, 0);
    if (total === 0) return;
    if (this.restarting || this.starting) return;
    if (!this.lastConfig) return;
    this.restarting = true;
    setTimeout(() => {
      this.ensureRunning(this.lastConfig)
        .catch((err) => this.logger('shared pipeline restart failed', err.message))
        .finally(() => {
          this.restarting = false;
        });
    }, this.restartDelayMs);
  }
}

function buildSharedPipelineArgs({ width, height, fps, socketPaths, shmSize }) {
  const { preview, record, inference } = socketPaths || DEFAULT_SHM_PATHS;
  return [
    '-e',
    'libcamerasrc',
    '!',
    `video/x-raw,width=${width},height=${height},format=NV12,framerate=${fps}/1`,
    '!',
    'queue',
    '!',
    'tee',
    'name=t',
    't.',
    '!',
    'queue',
    '!',
    'shmsink',
    `socket-path=${preview}`,
    `shm-size=${shmSize}`,
    'wait-for-connection=false',
    'sync=false',
    't.',
    '!',
    'queue',
    '!',
    'shmsink',
    `socket-path=${record}`,
    `shm-size=${shmSize}`,
    'wait-for-connection=false',
    'sync=false',
    't.',
    '!',
    'queue',
    '!',
    'shmsink',
    `socket-path=${inference}`,
    `shm-size=${shmSize}`,
    'wait-for-connection=false',
    'sync=false',
  ];
}

async function waitForHealthy(child, timeoutMs = 500) {
  if (!child) return;
  if (child.exitCode !== null) {
    const err = new Error('Pipeline exited before start');
    err.status = 409;
    throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  if (child.exitCode !== null) {
    const err = new Error('Camera device busy');
    err.status = 409;
    throw err;
  }
}

module.exports = {
  SharedPipeline,
};

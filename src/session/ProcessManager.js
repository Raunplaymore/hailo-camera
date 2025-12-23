const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const MAX_STDIO_LOG = 4000;

const createError = (message, status = 500) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

class ProcessManager {
  constructor(options = {}) {
    this.uploadDir = options.uploadDir || '/home/ray/uploads';
    this.metaDir = options.metaDir || '/tmp';
    this.stateDir = options.stateDir || '/tmp';
    this.lockFile = options.lockFile || '/tmp/session.lock';
    this.gstLaunchCmd = options.gstLaunchCmd || 'gst-launch-1.0';
    this.libavCodec = options.libavCodec || 'libx264';
    this.logger = options.logger || (() => {});
    this.buildGstArgs = options.buildGstArgs;
    this.buildRecordArgs = options.buildRecordArgs;
    this.ensureUploadsDir = options.ensureUploadsDir || this.defaultEnsureUploadsDir.bind(this);
    this.onSessionFinished = options.onSessionFinished || null;
    this.defaultModelOptions = options.defaultModelOptions || {};
    this.pipeline = options.pipeline || null;
    this.socketPath = options.socketPath || '/tmp/hailo_camera.shm';
    this.currentSession = null;
    this.signalHandlersRegistered = false;
  }

  registerSignalHandlers() {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;
    process.on('SIGINT', () => {
      this.logger('ProcessManager SIGINT - stopping active session');
      this.stopSession(this.currentSession?.jobId, 'sigint').catch(() => {});
    });
    process.on('SIGTERM', () => {
      this.logger('ProcessManager SIGTERM - stopping active session');
      this.stopSession(this.currentSession?.jobId, 'sigterm').catch(() => {});
    });
  }

  async startSession(options) {
    if (!this.buildGstArgs) {
      throw createError('GStreamer builder not configured', 500);
    }
    if (!options || !options.jobId) {
      throw createError('jobId is required', 400);
    }
    await this.ensureUploadsDir();
    await this.acquireLock(options.jobId);

    const jobId = options.jobId;
    const width = Number(options.width);
    const height = Number(options.height);
    const fps = Number(options.fps);
    const durationSec = Number(options.durationSec || 0);

    const videoFile = `${jobId}.mp4`;
    const videoPath = path.join(this.uploadDir, videoFile);
    const videoPartPath = `${videoPath}.part`;
    const metaPath = path.join(this.metaDir, `${jobId}.meta.json`);
    const metaRawPath = `${metaPath}.raw`;
    const statePath = path.join(this.stateDir, `${jobId}.session.json`);

    const session = {
      jobId,
      status: 'running',
      startedAt: Date.now(),
      stoppedAt: null,
      errorMessage: null,
      videoFile,
      videoPath,
      videoPartPath,
      metaPath,
      metaRawPath,
      statePath,
      record: null,
      inference: null,
      pids: {},
      stopRequested: false,
      exits: {},
    };

    this.currentSession = session;
    await this.writeState(session);

    let retained = false;
    try {
      if (this.pipeline) {
        await this.pipeline.retain('session', { width, height, fps });
        retained = true;
      }

      const inferenceArgs = this.buildGstArgs({
        socketPath: this.socketPath,
        width,
        height,
        fps,
        metaPath: metaRawPath,
        model: options.model,
        modelOptions: { ...this.defaultModelOptions, ...(options.modelOptions || {}) },
      });
      const recordArgs = this.buildRecordArgs
        ? this.buildRecordArgs({
            socketPath: this.socketPath,
            width,
            height,
            fps,
            outputPath: videoPartPath,
          })
        : null;
      if (!recordArgs) {
        throw createError('Record pipeline not configured', 500);
      }

      session.record = this.spawnProcess(this.gstLaunchCmd, recordArgs, 'record', session);
      session.inference = this.spawnProcess(this.gstLaunchCmd, inferenceArgs, 'inference', session);
      session.pids = {
        record: session.record.pid,
        inference: session.inference.pid,
      };
      await this.writeLock({ jobId, startedAt: session.startedAt, pids: session.pids });
      await this.writeState(session);
    } catch (err) {
      if (retained && this.pipeline) {
        this.pipeline.release('session');
      }
      await this.releaseLock().catch(() => {});
      this.currentSession = null;
      throw err;
    }

    return {
      jobId,
      videoFile,
      videoPath,
      metaPath,
      metaRawPath,
      videoPartPath,
    };
  }

  async stopSession(jobId, reason = 'user') {
    const session = this.currentSession;
    if (!session || session.jobId !== jobId) {
      throw createError('Session not found', 404);
    }
    if (session.status !== 'running') {
      return session;
    }
    session.stopRequested = true;
    this.logger(`Stopping session ${jobId} (${reason})`);

    const stopTasks = [
      this.terminateProcess(session.record, 'record', 'SIGINT'),
      this.terminateProcess(session.inference, 'inference', 'SIGINT'),
    ];
    await Promise.all(stopTasks);

    if (session.status === 'running') {
      this.finishSession(session, 'stopped');
    }

    return session;
  }

  getStatus(jobId) {
    if (this.currentSession && this.currentSession.jobId === jobId) {
      return this.serializeSession(this.currentSession);
    }
    const statePath = path.join(this.stateDir, `${jobId}.session.json`);
    const state = this.readStateSync(statePath);
    return state || null;
  }

  isRunning() {
    return Boolean(this.currentSession && this.currentSession.status === 'running');
  }

  serializeSession(session) {
    return {
      jobId: session.jobId,
      status: session.status,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      errorMessage: session.errorMessage,
      pids: session.pids,
    };
  }

  spawnProcess(command, args, label, session) {
    this.logger(`Starting ${label}: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (data) => {
      this.logger(`${label} stdout: ${this.truncate(data.toString())}`);
    });
    child.stderr.on('data', (data) => {
      this.logger(`${label} stderr: ${this.truncate(data.toString())}`);
    });

    child.on('error', (err) => {
      this.logger(`${label} spawn error:`, err.message);
      if (session.status === 'running') {
        this.failSession(session, `${label} spawn error: ${err.message}`);
      }
    });

    child.on('close', (code, signal) => {
      session.exits[label] = { code, signal };
      this.logger(`${label} exited`, code, signal || '');
      this.onProcessExit(session, label, code, signal);
    });

    return child;
  }

  onProcessExit(session, label, code, signal) {
    if (session.status !== 'running') {
      this.maybeFinalize(session);
      return;
    }

    if (!session.stopRequested && code !== 0) {
      this.failSession(session, `${label} exited with code ${code}${signal ? ` (${signal})` : ''}`);
      const other = label === 'record' ? session.inference : session.record;
      this.terminateProcess(other, label === 'record' ? 'inference' : 'record', 'SIGINT').catch(() => {});
      return;
    }

    if (!session.stopRequested) {
      session.stopRequested = true;
      const other = label === 'record' ? session.inference : session.record;
      this.terminateProcess(other, label === 'record' ? 'inference' : 'record', 'SIGINT').catch(() => {});
    }

    this.maybeFinalize(session);
  }

  maybeFinalize(session) {
    const recordDone = Boolean(session.exits.record);
    const inferenceDone = Boolean(session.exits.inference);
    if (session.status === 'running' && recordDone && inferenceDone) {
      this.finishSession(session, 'stopped');
    }
  }

  async terminateProcess(child, label, signal) {
    if (!child || child.killed || child.exitCode !== null) return;
    return new Promise((resolve) => {
      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      };
      child.once('close', finalize);
      try {
        child.kill(signal);
      } catch (err) {
        this.logger(`${label} kill error`, err.message);
        finalize();
        return;
      }
      const termTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }, 2000);
      const killTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  async failSession(session, message) {
    if (session.status !== 'running') return;
    session.errorMessage = message;
    this.finishSession(session, 'failed');
  }

  finishSession(session, status) {
    if (session.status !== 'running') return;
    session.status = status;
    session.stoppedAt = Date.now();
    this.writeState(session).catch(() => {});
    this.releaseLock().catch(() => {});
    this.finalizeVideo(session).catch(() => {});
    if (this.pipeline) {
      this.pipeline.release('session');
    }
    if (this.onSessionFinished) {
      this.onSessionFinished(session).catch((err) => {
        this.logger('Session finish handler failed', err.message);
      });
    }
  }

  async defaultEnsureUploadsDir() {
    await fsp.mkdir(this.uploadDir, { recursive: true });
  }

  async writeState(session) {
    const payload = {
      jobId: session.jobId,
      status: session.status,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      errorMessage: session.errorMessage,
      pids: session.pids,
      videoFile: session.videoFile,
      videoPath: session.videoPath,
      videoPartPath: session.videoPartPath,
      metaPath: session.metaPath,
      metaRawPath: session.metaRawPath,
    };
    await fsp.writeFile(session.statePath, JSON.stringify(payload, null, 2));
  }

  async finalizeVideo(session) {
    if (!session.videoPartPath || !session.videoPath) return;
    try {
      await fsp.rename(session.videoPartPath, session.videoPath);
    } catch (err) {
      this.logger('Video finalize failed', err.message);
    }
  }

  readStateSync(statePath) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  async acquireLock(jobId) {
    if (this.currentSession && this.currentSession.status === 'running') {
      throw createError('Session already running', 409);
    }
    await this.cleanupStaleLock();
    const payload = JSON.stringify({
      jobId,
      createdAt: new Date().toISOString(),
      serverPid: process.pid,
    });
    try {
      await fsp.writeFile(this.lockFile, payload, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw createError('Session already running', 409);
      }
      throw err;
    }
  }

  async writeLock(payload) {
    try {
      await fsp.writeFile(this.lockFile, JSON.stringify(payload));
    } catch (err) {
      this.logger('Failed to update session lock', err.message);
    }
  }

  async cleanupStaleLock() {
    try {
      const raw = await fsp.readFile(this.lockFile, 'utf8');
      const payload = JSON.parse(raw);
      const pids = payload?.pids || {};
      const alive = await this.anyPidAlive([pids.rpicam, pids.gst]);
      if (!alive) {
        await fsp.unlink(this.lockFile).catch(() => {});
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger('Session lock read failed', err.message);
      }
    }
  }

  async releaseLock() {
    await fsp.unlink(this.lockFile).catch(() => {});
  }

  async anyPidAlive(pids) {
    for (const pid of pids) {
      if (!pid) continue;
      if (this.isPidAlive(pid)) return true;
    }
    return false;
  }

  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return false;
    }
  }

  truncate(text) {
    return text.length > MAX_STDIO_LOG ? `${text.slice(0, MAX_STDIO_LOG)}... [truncated]` : text;
  }
}

module.exports = {
  ProcessManager,
};

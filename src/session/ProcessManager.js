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
    this.rpicamCmd = options.rpicamCmd || 'rpicam-vid';
    this.gstLaunchCmd = options.gstLaunchCmd || 'gst-launch-1.0';
    this.libavCodec = options.libavCodec || 'libx264';
    this.logger = options.logger || (() => {});
    this.buildGstArgs = options.buildGstArgs;
    this.ensureUploadsDir = options.ensureUploadsDir || this.defaultEnsureUploadsDir.bind(this);
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
    const metaPath = path.join(this.metaDir, `${jobId}.meta.json`);
    const statePath = path.join(this.stateDir, `${jobId}.session.json`);

    const rpicamArgs = [
      '--codec',
      'libav',
      '--libav-format',
      'mp4',
      '--libav-video-codec',
      this.libavCodec,
      '-t',
      String(durationSec > 0 ? durationSec * 1000 : 0),
      '--width',
      String(width),
      '--height',
      String(height),
      '--framerate',
      String(fps),
      '-o',
      videoPath,
      '-n',
    ];

    const gstArgs = this.buildGstArgs({
      width,
      height,
      fps,
      metaPath,
      model: options.model,
      modelOptions: options.modelOptions,
    });

    const session = {
      jobId,
      status: 'running',
      startedAt: Date.now(),
      stoppedAt: null,
      errorMessage: null,
      videoFile,
      videoPath,
      metaPath,
      statePath,
      rpicam: null,
      gst: null,
      pids: {},
      stopRequested: false,
      exits: {},
    };

    this.currentSession = session;
    await this.writeState(session);

    session.rpicam = this.spawnProcess(this.rpicamCmd, rpicamArgs, 'rpicam', session);
    session.gst = this.spawnProcess(this.gstLaunchCmd, gstArgs, 'gst', session);
    session.pids = {
      rpicam: session.rpicam.pid,
      gst: session.gst.pid,
    };
    await this.writeLock({ jobId, startedAt: session.startedAt, pids: session.pids });
    await this.writeState(session);

    return {
      jobId,
      videoFile,
      videoPath,
      metaPath,
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
      this.terminateProcess(session.rpicam, 'rpicam', 'SIGINT'),
      this.terminateProcess(session.gst, 'gst', 'SIGINT'),
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
      const other = label === 'rpicam' ? session.gst : session.rpicam;
      this.terminateProcess(other, label === 'rpicam' ? 'gst' : 'rpicam', 'SIGINT').catch(() => {});
      return;
    }

    if (!session.stopRequested && label === 'rpicam') {
      session.stopRequested = true;
      this.terminateProcess(session.gst, 'gst', 'SIGINT').catch(() => {});
    }

    if (!session.stopRequested && label === 'gst') {
      session.stopRequested = true;
      this.terminateProcess(session.rpicam, 'rpicam', 'SIGINT').catch(() => {});
    }

    this.maybeFinalize(session);
  }

  maybeFinalize(session) {
    const rpicamDone = Boolean(session.exits.rpicam);
    const gstDone = Boolean(session.exits.gst);
    if (session.status === 'running' && rpicamDone && gstDone) {
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
      metaPath: session.metaPath,
    };
    await fsp.writeFile(session.statePath, JSON.stringify(payload, null, 2));
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

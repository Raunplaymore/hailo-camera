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
    this.recordSocketPath = options.recordSocketPath || options.socketPath || '/tmp/hailo_camera_record.shm';
    this.inferenceSocketPath = options.inferenceSocketPath || options.socketPath || '/tmp/hailo_camera_infer.shm';
    this.currentSession = null;
    this.signalHandlersRegistered = false;
    this.zombieCleanupTimer = null;
    this.startZombieCleanupTimer();
  }

  registerSignalHandlers() {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;
    process.on('SIGINT', () => {
      this.logger('ProcessManager SIGINT - stopping active session');
      this.cleanup();
      this.stopSession(this.currentSession?.jobId, 'sigint').catch(() => {});
    });
    process.on('SIGTERM', () => {
      this.logger('ProcessManager SIGTERM - stopping active session');
      this.cleanup();
      this.stopSession(this.currentSession?.jobId, 'sigterm').catch(() => {});
    });
  }

  startZombieCleanupTimer() {
    // 1분마다 좀비 프로세스 정리
    this.zombieCleanupTimer = setInterval(() => {
      this.cleanupZombieProcesses();
    }, 60000);
    // Node.js가 이 타이머 때문에 종료되지 않도록
    if (this.zombieCleanupTimer.unref) {
      this.zombieCleanupTimer.unref();
    }
  }

  cleanupZombieProcesses() {
    const session = this.currentSession;
    if (!session) return;

    const checkProcess = (proc, label) => {
      if (!proc) return false;
      if (proc.exitCode !== null) return false;
      if (!proc.pid) {
        this.logger(`Zombie detected: ${label} has no PID`);
        return true;
      }
      if (proc.killed && !this.isPidAlive(proc.pid)) {
        this.logger(`Zombie detected: ${label} marked as killed but still in process list`);
        return true;
      }
      return false;
    };

    const recordZombie = checkProcess(session.record, 'record');
    const inferenceZombie = checkProcess(session.inference, 'inference');

    if (recordZombie || inferenceZombie) {
      this.logger('Cleaning up zombie processes in session', session.jobId);
      // 좀비가 감지되면 세션을 안전하게 종료
      if (session.status === 'running') {
        this.failSession(session, 'Zombie process detected, forcing cleanup');
      }
    }
  }

  cleanup() {
    if (this.zombieCleanupTimer) {
      clearInterval(this.zombieCleanupTimer);
      this.zombieCleanupTimer = null;
    }
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
    const modelOptions = { ...this.defaultModelOptions, ...(options.modelOptions || {}) };

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
      model: options.model || modelOptions.model || null,
      modelOptions,
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
        socketPath: this.inferenceSocketPath,
        width,
        height,
        fps,
        metaPath: metaRawPath,
        model: options.model,
        modelOptions,
      });
      const recordArgs = this.buildRecordArgs
        ? this.buildRecordArgs({
            socketPath: this.recordSocketPath,
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
      model: session.model,
      modelOptions: session.modelOptions,
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
    if (!child || child.exitCode !== null) return;
    return new Promise((resolve) => {
      let settled = false;
      const pid = child.pid;
      const isAlive = () => {
        if (!child || child.exitCode !== null) return false;
        if (!child.pid) return false;
        try {
          process.kill(child.pid, 0);
          return true;
        } catch (_) {
          return false;
        }
      };
      const finalize = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        clearTimeout(lastResortTimer);
        resolve();
      };
      child.once('close', finalize);
      try {
        child.kill(signal);
        this.logger(`${label} sent ${signal}`);
      } catch (err) {
        this.logger(`${label} kill error`, err.message);
        finalize();
        return;
      }
      const termTimer = setTimeout(() => {
        if (isAlive()) {
          this.logger(`${label} escalating to SIGTERM`);
          child.kill('SIGTERM');
        }
      }, 2000);
      const killTimer = setTimeout(() => {
        if (isAlive()) {
          this.logger(`${label} escalating to SIGKILL`);
          child.kill('SIGKILL');
        }
      }, 5000);
      const forceTimer = setTimeout(() => {
        if (isAlive()) {
          this.logger(`${label} still alive after SIGKILL, trying direct PID kill`);
          try {
            process.kill(pid, 'SIGKILL');
          } catch (err) {
            this.logger(`${label} direct PID kill failed:`, err.message);
          }
        }
      }, 7000);
      const lastResortTimer = setTimeout(() => {
        if (isAlive()) {
          this.logger(`${label} CRITICAL: process ${pid} did not terminate after all attempts`);
          // 프로세스가 정말 안 죽으면 경고하고 계속 진행
          // 실제 환경에서는 시스템 관리자에게 알림을 보내는 것이 좋음
        }
        finalize();
      }, 10000);
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

    // 상태 검증: 프로세스가 정말 종료되었는지 확인
    this.validateProcessTermination(session);

    this.writeState(session).catch(() => {});
    this.releaseLock().catch(() => {});
    const finalizePromise = this.finalizeVideo(session).catch((err) => {
      this.logger('Video finalize failed', err.message);
    });
    if (this.pipeline) {
      this.pipeline.release('session');
    }
    finalizePromise
      .then(async () => {
        if (this.onSessionFinished) {
          await this.onSessionFinished(session);
        }
      })
      .catch((err) => {
        this.logger('Session finish handler failed', err.message);
      });
  }

  validateProcessTermination(session) {
    // 프로세스가 실제로 종료되었는지 확인
    const processes = [
      { proc: session.record, label: 'record' },
      { proc: session.inference, label: 'inference' },
    ];

    for (const { proc, label } of processes) {
      if (!proc) continue;

      if (proc.exitCode === null && proc.pid) {
        if (this.isPidAlive(proc.pid)) {
          this.logger(`WARNING: ${label} process ${proc.pid} still alive after session finish`);
          // 마지막 시도로 SIGKILL
          try {
            process.kill(proc.pid, 'SIGKILL');
          } catch (err) {
            this.logger(`Failed to kill lingering ${label} process:`, err.message);
          }
        }
      }
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
      model: session.model,
      modelOptions: session.modelOptions,
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
    await fsp.rename(session.videoPartPath, session.videoPath);
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

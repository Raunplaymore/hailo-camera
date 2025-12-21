const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
let AutoRecordManager;
let RecorderController;

let tsNodeRegistered = false;
try {
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
  tsNodeRegistered = true;
  ({ AutoRecordManager, RecorderController } = require('./src/auto'));
} catch (err) {
  console.warn('ts-node/register unavailable - auto record disabled', err?.message || err);
}

const app = express();

const PORT = parseInt(process.env.PORT, 10) || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : '/home/ray/uploads';
const LOCK_FILE = '/tmp/camera.lock';
const COMMAND_GRACE_MS = 3000;
const LOCK_FALLBACK_TTL_MS = 10 * 60 * 1000;
const MAX_STDIO_LOG = 4000;

const DEFAULTS = {
  width: parseInt(process.env.DEFAULT_WIDTH, 10) || 1920,
  height: parseInt(process.env.DEFAULT_HEIGHT, 10) || 1080,
  fps: parseInt(process.env.DEFAULT_FPS, 10) || 30,
  stillDurationSec: parseInt(process.env.DEFAULT_STILL_DURATION_SEC, 10) || 1,
  videoDurationSec: parseInt(process.env.DEFAULT_VIDEO_DURATION_SEC, 10) || 3,
};

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const CORS_ALLOW_ALL = process.env.CORS_ALLOW_ALL === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const ANALYZE_URL = process.env.ANALYZE_URL || 'http://127.0.0.1:3000/api/analyze/from-file';
const STREAM_TOKEN = process.env.STREAM_TOKEN || '';
const STILL_COMMANDS = buildCommandList(process.env.CAMERA_STILL_CMDS || process.env.STILL_CMD, [
  'rpicam-still',
  'libcamera-still',
]);
const VIDEO_COMMANDS = buildCommandList(process.env.CAMERA_VIDEO_CMDS || process.env.VID_CMD, [
  'rpicam-vid',
  'libcamera-vid',
]);
const HELLO_COMMANDS = buildCommandList(process.env.CAMERA_HELLO_CMDS || process.env.HELLO_CMD, [
  'rpicam-hello',
  'libcamera-hello',
]);

let busy = false;
let lastCaptureAt = null;
let lastError = null;
let streamingActive = false;
let streamClients = 0;
let activeStreamCleanup = null;
let lastStreamStateChange = null;
let autoRecordManager = null;
let autoRecordInitError = null;

if (tsNodeRegistered && AutoRecordManager && RecorderController) {
  try {
    autoRecordManager = new AutoRecordManager({
      recorder: new RecorderController({
        uploadDir: UPLOAD_DIR,
        width: DEFAULTS.width,
        height: DEFAULTS.height,
        fps: DEFAULTS.fps,
        videoCommands: VIDEO_COMMANDS,
        libavCodec: process.env.LIBAV_VIDEO_CODEC || 'libx264',
        acquireLock: tryAcquireLock,
        releaseLock,
        ensureUploadsDir,
        buildFilename: () => buildDefaultFilename({ format: 'mp4' }),
        logger: (...args) => log(...args),
      }),
      logger: (...args) => log(...args),
    });
  } catch (err) {
    autoRecordInitError = err;
    console.warn('Auto record init failed', err?.message || err);
  }
} else {
  autoRecordInitError = new Error('ts-node/register unavailable');
}

app.use(express.json({ limit: '1mb' }));

if (CORS_ALLOW_ALL || CORS_ORIGIN) {
  const corsOptions = CORS_ALLOW_ALL
    ? { origin: true }
    : { origin: CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean) };
  app.use(cors(corsOptions));
}

app.use('/uploads', express.static(UPLOAD_DIR, { extensions: ['jpg', 'h264', 'mp4'] }));

app.use((req, _res, next) => {
  log(`${req.method} ${req.url}`, req.body && Object.keys(req.body).length ? req.body : '');
  next();
});

app.use('/api', authMiddleware);

app.get('/api/camera/status', async (_req, res) => {
  const cameraDetected = await detectCamera();
  const busyState = await isBusy();
  res.json({
    ok: true,
    cameraDetected,
    busy: busyState || streamingActive,
    streaming: streamingActive,
    streamClients,
    lastStreamAt: lastStreamStateChange,
    lastCaptureAt,
    lastError,
  });
});

app.get('/api/camera/auto-record/status', (_req, res) => {
  res.json({ ok: true, status: getAutoRecordStatus() });
});

app.post('/api/camera/auto-record/start', async (req, res) => {
  const manager = resolveAutoRecordManager(res);
  if (!manager) return;
  if (streamingActive) {
    return res.status(409).json({ ok: false, error: 'Camera streaming in progress' });
  }
  if (await isBusy()) {
    return res.status(409).json({ ok: false, error: 'Camera busy' });
  }
  try {
    const status = await manager.start();
    res.json({ ok: true, status });
  } catch (err) {
    const statusCode = err.status || err.httpStatus || 500;
    res.status(statusCode).json({ ok: false, error: err.message });
  }
});

app.post('/api/camera/auto-record/stop', async (_req, res) => {
  const manager = resolveAutoRecordManager(res);
  if (!manager) return;
  try {
    const status = await manager.stop('user');
    res.json({ ok: true, status });
  } catch (err) {
    const statusCode = err.status || err.httpStatus || 500;
    res.status(statusCode).json({ ok: false, error: err.message });
  }
});

app.post('/api/camera/capture', async (req, res) => {
  let options;
  try {
    options = parseCaptureOptions(req.body || {});
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ ok: false, error: err.message });
  }

  if (streamingActive) {
    return res.status(409).json({ ok: false, error: 'Camera streaming in progress' });
  }

  const timeouts = computeTimeouts(options.format, options.durationSec);
  const acquired = await tryAcquireLock(timeouts.total);
  if (!acquired) {
    return res.status(409).json({ ok: false, error: 'Camera busy' });
  }

  let filename;
  try {
    filename = await handleCapture(options, timeouts);
    lastCaptureAt = new Date().toISOString();
    lastError = null;
    res.json({ ok: true, filename, url: `/uploads/${filename}` });
  } catch (err) {
    lastError = err.message;
    const status = err.httpStatus || (err.code === 'TIMEOUT' ? 504 : 500);
    res.status(status).json({ ok: false, error: err.message });
  } finally {
    await releaseLock();
  }
});

app.post('/api/camera/capture-and-analyze', async (req, res) => {
  let options;
  try {
    options = parseCaptureOptions(req.body || {});
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ ok: false, error: err.message });
  }

  if (streamingActive) {
    return res.status(409).json({ ok: false, error: 'Camera streaming in progress' });
  }

  const timeouts = computeTimeouts(options.format, options.durationSec);
  const acquired = await tryAcquireLock(timeouts.total);
  if (!acquired) {
    return res.status(409).json({ ok: false, error: 'Camera busy' });
  }

  let filename;
  try {
    filename = await handleCapture(options, timeouts);
    lastCaptureAt = new Date().toISOString();
    lastError = null;

    const analyzeTarget = ANALYZE_URL;
    let jobId = null;
    try {
      const analyzePayload = {
        filename: options.filename,
        force: Boolean(req.body?.force),
      };
      const analyzeResp = await fetch(analyzeTarget, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
        },
        body: JSON.stringify(analyzePayload),
      });
      const data = await analyzeResp.json().catch(() => ({}));
      if (!analyzeResp.ok) {
        throw new Error(data.error || `Analyze failed with status ${analyzeResp.status}`);
      }
      jobId = data.jobId || data.id || null;
    } catch (err) {
      lastError = err.message;
      return res.status(500).json({ ok: false, error: `Analyze request failed: ${err.message}` });
    }

    res.json({ ok: true, jobId, filename, status: 'queued', url: `/uploads/${filename}` });
  } catch (err) {
    lastError = err.message;
    const status = err.httpStatus || (err.code === 'TIMEOUT' ? 504 : 500);
    res.status(status).json({ ok: false, error: err.message });
  } finally {
    await releaseLock();
  }
});

app.get('/api/camera/stream.mjpeg', async (req, res) => {
  if (STREAM_TOKEN) {
    const token = req.query.token || req.headers['x-stream-token'];
    if (!token || token !== STREAM_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Invalid stream token' });
    }
  }
  if (await isBusy()) {
    return res.status(409).json({ ok: false, error: 'Camera busy' });
  }
  if (streamingActive) {
    return res.status(409).json({ ok: false, error: 'Stream already active' });
  }

  const streamOptions = parseStreamOptions(req.query || {});
  let pipeline;
  let cleaned = false;

  const cleanup = (reason) => {
    if (cleaned) return;
    cleaned = true;
    setStreamingState(false);
    if (activeStreamCleanup === cleanup) {
      activeStreamCleanup = null;
    }
    log(`MJPEG stream cleanup (${reason})`);
    if (pipeline) {
      if (pipeline.source && pipeline.ffmpeg && pipeline.source.stdout && pipeline.ffmpeg.stdin) {
        pipeline.source.stdout.unpipe(pipeline.ffmpeg.stdin);
      }
      if (pipeline.source && !pipeline.source.killed) {
        pipeline.source.kill('SIGTERM');
        setTimeout(() => pipeline.source.kill('SIGKILL'), 1500);
      }
      if (pipeline.ffmpeg && !pipeline.ffmpeg.killed) {
        if (pipeline.ffmpeg.stdout) {
          pipeline.ffmpeg.stdout.unpipe(res);
        }
        if (pipeline.ffmpeg.stdin && !pipeline.ffmpeg.stdin.destroyed) {
          pipeline.ffmpeg.stdin.destroy();
        }
        pipeline.ffmpeg.kill('SIGTERM');
        setTimeout(() => pipeline.ffmpeg.kill('SIGKILL'), 1500);
      }
    }
    if (!res.writableEnded) {
      res.end();
    }
  };

  try {
    pipeline = await startStreamPipeline(streamOptions);
  } catch (err) {
    const status = err.httpStatus || 500;
    return res.status(status).json({ ok: false, error: err.message });
  }

  setStreamingState(true, 1);
  activeStreamCleanup = cleanup;

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    Pragma: 'no-cache',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const handleError = (label) => (err) => {
    if (err && err.message) {
      log(`${label} stream error:`, err.message);
    } else {
      log(`${label} stream error`);
    }
    cleanup(`${label}_error`);
  };

  pipeline.ffmpeg.stdout.on('data', (chunk) => {
    if (!res.writableEnded) {
      res.write(chunk);
    }
  });
  pipeline.ffmpeg.stdout.on('error', handleError('ffmpeg_stdout'));

  const onClose = (label) => (code, signal) => {
    log(`${label} stream process closed`, code, signal || '');
    cleanup(`${label}_close`);
  };

  pipeline.source.on('error', handleError('source'));
  pipeline.ffmpeg.on('error', handleError('ffmpeg'));
  pipeline.source.on('close', onClose('source'));
  pipeline.ffmpeg.on('close', onClose('ffmpeg'));

  const onClientClose = () => cleanup('client_disconnect');
  req.on('close', onClientClose);
  res.on('close', () => cleanup('response_close'));
  res.on('finish', () => cleanup('response_finish'));
  res.on('error', (err) => {
    log('stream response error:', err.message);
    cleanup('response_error');
  });
});

app.post('/api/camera/stream/stop', (_req, res) => {
  if (activeStreamCleanup) {
    activeStreamCleanup('manual_stop');
    return res.json({ ok: true, stopped: true });
  }
  res.json({ ok: true, stopped: false });
});

app.use((err, _req, res, _next) => {
  log('Unhandled error', err.stack || err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection', reason);
});

(async () => {
  await ensureUploadsDir();
  await cleanupStaleLock();
  app.listen(PORT, () => {
    log(`Capture server listening on port ${PORT}`);
  });
})();

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function parseCaptureOptions(body) {
  const format = (body.format || 'jpg').toLowerCase();
  if (!['jpg', 'h264', 'mp4'].includes(format)) {
    throw httpError('Invalid format. Use jpg, h264, or mp4', 400);
  }

  const width = parsePositiveNumber(body.width, DEFAULTS.width);
  const height = parsePositiveNumber(body.height, DEFAULTS.height);
  const fps = format === 'jpg' ? DEFAULTS.fps : parsePositiveNumber(body.fps, DEFAULTS.fps);
  const durationSec = parsePositiveNumber(
    body.durationSec,
    format === 'jpg' ? DEFAULTS.stillDurationSec : DEFAULTS.videoDurationSec,
  );

  const filename = deriveFilename(body.filename, { format, width, height, fps, durationSec });
  return { format, width, height, fps, durationSec, filename };
}

function deriveFilename(inputName, { format, width, height, fps, durationSec }) {
  const ext = format === 'jpg' ? 'jpg' : format;
  if (inputName) {
    const safe = sanitizeFilename(path.basename(inputName));
    if (safe.endsWith(`.${ext}`)) return safe;
    const withoutExt = safe.replace(/\.[^.]+$/, '');
    return `${withoutExt}.${ext}`;
  }
  return buildDefaultFilename({ format: ext, width, height, fps, durationSec });
}

function sanitizeFilename(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function buildDefaultFilename({ format }) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${ms}`;
  return `ray_golf_${ts}_swing.${format}`;
}

function getAutoRecordStatus() {
  if (autoRecordManager) {
    return autoRecordManager.getStatus();
  }
  return {
    enabled: false,
    state: 'idle',
    startedAt: null,
    recordingFilename: null,
    lastError: autoRecordInitError ? autoRecordInitError.message : 'auto record disabled',
  };
}

function resolveAutoRecordManager(res) {
  if (!autoRecordManager) {
    const reason = autoRecordInitError ? autoRecordInitError.message : 'Auto record unavailable';
    res.status(503).json({ ok: false, error: reason });
    return null;
  }
  return autoRecordManager;
}

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}

function parseStreamOptions(query) {
  const width = parsePositiveNumber(query.width, 640);
  const height = parsePositiveNumber(query.height, 360);
  const fps = parsePositiveNumber(query.fps, 15);
  return { width, height, fps, quality: 5 };
}

function setStreamingState(active, clients = 0) {
  streamingActive = Boolean(active);
  streamClients = streamingActive ? Math.max(1, Number(clients) || 1) : 0;
  lastStreamStateChange = new Date().toISOString();
  log(`Streaming state -> active=${streamingActive} clients=${streamClients}`);
}

async function ensureUploadsDir() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

async function isBusy() {
  if (busy) return true;
  try {
    await fsp.access(LOCK_FILE, fs.constants.F_OK);
  } catch (_) {
    return false;
  }
  const stale = await cleanupStaleLock();
  if (stale) return false;
  return true;
}

async function cleanupStaleLock() {
  try {
    const stat = await fsp.stat(LOCK_FILE);
    const content = await fsp.readFile(LOCK_FILE, 'utf-8').catch(() => '');
    let expiresAt = stat.mtimeMs + LOCK_FALLBACK_TTL_MS;
    try {
      const parsed = JSON.parse(content);
      const parsedExpire = parsed.expiresAt || parsed.expireAt;
      if (parsedExpire) {
        expiresAt = Number(parsedExpire);
      } else if (parsed.createdAt) {
        expiresAt = new Date(parsed.createdAt).getTime() + LOCK_FALLBACK_TTL_MS;
      }
    } catch (err) {
      log('Lock file parse error', err.message);
    }

    if (Date.now() > expiresAt) {
      await fsp.unlink(LOCK_FILE).catch(() => {});
      log('Removed stale lock file');
      return true;
    }
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    log('Lock check failed', err.message);
    return false;
  }
}

async function tryAcquireLock(expectedMs) {
  await cleanupStaleLock();
  if (busy) return false;
  const expiresAt = Date.now() + Math.max(expectedMs + COMMAND_GRACE_MS, 5000);
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    expiresAt,
    note: 'camera capture lock',
  });

  try {
    await fsp.writeFile(LOCK_FILE, payload, { flag: 'wx' });
    busy = true;
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      const stale = await cleanupStaleLock();
      if (stale) {
        return tryAcquireLock(expectedMs);
      }
      return false;
    }
    throw err;
  }
}

async function releaseLock() {
  busy = false;
  await fsp.unlink(LOCK_FILE).catch(() => {});
}

function computeTimeouts(format, durationSec) {
  const durationMs = Math.max(1, durationSec) * 1000;
  const captureTimeout = durationMs + COMMAND_GRACE_MS + 1000;
  const convertTimeout = format === 'mp4' ? Math.max(5000, durationMs + COMMAND_GRACE_MS) : 0;
  return { captureTimeout, convertTimeout, total: captureTimeout + convertTimeout };
}

async function handleCapture(options, timeouts) {
  await ensureUploadsDir();
  const finalPath = path.join(UPLOAD_DIR, options.filename);
  const tempPath = `${finalPath}.part`;

  if (options.format === 'mp4') {
    const directHandled = await captureMp4Direct(
      { ...options, outputPath: tempPath },
      timeouts.captureTimeout,
    );
    if (directHandled) {
      await finalizeTempFile(tempPath, finalPath);
      return options.filename;
    }
  }

  if (options.format === 'jpg') {
    await captureStill({ ...options, outputPath: finalPath }, timeouts.captureTimeout);
    return options.filename;
  }

  if (options.format === 'h264') {
    await captureVideo({ ...options, outputPath: finalPath }, timeouts.captureTimeout);
    return options.filename;
  }

  const tempH264 = tempPath.replace(/\.mp4\.part$/, '.h264');
  await captureVideo({ ...options, format: 'h264', outputPath: tempH264 }, timeouts.captureTimeout);
  await remuxToMp4(tempH264, tempPath, options.fps, timeouts.convertTimeout);
  await finalizeTempFile(tempPath, finalPath);
  await fsp.unlink(tempH264).catch(() => {});
  return options.filename;
}

async function finalizeTempFile(tempPath, finalPath) {
  if (tempPath === finalPath) return;
  await fsp.rename(tempPath, finalPath);
}

async function captureStill({ width, height, durationSec, outputPath }, timeoutMs) {
  const timeout = Math.max(500, durationSec * 1000);
  const args = ['-o', outputPath, '--width', String(width), '--height', String(height), '-t', String(timeout), '-n'];
  const { stdout, stderr } = await runCameraCommand(STILL_COMMANDS, args, timeoutMs);
  logOutputs(stdout, stderr);
}

async function captureVideo({ width, height, durationSec, fps, outputPath }, timeoutMs) {
  const duration = Math.max(1, durationSec) * 1000;
  const args = [
    '--codec',
    'h264',
    '-t',
    String(duration),
    '--width',
    String(width),
    '--height',
    String(height),
    '--framerate',
    String(fps),
    '-o',
    outputPath,
    '-n',
  ];
  args.push('--inline');
  const { stdout, stderr } = await runCameraCommand(VIDEO_COMMANDS, args, timeoutMs);
  logOutputs(stdout, stderr);
}

async function captureMp4Direct({ width, height, durationSec, fps, outputPath }, timeoutMs) {
  const rpicamCommands = VIDEO_COMMANDS.filter((cmd) => cmd.includes('rpicam'));
  if (!rpicamCommands.length) return false;
  const duration = Math.max(1, durationSec) * 1000;
  const args = [
    '--codec',
    'libav',
    '--libav-format',
    'mp4',
    '--libav-video-codec',
    process.env.LIBAV_VIDEO_CODEC || 'libx264',
    '-t',
    String(duration),
    '--width',
    String(width),
    '--height',
    String(height),
    '--framerate',
    String(fps),
    '-o',
    outputPath,
    '-n',
  ];
  const { stdout, stderr } = await runCameraCommand(rpicamCommands, args, timeoutMs);
  logOutputs(stdout, stderr);
  return true;
}

async function remuxToMp4(inputPath, outputPath, fps, timeoutMs) {
  const args = [
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'h264',
    '-framerate',
    String(fps),
    '-i',
    inputPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outputPath,
  ];
  logCommand('ffmpeg', args);
  const { stdout, stderr } = await runCommand('ffmpeg', args, timeoutMs);
  logOutputs(stdout, stderr);
}

async function startStreamPipeline({ width, height, fps, quality }) {
  const preferred = buildStreamCommandList();
  let lastErr = null;

  for (const command of preferred) {
    const args = [
      '--codec',
      'yuv420',
      '--width',
      String(width),
      '--height',
      String(height),
      '--framerate',
      String(fps),
      '-t',
      '0',
      '-o',
      '-',
      '-n',
    ];

    let source;
    try {
      source = await spawnStreamingProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        `${width}x${height}`,
        '-r',
        String(fps),
        '-i',
        '-',
        '-f',
        'mpjpeg',
        '-q:v',
        String(quality),
        '-',
      ];
      const ffmpeg = await spawnStreamingProcess('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

      source.stdout.pipe(ffmpeg.stdin);

      source.stderr.on('data', (data) => log('stream source stderr:', truncate(data.toString())));
      ffmpeg.stderr.on('data', (data) => log('stream ffmpeg stderr:', truncate(data.toString())));

      return { source, ffmpeg };
    } catch (err) {
      if (source && !source.killed) {
        source.kill('SIGTERM');
        setTimeout(() => source.kill('SIGKILL'), 1500);
      }
      lastErr = err;
      log(`Streaming via ${command} failed:`, err.message);
      continue;
    }
  }

  throw httpError(lastErr?.message || 'Unable to start streaming pipeline', lastErr?.httpStatus || 500);
}

function spawnStreamingProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    logCommand(command, args);
    const child = spawn(command, args, options);
    const handleError = (err) => {
      child.off('spawn', handleSpawn);
      reject(err);
    };
    const handleSpawn = () => {
      child.off('error', handleError);
      resolve(child);
    };
    child.once('error', handleError);
    child.once('spawn', handleSpawn);
  });
}

async function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500);
      const err = new Error(`Command timed out after ${timeoutMs}ms: ${command}`);
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      err.httpStatus = 500;
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`Command failed (${command}) with exit ${code}${signal ? ` signal ${signal}` : ''}`);
        err.httpStatus = 500;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function logCommand(command, args) {
  log(`Executing: ${command} ${args.join(' ')}`);
}

function logOutputs(stdout, stderr) {
  if (stdout) log('stdout:', truncate(stdout));
  if (stderr) log('stderr:', truncate(stderr));
}

function truncate(text, limit = MAX_STDIO_LOG) {
  return text.length > limit ? `${text.slice(0, limit)}... [truncated]` : text;
}

async function runCameraCommand(commands, args, timeoutMs) {
  let lastErr = null;
  for (const command of commands) {
    try {
      logCommand(command, args);
      return await runCommand(command, args, timeoutMs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        lastErr = err;
        log(`Command ${command} not found, trying next option...`);
        continue;
      }
      throw err;
    }
  }
  const err = lastErr || new Error('No camera command available');
  err.httpStatus = err.httpStatus || 500;
  throw err;
}

async function detectCamera() {
  const checks = [
    ...HELLO_COMMANDS.map((cmd) => [cmd, ['--list-cameras']]),
    ...STILL_COMMANDS.map((cmd) => [cmd, ['--list-cameras']]),
  ];

  for (const [cmd, args] of checks) {
    try {
      const { stdout } = await runCommand(cmd, args, 4000);
      if (stdout && stdout.trim().length > 0) {
        return true;
      }
    } catch (err) {
      log(`Camera detection via ${cmd} failed:`, err.message);
    }
  }
  return false;
}

function httpError(message, status) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

function buildCommandList(raw, defaults) {
  if (!raw) return defaults;
  const list = String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return list.length ? list : defaults;
}

function buildStreamCommandList() {
  const preferred = [];
  const seen = new Set();
  for (const cmd of VIDEO_COMMANDS) {
    if (/rpicam/.test(cmd) && !seen.has(cmd)) {
      preferred.push(cmd);
      seen.add(cmd);
    }
  }
  for (const cmd of VIDEO_COMMANDS) {
    if (!seen.has(cmd)) {
      preferred.push(cmd);
      seen.add(cmd);
    }
  }
  return preferred.length ? preferred : ['rpicam-vid'];
}

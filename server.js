const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { ProcessManager } = require('./src/session/ProcessManager');
const {
  buildGstFileArgs,
  buildGstShmInferenceArgs,
  buildGstShmPreviewArgs,
  buildGstShmRecordArgs,
} = require('./src/session/gstPipeline');
const {
  readTail,
  parseTailFrames,
  parseFramesFromText,
  normalizeFrame,
} = require('./src/session/tailParser');
const { normalizeMetaFile } = require('./src/session/metaNormalizer');
const { SharedPipeline } = require('./src/session/SharedPipeline');
let AutoRecordManager;
let RecorderController;

let tsNodeRegistered = false;
try {
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
  tsNodeRegistered = true;
  ({ AutoRecordManager, RecorderController } = require('./src/auto/index.ts'));
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

const SESSION_DEFAULTS = {
  width: 1456,
  height: 1088,
  fps: 60,
};
const SESSION_META_DIR = process.env.META_DIR ? path.resolve(process.env.META_DIR) : '/tmp';
const SESSION_STATE_DIR = '/tmp';
const SESSION_LOCK_FILE = '/tmp/session.lock';
const SESSION_MAX_TAIL_FRAMES = 200;
const SHARED_PIPELINE_SOCKET = '/tmp/hailo_camera.shm';
const SHARED_PIPELINE_SHM_SIZE = 64 * 1024 * 1024;

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const CORS_ALLOW_ALL = process.env.CORS_ALLOW_ALL === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const ANALYZE_URL = process.env.ANALYZE_URL || 'http://127.0.0.1:3000/api/analyze/from-file';
const STREAM_TOKEN = process.env.STREAM_TOKEN || '';
const HAILO_HEF_PATH = process.env.HAILO_HEF_PATH || '/usr/share/hailo-models/yolov8s_h8.hef';
const SESSION_RECORD_ENCODER = detectRecordEncoder();
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
const SESSION_GST_CMD = process.env.GST_LAUNCH_CMD || 'gst-launch-1.0';

let busy = false;
let lastCaptureAt = null;
let lastError = null;
let streamingActive = false;
let streamClients = 0;
let lastStreamStateChange = null;
let autoRecordManager = null;
let autoRecordInitError = null;

const sharedPipeline = new SharedPipeline({
  gstCmd: SESSION_GST_CMD,
  socketPath: SHARED_PIPELINE_SOCKET,
  shmSize: SHARED_PIPELINE_SHM_SIZE,
  logger: (...args) => log(...args),
});
const previewSessions = new Map();
let previewSessionCounter = 0;

const sessionManager = new ProcessManager({
  uploadDir: UPLOAD_DIR,
  metaDir: SESSION_META_DIR,
  stateDir: SESSION_STATE_DIR,
  lockFile: SESSION_LOCK_FILE,
  gstLaunchCmd: SESSION_GST_CMD,
  buildGstArgs: buildGstShmInferenceArgs,
  buildRecordArgs: (options) =>
    buildGstShmRecordArgs({ ...options, encoder: SESSION_RECORD_ENCODER }),
  pipeline: sharedPipeline,
  socketPath: SHARED_PIPELINE_SOCKET,
  defaultModelOptions: { hefPath: HAILO_HEF_PATH },
  ensureUploadsDir: ensureSessionDirs,
  logger: (...args) => log(...args),
  onSessionFinished: async (session) => {
    await finalizeSessionMeta(session);
  },
});
sessionManager.registerSignalHandlers();

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

app.delete('/api/uploads/*', async (req, res) => {
  const rawPath = req.params[0] || '';
  const decoded = decodeURIComponent(rawPath);
  const targetPath = path.resolve(UPLOAD_DIR, decoded);
  if (!targetPath.startsWith(`${UPLOAD_DIR}${path.sep}`)) {
    return res.status(400).json({ ok: false, error: 'Invalid upload path' });
  }
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }
  try {
    await fsp.unlink(targetPath);
    res.json({ ok: true, filename: path.basename(targetPath) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/camera/status', async (_req, res) => {
  const cameraDetected = await detectCamera();
  const busyState = await isBusy();
  res.json({
    ok: true,
    cameraDetected,
    busy: busyState,
    streaming: streamingActive,
    streamClients,
    lastStreamAt: lastStreamStateChange,
    lastCaptureAt,
    lastError,
  });
});

app.get('/api/camera/auto-record/status', (_req, res) => {
  try {
    res.json({ ok: true, status: getAutoRecordStatus() });
  } catch (err) {
    log('Auto record status error', err.message || err);
    res.status(200).json({
      ok: false,
      error: err.message || 'Auto record status error',
      status: getFallbackStatus(),
    });
  }
});

app.post('/api/camera/auto-record/start', async (req, res) => {
  const manager = resolveAutoRecordManager(res);
  if (!manager) return;
  if (await isBusy()) {
    return res.status(409).json({ ok: false, error: 'Camera busy' });
  }
  try {
    const status = await manager.start();
    res.json({ ok: true, status });
  } catch (err) {
    const statusCode = err.status === 409 ? 409 : 200;
    res.status(statusCode).json({
      ok: false,
      error: err.message || 'Failed to start auto record',
      status: safeManagerStatus(),
    });
  }
});

app.post('/api/camera/auto-record/stop', async (_req, res) => {
  const manager = resolveAutoRecordManager(res);
  if (!manager) return;
  try {
    const status = await manager.stop('user');
    res.json({ ok: true, status });
  } catch (err) {
    const statusCode = err.status === 409 ? 409 : 200;
    res.status(statusCode).json({
      ok: false,
      error: err.message || 'Failed to stop auto record',
      status: safeManagerStatus(),
    });
  }
});

app.post('/api/session/start', async (req, res) => {
  let options;
  try {
    options = parseSessionOptions(req.body || {});
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ ok: false, error: err.message });
  }

  if (streamingActive) {
    return res.status(409).json({ ok: false, error: 'Camera streaming in progress' });
  }
  if (await isBusy()) {
    return res.status(409).json({ ok: false, error: 'Camera busy' });
  }

  const jobId = buildJobId();
  try {
    const session = await sessionManager.startSession({ jobId, ...options });
    res.json({
      ok: true,
      jobId,
      videoFile: session.videoFile,
      videoUrl: `/uploads/${session.videoFile}`,
      metaPath: session.metaPath,
    });
  } catch (err) {
    const status = err.status || err.httpStatus || 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.post('/api/session/:jobId/stop', async (req, res) => {
  const jobId = req.params.jobId;
  try {
    const session = await sessionManager.stopSession(jobId, 'user');
    res.json({
      ok: true,
      jobId,
      videoUrl: `/uploads/${session.videoFile}`,
      metaPath: session.metaPath,
    });
  } catch (err) {
    const status = err.status || err.httpStatus || 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.get('/api/session/list', async (req, res) => {
  const limit = clamp(parseNonNegativeNumber(req.query.limit, 50), 1, 200);
  const offset = clamp(parseNonNegativeNumber(req.query.offset, 0), 0, 1000);

  try {
    const sessions = await listSessions({ limit, offset });
    res.json({ ok: true, sessions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/session/:jobId/status', (req, res) => {
  const jobId = req.params.jobId;
  const status = sessionManager.getStatus(jobId);
  if (!status) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }
  res.json({ ok: true, jobId, ...status });
});

app.get('/api/session/:jobId/meta', async (req, res) => {
  const jobId = req.params.jobId;
  const metaPath = path.join(SESSION_META_DIR, `${jobId}.meta.json`);
  const metaRawPath = `${metaPath}.raw`;
  const labelMap = parseLabelMap(process.env.SESSION_LABEL_MAP || process.env.HAILO_LABEL_MAP);

  try {
    const targetPath = fs.existsSync(metaPath) ? metaPath : metaRawPath;
    const raw = await fsp.readFile(targetPath, 'utf8');
    let frames = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        frames = parsed;
      } else if (Array.isArray(parsed.frames)) {
        frames = parsed.frames;
      }
    } catch (_) {
      // fall back to best-effort extraction
    }

    if (!frames.length) {
      frames = parseFramesFromText(raw);
    } else {
      frames = frames.map(normalizeFrame);
    }
    frames = applyLabelMap(frames, labelMap).filter((frame) => frame.t !== null || frame.detections.length);
    res.json({ ok: true, jobId, metaPath, frames });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message, metaPath, frames: [] });
  }
});

app.get('/api/session/:jobId/live', async (req, res) => {
  const jobId = req.params.jobId;
  const tailFrames = clamp(
    parseNonNegativeNumber(req.query.tailFrames, 30),
    1,
    SESSION_MAX_TAIL_FRAMES,
  );
  const metaPath = path.join(SESSION_META_DIR, `${jobId}.meta.json`);
  const metaRawPath = `${metaPath}.raw`;
  const tailBytes = Math.min(512 * 1024, Math.max(16 * 1024, tailFrames * 4096));
  const labelMap = parseLabelMap(process.env.SESSION_LABEL_MAP || process.env.HAILO_LABEL_MAP);

  try {
    const targetPath = fs.existsSync(metaPath) ? metaPath : metaRawPath;
    const text = await readTail(targetPath, tailBytes);
    const frames = applyLabelMap(parseTailFrames(text, tailFrames), labelMap);
    res.json({ ok: true, jobId, frames });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, frames: [] });
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
  if (sharedPipeline.isRunning()) {
    return res.status(409).json({ ok: false, error: 'Camera pipeline active' });
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
  if (sharedPipeline.isRunning()) {
    return res.status(409).json({ ok: false, error: 'Camera pipeline active' });
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
    const metaBase = deriveMetaBase(filename);
    const metaPath = path.join(SESSION_META_DIR, `${metaBase}.meta.json`);
    const metaRawPath = `${metaPath}.raw`;

    await ensureSessionDirs();
    await runHailoInferenceOnFile({
      format: options.format,
      inputPath: path.join(UPLOAD_DIR, filename),
      metaRawPath,
      model: 'yolov8s',
      durationSec: options.durationSec,
    });
    await normalizeMetaFile(metaRawPath, metaPath, {
      jobId: metaBase,
      labelMap: parseLabelMap(process.env.SESSION_LABEL_MAP || process.env.HAILO_LABEL_MAP),
    });

    triggerAnalyzeRequest({
      jobId: metaBase,
      filename,
      metaPath,
      force: Boolean(req.body?.force),
    }).catch(() => {});

    res.json({
      ok: true,
      filename,
      url: `/uploads/${filename}`,
      metaPath,
    });
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
  const streamOptions = parseStreamOptions(req.query || {});
  const sourceConfig = sharedPipeline.getConfig() || {
    width: SESSION_DEFAULTS.width,
    height: SESSION_DEFAULTS.height,
    fps: SESSION_DEFAULTS.fps,
  };

  try {
    await sharedPipeline.retain('preview', sourceConfig);
  } catch (err) {
    const status = err.status || 503;
    return res.status(status).json({ ok: false, error: err.message });
  }

  const previewId = ++previewSessionCounter;
  const previewArgs = buildGstShmPreviewArgs({
    socketPath: SHARED_PIPELINE_SOCKET,
    srcWidth: sourceConfig.width,
    srcHeight: sourceConfig.height,
    srcFps: sourceConfig.fps,
    width: streamOptions.width,
    height: streamOptions.height,
    fps: streamOptions.fps,
  });
  const previewProc = spawn(SESSION_GST_CMD, previewArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  previewSessions.set(previewId, { proc: previewProc, res });
  setStreamingState(true, previewSessions.size);

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    Pragma: 'no-cache',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const cleanup = (reason) => {
    if (!previewSessions.has(previewId)) return;
    previewSessions.delete(previewId);
    sharedPipeline.release('preview');
    setStreamingState(previewSessions.size > 0, previewSessions.size);
    log(`MJPEG stream cleanup (${reason})`);
    if (previewProc && previewProc.exitCode === null) {
      previewProc.kill('SIGINT');
    }
    if (!res.writableEnded) {
      res.end();
    }
  };

  previewProc.stdout.on('data', (chunk) => {
    if (!res.writableEnded) {
      res.write(chunk);
    }
  });
  previewProc.stderr.on('data', (data) => {
    log('preview stderr:', data.toString());
  });
  previewProc.on('error', (err) => {
    log('preview process error:', err.message);
    cleanup('preview_error');
  });
  previewProc.on('close', (code, signal) => {
    log('preview process closed', code, signal || '');
    cleanup('preview_close');
  });

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
  if (previewSessions.size > 0) {
    const count = previewSessions.size;
    for (const [id, session] of previewSessions.entries()) {
      if (session && session.proc && session.proc.exitCode === null) {
        session.proc.kill('SIGINT');
      }
      if (session && session.res && !session.res.writableEnded) {
        session.res.end();
      }
      previewSessions.delete(id);
    }
    for (let i = 0; i < count; i += 1) {
      sharedPipeline.release('preview');
    }
    setStreamingState(false, 0);
    return res.json({ ok: true, stopped: true });
  }
  return res.json({ ok: true, stopped: false });
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

function parseLabelMap(raw) {
  if (!raw) return {};
  const trimmed = String(raw).trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    // fall through to simple format
  }
  const map = {};
  trimmed.split(',').forEach((pair) => {
    const [key, value] = pair.split(':').map((part) => part.trim());
    if (!key || !value) return;
    const idx = Number(key);
    if (Number.isFinite(idx)) {
      map[idx] = value;
    }
  });
  return map;
}

function applyLabelMap(frames, labelMap) {
  if (!labelMap || !Object.keys(labelMap).length) return frames;
  return frames.map((frame) => ({
    ...frame,
    detections: (frame.detections || []).map((det) => {
      if (!det) return det;
      if (det.label && det.label !== 'unknown') return det;
      if (det.classId !== null && labelMap[det.classId]) {
        return { ...det, label: labelMap[det.classId] };
      }
      return det;
    }),
  }));
}

function parseSessionOptions(body) {
  const width = parsePositiveNumber(body.width, SESSION_DEFAULTS.width);
  const height = parsePositiveNumber(body.height, SESSION_DEFAULTS.height);
  const fps = parsePositiveNumber(body.fps, SESSION_DEFAULTS.fps);
  const durationSec = parseNonNegativeNumber(body.durationSec, 0);
  const model = (body.model || 'yolov8s').toLowerCase();
  if (model !== 'yolov8s') {
    throw httpError('Invalid model. Use yolov8s', 400);
  }
  return { width, height, fps, durationSec, model };
}

function buildJobId() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`;
  const suffix = Math.random().toString(36).slice(2, 8);
  return `session_${ts}_${suffix}`;
}

function detectRecordEncoder() {
  const candidates = ['avenc_h264_omx', 'openh264enc', 'x264enc', 'v4l2h264enc', 'avenc_h264'];
  for (const candidate of candidates) {
    if (gstElementAvailable(candidate)) {
      log(`Record encoder selected: ${candidate}`);
      return candidate;
    }
  }
  log('No preferred H.264 encoder found; defaulting to openh264enc');
  return 'openh264enc';
}

function gstElementAvailable(element) {
  try {
    const result = spawnSync('gst-inspect-1.0', [element], { stdio: 'ignore' });
    return result.status === 0;
  } catch (err) {
    log('gst-inspect-1.0 unavailable', err.message);
    return false;
  }
}

async function listSessions({ limit, offset }) {
  const entries = await fsp.readdir(SESSION_STATE_DIR, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.session.json')) continue;
    const statePath = path.join(SESSION_STATE_DIR, entry.name);
    try {
      const raw = await fsp.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      const jobId = parsed.jobId || deriveJobIdFromStateFile(entry.name);
      const videoFile = parsed.videoFile || null;
      items.push({
        jobId,
        status: parsed.status || 'unknown',
        startedAt: parsed.startedAt || null,
        stoppedAt: parsed.stoppedAt || null,
        errorMessage: parsed.errorMessage || null,
        videoFile,
        videoUrl: videoFile ? `/uploads/${videoFile}` : null,
        metaPath: parsed.metaPath || null,
      });
    } catch (err) {
      log('Session list parse error', entry.name, err.message);
    }
  }

  items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return items.slice(offset, offset + limit);
}

function deriveJobIdFromStateFile(name) {
  return name.replace(/\.session\.json$/, '');
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

function getFallbackStatus() {
  return {
    enabled: false,
    state: 'failed',
    startedAt: null,
    recordingFilename: null,
    lastError: 'Auto record unavailable',
  };
}

function safeManagerStatus() {
  try {
    return autoRecordManager ? autoRecordManager.getStatus() : getFallbackStatus();
  } catch (err) {
    return getFallbackStatus();
  }
}

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}

function parseNonNegativeNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

async function ensureSessionDirs() {
  await ensureUploadsDir();
  await fsp.mkdir(SESSION_META_DIR, { recursive: true });
}

async function finalizeSessionMeta(session) {
  if (!session || !session.metaRawPath || !session.metaPath) return;
  const labelMap = parseLabelMap(process.env.SESSION_LABEL_MAP || process.env.HAILO_LABEL_MAP);
  try {
    await normalizeMetaFile(session.metaRawPath, session.metaPath, {
      jobId: session.jobId,
      labelMap,
    });
  } catch (err) {
    log('Meta normalization failed', err.message);
  } finally {
    triggerAnalyzeRequest({
      jobId: session.jobId,
      filename: session.videoFile,
      metaPath: session.metaPath,
    }).catch(() => {});
  }
}

async function runHailoInferenceOnFile({ format, inputPath, metaRawPath, model, durationSec }) {
  const gstArgs = buildGstFileArgs({
    format,
    inputPath,
    metaPath: metaRawPath,
    model,
    modelOptions: { hefPath: HAILO_HEF_PATH },
  });
  const timeoutMs = computeAnalyzeTimeout(format, durationSec);
  logCommand(SESSION_GST_CMD, gstArgs);
  const { stdout, stderr } = await runCommand(SESSION_GST_CMD, gstArgs, timeoutMs);
  logOutputs(stdout, stderr);
}

function computeAnalyzeTimeout(format, durationSec) {
  if (format === 'jpg') return 5000;
  const durationMs = Math.max(1, durationSec || 0) * 1000;
  return Math.max(8000, durationMs + COMMAND_GRACE_MS + 4000);
}

function deriveMetaBase(filename) {
  return path.basename(filename).replace(/\.[^.]+$/, '');
}

async function triggerAnalyzeRequest({ jobId, filename, metaPath, force }) {
  if (!ANALYZE_URL) return;
  const payload = {
    jobId,
    filename,
    metaPath,
    force: Boolean(force),
  };
  try {
    const analyzeResp = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!analyzeResp.ok) {
      const data = await analyzeResp.json().catch(() => ({}));
      throw new Error(data.error || `Analyze failed with status ${analyzeResp.status}`);
    }
  } catch (err) {
    log('Analyze trigger failed', err.message);
  }
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

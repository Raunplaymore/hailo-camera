const fs = require('fs');
const fsp = fs.promises;
const { parseFramesFromText } = require('./tailParser');

async function normalizeMetaFile(rawPath, outputPath, options = {}) {
  const raw = await fsp.readFile(rawPath, 'utf8').catch(() => null);
  const frames = raw ? parseFramesFromText(raw) : [];
  const pts = options.sourceTimesMs;
  // Only pair timestamps when every exported buffer has an observed PTS.
  if (Array.isArray(pts) && pts.length === frames.length && pts.every((t, i) =>
    Number.isFinite(t) && t >= 0 && (i === 0 || t > pts[i - 1]))) {
    frames.forEach((frame, index) => { frame.sourceTimeMs = pts[index]; });
  }
  const transformedFrames = applyCoordinateTransform(frames, options.coordinateTransform);
  const mappedFrames = applyLabelMap(
    transformedFrames,
    options.labelMap || {},
    options.allowedLabels,
    options.minConfidenceByLabel,
  ).filter(
    (frame) => frame.t !== null || frame.detections.length,
  );
  const normalizedFrames = normalizeFrameTimes(mappedFrames, options.fps, options.durationMs);
  const inferredDurationMs = inferDurationMs(normalizedFrames, options.fps);
  const payload = {
    jobId: options.jobId || null,
    fps: toPositiveNumber(options.fps),
    width: toPositiveNumber(options.coordinateTransform?.sourceWidth) || toPositiveNumber(options.width),
    height: toPositiveNumber(options.coordinateTransform?.sourceHeight) || toPositiveNumber(options.height),
    durationMs: toPositiveNumber(options.durationMs) || inferredDurationMs,
    frames: normalizedFrames,
  };
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));
  return { framesCount: normalizedFrames.length, durationMs: payload.durationMs || 0 };
}

function normalizeFrameTimes(frames, fps, durationMs) {
  if (frames.length && frames.every((frame) => Number.isFinite(frame.sourceTimeMs))) {
    return frames.map((frame) => ({ ...frame, sourceTimestampMs: frame.t, t: frame.sourceTimeMs }));
  }
  const safeFps = toPositiveNumber(fps);
  const safeDurationMs = toPositiveNumber(durationMs);
  const frameTimes = frames.map((frame) => {
    const rawFrameIndex = frame?.frame;
    const frameIndex = rawFrameIndex === null || rawFrameIndex === undefined ? null : Number(rawFrameIndex);
    return Number.isFinite(frameIndex) && frameIndex >= 0 && safeFps
      ? (frameIndex * 1000) / safeFps
      : null;
  });
  const validFrameTimes = frameTimes.filter(Number.isFinite);
  if (validFrameTimes.length >= 2) {
    const maxFrameTime = Math.max(...validFrameTimes);
    const frameClockFitsVideo = !safeDurationMs || maxFrameTime <= safeDurationMs * 1.12 + 120;
    if (frameClockFitsVideo && maxFrameTime > Math.min(...validFrameTimes)) {
      return frames.map((frame, index) => ({
        ...frame,
        sourceTimestampMs: frame.t === null ? null : Number(frame.t),
        t: frameTimes[index],
      }));
    }
  }
  const expectedFrameCount = safeFps && safeDurationMs ? (safeDurationMs * safeFps) / 1000 : null;
  const frameCountMatchesVideo = expectedFrameCount
    && Math.abs((frames.length - 1) - expectedFrameCount) <= Math.max(2, expectedFrameCount * 0.08);
  const rawTimes = frames
    .map((frame) => Number(frame?.t))
    .filter(Number.isFinite);
  const rawSpanMs = rawTimes.length >= 2 ? Math.max(...rawTimes) - Math.min(...rawTimes) : 0;
  const compressedInferenceClock = safeDurationMs && rawSpanMs > 0 && rawSpanMs < safeDurationMs * 0.75;
  if (!validFrameTimes.length && frameCountMatchesVideo && compressedInferenceClock) {
    return frames.map((frame, index) => ({
      ...frame,
      frame: index,
      inferredFrameIndex: true,
      sourceTimestampMs: frame.t === null ? null : Number(frame.t),
      t: (index * 1000) / safeFps,
    }));
  }
  let baseTime = null;
  for (const frame of frames) {
    if (frame && frame.t !== null && Number.isFinite(Number(frame.t))) {
      baseTime = Number(frame.t);
      break;
    }
  }
  if (baseTime === null) return frames;
  return frames.map((frame) => ({
    ...frame,
    t: frame.t === null ? null : Math.max(0, Number(frame.t) - baseTime),
  }));
}

// Observe buffers after inference: Hailo can omit the final input buffer.
function parseSourceTimes(log) {
  const lines = String(log).split(/\r?\n/).filter((line) =>
    line.includes('GstIdentity:source_timeline: last-message = chain'));
  return lines.map((line) => {
    const match = line.match(/pts: (\d+):(\d+):(\d+\.\d+),/);
    return match ? (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 : null;
  });
}

function inferDurationMs(frames, fps) {
  if (!Array.isArray(frames) || !frames.length) return 0;
  const times = frames.map((frame) => Number(frame.t)).filter(Number.isFinite);
  if (times.length) return Math.max(0, Math.round(Math.max(...times)));
  const safeFps = toPositiveNumber(fps);
  if (!safeFps) return 0;
  return Math.round(((frames.length - 1) * 1000) / safeFps);
}

function applyLabelMap(frames, labelMap, allowedLabels, minConfidenceByLabel) {
  const mapped = (!labelMap || !Object.keys(labelMap).length)
    ? frames
    : frames.map((frame) => ({
        ...frame,
        detections: (frame.detections || []).map((det) => {
          if (det && det.label && det.label !== 'unknown') return det;
          if (det && det.classId !== null && labelMap[det.classId]) {
            return { ...det, label: labelMap[det.classId] };
          }
          return det;
        }),
      }));
  const allowedSet = normalizeAllowedLabels(allowedLabels);
  const thresholdMap = normalizeConfidenceThresholds(minConfidenceByLabel);
  if (!allowedSet && !thresholdMap) return mapped;
  return mapped.map((frame) => ({
    ...frame,
    detections: (frame.detections || []).filter((det) => {
      if (!det || !det.label) return false;
      const label = String(det.label).trim().toLowerCase();
      if (!label || (allowedSet && !allowedSet.has(label))) return false;
      const threshold = thresholdMap?.[label];
      return threshold === undefined || Number(det.conf) >= threshold;
    }),
  }));
}

function applyCoordinateTransform(frames, transform) {
  const normalized = normalizeCoordinateTransform(transform);
  if (!normalized) return frames;
  return frames.map((frame) => ({
    ...frame,
    detections: (frame.detections || [])
      .map((detection) => transformDetection(detection, normalized))
      .filter(Boolean),
  }));
}

function transformDetection(detection, transform) {
  if (!Array.isArray(detection?.bbox) || detection.bbox.length < 4) return detection;
  const [xmin, ymin, width, height] = detection.bbox.map(Number);
  if (![xmin, ymin, width, height].every(Number.isFinite)) return null;
  const left = ((xmin * transform.targetWidth) - transform.padX) / transform.scale;
  const top = ((ymin * transform.targetHeight) - transform.padY) / transform.scale;
  const right = (((xmin + width) * transform.targetWidth) - transform.padX) / transform.scale;
  const bottom = (((ymin + height) * transform.targetHeight) - transform.padY) / transform.scale;
  const clippedLeft = clamp(left, 0, transform.sourceWidth);
  const clippedTop = clamp(top, 0, transform.sourceHeight);
  const clippedRight = clamp(right, 0, transform.sourceWidth);
  const clippedBottom = clamp(bottom, 0, transform.sourceHeight);
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return null;
  return {
    ...detection,
    bbox: [
      clippedLeft / transform.sourceWidth,
      clippedTop / transform.sourceHeight,
      (clippedRight - clippedLeft) / transform.sourceWidth,
      (clippedBottom - clippedTop) / transform.sourceHeight,
    ],
  };
}

function normalizeCoordinateTransform(transform) {
  if (!transform || typeof transform !== 'object') return null;
  const values = ['sourceWidth', 'sourceHeight', 'targetWidth', 'targetHeight', 'scale']
    .map((key) => Number(transform[key]));
  if (!values.every((value) => Number.isFinite(value) && value > 0)) return null;
  const [sourceWidth, sourceHeight, targetWidth, targetHeight, scale] = values;
  const padX = Number(transform.padX);
  const padY = Number(transform.padY);
  if (!Number.isFinite(padX) || !Number.isFinite(padY)) return null;
  return { sourceWidth, sourceHeight, targetWidth, targetHeight, scale, padX, padY };
}

function normalizeConfidenceThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) return null;
  const normalized = {};
  Object.entries(thresholds).forEach(([label, value]) => {
    const key = String(label).trim().toLowerCase();
    const threshold = Number(value);
    if (key && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
      normalized[key] = threshold;
    }
  });
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeAllowedLabels(allowedLabels) {
  if (!allowedLabels) return null;
  if (allowedLabels instanceof Set) return allowedLabels.size ? allowedLabels : null;
  if (!Array.isArray(allowedLabels)) return null;
  const set = new Set();
  allowedLabels.forEach((label) => {
    const value = String(label).trim().toLowerCase();
    if (value) set.add(value);
  });
  return set.size ? set : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

module.exports = {
  normalizeMetaFile,
  normalizeFrameTimes,
  parseSourceTimes,
  applyCoordinateTransform,
  applyLabelMap,
};

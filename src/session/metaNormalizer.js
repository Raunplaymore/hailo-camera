const fs = require('fs');
const fsp = fs.promises;
const { parseFramesFromText } = require('./tailParser');

async function normalizeMetaFile(rawPath, outputPath, options = {}) {
  const raw = await fsp.readFile(rawPath, 'utf8').catch(() => null);
  const frames = raw ? parseFramesFromText(raw) : [];
  const mappedFrames = applyLabelMap(frames, options.labelMap || {}, options.allowedLabels).filter(
    (frame) => frame.t !== null || frame.detections.length,
  );
  const normalizedFrames = normalizeFrameTimes(mappedFrames);
  const inferredDurationMs = inferDurationMs(normalizedFrames, options.fps);
  const payload = {
    jobId: options.jobId || null,
    fps: toPositiveNumber(options.fps),
    width: toPositiveNumber(options.width),
    height: toPositiveNumber(options.height),
    durationMs: toPositiveNumber(options.durationMs) || inferredDurationMs,
    frames: normalizedFrames,
  };
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));
  return { framesCount: normalizedFrames.length, durationMs: payload.durationMs || 0 };
}

function normalizeFrameTimes(frames) {
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

function inferDurationMs(frames, fps) {
  if (!Array.isArray(frames) || !frames.length) return 0;
  const times = frames.map((frame) => Number(frame.t)).filter(Number.isFinite);
  if (times.length) return Math.max(0, Math.round(Math.max(...times)));
  const safeFps = toPositiveNumber(fps);
  if (!safeFps) return 0;
  return Math.round(((frames.length - 1) * 1000) / safeFps);
}

function applyLabelMap(frames, labelMap, allowedLabels) {
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
  if (!allowedSet) return mapped;
  return mapped.map((frame) => ({
    ...frame,
    detections: (frame.detections || []).filter((det) => {
      if (!det || !det.label) return false;
      const label = String(det.label).trim().toLowerCase();
      return label ? allowedSet.has(label) : false;
    }),
  }));
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

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

module.exports = {
  normalizeMetaFile,
};

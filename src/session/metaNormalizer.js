const fs = require('fs');
const fsp = fs.promises;
const { parseFramesFromText } = require('./tailParser');

async function normalizeMetaFile(rawPath, outputPath, options = {}) {
  const raw = await fsp.readFile(rawPath, 'utf8').catch(() => null);
  const frames = raw ? parseFramesFromText(raw) : [];
  const mappedFrames = applyLabelMap(frames, options.labelMap || {}, options.allowedLabels).filter(
    (frame) => frame.t !== null || frame.detections.length,
  );
  const payload = {
    jobId: options.jobId || null,
    frames: mappedFrames,
  };
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));
  return { framesCount: mappedFrames.length };
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

module.exports = {
  normalizeMetaFile,
};

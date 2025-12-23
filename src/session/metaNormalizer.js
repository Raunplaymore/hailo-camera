const fs = require('fs');
const fsp = fs.promises;
const { parseFramesFromText } = require('./tailParser');

async function normalizeMetaFile(rawPath, outputPath, options = {}) {
  const raw = await fsp.readFile(rawPath, 'utf8').catch(() => null);
  const frames = raw ? parseFramesFromText(raw) : [];
  const mappedFrames = applyLabelMap(frames, options.labelMap || {}).filter(
    (frame) => frame.t !== null || frame.detections.length,
  );
  const payload = {
    jobId: options.jobId || null,
    frames: mappedFrames,
  };
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));
  return { framesCount: mappedFrames.length };
}

function applyLabelMap(frames, labelMap) {
  if (!labelMap || !Object.keys(labelMap).length) return frames;
  return frames.map((frame) => ({
    ...frame,
    detections: (frame.detections || []).map((det) => {
      if (det && det.label && det.label !== 'unknown') return det;
      if (det && det.classId !== null && labelMap[det.classId]) {
        return { ...det, label: labelMap[det.classId] };
      }
      return det;
    }),
  }));
}

module.exports = {
  normalizeMetaFile,
};

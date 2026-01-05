const fs = require('fs');
const fsp = fs.promises;

async function readTail(filePath, maxBytes) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return '';
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length <= 0) return '';

  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseTailFrames(text, limit) {
  const frames = [];
  const jsonFrames = extractJsonFrames(text, limit);
  for (const frame of jsonFrames) {
    frames.push(normalizeFrame(frame));
  }
  if (frames.length) {
    return frames.filter((frame) => frame.t !== null || frame.detections.length);
  }

  const lineFrames = parseLineDelimited(text, limit);
  return lineFrames.map(normalizeFrame).filter((frame) => frame.t !== null || frame.detections.length);
}

function parseFramesFromText(text, limit = Infinity) {
  const frames = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          const parsed = safeParse(candidate);
          if (parsed && isLikelyFrame(parsed)) {
            frames.push(normalizeFrame(parsed));
            if (frames.length >= limit) {
              break;
            }
          }
          start = -1;
        }
      }
    }
  }

  return frames;
}

function extractJsonFrames(text, limit) {
  const frames = [];
  let end = text.lastIndexOf('}');
  while (end !== -1 && frames.length < limit * 3) {
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === '}') depth += 1;
      if (ch === '{') {
        depth -= 1;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (start === -1) break;
    const candidate = text.slice(start, end + 1);
    const parsed = safeParse(candidate);
    if (parsed && isLikelyFrame(parsed)) {
      frames.push(parsed);
    }
    end = text.lastIndexOf('}', start - 1);
  }
  return frames.reverse().slice(-limit);
}

function parseLineDelimited(text, limit) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const frames = [];
  for (let i = lines.length - 1; i >= 0 && frames.length < limit; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    const parsed = safeParse(line);
    if (parsed && isLikelyFrame(parsed)) {
      frames.push(parsed);
    }
  }
  return frames.reverse();
}

function safeParse(payload) {
  try {
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
}

function isLikelyFrame(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    obj['timestamp (ms)'] !== undefined ||
    obj.timestamp !== undefined ||
    obj.ts !== undefined ||
    obj.frame_id !== undefined ||
    obj.frame !== undefined ||
    Array.isArray(obj.detections) ||
    Array.isArray(obj.objects)
  );
}

function normalizeFrame(frame) {
  const t = numberOrNull(
    frame.t ?? frame['timestamp (ms)'] ?? frame.timestamp ?? frame.ts ?? frame.timestamp_ms,
  );
  const frameId = numberOrNull(frame.frame_id ?? frame.frame ?? frame.frameId);
  const detectionsRaw = [];
  if (Array.isArray(frame.detections)) detectionsRaw.push(...frame.detections);
  if (Array.isArray(frame.objects)) detectionsRaw.push(...frame.objects);
  if (Array.isArray(frame.boxes)) detectionsRaw.push(...frame.boxes);
  const hailoDetections = extractHailoDetections(frame);
  if (hailoDetections.length) detectionsRaw.push(...hailoDetections);
  const detections = detectionsRaw.map(normalizeDetection).filter(Boolean);
  return {
    t,
    frame: frameId,
    detections,
  };
}

function extractHailoDetections(frame) {
  const roi = frame?.HailoROI || frame?.hailo_roi || null;
  if (!roi) return [];
  const detections = [];
  const stack = [roi];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const det = node.HailoDetection || node.hailo_detection;
    if (det && typeof det === 'object') {
      detections.push({
        label: det.label ?? det.class_name ?? det.name ?? null,
        class_id: det.class_id ?? det.classId ?? det.class_index ?? det.id,
        confidence: det.confidence ?? det.conf ?? det.score ?? det.prob,
        bbox: det.HailoBBox ?? det.hailo_bbox ?? det.bbox ?? det.box ?? det.rect,
      });
      if (Array.isArray(det.SubObjects)) {
        stack.push(...det.SubObjects);
      } else if (Array.isArray(det.sub_objects)) {
        stack.push(...det.sub_objects);
      }
    }
    const sub = node.SubObjects || node.sub_objects;
    if (Array.isArray(sub)) {
      stack.push(...sub);
    }
  }
  return detections;
}

function normalizeDetection(det) {
  if (!det || typeof det !== 'object') return null;
  const label = det.label ?? det.class ?? det.class_name ?? det.name ?? null;
  const classId = numberOrNull(det.class_id ?? det.classId ?? det.id ?? det.class_index);
  const conf = numberOrNull(det.confidence ?? det.conf ?? det.score ?? det.prob);
  const bbox = normalizeBbox(det.bbox ?? det.box ?? det.rect ?? det);
  if (!bbox || conf === null) return null;
  if (label === null && classId === null) return null;
  return {
    label: label || (classId !== null ? 'unknown' : null),
    classId,
    conf,
    bbox,
  };
}

function normalizeBbox(source) {
  if (!source || typeof source !== 'object') return null;
  if (Array.isArray(source) && source.length >= 4) {
    return [
      numberOrNull(source[0]),
      numberOrNull(source[1]),
      numberOrNull(source[2]),
      numberOrNull(source[3]),
    ];
  }
  const xmin = numberOrNull(source.xmin ?? source.x_min ?? source.left ?? source.x);
  const ymin = numberOrNull(source.ymin ?? source.y_min ?? source.top ?? source.y);
  const xmax = numberOrNull(source.xmax ?? source.x_max ?? source.right);
  const ymax = numberOrNull(source.ymax ?? source.y_max ?? source.bottom);
  const width = numberOrNull(source.width ?? source.w);
  const height = numberOrNull(source.height ?? source.h);

  if (xmin !== null && ymin !== null && width !== null && height !== null) {
    return [xmin, ymin, width, height];
  }
  if (xmin !== null && ymin !== null && xmax !== null && ymax !== null) {
    return [xmin, ymin, xmax - xmin, ymax - ymin];
  }
  return null;
}

function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

module.exports = {
  readTail,
  parseTailFrames,
  parseFramesFromText,
  normalizeFrame,
};

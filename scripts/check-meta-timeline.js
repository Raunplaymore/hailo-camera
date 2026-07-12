const assert = require('node:assert/strict');
const { normalizeFrameTimes } = require('../src/session/metaNormalizer');

const frames = Array.from({ length: 95 }, (_, frame) => ({
  frame,
  t: Math.round((frame * 954) / 94),
  detections: [],
}));
const normalized = normalizeFrameTimes(frames, 29.97002997002997, 3197);

assert.equal(Math.round(normalized[94].t), 3136);
assert.equal(normalized[94].sourceTimestampMs, 954);
console.log('meta timeline check passed');

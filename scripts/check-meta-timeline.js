const assert = require('node:assert/strict');
const { normalizeFrameTimes } = require('../src/session/metaNormalizer');

const GOLDEN_JOB = '957e5457-4d13-46bf-88c6-65c467af8487';
const FPS = 29.97002997002997;
const DURATION_MS = 3197;
const frames = Array.from({ length: 95 }, (_, index) => ({
  frame: null,
  t: Math.round((index * 954) / 94),
  detections: [],
}));
const normalized = normalizeFrameTimes(frames, FPS, DURATION_MS);

assert.equal(Math.round(normalized[94].t), 3136);
assert.equal(normalized[94].sourceTimestampMs, 954);
assert.equal(normalized[94].frame, 94);
assert.equal(normalized[94].inferredFrameIndex, true);
for (const [frame, expectedTimeMs] of [[34, 1132], [65, 2164], [73, 2431], [77, 2564]]) {
  assert.ok(
    Math.abs(normalized[frame].t - expectedTimeMs) <= 80,
    `${GOLDEN_JOB}: frame ${frame} must remain on the video timeline`,
  );
}
console.log(`meta timeline check passed (${GOLDEN_JOB})`);

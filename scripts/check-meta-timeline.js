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

(async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { normalizeMetaFile, parseSourceTimes } = require('../src/session/metaNormalizer');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'club-timeline-'));
  try {
    const log = [0, 0.017, 0.051].map(t => `/GstPipeline:p/GstIdentity:source_timeline: last-message = chain (pts: 0:00:${t.toFixed(9)}, duration: none)`).join('\n');
    assert.deepEqual(parseSourceTimes(log), [0, 17, 51]);
    assert.deepEqual(parseSourceTimes(log + '\n/GstIdentity:source_timeline: last-message = chain (pts: none,)'), [0, 17, 51, null]);
    const input = path.join(dir, 'raw.json'), output = path.join(dir, 'meta.json');
    await fs.writeFile(input, JSON.stringify([0, 30, 100].map(t => ({ timestamp: t, detections: [] }))));
    await normalizeMetaFile(input, output, { fps: 60, sourceTimesMs: [0, 17, 51] });
    const meta = JSON.parse(await fs.readFile(output));
    assert.deepEqual(meta.frames.map(f => f.t), [0, 17, 51]);
    assert.deepEqual(meta.frames.map(f => f.sourceTimestampMs), [0, 30, 100]);
    for (const invalid of [[0, 17], [0, null, 51], [0, 0, 51]]) {
      await normalizeMetaFile(input, output, { fps: 60, sourceTimesMs: invalid });
      assert.ok(JSON.parse(await fs.readFile(output)).frames.every(f => f.sourceTimeMs === undefined));
    }
    console.log('source PTS, missing buffer and invalid clock checks passed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch(err => { console.error(err); process.exitCode = 1; });

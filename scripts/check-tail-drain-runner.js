const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { drainTail } = require('../src/session/tailDrain');
const { parseFramesFromText } = require('../src/session/tailParser');

(async () => {
  const source = await fsp.readFile(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('async function runHailoInferenceOnFile(');
  const end = source.indexOf('\nasync function normalizeService7FileInput(', start);
  assert.ok(start >= 0 && end > start);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hailo-tail-runner-'));
  const rawPath = path.join(root, 'output.raw');
  const original = 'previous output';
  let mode = 'success';
  let attempts = [];
  const context = vm.createContext({
    fsp, process, Math, Date, drainTail, parseFramesFromText, SERVICE7_NORMALIZE_TIMEOUT_MS: 120_000,
    SESSION_GST_CMD: 'gst', computeAnalyzeTimeout: () => 30_000,
    log: () => {}, logCommand: () => {}, logOutputs: () => {},
    buildHailoModelOptions: () => ({ inferenceWidth: 640, inferenceHeight: 640 }),
    normalizeService7FileInput: async ({ useTailDrain }) => {
      attempts.push(useTailDrain);
      if (mode === 'normalize-failure' && useTailDrain) {
        const error = new Error('no timestamps'); error.code = 'TAIL_DRAIN_UNAVAILABLE'; throw error;
      }
      if (mode === 'timeout' && useTailDrain) {
        const error = new Error('normalization timeout'); error.code = 'TIMEOUT'; throw error;
      }
      const normalized = path.join(root, `input-${attempts.length}.mkv`);
      await fsp.writeFile(normalized, 'normalized');
      return { path: normalized, coordinateTransform: { sourceWidth: 640 },
        inputTimesMs: [0, 16.667, 33.333], paddedTimesMs: [0, 16.667, 33.333, 50, 66.667, 83.333] };
    },
    buildGstFileArgs: ({ metaPath }) => [metaPath],
    runCommand: async (_command, [output]) => {
      if (mode === 'inference-failure') throw new Error('Hailo unavailable');
      if (output === rawPath) {
        if (mode === 'invalid') assert.equal(await fsp.readFile(rawPath, 'utf8'), original);
        await fsp.writeFile(output, JSON.stringify([{ buffer_offset: 0, 'timestamp (ms)': 0 }]));
        return { stdout: 'baseline', stderr: '' };
      }
      await fsp.writeFile(output, JSON.stringify([0, 1, 2, 3, 4].map(buffer_offset => ({ buffer_offset, 'timestamp (ms)': 0 }))));
      return { stdout: mode === 'invalid' ? 'invalid' : 'valid', stderr: '' };
    },
    parseSourceTimes: (output) => output === 'valid' ? [0, 17, 33, 50, 67] : output === 'invalid' ? [0, null, 33, 50, 67] : [0],
  });
  vm.runInContext(source.slice(start, end), context);
  const run = () => context.runHailoInferenceOnFile({ format: 'mp4', inputPath: 'source.mp4', metaRawPath: rawPath, model: 'test' });
  try {
    await fsp.writeFile(rawPath, original);
    let result = await run();
    assert.deepEqual(Array.from(result.sourceTimesMs), [0, 17, 33]);
    assert.deepEqual(JSON.parse(await fsp.readFile(rawPath)).map(r => r.buffer_offset), [0, 1, 2]);
    assert.deepEqual(attempts, [true]);
    for (mode of ['invalid', 'normalize-failure']) {
      attempts = [];
      await fsp.writeFile(rawPath, original);
      result = await run();
      assert.deepEqual(Array.from(result.sourceTimesMs), [0]);
      assert.deepEqual(attempts, [true, false]);
      assert.deepEqual(JSON.parse(await fsp.readFile(rawPath)).map(r => r.buffer_offset), [0]);
    }
    mode = 'inference-failure'; attempts = [];
    await fsp.writeFile(rawPath, original);
    await assert.rejects(run(), /Hailo unavailable/);
    assert.deepEqual(attempts, [true]);
    assert.equal(await fsp.readFile(rawPath, 'utf8'), original);
    assert.deepEqual((await fsp.readdir(root)).sort(), ['output.raw']);
    mode = 'timeout'; attempts = [];
    await assert.rejects(run(), /normalization timeout/);
    assert.deepEqual(attempts, [true]);
    assert.equal(await fsp.readFile(rawPath, 'utf8'), original);
    mode = 'success'; attempts = [];
    context.fsp = { ...fsp, rename: async () => { throw new Error('atomic publish failed'); } };
    await assert.rejects(run(), /atomic publish failed/);
    assert.equal(await fsp.readFile(rawPath, 'utf8'), original);
    assert.deepEqual((await fsp.readdir(root)).sort(), ['output.raw']);
    context.fsp = fsp;
    console.log('tail drain runner: atomic publish, unverified fallback and error cleanup passed');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

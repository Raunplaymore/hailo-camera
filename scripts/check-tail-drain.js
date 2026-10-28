const assert = require('node:assert/strict');
const { parseShowInfoTimes, drainTail } = require('../src/session/tailDrain');

const lines = (name, times) => times.map((time, i) =>
  `[showinfo@${name} @ 0x123] n: ${i} pts: ${i} pts_time: ${time / 1000}`).join('\n');
const source = [125, 141.667, 158.333];
const padded = [...source, 175, 191.667, 208.333];
const log = `${lines('tail_input', source)}\n${lines('tail_output', padded)}`;
assert.deepEqual(parseShowInfoTimes(log, 'tail_input'), source);
assert.deepEqual(parseShowInfoTimes(log, 'tail_output'), padded);
assert.equal(parseShowInfoTimes(lines('tail_input', [0, 10]).replace('n: 1', 'n: 2'), 'tail_input'), null);
assert.equal(parseShowInfoTimes('', 'tail_input'), null);

const raw = (offsets) => JSON.stringify(offsets.map(buffer_offset => ({ buffer_offset, 'timestamp (ms)': 0 })));
const result = drainTail(raw([0, 1, 2, 3, 4]), [0, 17, 33, 50, 67], source, padded);
assert.deepEqual(result.records.map(r => r.buffer_offset), [0, 1, 2]);
assert.deepEqual(result.sourceTimesMs, [0, 17, 33]);
const missing = drainTail(raw([0, 2, 3, 4]), [0, 33, 50, 67], source, padded);
assert.deepEqual(missing.records.map(r => r.buffer_offset), [0, 2]);
assert.deepEqual(missing.sourceTimesMs, [0, 33]);
for (const args of [
  ['bad json', [0], source, padded],
  [raw([0, 1]), [0], source, padded],
  [raw([0, 1]), [0, null], source, padded],
  [raw([0, 1]), [0, 0], source, padded],
  [raw([0, 1]), [0, 30], source, padded],
  [raw([0, 0]), [0, 17], source, padded],
  [raw([0, 2]), [0, 17], source, padded],
  [raw([3, 4]), [50, 67], source, padded],
  [raw([0, 1]), [0, 17], source, padded.slice(0, -1)],
  [raw([0, 1]), [0, 17], source, [125, 141.667, 158.333, 159, 191.667, 208.333]],
  [raw([0, 1]), [0, 17], [125, 140, 158.333], padded],
]) assert.equal(drainTail(...args), null);
console.log('tail drain: source identity, gaps, duplicates, synthetic exclusion and fallback gates passed');

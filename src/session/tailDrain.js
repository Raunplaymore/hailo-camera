const DRAIN_FRAMES = 3;

function parseShowInfoTimes(log, name) {
  const pattern = new RegExp(`\\[showinfo@${name} @ [^\\]]+\\]\\s+n:\\s*(\\d+)\\s+pts:\\s*-?\\d+\\s+pts_time:\\s*([^\\s]+)`, 'g');
  const times = [];
  for (const match of String(log).matchAll(pattern)) {
    const time = Number(match[2]) * 1000;
    if (Number(match[1]) !== times.length || !Number.isFinite(time)) return null;
    times.push(time);
  }
  return times.length ? times : null;
}

function drainTail(rawText, exportedTimes, inputTimes, paddedTimes) {
  let records;
  try { records = JSON.parse(rawText); } catch { return null; }
  if (!Array.isArray(records) || !Array.isArray(exportedTimes) || records.length !== exportedTimes.length ||
      !Array.isArray(inputTimes) || !inputTimes.length || !Array.isArray(paddedTimes) ||
      paddedTimes.length !== inputTimes.length + DRAIN_FRAMES) return null;
  if (!inputTimes.every((time, i) => Number.isFinite(time) && Number.isFinite(paddedTimes[i]) &&
      Math.abs(time - paddedTimes[i]) < 0.01)) return null;
  // Disjoint tolerance windows prevent an output matching two input frames.
  if (!paddedTimes.every((time, i) => Number.isFinite(time) &&
      (i === 0 || time - paddedTimes[i - 1] > 2.2))) return null;
  const times = paddedTimes.map((time) => time - paddedTimes[0]);
  const retained = [];
  const retainedTimes = [];
  let previous = -1;
  for (let i = 0; i < records.length; i += 1) {
    const time = exportedTimes[i];
    const index = records[i]?.buffer_offset;
    if (!Number.isFinite(time) || time < 0 || !Number.isSafeInteger(index) ||
        index <= previous || index >= times.length || Math.abs(times[index] - time) > 1.1) return null;
    previous = index;
    if (index < inputTimes.length) {
      retained.push(records[i]);
      retainedTimes.push(time);
    }
  }
  return retained.length ? { records: retained, sourceTimesMs: retainedTimes } : null;
}

module.exports = { DRAIN_FRAMES, parseShowInfoTimes, drainTail };

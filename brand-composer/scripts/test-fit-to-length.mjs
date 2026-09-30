// Unit tests for "anpassa till längd". Run: node scripts/test-fit-to-length.mjs
import assert from "node:assert/strict";
import { anchorOffsetInMusic, blockOptions, chooseLengths, fitToLength, regionChunks } from "../src/project/fitToLength.ts";

const timing = { barSeconds: 1.6, beatSeconds: 0.4, anchorBeat: 3 }; // 150 BPM 4/4, logo plopp on beat 3

// Options respect min/max/step.
assert.deepEqual(blockOptions({ section: "a", bars: 8, minBars: 0, maxBars: 16, stepBars: 4 }), [0, 4, 8, 12, 16]);
assert.deepEqual(blockOptions({ section: "a", bars: 4, minBars: 2, stepBars: 2 }), [2, 4]);
assert.deepEqual(blockOptions({ section: "a", bars: 8 }), [8]);

const template = [
  { section: "intro", bars: 4, minBars: 2, stepBars: 2, priority: 3 },
  { section: "a", bars: 8, minBars: 0, maxBars: 16, stepBars: 4, priority: 1 },
  { section: "b", bars: 8, minBars: 4, maxBars: 16, stepBars: 4, priority: 2 },
  { section: "final", bars: 8, minBars: 2, maxBars: 8, stepBars: 2, priority: 4 },
];
const regions = { intro: [1, 4], a: [5, 12], b: [13, 20], final: [49, 56] };

// Exact template length: 28 bars, anchor at beat 3 of bar 28.
{
  const target = anchorOffsetInMusic(28, timing);
  const r = fitToLength(template, target, timing, regions);
  assert.equal(r.totalBars, 28);
  assert.deepEqual(r.lengths, [4, 8, 8, 8]);
  assert.ok(Math.abs(r.musicStartSeconds) < 1e-9);
  assert.ok(Math.abs(r.errorSeconds) < 1e-9);
  assert.deepEqual(r.cues.map((c) => c.bar), [1, 5, 13, 21]);
}

// A 30 s film with the anchor 3 s before the end (27 s): exact sync, music starts later.
{
  const r = fitToLength(template, 27, timing, regions);
  assert.ok(Math.abs(r.errorSeconds) < 1e-9, "anchor exact");
  // Ideal is floor((27-0.8)/1.6)+1 = 17 bars, but these steps only allow even totals -> 16, and the
  // music starts one bar later instead (still exact on the anchor).
  assert.equal(r.totalBars, 16);
  assert.ok(r.musicStartSeconds >= timing.barSeconds && r.musicStartSeconds < 2 * timing.barSeconds, `start ${r.musicStartSeconds}`);
  assert.equal(r.warnings.length, 1);
  // Lowest priority ("a", priority 1) is cut first.
  assert.equal(r.lengths[1], 0, `a dropped: ${r.lengths}`);
  assert.equal(r.lengths[3], 8, "final (priority 4) untouched");
}

// Longer than the template: extend lowest priority first.
{
  const r = fitToLength(template, anchorOffsetInMusic(36, timing), timing, regions);
  assert.equal(r.totalBars, 36);
  assert.equal(r.lengths[1], 16, `a extended: ${r.lengths}`);
  assert.ok(Math.abs(r.errorSeconds) < 1e-9);
}

// Shorter than the minimum: anchor lands late, with a warning.
{
  const r = fitToLength(template, 3, timing, regions);
  assert.equal(r.totalBars, 2 + 0 + 4 + 2);
  assert.equal(r.musicStartSeconds, 0);
  assert.ok(r.errorSeconds > 0);
  assert.equal(r.warnings.length, 1);
}

// keep "end": a shortened section starts later in its source region.
{
  const r = fitToLength(template, anchorOffsetInMusic(26, timing), timing, regions);
  const final = r.cues.find((c) => c.section === "final");
  const len = r.lengths[3];
  assert.equal(final.sourceBar, 56 - len + 1);
  const intro = r.cues.find((c) => c.section === "intro");
  assert.equal(intro.sourceBar, 4 - r.lengths[0] + 1);
}

// Every whole-second target from 12 to 90 s: exact whenever the template allows it.
for (let target = 12; target <= 90; target++) {
  const r = fitToLength(template, target, timing, regions);
  const total = r.cues.length ? r.lengths.reduce((a, b) => a + b, 0) : 0;
  assert.equal(total, r.totalBars);
  if (target >= 13) assert.ok(Math.abs(r.errorSeconds) < 1e-9, `target ${target}`);
  if (r.warnings.length === 0) assert.ok(r.musicStartSeconds <= timing.barSeconds + 1e-9);
}

// Region chunks: shortened, exact and repeated.
assert.deepEqual(regionChunks(1, 4, [5, 12], 9), [{ startBar: 1, sourceBar: 9, bars: 4 }]);
assert.deepEqual(regionChunks(5, 8, [5, 12]), [{ startBar: 5, sourceBar: 5, bars: 8 }]);
assert.deepEqual(regionChunks(1, 12, [5, 12]), [
  { startBar: 1, sourceBar: 5, bars: 8 },
  { startBar: 9, sourceBar: 5, bars: 4 },
]);

// chooseLengths never exceeds the ideal when something fits.
assert.ok(chooseLengths(template, 20).total <= 20);

console.log("fitToLength: all tests passed");

// Unit tests for "anpassa till längd". Run: node scripts/test-fit-to-length.mjs
import assert from "node:assert/strict";
import { anchorOffsetInMusic, blockOptions, chooseLengths, expandLongSections, fitOriginal, fitToLength, regionChunks } from "../src/project/fitToLength.ts";

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

// Shorter than the original: the parts that fit, the next one brought in from its start once half of it fits.
{
  const r = fitToLength(template, 27, timing, regions);
  assert.ok(Math.abs(r.errorSeconds) < 1e-9, "anchor exact");
  assert.equal(r.totalBars, 17);
  assert.deepEqual(r.cues.map((c) => `${c.section}@${c.bar}`), ["intro@1", "a@5", "b@13"]);
  assert.ok(r.musicStartSeconds < timing.barSeconds);
}

// Shorter, but not room for half the next part: the parts that fit are extended instead.
{
  const r = fitToLength(template, anchorOffsetInMusic(15, timing), timing, regions);
  assert.equal(r.totalBars, 15);
  assert.deepEqual(r.lengths, [3, 12, 0, 0], `extended: ${r.lengths}`);
}

// Longer than the template: the extra length is spread over the loopable sections.
{
  const r = fitToLength(template, anchorOffsetInMusic(36, timing), timing, regions);
  assert.equal(r.totalBars, 36);
  assert.deepEqual(r.lengths, [4, 12, 12, 8], `spread: ${r.lengths}`);
  assert.ok(Math.abs(r.errorSeconds) < 1e-9);
}

// Much longer: every loopable section grows, none beyond its max.
{
  const long = [
    { section: "a", bars: 8, minBars: 0, maxBars: 32, stepBars: 4, priority: 1 },
    { section: "b", bars: 8, minBars: 0, maxBars: 32, stepBars: 4, priority: 1 },
    { section: "c", bars: 8, minBars: 0, maxBars: 32, stepBars: 4, priority: 1 },
    { section: "final", bars: 8, minBars: 2, maxBars: 8, stepBars: 2, priority: 5 },
  ];
  const r = fitToLength(long, anchorOffsetInMusic(80, timing), timing);
  assert.equal(r.totalBars, 80);
  assert.deepEqual(r.lengths, [24, 24, 24, 8], `even: ${r.lengths}`);
}

// Every whole-second target from 12 to 90 s: exact whenever the template allows it.
for (let target = 12; target <= 90; target++) {
  const r = fitToLength(template, target, timing, regions);
  const total = r.cues.length ? r.lengths.reduce((a, b) => a + b, 0) : 0;
  assert.equal(total, r.totalBars);
  assert.ok(Math.abs(r.errorSeconds) < 1e-9, `target ${target}`);
  if (r.warnings.length === 0) assert.ok(r.musicStartSeconds <= timing.barSeconds + 1e-9);
}

// Region chunks: shortened, exact and repeated.
assert.deepEqual(regionChunks(1, 4, [5, 12], 9), [{ startBar: 1, sourceBar: 9, bars: 4 }]);
assert.deepEqual(regionChunks(5, 8, [5, 12]), [{ startBar: 5, sourceBar: 5, bars: 8 }]);
// Longer than the region: the extra bars come from its end (not its start again).
assert.deepEqual(regionChunks(1, 12, [5, 12]), [
  { startBar: 1, sourceBar: 5, bars: 8 },
  { startBar: 9, sourceBar: 9, bars: 4 },
]);

// chooseLengths never exceeds the ideal when something fits.
assert.ok(chooseLengths(template, 20).total <= 20);

assert.deepEqual(regionChunks(1, 20, [5, 12]), [
  { startBar: 1, sourceBar: 5, bars: 8 },
  { startBar: 9, sourceBar: 5, bars: 8 },
  { startBar: 17, sourceBar: 9, bars: 4 },
]);

// Original form: sections in order at full length, cut at the end, then repeats from the 2nd section.
{
  const r = fitOriginal(template, anchorOffsetInMusic(10, timing), timing, regions);
  assert.equal(r.totalBars, 10);
  assert.deepEqual(r.cues.map((c) => `${c.section}@${c.bar}`), ["intro@1", "a@5"]);
  const long = fitOriginal(template, anchorOffsetInMusic(40, timing), timing, regions);
  assert.equal(long.totalBars, 40);
  assert.deepEqual(long.cues.map((c) => c.section), ["intro", "a", "b", "final", "a", "b"]);
  assert.ok(Math.abs(long.errorSeconds) < 1e-9);
}

// Too-long sections: loop (auto) or run on into the next parts (original).
{
  const regions = { intro: [1, 4], a: [5, 12], b: [13, 20] };
  const cues = [
    { bar: 1, section: "intro", sourceBar: 1 },
    { bar: 5, section: "a", sourceBar: 5, transition: "crossfade" },
  ];
  // "a" is 20 bars long (8 bars of material).
  const loop = expandLongSections(cues, 24, regions, "loop");
  assert.deepEqual(loop.map((c) => [c.bar, c.section, c.sourceBar]), [[1, "intro", 1], [5, "a", 5], [13, "a", 5], [21, "a", 9]]);
  const cont = expandLongSections(cues, 24, regions, "continue");
  assert.deepEqual(cont.map((c) => [c.bar, c.section, c.sourceBar]), [[1, "intro", 1], [5, "a", 5], [13, "b", 13], [21, "a", 5]]);
  // Nothing too long: unchanged.
  assert.deepEqual(expandLongSections(cues, 12, regions, "loop").map((c) => c.bar), [1, 5]);
}

console.log("fitToLength: all tests passed");

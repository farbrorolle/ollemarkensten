// Unit tests for swell placement. Run: node scripts/test-swell-plan.mjs
import assert from "node:assert/strict";
import { planSwells } from "../src/project/swellPlan.ts";

const events = [
  { start: 3, end: 7, anchorBar: 5 },
  { start: 17, end: 20, anchorBar: 13 },
  { start: 28, end: 30, anchorBar: 20 }, // a mid-section swell (not a section start)
  { start: 27, end: 32, anchorBar: 21 },
];
const sectionStarts = [1, 5, 13, 21];
const bars = (placed) => placed.map((p) => `${p.event.anchorBar}@${p.arrangementBar}`).sort();

// Untouched form (intro 1-4, A 5-12, B 13-20, C 21-28): exactly the original swells.
{
  const chunks = [
    { startBar: 1, sourceBar: 1, bars: 4, isCueStart: true },
    { startBar: 5, sourceBar: 5, bars: 8, isCueStart: true },
    { startBar: 13, sourceBar: 13, bars: 8, isCueStart: true },
    { startBar: 21, sourceBar: 21, bars: 8, isCueStart: true },
  ];
  assert.deepEqual(bars(planSwells(chunks, events, sectionStarts)), ["13@13", "20@20", "21@21", "5@5"]);
}

// A dropped: intro -> B. B has its own lead-in (13), placed at B's new start.
{
  const chunks = [
    { startBar: 1, sourceBar: 1, bars: 4, isCueStart: true },
    { startBar: 5, sourceBar: 13, bars: 8, isCueStart: true },
  ];
  assert.deepEqual(bars(planSwells(chunks, events, sectionStarts)), ["13@5", "20@12"]);
}

// Shortened B keeping its end (source 17-20) after intro: no swell anchored at 17, form changed -> stand-in
// (nearest section-start swell to bar 17: 13 or 21, both 4 away -> the first found, 13).
{
  const chunks = [
    { startBar: 1, sourceBar: 1, bars: 4, isCueStart: true },
    { startBar: 5, sourceBar: 17, bars: 4, isCueStart: true },
  ];
  const placed = planSwells(chunks, events, sectionStarts);
  assert.equal(placed.filter((p) => p.arrangementBar === 5).length, 1);
  assert.ok(bars(placed).includes("20@8"), "interior swell kept");
}

// A section repeated by looping (not a cue start): the lead-in into the region start plays before the repeat.
{
  const chunks = [
    { startBar: 1, sourceBar: 5, bars: 8, isCueStart: true },
    { startBar: 9, sourceBar: 5, bars: 8, isCueStart: false },
  ];
  assert.deepEqual(bars(planSwells(chunks, events, sectionStarts)), ["5@9"]);
}

// The first bar of the music never gets a lead-in.
assert.deepEqual(planSwells([{ startBar: 1, sourceBar: 5, bars: 2, isCueStart: true }], events, sectionStarts), []);

// A loop of the same part gets no lead-in swell.
{
  const events = [{ start: 30, end: 31.6, anchorBar: 21 }];
  const looped = planSwells(
    [
      { startBar: 1, sourceBar: 21, bars: 8, isCueStart: true },
      { startBar: 9, sourceBar: 21, bars: 8, isCueStart: true, isLoop: true },
    ],
    events,
    [21],
  );
  assert.equal(looped.length, 0);
}

console.log("swellPlan: all tests passed");

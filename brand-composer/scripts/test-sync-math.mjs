// Unit tests for the video drift-correction maths. Run: node scripts/test-sync-math.mjs
// (Node 22+ strips TypeScript types natively.)
import assert from "node:assert/strict";
import {
  SYNC_TUNING,
  computePeaks,
  decideCorrection,
  formatFilmTime,
  formatSecondsSv,
  smoothDrift,
} from "../src/video/syncMath.ts";

// Tiny drift: play normally.
assert.deepEqual(decideCorrection(0.01, 0.01, true), { kind: "rate", rate: 1 });

// Video ahead of the music -> slow down; behind -> speed up.
const ahead = decideCorrection(0.05, 0.05, true);
assert.equal(ahead.kind, "rate");
assert.ok(ahead.rate < 1 && ahead.rate >= 1 - SYNC_TUNING.maxRateDeviation, `ahead rate ${ahead.rate}`);
const behind = decideCorrection(-0.05, -0.05, true);
assert.ok(behind.kind === "rate" && behind.rate > 1 && behind.rate <= 1 + SYNC_TUNING.maxRateDeviation);

// Rate change is capped.
const far = decideCorrection(0.15, 0.15, true);
assert.equal(far.kind === "rate" && far.rate, 1 - SYNC_TUNING.maxRateDeviation);

// Big jump (e.g. clicked elsewhere in the timeline) -> seek, unless we just sought.
assert.deepEqual(decideCorrection(1.5, 0, true), { kind: "seek" });
assert.deepEqual(decideCorrection(-0.3, 0, true), { kind: "seek" });
const noSeek = decideCorrection(-0.3, 0, false);
assert.ok(noSeek.kind === "rate" && noSeek.rate === 1 + SYNC_TUNING.maxRateDeviation);

// Closed-loop simulation: a video that starts 150 ms behind and whose clock runs 0.5 % fast
// must converge into the deadband and stay there.
{
  const dt = 1 / 60;
  let expected = 10;
  let video = 10 - 0.15;
  let smoothed = 0;
  let rate = 1;
  let maxLateDrift = 0;
  for (let frame = 0; frame < 60 * 20; frame++) {
    expected += dt;
    video += dt * rate * 1.005;
    const drift = video - expected;
    smoothed = smoothDrift(smoothed, drift);
    const c = decideCorrection(drift, smoothed, false);
    assert.equal(c.kind, "rate");
    rate = c.rate;
    if (frame > 60 * 5) maxLateDrift = Math.max(maxLateDrift, Math.abs(drift));
  }
  assert.ok(maxLateDrift < 0.03, `drift after settling: ${maxLateDrift.toFixed(4)} s`);
  console.log(`simulation: max drift after 5 s = ${(maxLateDrift * 1000).toFixed(1)} ms`);
}

// Peaks.
const data = new Float32Array([0, 0.5, -0.25, 0, 1, -1, 0.1, 0]);
assert.deepEqual(Array.from(computePeaks(data, 2)), [-0.25, 0.5, -1, 1]);

// Formatting.
assert.equal(formatFilmTime(75.34), "1:15.3");
assert.equal(formatFilmTime(3725), "1:02:05.0");
assert.equal(formatSecondsSv(4.25), "4,3");

console.log("syncMath: all tests passed");

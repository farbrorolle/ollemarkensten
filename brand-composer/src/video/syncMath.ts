/**
 * Pure drift-correction maths for keeping a <video> element locked to the
 * audio transport. No DOM or Tone.js imports, so it can be unit-tested in
 * plain Node (see scripts/test-sync-math.mjs).
 *
 * "Drift" is always `video.currentTime - expected`, in seconds: positive
 * means the picture is ahead of the music, negative means it lags behind.
 */

export const SYNC_TUNING = {
  /** Below this (smoothed) drift the video just plays at normal speed. ~half a frame at 25 fps. */
  deadband: 0.02,
  /** At or above this raw drift, a gentle speed change would take too long: jump (seek) instead. */
  hardSeek: 0.2,
  /** Largest speed change used for gentle correction (±10 %). Browsers keep the pitch of the video's own audio. */
  maxRateDeviation: 0.1,
  /** Speed change per second of drift: 0.05 s drift -> 15 % requested (clamped to 10 %). Time constant ~0.33 s. */
  gain: 3,
  /** Never seek more often than this, so a slow decoder can't get stuck in a seek storm. */
  minSeekIntervalSeconds: 0.5,
  /** Exponential smoothing factor for the drift used by the gentle correction (per frame). */
  smoothing: 0.3,
} as const;

export type Correction = { kind: "seek" } | { kind: "rate"; rate: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Decides how to correct the video this frame.
 * - Large drift (e.g. after clicking somewhere else in the timeline): seek.
 * - Small drift: nudge `playbackRate` slightly so the video catches up or
 *   waits, invisibly and without a jump.
 * - Tiny drift: play at normal speed.
 */
export function decideCorrection(rawDrift: number, smoothedDrift: number, canSeek: boolean): Correction {
  const t = SYNC_TUNING;
  if (Math.abs(rawDrift) >= t.hardSeek && canSeek) return { kind: "seek" };
  // Right after a seek we may not seek again yet: correct at full (gentle) strength meanwhile.
  const drift = Math.abs(rawDrift) >= t.hardSeek ? rawDrift : smoothedDrift;
  if (Math.abs(drift) <= t.deadband) return { kind: "rate", rate: 1 };
  return { kind: "rate", rate: 1 - clamp(drift * t.gain, -t.maxRateDeviation, t.maxRateDeviation) };
}

/** One step of exponential smoothing. */
export function smoothDrift(previous: number, raw: number): number {
  return previous + (raw - previous) * SYNC_TUNING.smoothing;
}

/**
 * Min/max peaks of an audio channel in `buckets` equal slices, interleaved
 * as [min0, max0, min1, max1, ...]. Used to draw the film's audio track as a
 * waveform without keeping the whole decoded buffer in memory.
 */
export function computePeaks(data: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets * 2);
  const size = data.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.floor((b + 1) * size));
    let min = 0;
    let max = 0;
    for (let i = start; i < end && i < data.length; i++) {
      const v = data[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

/** "m:ss.t" (or "h:mm:ss.t"), e.g. 75.34 -> "1:15.3". */
export function formatFilmTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const tenths = Math.floor((s * 10) % 10);
  const whole = Math.floor(s);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const mmss = `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(secs).padStart(2, "0")}`;
  return `${mmss}.${tenths}`;
}

/** Seconds with one decimal, e.g. 4.25 -> "4.3". */
export function formatSeconds(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1);
}

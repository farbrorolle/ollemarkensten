/**
 * Finds the last hard cut in a film -- usually where the end card / logo
 * appears -- so the sonic logo's hit can be synced to it automatically.
 *
 * Works entirely in the browser: a hidden <video> is stepped through the
 * last seconds of the film, each frame is drawn small to a canvas, and the
 * frame-to-frame difference in brightness is measured. A cut is a single
 * frame with a difference far above the rest. A second, finer pass pins it
 * to (roughly) the exact frame.
 */

export interface CutResult {
  /** Film seconds of the first frame after the cut. */
  time: number;
  /** How much stronger than a typical frame change (the higher, the clearer the cut). */
  strength: number;
}

const W = 64;
const H = 36;

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = (): void => {
      cleanup();
      resolve();
    };
    const fail = (): void => {
      cleanup();
      reject(new Error("video error"));
    };
    const cleanup = (): void => {
      video.removeEventListener(event, ok);
      video.removeEventListener("error", fail);
    };
    video.addEventListener(event, ok, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
}

async function frameAt(video: HTMLVideoElement, ctx: CanvasRenderingContext2D, t: number): Promise<Float32Array> {
  video.currentTime = t;
  await waitFor(video, "seeked");
  ctx.drawImage(video, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  return lum;
}

function difference(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

async function scan(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  from: number,
  to: number,
  step: number,
): Promise<{ t: number; diff: number; frame: Float32Array }[]> {
  const out: { t: number; diff: number; frame: Float32Array }[] = [];
  let prev = await frameAt(video, ctx, from);
  out.push({ t: from, diff: 0, frame: prev });
  for (let t = from + step; t <= to + 1e-6; t += step) {
    const cur = await frameAt(video, ctx, t);
    out.push({ t, diff: difference(prev, cur), frame: cur });
    prev = cur;
  }
  return out;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Frames apart (at 10 fps) for spotting dissolves: a change that is gradual frame to frame. */
const DISSOLVE_GAP = 6;

/**
 * @param url object URL of the film
 * @param duration film length in seconds
 * @param windowSeconds how far back from the end to look
 */
export async function findLastCut(url: string, duration: number, windowSeconds = 15): Promise<CutResult | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  try {
    await waitFor(video, "loadeddata");
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    // Coarse pass: 10 frames a second over the last seconds (not the very last frame).
    const end = Math.max(0, duration - 0.05);
    const start = Math.max(0, end - windowSeconds);
    const coarse = await scan(video, ctx, start, end, 0.1);
    if (coarse.length < DISSOLVE_GAP + 5) return null;

    // Hard cuts: one frame change far above the typical one.
    const steps = coarse.slice(1).map((c) => c.diff);
    const typicalStep = median(steps);
    const hardThreshold = Math.max(12, typicalStep * 4);
    const hard = new Set<number>();
    coarse.forEach((c, i) => {
      if (i > 0 && c.diff >= hardThreshold) hard.add(i);
    });

    // Dissolves / quick fades (e.g. into a dark end card): small changes frame to frame, but a
    // big change over ~0.6 s. Found as a run where frames 0.6 s apart differ a lot and no hard
    // cut explains it; the transition's middle is taken as the cut.
    const wide = coarse.map((c, i) => (i >= DISSOLVE_GAP ? difference(coarse[i - DISSOLVE_GAP]!.frame, c.frame) : 0));
    const wideThreshold = Math.max(25, median(wide.slice(DISSOLVE_GAP)) * 6);
    type Event = { t: number; strength: number; hardIndex?: number };
    const events: Event[] = [];
    for (const i of hard) events.push({ t: coarse[i]!.t, strength: coarse[i]!.diff / Math.max(1, typicalStep), hardIndex: i });
    for (let i = DISSOLVE_GAP; i < coarse.length; i++) {
      if (wide[i]! < wideThreshold) continue;
      let j = i;
      while (j + 1 < coarse.length && wide[j + 1]! >= wideThreshold) j++;
      let explained = false;
      for (let k = i - DISSOLVE_GAP + 1; k <= j && !explained; k++) explained = hard.has(k);
      if (!explained) {
        let peak = i;
        for (let k = i; k <= j; k++) if (wide[k]! > wide[peak]!) peak = k;
        events.push({ t: coarse[peak]!.t - (DISSOLVE_GAP * 0.1) / 2, strength: wide[peak]! / Math.max(1, median(wide.slice(DISSOLVE_GAP))) });
      }
      i = j;
    }
    if (!events.length) return null;
    // End cards come last: the latest clear change.
    const best = events.reduce((a, b) => (b.t > a.t ? b : a));
    if (best.hardIndex === undefined) return { time: best.t, strength: best.strength };

    // Fine pass around a hard cut: 1/50 s steps over the 0.1 s interval that contained it.
    const fine = await scan(video, ctx, Math.max(0, best.t - 0.12), Math.min(end, best.t + 0.02), 0.02);
    const peak = fine.slice(1).reduce((a, b) => (b.diff > a.diff ? b : a), fine[1] ?? fine[0]!);
    return { time: peak.t, strength: best.strength };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

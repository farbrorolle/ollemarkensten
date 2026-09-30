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
): Promise<{ t: number; diff: number }[]> {
  const out: { t: number; diff: number }[] = [];
  let prev = await frameAt(video, ctx, from);
  for (let t = from + step; t <= to + 1e-6; t += step) {
    const cur = await frameAt(video, ctx, t);
    out.push({ t, diff: difference(prev, cur) });
    prev = cur;
  }
  return out;
}

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
    if (coarse.length < 5) return null;
    const sorted = coarse.map((c) => c.diff).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // The latest strong change (end cards come last): clearly above the typical change.
    const threshold = Math.max(12, median * 4);
    const candidates = coarse.filter((c) => c.diff >= threshold);
    if (!candidates.length) return null;
    const best = candidates[candidates.length - 1]!;

    // Fine pass around it: 1/50 s steps over the 0.1 s interval that contained the cut.
    const fine = await scan(video, ctx, Math.max(0, best.t - 0.12), Math.min(end, best.t + 0.02), 0.02);
    const peak = fine.reduce((a, b) => (b.diff > a.diff ? b : a), fine[0] ?? best);
    return { time: peak.t, strength: best.diff / Math.max(1, median) };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * "Anpassa till längd": computes an arrangement (cue list) from the creator's
 * template + rules so that the sonic logo's anchor (its first "plopp") lands
 * exactly on a requested time in the film.
 *
 * Pure maths, no DOM or Tone.js, so it's unit-tested in plain Node
 * (scripts/test-fit-to-length.mjs).
 *
 * How exact sync works with a fixed tempo: the anchor always lands on beat
 * `anchorBeat` of the arrangement's last bar, so the anchor's position inside
 * the music is (totalBars - 1) bars + (anchorBeat - 1) beats. The music then
 * simply *starts later in the film* (`musicStartSeconds`, 0 up to about one
 * bar) so that position hits the target exactly. When the template's rules
 * can't produce the ideal number of bars, the closest shorter arrangement is
 * used (the music starts a little later still); only if even the shortest
 * allowed arrangement is too long does the anchor miss (a warning says so).
 */

import type { CueConfig, FitBlock, TransitionType } from "./types.ts";

export interface FitTiming {
  barSeconds: number;
  beatSeconds: number;
  /** Beat of the last bar the logo anchor lands on (1-indexed). */
  anchorBeat: number;
}

export interface FitResult {
  cues: CueConfig[];
  /** Arrangement length in bars; the logo anchor is in the last one. */
  totalBars: number;
  /** When bar 1 starts, in film/transport seconds (>= 0). */
  musicStartSeconds: number;
  /** Where the anchor actually lands, in film/transport seconds. */
  anchorSeconds: number;
  /** anchorSeconds - requested target (0 when exact). */
  errorSeconds: number;
  /** Length chosen for each template block (0 = dropped), same order as the template. */
  lengths: number[];
  warnings: string[];
}

/** Seconds from the start of the music to the anchor, for an arrangement of `totalBars`. */
export function anchorOffsetInMusic(totalBars: number, t: FitTiming): number {
  return (totalBars - 1) * t.barSeconds + (t.anchorBeat - 1) * t.beatSeconds;
}

/** The lengths a block may take, from its rules. Always includes its template length. */
export function blockOptions(block: FitBlock): number[] {
  const min = block.minBars ?? block.bars;
  const max = block.maxBars ?? block.bars;
  const step = Math.max(1, block.stepBars ?? 1);
  const options = new Set<number>([block.bars]);
  for (let len = block.bars - step; len >= min && len > 0; len -= step) options.add(len);
  for (let len = block.bars + step; len <= max; len += step) options.add(len);
  if (min === 0) options.add(0);
  return Array.from(options).sort((a, b) => a - b);
}

function changeCost(block: FitBlock, len: number): number {
  const priority = block.priority ?? 1;
  if (len > block.bars) {
    // Extending grows quadratically, so extra length is spread over several sections
    // (A x2 and C x2 rather than A x5) -- more musical than looping one section forever.
    // Divided by the section's own length, so each grows in proportion to its size: a 4-bar
    // break gets about half the extra bars of an 8-bar section. (Priority only decides what
    // gets cut first when shortening.)
    return (len - block.bars) ** 2 / Math.max(1, block.bars);
  }
  // Dropping a section entirely is a bigger musical change than shortening it by the same amount.
  const dropPenalty = len === 0 ? block.bars : 0;
  return (block.bars - len + dropPenalty) * priority;
}

/**
 * Picks one length per block: the longest total that is <= `idealBars`
 * (or the shortest possible total if none is), and among those the one that
 * changes low-priority sections first (smallest priority-weighted change).
 */
export function chooseLengths(template: FitBlock[], idealBars: number): { lengths: number[]; total: number } {
  // DP over totals: best[total] = { cost, lengths }.
  let best = new Map<number, { cost: number; lengths: number[] }>([[0, { cost: 0, lengths: [] }]]);
  for (const block of template) {
    const next = new Map<number, { cost: number; lengths: number[] }>();
    const options = blockOptions(block);
    for (const [total, state] of best) {
      for (const len of options) {
        const t = total + len;
        const cost = state.cost + changeCost(block, len);
        const existing = next.get(t);
        if (!existing || cost < existing.cost) next.set(t, { cost, lengths: [...state.lengths, len] });
      }
    }
    best = next;
  }
  const totals = Array.from(best.keys()).filter((t) => t > 0);
  if (totals.length === 0) throw new Error("The template can't be longer than 0 bars");
  const fitting = totals.filter((t) => t <= idealBars);
  const total = fitting.length ? Math.max(...fitting) : Math.min(...totals);
  return { total, lengths: best.get(total)!.lengths };
}

/**
 * Where to start reading a block's source region: keep the region's start
 * (default for extended blocks) or its end (so a shortened section keeps its
 * lead-in to the next one).
 */
function sourceBarFor(block: FitBlock, len: number, region: [number, number] | undefined): number | undefined {
  if (!region) return undefined;
  const regionBars = region[1] - region[0] + 1;
  const keep = block.keep ?? "end";
  if (keep === "end" && len < regionBars) return region[1] - len + 1;
  return region[0];
}

/**
 * @param targetAnchorSeconds where the logo's anchor should land, in film seconds.
 * @param regions section id -> inclusive source-bar range (long-bounce projects), for `sourceBar`.
 */
export function fitToLength(
  template: FitBlock[],
  targetAnchorSeconds: number,
  timing: FitTiming,
  regions?: Record<string, [number, number]>,
): FitResult {
  const warnings: string[] = [];
  const beforeFirstBar = (timing.anchorBeat - 1) * timing.beatSeconds;
  // Ideal bar count: the most bars whose anchor still fits at or before the target.
  const idealBars = Math.floor((targetAnchorSeconds - beforeFirstBar) / timing.barSeconds + 1e-9) + 1;

  const { lengths, total } = chooseLengths(template, Math.max(0, idealBars));

  const anchorInMusic = anchorOffsetInMusic(total, timing);
  let musicStartSeconds = targetAnchorSeconds - anchorInMusic;
  if (musicStartSeconds < -1e-9) {
    warnings.push("The music can't get this short with these rules – the logo lands later than requested.");
    musicStartSeconds = 0;
  } else if (musicStartSeconds >= timing.barSeconds + 1e-9) {
    warnings.push("The rules can't give exactly the right number of bars – the music starts a little later in the film.");
  }
  musicStartSeconds = Math.max(0, musicStartSeconds);
  const anchorSeconds = musicStartSeconds + anchorInMusic;

  const cues: CueConfig[] = [];
  let bar = 1;
  template.forEach((block, i) => {
    const len = lengths[i]!;
    if (len <= 0) return;
    const cue: CueConfig = { bar, section: block.section, transition: (block.transition ?? "cut") as TransitionType };
    // The music always starts where the track starts (no reverb/delay tails from an earlier bar):
    // the first section reads from its region start whatever its "keep" rule.
    const region = regions?.[block.section];
    const sourceBar = cues.length === 0 && region ? region[0] : sourceBarFor(block, len, region);
    if (sourceBar !== undefined) cue.sourceBar = sourceBar;
    cues.push(cue);
    bar += len;
  });

  return {
    cues,
    totalBars: total,
    musicStartSeconds,
    anchorSeconds,
    errorSeconds: anchorSeconds - targetAnchorSeconds,
    lengths,
    warnings,
  };
}

/** One contiguous piece of source audio to play for a (part of a) section. */
export interface RegionChunk {
  /** Arrangement bar where the chunk starts (1-indexed). */
  startBar: number;
  /** Source-bounce bar it plays from (1-indexed). */
  sourceBar: number;
  bars: number;
}

/**
 * Splits a section of `lengthBars` into source chunks: starts at `sourceBar`
 * (default the region start) and runs on through the region. If it's longer
 * than that, the extra bars are taken from the *end* of the region (whole
 * repeats first, then the last bars again) -- the section keeps moving forward
 * and still ends with its own lead-in to the next section, instead of
 * restarting from its beginning.
 */
export function regionChunks(
  startBar: number,
  lengthBars: number,
  region: [number, number],
  sourceBar?: number,
): RegionChunk[] {
  const [first, last] = region;
  const chunks: RegionChunk[] = [];
  const regionBars = last - first + 1;
  const src = Math.min(Math.max(sourceBar ?? first, first), last);
  const firstBars = Math.min(lengthBars, last - src + 1);
  chunks.push({ startBar, sourceBar: src, bars: firstBars });
  let done = firstBars;
  let remaining = lengthBars - done;
  // Whole repeats, then the remainder from the end of the region.
  while (remaining > regionBars) {
    chunks.push({ startBar: startBar + done, sourceBar: first, bars: regionBars });
    done += regionBars;
    remaining -= regionBars;
  }
  if (remaining > 0) chunks.push({ startBar: startBar + done, sourceBar: last - remaining + 1, bars: remaining });
  return chunks;
}

/**
 * Where a section of `lengthBars` should start reading its region so it ends
 * with the region's own ending (keeps the lead-in to the next section).
 */
export function keepEndSourceBar(region: [number, number], lengthBars: number): number {
  return Math.max(region[0], region[1] - lengthBars + 1);
}

/**
 * "Original form": no re-arranging -- the sections play in their original
 * order at full length and the music is simply cut (or, if longer than the
 * whole track, continues by repeating everything after the first section).
 */
export function fitOriginal(
  template: FitBlock[],
  targetAnchorSeconds: number,
  timing: FitTiming,
  regions?: Record<string, [number, number]>,
): FitResult {
  const beforeFirstBar = (timing.anchorBeat - 1) * timing.beatSeconds;
  const idealBars = Math.max(1, Math.floor((targetAnchorSeconds - beforeFirstBar) / timing.barSeconds + 1e-9) + 1);
  const cues: CueConfig[] = [];
  const lengths = template.map(() => 0);
  let bar = 1;
  let i = 0;
  let guard = 0;
  while (bar <= idealBars && template.length && guard++ < 10000) {
    const block = template[i]!;
    const len = Math.min(block.bars, idealBars - bar + 1);
    const region = regions?.[block.section];
    const cue: CueConfig = { bar, section: block.section, transition: "cut" };
    if (region) cue.sourceBar = region[0];
    cues.push(cue);
    lengths[i]! += len;
    bar += len;
    i = i + 1 < template.length ? i + 1 : Math.min(1, template.length - 1); // after the end: repeat from the 2nd section
  }
  const totalBars = bar - 1;
  const musicStartSeconds = Math.max(0, targetAnchorSeconds - anchorOffsetInMusic(totalBars, timing));
  const anchorSeconds = musicStartSeconds + anchorOffsetInMusic(totalBars, timing);
  return {
    cues,
    totalBars,
    musicStartSeconds,
    anchorSeconds,
    errorSeconds: anchorSeconds - targetAnchorSeconds,
    lengths,
    warnings: [],
  };
}

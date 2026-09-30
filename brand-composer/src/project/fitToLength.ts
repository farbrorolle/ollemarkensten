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

/** A jump in the source (the music doesn't simply continue): the more of these, the less "as composed". */
const JUMP_COST = 6;

interface BlockChoice {
  len: number;
  /** Source bar the block starts reading from (undefined without regions). */
  sourceBar?: number;
  /** Source bar where it ends (for continuity with the next block). */
  sourceEnd?: number;
  /** Jumps inside the block itself (a repeat wraps around). */
  innerJumps: number;
}

/** The ways a block can be played at each allowed length (keep its start or its end when shortened). */
function blockChoices(block: FitBlock, region: [number, number] | undefined, isFirst: boolean): BlockChoice[] {
  const choices: BlockChoice[] = [];
  for (const len of blockOptions(block)) {
    if (len === 0 || !region) {
      choices.push({ len, innerJumps: 0 });
      continue;
    }
    const [first, last] = region;
    const regionBars = last - first + 1;
    if (len >= regionBars) {
      // Full, or longer: runs through, then repeats taken from the end (see regionChunks).
      const repeats = Math.ceil((len - regionBars) / regionBars);
      choices.push({ len, sourceBar: first, sourceEnd: last, innerJumps: repeats });
      continue;
    }
    // Shortened: keep its start (ends early) and/or its end (starts late).
    // The music's first section always starts where the track starts.
    const keeps = isFirst ? ["start"] : block.keep ? [block.keep] : ["end", "start"];
    for (const keep of keeps) {
      choices.push(
        keep === "start"
          ? { len, sourceBar: first, sourceEnd: first + len - 1, innerJumps: 0 }
          : { len, sourceBar: last - len + 1, sourceEnd: last, innerJumps: 0 },
      );
    }
  }
  return choices;
}

/**
 * Picks how to play each block: the longest total that is <= `idealBars`
 * (or the shortest possible total if none is), and among those the most
 * "as composed" one -- inspired by the original form: sections stay whole and
 * in order where possible, low-priority sections are cut first, and every
 * place where the music doesn't simply continue in the source costs extra.
 */
export function chooseArrangement(
  template: FitBlock[],
  idealBars: number,
  regions?: Record<string, [number, number]>,
): { total: number; choices: BlockChoice[] } {
  type State = { cost: number; choices: BlockChoice[]; total: number; lastEnd: number };
  // DP over (total bars, source bar where the music so far ends).
  let best = new Map<string, State>([["0|-1", { cost: 0, choices: [], total: 0, lastEnd: -1 }]]);
  for (const block of template) {
    const next = new Map<string, State>();
    const region = regions?.[block.section];
    for (const state of best.values()) {
      for (const choice of blockChoices(block, region, state.total === 0)) {
        let cost = state.cost + changeCost(block, choice.len) + choice.innerJumps * (JUMP_COST / 2);
        let lastEnd = state.lastEnd;
        if (choice.len > 0) {
          if (regions && state.lastEnd !== -1 && choice.sourceBar !== state.lastEnd + 1) cost += JUMP_COST;
          lastEnd = choice.sourceEnd ?? -1;
        }
        const total = state.total + choice.len;
        const key = `${total}|${lastEnd}`;
        const existing = next.get(key);
        if (!existing || cost < existing.cost) next.set(key, { cost, choices: [...state.choices, choice], total, lastEnd });
      }
    }
    best = next;
  }
  const states = Array.from(best.values()).filter((s) => s.total > 0);
  if (states.length === 0) throw new Error("The template can't be longer than 0 bars");
  const fitting = states.filter((s) => s.total <= idealBars);
  const total = fitting.length ? Math.max(...fitting.map((s) => s.total)) : Math.min(...states.map((s) => s.total));
  const winner = states.filter((s) => s.total === total).reduce((a, b) => (b.cost < a.cost ? b : a));
  return { total, choices: winner.choices };
}

/** Lengths only (for callers/tests that don't care where each block reads from). */
export function chooseLengths(template: FitBlock[], idealBars: number): { lengths: number[]; total: number } {
  const { total, choices } = chooseArrangement(template, idealBars);
  return { total, lengths: choices.map((c) => c.len) };
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

  // Up to the original length, auto arrange behaves exactly like the original form: the track as
  // composed, cut at the end. Longer: every section is extended in proportion to its original
  // length (never shortened), looping on in its own material.
  const originalBars = template.reduce((sum, b) => sum + b.bars, 0);
  if (idealBars <= originalBars) return fitShorter(template, targetAnchorSeconds, timing, regions);
  // (The first section may still be trimmed at its end, to land on the exact bar count.)
  const extendOnly = template.map((b, i) => ({
    ...b,
    minBars: i === 0 ? Math.min(b.bars, b.minBars ?? b.bars) : b.bars,
    maxBars: Math.max(b.bars, b.maxBars ?? b.bars),
  }));
  const { total, choices } = chooseArrangement(extendOnly, Math.max(0, idealBars), regions);
  const lengths = choices.map((c) => c.len);

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
    const sourceBar = choices[i]!.sourceBar;
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

/**
 * Splits every section that is longer than its source material into visible parts:
 * - "loop" (auto arrange): the section repeats -- the whole part again (crossfaded, with its
 *   ring-outs), the last repeat keeping the part's own ending so it still leads into what follows;
 * - "continue" (original form): the music simply runs on into the next part(s) of the track, as
 *   written (after the last part it goes on from the 2nd, like `fitOriginal`).
 */
/** Bars at the end of a part that belong to its ending (fill/lead-in), played only once when it loops. */
const ENDING_BARS = 4;

export function expandLongSections(
  cues: CueConfig[],
  totalBars: number,
  regions: Record<string, [number, number]>,
  mode: "loop" | "continue",
): CueConfig[] {
  const order = Object.entries(regions)
    .sort((a, b) => a[1][0] - b[1][0])
    .map(([id]) => id);
  const out: CueConfig[] = [];
  let bar = 1;
  const push = (cue: CueConfig, bars: number): void => {
    out.push({ ...cue, bar });
    bar += bars;
  };
  cues.forEach((cue, i) => {
    const length = (cues[i + 1]?.bar ?? totalBars + 1) - cue.bar;
    const region = regions[cue.section];
    if (!region || length <= 0) {
      if (length > 0) push(cue, length);
      return;
    }
    const src = Math.min(Math.max(cue.sourceBar ?? region[0], region[0]), region[1]);
    const available = region[1] - src + 1;
    if (length <= available) {
      push(cue, length);
      return;
    }
    if (mode === "loop") {
      // The part's ending (its last phrase: fill/lead-in into the next part) is played only once,
      // at the very end: first the part without its ending, then loops of its body, and the last
      // loop runs out through the ending -- so it still leads nicely into what follows.
      const regionBars = region[1] - region[0] + 1;
      const ending = regionBars >= 16 ? ENDING_BARS : 0;
      const bodyEnd = region[1] - ending; // last bar of the body
      const first = Math.max(1, bodyEnd - src + 1);
      push(cue, first);
      let left = length - first;
      const body = bodyEnd - region[0] + 1;
      while (left > regionBars) {
        push({ bar, section: cue.section, transition: "crossfade", sourceBar: region[0] }, body);
        left -= body;
      }
      if (left > 0) push({ bar, section: cue.section, transition: "crossfade", sourceBar: keepEndSourceBar(region, left) }, left);
      return;
    }
    push(cue, available);
    let left = length - available;
    let index = order.indexOf(cue.section);
    let guard = 0;
    while (left > 0 && guard++ < 1000) {
      index = index + 1 < order.length ? index + 1 : Math.min(1, order.length - 1);
      const section = order[index]!;
      const r = regions[section]!;
      const bars = Math.min(left, r[1] - r[0] + 1);
      push({ bar, section, transition: "cut", sourceBar: r[0] }, bars);
      left -= bars;
    }
  });
  return out;
}


/**
 * Auto arrange up to the original length: the parts that fit whole, in their original order, and
 * those parts *extended* (whole 4-bar phrases, spread in proportion to their length, the most
 * important first) to fill the rest -- instead of cutting the next part off after a bar or two.
 * The next part is only brought in (from its beginning, whole phrases) once at least half of it
 * fits. Odd bars: the first part is trimmed a little, or the music starts up to a bar later.
 */
export function fitShorter(
  template: FitBlock[],
  targetAnchorSeconds: number,
  timing: FitTiming,
  regions?: Record<string, [number, number]>,
): FitResult {
  const beforeFirstBar = (timing.anchorBeat - 1) * timing.beatSeconds;
  const idealBars = Math.max(1, Math.floor((targetAnchorSeconds - beforeFirstBar) / timing.barSeconds + 1e-9) + 1);
  const lengths = template.map(() => 0);
  const trimmedStart = new Set<number>(); // parts played from their beginning (not keeping the end)
  let used = 0;
  let k = 0;
  while (k < template.length && used + template[k]!.bars <= idealBars) {
    lengths[k] = template[k]!.bars;
    used += template[k]!.bars;
    k++;
  }
  if (k === 0) return fitOriginal(template, targetAnchorSeconds, timing, regions);
  let left = idealBars - used;
  const next = template[k];
  if (next && left >= Math.max(4, next.bars / 2)) {
    const len = Math.min(next.bars, left - (left % 4));
    lengths[k] = len;
    trimmedStart.add(k);
    left -= len;
  }
  let phrases = Math.floor(left / 4);
  const odd = left % 4;
  const firstMin = Math.max(2, template[0]!.minBars ?? template[0]!.bars);
  if (odd && trimmedStart.has(k) && lengths[k]! + odd <= next!.bars) {
    // The part cut off at the end simply plays a bar or two further.
    lengths[k]! += odd;
  } else if (odd >= 2 && lengths[0]! - (4 - odd) >= firstMin) {
    lengths[0]! -= 4 - odd;
    phrases += 1;
  }
  // Spread the phrases: always to the part extended least (relative to its length), the most
  // important one first; never the first part, and not past the part's maximum.
  const candidates = template.map((_, i) => i).filter((i) => i > 0 && lengths[i]! > 0 && !trimmedStart.has(i));
  const extension = template.map(() => 0);
  for (let p = 0; p < phrases; p++) {
    let best = -1;
    for (const i of candidates) {
      const block = template[i]!;
      const max = Math.max(block.bars * 2, block.maxBars ?? 0);
      if (lengths[i]! + 4 > max) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const a = extension[i]! / template[i]!.bars;
      const b = extension[best]! / template[best]!.bars;
      if (a < b - 1e-9 || (Math.abs(a - b) < 1e-9 && (template[i]!.priority ?? 1) > (template[best]!.priority ?? 1))) best = i;
    }
    if (best < 0) break; // nothing can take more: the music starts a little later instead
    lengths[best]! += 4;
    extension[best]! += 4;
  }

  const cues: CueConfig[] = [];
  let bar = 1;
  template.forEach((block, i) => {
    const len = lengths[i]!;
    if (len <= 0) return;
    const cue: CueConfig = { bar, section: block.section, transition: i === 0 ? "cut" : ((block.transition ?? "cut") as TransitionType) };
    const region = regions?.[block.section];
    if (region) cue.sourceBar = region[0];
    cues.push(cue);
    bar += len;
  });
  const totalBars = bar - 1;
  const musicStartSeconds = Math.max(0, targetAnchorSeconds - anchorOffsetInMusic(totalBars, timing));
  const anchorSeconds = musicStartSeconds + anchorOffsetInMusic(totalBars, timing);
  const warnings =
    musicStartSeconds > timing.barSeconds + 1e-9 ? ["The music starts a little later in the film, so every part keeps whole phrases."] : [];
  return {
    cues,
    totalBars,
    musicStartSeconds,
    anchorSeconds,
    errorSeconds: anchorSeconds - targetAnchorSeconds,
    lengths,
    warnings,
  };
}

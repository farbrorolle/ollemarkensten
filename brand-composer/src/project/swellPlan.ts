/**
 * Where to play the swell clips ("allt med swell i namnet") in an arrangement.
 *
 * Rule (Olle, 2026-09-30): a swell always starts before a transition and lands
 * on the downbeat of the next section. Wherever the form is untouched, the
 * swells are exactly as in the original bounce.
 *
 * Implemented as: every played stretch of the bounce ("chunk") gets
 *  - its interior swells (anchored inside the stretch), exactly as in the original,
 *  - the swell that originally led into its first bar (its lead-in), and
 *  - if it starts a section after a jump in the source (the form was changed)
 *    and has no lead-in of its own, a stand-in: the swell anchored nearest to
 *    that source bar among the swells that lead into section starts.
 *
 * Pure maths (no Tone.js), unit-tested in scripts/test-swell-plan.mjs.
 */

export interface SwellEvent {
  /** Source seconds (bar 1 of the bounce = 0). */
  start: number;
  end: number;
  /** The source bar whose downbeat this swell leads into. */
  anchorBar: number;
}

export interface PlayedChunk {
  /** Arrangement bar where this stretch starts (1-indexed). */
  startBar: number;
  /** Source bar it plays from. */
  sourceBar: number;
  bars: number;
  /** True when this chunk begins a section (a cue), false for a loop repeat inside one. */
  isCueStart: boolean;
  /** The same part again (a loop): gets no swell leading into it -- it would build up to a new part that doesn't come. */
  isLoop?: boolean;
}

export interface PlacedSwell {
  event: SwellEvent;
  /** Arrangement bar whose downbeat the swell lands on. */
  arrangementBar: number;
}

/**
 * @param sectionStarts source bars where sections begin (region starts), used to pick stand-ins.
 */
export function planSwells(chunks: PlayedChunk[], events: SwellEvent[], sectionStarts: number[]): PlacedSwell[] {
  const placed: PlacedSwell[] = [];
  const starts = new Set(sectionStarts);
  const transitionSwells = events.filter((e) => starts.has(e.anchorBar));

  chunks.forEach((chunk, index) => {
    const first = chunk.sourceBar;
    const last = chunk.sourceBar + chunk.bars - 1;
    const prev = chunks[index - 1];
    const contiguous = !!prev && prev.sourceBar + prev.bars === first;

    // Lead-in into the chunk's first bar (not before the very first bar of the music, and not
    // into a loop of the same part: swells only lead into new parts).
    if (index > 0 && !chunk.isLoop) {
      const own = events.filter((e) => e.anchorBar === first);
      if (own.length) {
        for (const event of own) placed.push({ event, arrangementBar: chunk.startBar });
      } else if (!contiguous && chunk.isCueStart && transitionSwells.length) {
        const nearest = transitionSwells.reduce((best, e) =>
          Math.abs(e.anchorBar - first) < Math.abs(best.anchorBar - first) ? e : best,
        );
        // Every swell anchored at that bar (e.g. synth swell + noise swell) comes along.
        for (const event of transitionSwells.filter((e) => e.anchorBar === nearest.anchorBar)) {
          placed.push({ event, arrangementBar: chunk.startBar });
        }
      }
    }

    // Swells inside the stretch, as in the original.
    for (const event of events) {
      if (event.anchorBar > first && event.anchorBar <= last) {
        placed.push({ event, arrangementBar: chunk.startBar + (event.anchorBar - first) });
      }
    }
  });
  return placed;
}

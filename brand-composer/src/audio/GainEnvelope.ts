import type * as Tone from "tone";

export interface EnvelopePoint {
  /** Transport seconds. */
  t: number;
  v: number;
}

/**
 * A piecewise-linear gain curve on the transport timeline (e.g. a section's
 * fade in/out, or the melody mute before the logo).
 *
 * Unlike Transport.schedule() callbacks -- which only fire when playback
 * passes them -- an envelope is re-applied from wherever playback starts, so
 * it's also correct after clicking somewhere else in the timeline.
 */
export class GainEnvelope {
  readonly param: Tone.Param<"gain">;
  /** Value before the first point. */
  readonly initial: number;
  readonly points: EnvelopePoint[];

  constructor(param: Tone.Param<"gain">, initial: number, points: EnvelopePoint[]) {
    this.param = param;
    this.initial = initial;
    this.points = [...points].sort((a, b) => a.t - b.t);
  }

  valueAt(t: number): number {
    const pts = this.points;
    if (pts.length === 0 || t < pts[0]!.t) return this.initial;
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i]!;
      if (t >= p.t) {
        const next = pts[i + 1];
        if (!next || next.t <= p.t) return p.v;
        return p.v + ((next.v - p.v) * (t - p.t)) / (next.t - p.t);
      }
    }
    return this.initial;
  }

  /** Playback starts at transport position `offset` at context time `time`. */
  applyFrom(time: number, offset: number): void {
    const param = this.param;
    param.cancelScheduledValues(time);
    param.setValueAtTime(this.valueAt(offset), time);
    for (const p of this.points) {
      if (p.t <= offset) continue;
      param.linearRampToValueAtTime(p.v, time + (p.t - offset));
    }
  }

  /** Paused: freeze where it is. */
  hold(time: number): void {
    this.param.cancelScheduledValues(time);
  }

  /** Stopped (rewound to 0). */
  reset(time: number): void {
    this.param.cancelScheduledValues(time);
    this.param.setValueAtTime(this.valueAt(0), time);
  }
}

import * as Tone from "tone";

/**
 * Shared, always-on synthesis nodes that back the "filter-sweep" and "riser"
 * transition types. Built once and reused for every cue (rather than
 * creating/tearing down nodes per transition) since Tone.Noise only ever
 * needs to run continuously behind a closed gain.
 */
export class TransitionFx {
  /** Insert into the master chain (e.g. masterBus -> filter -> limiter). Neutral (wide open) outside a sweep. */
  readonly filter: Tone.Filter;

  private readonly riserNoise: Tone.Noise;
  private readonly riserFilter: Tone.Filter;
  private readonly riserGain: Tone.Gain;

  constructor() {
    this.filter = new Tone.Filter({ type: "lowpass", frequency: 20000, Q: 0.7 });

    this.riserNoise = new Tone.Noise({ type: "white" });
    this.riserFilter = new Tone.Filter({ type: "bandpass", frequency: 200, Q: 1.2 });
    this.riserGain = new Tone.Gain(0);
    this.riserNoise.connect(this.riserFilter);
    this.riserFilter.connect(this.riserGain);
    this.riserNoise.start();
  }

  /** Mixes the riser's output into `destination` (e.g. the master bus channel). */
  connectRiser(destination: Tone.ToneAudioNode): void {
    this.riserGain.connect(destination);
  }

  /** Sweeps the master filter closed over `leadSeconds` then pops back open, landing exactly at `time`. */
  scheduleFilterSweep(time: number, leadSeconds: number): void {
    const freq = this.filter.frequency;
    const start = Math.max(0, time - leadSeconds);
    freq.cancelScheduledValues(start);
    freq.setValueAtTime(20000, start);
    freq.exponentialRampToValueAtTime(300, time);
    freq.setValueAtTime(300, time);
    freq.exponentialRampToValueAtTime(20000, time + 0.15);
  }

  /** Builds a noise riser over `leadSeconds` that peaks exactly at `time`, then cuts. */
  scheduleRiser(time: number, leadSeconds: number): void {
    const start = Math.max(0, time - leadSeconds);
    const gain = this.riserGain.gain;
    const freq = this.riserFilter.frequency;
    gain.cancelScheduledValues(start);
    freq.cancelScheduledValues(start);
    gain.setValueAtTime(0, start);
    gain.linearRampToValueAtTime(0.5, time);
    gain.linearRampToValueAtTime(0, time + 0.12);
    freq.setValueAtTime(200, start);
    freq.exponentialRampToValueAtTime(9000, time);
  }

  dispose(): void {
    this.filter.dispose();
    this.riserNoise.dispose();
    this.riserFilter.dispose();
    this.riserGain.dispose();
  }
}

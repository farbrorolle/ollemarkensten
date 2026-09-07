import * as Tone from "tone";
import type { Track } from "./Track.ts";
import type { SidechainConfig } from "../project/types.ts";

export interface SidechainTarget {
  readonly duckNode: Tone.Gain;
}

export interface SidechainParams {
  /** dBFS level above which ducking kicks in. */
  threshold: number;
  /** Compression ratio applied above the threshold (e.g. 4 = 4:1). */
  ratio: number;
  /** Seconds to duck down when the source crosses the threshold. */
  attack: number;
  /** Seconds to recover back to unity gain once the source drops below it. */
  release: number;
}

/**
 * Real-time sidechain ducking: follows a source track's level with a Tone.Meter
 * and ramps the target's gain down/up accordingly (classic "pumping" effect).
 *
 * Web Audio's DynamicsCompressorNode has no external sidechain input, so this
 * implements the envelope-follower approach instead: read the source's dBFS
 * every animation frame, compute a compressor-style gain reduction above
 * `threshold` at `ratio`, and ramp the target's duck gain toward it using
 * `attack`/`release` as the ramp times.
 */
export class Sidechain {
  readonly id: string;
  params: SidechainParams;

  private readonly meter: Tone.Meter;
  private readonly target: SidechainTarget;
  private currentGain = 1;
  private rafId: number | null = null;

  constructor(id: string, source: Track, target: SidechainTarget, config: SidechainConfig) {
    this.id = id;
    this.target = target;
    this.params = {
      threshold: config.threshold,
      ratio: config.ratio,
      attack: config.attack,
      release: config.release,
    };

    this.meter = new Tone.Meter({ channelCount: 1, normalRange: false, smoothing: 0 });
    source.output.connect(this.meter);

    this.start();
  }

  private start(): void {
    const step = () => {
      const level = this.meter.getValue();
      const db = Array.isArray(level) ? level[0] : level;

      let targetGain = 1;
      if (db > this.params.threshold) {
        const excess = db - this.params.threshold;
        const reductionDb = excess - excess / this.params.ratio;
        targetGain = Tone.dbToGain(-reductionDb);
      }

      if (targetGain !== this.currentGain) {
        const rampTime = targetGain < this.currentGain ? this.params.attack : this.params.release;
        this.target.duckNode.gain.rampTo(targetGain, Math.max(rampTime, 0.001));
        this.currentGain = targetGain;
      }

      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.meter.dispose();
  }
}

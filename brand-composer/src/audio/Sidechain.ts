import * as Tone from "tone";
import type { Track } from "./Track.ts";
import type { SidechainConfig, SidechainCurve } from "../project/types.ts";

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
  /** Maximum reduction in dB. */
  depth: number;
  curve: SidechainCurve;
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
  readonly sourceId: string;
  readonly targetId: string;
  params: SidechainParams;

  private readonly meter: Tone.Meter;
  private readonly target: SidechainTarget;
  private currentGain = 1;
  private rafId: number | null = null;

  constructor(id: string, source: Track, target: SidechainTarget, config: SidechainConfig) {
    this.id = id;
    this.sourceId = config.source;
    this.targetId = config.target;
    this.target = target;
    this.params = {
      threshold: config.threshold,
      ratio: config.ratio,
      attack: config.attack,
      release: config.release,
      depth: config.depth ?? 24,
      curve: config.curve ?? "smooth",
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
        const reductionDb = Math.min(this.params.depth, excess - excess / this.params.ratio);
        targetGain = Tone.dbToGain(-reductionDb);
      }

      if (Math.abs(targetGain - this.currentGain) > 1e-4) {
        const rampTime = Math.max(targetGain < this.currentGain ? this.params.attack : this.params.release, 0.001);
        this.ramp(targetGain, rampTime);
        this.currentGain = targetGain;
      }

      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  private ramp(value: number, seconds: number): void {
    const gain = this.target.duckNode.gain;
    const now = Tone.now();
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    switch (this.params.curve) {
      case "linear":
        gain.linearRampToValueAtTime(value, now + seconds);
        break;
      case "exponential":
        gain.exponentialRampToValueAtTime(Math.max(value, 1e-4), now + seconds);
        break;
      default:
        // RC curve: ~95 % of the way after `seconds`.
        gain.setTargetAtTime(value, now, seconds / 3);
    }
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.meter.dispose();
    const gain = this.target.duckNode.gain;
    gain.cancelScheduledValues(Tone.now());
    gain.value = 1;
  }
}

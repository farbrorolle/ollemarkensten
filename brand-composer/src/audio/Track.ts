import * as Tone from "tone";
import type { TrackConfig } from "../project/types.ts";

/**
 * A single WAV stem. Signal chain:
 * player -> sidechainGain (ducking insert point) -> sectionGain (transition gate) -> channel (volume/pan/mute) -> bus
 *
 * Mute/solo are tracked here as plain booleans; AudioEngine resolves the
 * *effective* mute across all tracks (own mute OR "someone else is soloed")
 * and writes it to `channel.mute`. This deliberately avoids Tone.Channel's
 * built-in solo bus, which is a single global registry shared by every
 * Tone.Channel/Tone.Solo instance in the app -- using it here would also
 * silence the DrumsBus/SynthBus/MasterBus channels whenever a track solos.
 */
export class Track {
  readonly id: string;
  readonly name: string;
  readonly busId: string;

  readonly player: Tone.Player;
  private readonly sidechainGain: Tone.Gain;
  /** Gain gate driven by TransitionManager, scheduled sample-accurately on bar boundaries. */
  readonly sectionGain: Tone.Gain;
  readonly channel: Tone.Channel;

  private _mute: boolean;
  private _solo: boolean;

  constructor(config: TrackConfig) {
    this.id = config.id;
    this.name = config.name;
    this.busId = config.bus ?? "master";

    this.player = new Tone.Player({ loop: true, fadeIn: 0.002, fadeOut: 0.01 });
    this.sidechainGain = new Tone.Gain(1);
    this.sectionGain = new Tone.Gain(1);
    this.channel = new Tone.Channel({
      volume: config.volume ?? 0,
      pan: config.pan ?? 0,
    });

    this.player.connect(this.sidechainGain);
    this.sidechainGain.connect(this.sectionGain);
    this.sectionGain.connect(this.channel);

    this._mute = config.mute ?? false;
    this._solo = config.solo ?? false;
  }

  async load(url: string): Promise<void> {
    await this.player.load(url);
  }

  /** Node a Sidechain instance can duck to affect only this track. */
  get duckNode(): Tone.Gain {
    return this.sidechainGain;
  }

  /** Tap point for a Sidechain source (post-fader signal, safe to fan out to a Meter). */
  get output(): Tone.Channel {
    return this.channel;
  }

  connect(destination: Tone.ToneAudioNode): this {
    this.channel.connect(destination);
    return this;
  }

  /** Starts playback synced to Tone.Transport so every track stays sample-locked. */
  syncToTransport(): void {
    this.player.sync().start(0);
  }

  set volume(db: number) {
    this.channel.volume.value = db;
  }
  get volume(): number {
    return this.channel.volume.value;
  }

  set pan(value: number) {
    this.channel.pan.value = value;
  }
  get pan(): number {
    return this.channel.pan.value;
  }

  set mute(value: boolean) {
    this._mute = value;
  }
  get mute(): boolean {
    return this._mute;
  }

  set solo(value: boolean) {
    this._solo = value;
  }
  get solo(): boolean {
    return this._solo;
  }

  /** Applies this track's effective mute given whether any track in the project is soloed. */
  applySoloState(anySoloed: boolean): void {
    this.channel.mute = this._mute || (anySoloed && !this._solo);
  }

  dispose(): void {
    this.player.dispose();
    this.sidechainGain.dispose();
    this.sectionGain.dispose();
    this.channel.dispose();
  }
}

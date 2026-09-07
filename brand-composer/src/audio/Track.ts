import * as Tone from "tone";
import type { TrackConfig } from "../project/types.ts";

/** Short crossfade between section takes at a cue boundary, so switches never click. */
export const TAKE_FADE_SECONDS = 0.008;

interface SectionTake {
  readonly sectionId: string;
  readonly player: Tone.Player;
  /** Per-take gain, ramped 0<->1 at cue boundaries by ArrangementManager. */
  readonly takeGain: Tone.Gain;
}

/**
 * A single logical stem (e.g. "Bass"). Signal chain:
 * player(s) -> sidechainGain (ducking insert point) -> sectionGain (legacy on/off gate) -> channel (volume/pan/mute) -> bus
 *
 * Two modes, chosen by the project config:
 * - Legacy (`TrackConfig.file`): one continuously-looping Player, gated on/off
 *   per section via `sectionGain` automation (same audio everywhere it's active).
 * - Sectioned (`TrackConfig.sections`): one Player per section, each holding
 *   that section's own audio file. Only the active section's player is ever
 *   started; ArrangementManager schedules each one's start/stop bar range in
 *   advance and they repeat automatically as the transport loops. `takeGain`
 *   gives each a short click-free fade at its cue boundaries.
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
  readonly isSectioned: boolean;

  private readonly legacyPlayer: Tone.Player | null = null;
  private readonly legacyFile: string | null = null;
  private readonly takes = new Map<string, SectionTake>();

  private readonly sidechainGain: Tone.Gain;
  /** Gain gate driven by ArrangementManager for legacy tracks, scheduled sample-accurately on cue bars. */
  readonly sectionGain: Tone.Gain;
  readonly channel: Tone.Channel;

  private _mute: boolean;
  private _solo: boolean;
  private objectUrl: string | null = null;
  /** True once a local file (drag-and-drop / file picker) has replaced the config-provided stem. */
  isLocalFile = false;

  constructor(config: TrackConfig) {
    this.id = config.id;
    this.name = config.name;
    this.busId = config.bus ?? "master";
    this.isSectioned = !!config.sections;

    this.sidechainGain = new Tone.Gain(1);
    this.sectionGain = new Tone.Gain(1);
    this.channel = new Tone.Channel({
      volume: config.volume ?? 0,
      pan: config.pan ?? 0,
    });
    this.sidechainGain.connect(this.sectionGain);
    this.sectionGain.connect(this.channel);

    if (config.sections) {
      for (const [sectionId, file] of Object.entries(config.sections)) {
        const player = new Tone.Player({ loop: true, fadeIn: 0.002, fadeOut: 0.01 });
        const takeGain = new Tone.Gain(0);
        player.connect(takeGain);
        takeGain.connect(this.sidechainGain);
        this.takes.set(sectionId, { sectionId, player, takeGain });
        // stash the file on the take via a side map since Player has no public "pending url"
        pendingFiles.set(player, file);
      }
    } else {
      this.legacyPlayer = new Tone.Player({ loop: true, fadeIn: 0.002, fadeOut: 0.01 });
      this.legacyPlayer.connect(this.sidechainGain);
      this.legacyFile = config.file ?? null;
    }

    this._mute = config.mute ?? false;
    this._solo = config.solo ?? false;
  }

  /** Loads every player this track needs (its single file, or one per section). */
  async load(): Promise<void> {
    if (this.legacyPlayer) {
      if (this.legacyFile) await this.legacyPlayer.load(this.legacyFile);
      return;
    }
    await Promise.all(
      Array.from(this.takes.values()).map(async (take) => {
        const file = pendingFiles.get(take.player);
        if (file) await take.player.load(file);
      }),
    );
  }

  /** Loads a local audio file (from a <input type="file"> or a drag-and-drop) as this track's stem. */
  async loadFromFile(file: File): Promise<void> {
    if (!this.legacyPlayer) throw new Error(`Track "${this.id}" has per-section audio; can't replace it with a single file.`);
    const url = URL.createObjectURL(file);
    await this.legacyPlayer.load(url);
    const previous = this.objectUrl;
    this.objectUrl = url;
    this.isLocalFile = true;
    if (previous) URL.revokeObjectURL(previous);
  }

  /** The player for a given section id, if this is a sectioned track. */
  takeFor(sectionId: string): Tone.Player | undefined {
    return this.takes.get(sectionId)?.player;
  }

  /** The per-take fade gain for a given section id, if this is a sectioned track. */
  takeGainFor(sectionId: string): Tone.Gain | undefined {
    return this.takes.get(sectionId)?.takeGain;
  }

  get sectionIds(): string[] {
    return Array.from(this.takes.keys());
  }

  /** A representative player for waveform display / metering (legacy player, or the first section take). */
  get displayPlayer(): Tone.Player {
    if (this.legacyPlayer) return this.legacyPlayer;
    const first = this.takes.values().next().value as SectionTake | undefined;
    if (!first) throw new Error(`Track "${this.id}" has no audio source`);
    return first.player;
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

  /** Starts the legacy player synced to Tone.Transport (sectioned tracks are started/stopped by ArrangementManager instead). */
  syncToTransport(): void {
    this.legacyPlayer?.sync().start(0);
    for (const take of this.takes.values()) take.player.sync();
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
    this.legacyPlayer?.dispose();
    for (const take of this.takes.values()) {
      take.player.dispose();
      take.takeGain.dispose();
    }
    this.sidechainGain.dispose();
    this.sectionGain.dispose();
    this.channel.dispose();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

const pendingFiles = new WeakMap<Tone.Player, string>();

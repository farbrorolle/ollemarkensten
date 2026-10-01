import * as Tone from "tone";
import type { TrackConfig } from "../project/types.ts";

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
/**
 * How a single-file track is played:
 * - "loop": the original behaviour -- one looping player from bar 1, gated per section.
 * - "region": long-bounce projects -- ArrangementManager plays the right slice of the file for each cue.
 * - "oneshot": the sonic logo -- started once at a computed time.
 */
export type TrackPlayMode = "loop" | "region" | "oneshot";

export class Track {
  readonly id: string;
  readonly name: string;
  readonly busId: string;
  readonly isSectioned: boolean;
  readonly playMode: TrackPlayMode;
  /** Long-bounce projects: the bounce bar at which this (silence-trimmed) file starts. */
  readonly fileStartBar: number;
  readonly isLogo: boolean;
  readonly isSwell: boolean;
  /** Ring-out seconds after each source bar (index 0 = bar 1); empty if not analysed. */
  readonly tails: number[];
  /** Ring-out after each source beat (index 0 = end of beat 1), for the logo's mid-bar hit. */
  readonly beatTails: number[];
  /** Source section start bar -> bars of pickup (upbeat) leading into it. */
  readonly pickups: Record<string, number>;
  readonly swellEvents: { start: number; end: number; anchorBar: number }[];

  private readonly legacyPlayer: Tone.Player | null = null;
  /**
   * Region mode: two "voices" playing the same buffer, used alternately per
   * section so a crossfade can overlap the outgoing and incoming section.
   * Voice 0 is `legacyPlayer`. Each has its own gain, driven by gain envelopes.
   */
  private readonly regionVoices: { player: Tone.Player; gain: Tone.Gain }[] = [];
  /** Region tracks: the normal playback (both voices) goes through this, so a layer can replace it. */
  readonly regionBus: Tone.Gain | null = null;
  /** Region tracks: an extra voice for layer blocks (e.g. the melody played over another part). */
  readonly layerVoice: { player: Tone.Player; gain: Tone.Gain } | null = null;
  private readonly legacyFile: string | null = null;
  private readonly takes = new Map<string, SectionTake>();

  private readonly sidechainGain: Tone.Gain;
  /** Gain gate driven by ArrangementManager for legacy tracks, scheduled sample-accurately on cue bars. */
  readonly sectionGain: Tone.Gain;
  /** Arrangement automation (melody mute / fade into the logo), driven by AudioEngine. */
  readonly autoGain: Tone.Gain;
  /** Volume cue points (the customer's level changes along the timeline). */
  readonly cueGain: Tone.Gain;
  readonly channel: Tone.Channel;

  private _mute: boolean;
  private _solo: boolean;
  private objectUrl: string | null = null;
  /** True once a local file (drag-and-drop / file picker) has replaced the config-provided stem. */
  isLocalFile = false;

  constructor(config: TrackConfig, playMode: TrackPlayMode = "loop") {
    this.id = config.id;
    this.name = config.name;
    this.busId = config.bus ?? "master";
    this.isSectioned = !!config.sections;
    this.playMode = config.sections ? "loop" : playMode;
    this.fileStartBar = config.fileStartBar ?? 1;
    this.isLogo = config.role === "logo";
    this.isSwell = config.role === "swell";
    this.tails = config.tails ?? [];
    this.beatTails = config.beatTails ?? [];
    this.pickups = config.pickups ?? {};
    this.swellEvents = config.swellEvents ?? [];

    this.sidechainGain = new Tone.Gain(1);
    this.sectionGain = new Tone.Gain(1);
    this.autoGain = new Tone.Gain(1);
    this.cueGain = new Tone.Gain(1);
    this.channel = new Tone.Channel({
      volume: config.volume ?? 0,
      pan: config.pan ?? 0,
    });
    this.sidechainGain.connect(this.sectionGain);
    this.sectionGain.connect(this.autoGain);
    this.autoGain.connect(this.cueGain);
    this.cueGain.connect(this.channel);

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
      this.legacyPlayer = new Tone.Player({ loop: this.playMode === "loop", fadeIn: 0.002, fadeOut: 0.01 });
      if (this.playMode === "region") {
        const second = new Tone.Player({ loop: false, fadeIn: 0.002, fadeOut: 0.01 });
        this.regionBus = new Tone.Gain(1);
        this.regionBus.connect(this.sidechainGain);
        for (const player of [this.legacyPlayer, second]) {
          const gain = new Tone.Gain(0);
          player.connect(gain);
          gain.connect(this.regionBus);
          this.regionVoices.push({ player, gain });
        }
        const layerPlayer = new Tone.Player({ loop: false, fadeIn: 0.002, fadeOut: 0.01 });
        const layerGain = new Tone.Gain(0);
        layerPlayer.connect(layerGain);
        layerGain.connect(this.sidechainGain);
        this.layerVoice = { player: layerPlayer, gain: layerGain };
      } else {
        this.legacyPlayer.connect(this.sidechainGain);
      }
      this.legacyFile = config.file ?? null;
    }

    this._mute = config.mute ?? false;
    this._solo = config.solo ?? false;
  }

  /** Loads every player this track needs (its single file, or one per section). */
  async load(): Promise<void> {
    if (this.legacyPlayer) {
      if (this.legacyFile) await this.legacyPlayer.load(this.legacyFile);
      this.shareRegionBuffer();
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
    this.shareRegionBuffer();
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

  /** Region mode: the second voice plays the very same decoded buffer (no extra memory). */
  private shareRegionBuffer(): void {
    const second = this.regionVoices[1];
    if (second && this.legacyPlayer?.loaded) second.player.buffer = this.legacyPlayer.buffer;
    if (this.layerVoice && this.legacyPlayer?.loaded) this.layerVoice.player.buffer = this.legacyPlayer.buffer;
  }

  private swellPeaks = new Map<number, number>();

  /** Peak level (dBFS) of a stretch of this track's file (source seconds), e.g. one swell clip. */
  peakDb(startSeconds: number, endSeconds: number): number {
    const cached = this.swellPeaks.get(startSeconds);
    if (cached !== undefined) return cached;
    const player = this.legacyPlayer;
    if (!player?.loaded) return 0;
    const buffer = player.buffer;
    const sr = buffer.sampleRate;
    const offset = (this.fileStartBar - 1) * (60 / Tone.getTransport().bpm.value) * 4;
    const a = Math.max(0, Math.floor((startSeconds - offset) * sr));
    const b = Math.min(buffer.length, Math.ceil((endSeconds - offset) * sr));
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(data[i]!));
    }
    const db = 20 * Math.log10(peak + 1e-9);
    this.swellPeaks.set(startSeconds, db);
    return db;
  }

  /** Region mode: voice `i` (0 or 1) -- its player and its gain. */
  regionVoice(i: number): { player: Tone.Player; gain: Tone.Gain } | undefined {
    return this.regionVoices[i];
  }

  /** The single-file player (loop/region/oneshot tracks), or null for per-section tracks. */
  get filePlayer(): Tone.Player | null {
    return this.legacyPlayer;
  }

  get sectionIds(): string[] {
    return Array.from(this.takes.keys());
  }

  /**
   * Clears every section-take player's recorded start/stop state and resets
   * its fade gain to silent. Call before re-scheduling a changed arrangement
   * (ArrangementManager.schedule only ever *adds* start/stop points; without
   * this, an edited arrangement would pile new ones on top of stale old ones).
   */
  resyncSectionTakes(): void {
    if (this.legacyPlayer && this.playMode !== "loop") this.legacyPlayer.unsync().sync();
    for (const voice of this.regionVoices.slice(1)) voice.player.unsync().sync();
    this.layerVoice?.player.unsync().sync();
    for (const take of this.takes.values()) {
      take.player.unsync().sync();
      take.takeGain.gain.cancelScheduledValues(0);
      take.takeGain.gain.value = 0;
    }
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
    if (this.playMode === "loop") this.legacyPlayer?.sync().start(0);
    else this.legacyPlayer?.sync(); // started per cue by ArrangementManager / AudioEngine
    for (const voice of this.regionVoices.slice(1)) voice.player.sync();
    this.layerVoice?.player.sync();
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
    for (const voice of this.regionVoices) {
      if (voice.player !== this.legacyPlayer) voice.player.dispose();
      voice.gain.dispose();
    }
    for (const take of this.takes.values()) {
      take.player.dispose();
      take.takeGain.dispose();
    }
    this.layerVoice?.player.dispose();
    this.layerVoice?.gain.dispose();
    this.regionBus?.dispose();
    this.sidechainGain.dispose();
    this.sectionGain.dispose();
    this.autoGain.dispose();
    this.cueGain.dispose();
    this.channel.dispose();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

const pendingFiles = new WeakMap<Tone.Player, string>();

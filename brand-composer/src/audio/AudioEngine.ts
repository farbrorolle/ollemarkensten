import * as Tone from "tone";
import { Bus } from "./Bus.ts";
import { Track } from "./Track.ts";
import type { TrackPlayMode } from "./Track.ts";
import { Sidechain } from "./Sidechain.ts";
import type { SidechainTarget } from "./Sidechain.ts";
import { ArrangementManager } from "./ArrangementManager.ts";
import { GainEnvelope } from "./GainEnvelope.ts";
import { LoudnessMeter } from "./LoudnessMeter.ts";
import type { EnvelopePoint } from "./GainEnvelope.ts";
import { reencodeBlobAsWav } from "./wav.ts";
import type {
  CompressorSettings,
  CueConfig,
  FitConfig,
  LogoConfig,
  ProjectConfig,
  SectionConfig,
  SidechainConfig,
  TransitionType,
} from "../project/types.ts";
import { fitOriginal, fitToLength } from "../project/fitToLength.ts";
import type { FitResult } from "../project/fitToLength.ts";

const MUTE_RAMP_SECONDS = 0.03;

/** Old configs used "riser"/"filter-sweep" (removed): they become a crossfade. */
function normalizeTransition(t: string | undefined): TransitionType {
  return t === "cut" ? "cut" : "crossfade";
}

export const DEFAULT_COMPRESSOR: CompressorSettings = {
  enabled: false,
  threshold: -18,
  ratio: 2,
  attack: 0.01,
  release: 0.2,
  knee: 6,
};

/**
 * Owns Tone.Transport, the MasterBus (-> bus compressor -> Limiter -> speakers)
 * and every Track/Bus/Sidechain in the currently loaded project.
 */
export class AudioEngine {
  readonly masterBus: Bus;
  readonly compressor: Tone.Compressor;
  /** Gain into the limiter ("drive"): push the mix harder into the limiter. */
  readonly limiterDrive: Tone.Gain;
  readonly limiter: Tone.Limiter;
  readonly loudness: LoudnessMeter;
  private compressorSettings: CompressorSettings = { ...DEFAULT_COMPRESSOR };

  readonly buses = new Map<string, Bus>();
  readonly tracks = new Map<string, Track>();
  readonly sidechains = new Map<string, Sidechain>();
  readonly arrangement = new ArrangementManager();

  private projectTitle = "";
  private sectionsById = new Map<string, SectionConfig>();
  /** "Film mode": a video is loaded, so the song plays once from bar 1 and stops at the arrangement's end instead of looping. */
  private filmMode = false;
  private endEventId: number | null = null;

  private regions: Record<string, [number, number]> | undefined;
  private fitConfig: FitConfig | undefined;
  private logoConfig: LogoConfig | undefined;
  private logoTrack: Track | null = null;
  /** Seek-safe gain curves: section voices (regions) + melody mute / fade into the logo. */
  private envelopes: GainEnvelope[] = [];
  private _lastFit: FitResult | null = null;
  /** "auto": re-arrange sections to fit; "original": play the track as written, cut/extended at the end. */
  private _arrangeMode: "auto" | "original" = "auto";
  private readonly arrangementListeners = new Set<() => void>();

  constructor() {
    this.masterBus = new Bus("master", "MasterBus");
    this.limiter = new Tone.Limiter(-1);
    this.compressor = new Tone.Compressor();
    this.applyCompressor();

    this.limiterDrive = new Tone.Gain(1);
    this.masterBus.connect(this.compressor);
    this.compressor.connect(this.limiterDrive);
    this.limiterDrive.connect(this.limiter);
    this.limiter.connect(Tone.getDestination());
    this.loudness = new LoudnessMeter(this.limiter);

    Tone.getTransport().bpm.value = 120;

    // Gain envelopes are written straight onto their gains from wherever playback starts,
    // so they're also right after a seek.
    const transport = Tone.getTransport();
    transport.on("start", (time, offset) => {
      this.envelopes.forEach((e) => e.applyFrom(time, offset ?? 0));
      if ((offset ?? 0) < 0.05) this.loudness.reset(); // integrated LUFS: from the top of each play-through
    });
    transport.on("loopStart", (time, offset) => this.envelopes.forEach((e) => e.applyFrom(time, offset ?? 0)));
    transport.on("stop", (time) => this.envelopes.forEach((e) => e.reset(time)));
    transport.on("pause", (time) => this.envelopes.forEach((e) => e.hold(time)));
  }

  // --- Master bus compressor -------------------------------------------------------------------

  get compressorState(): CompressorSettings {
    return { ...this.compressorSettings };
  }

  setCompressor(settings: Partial<CompressorSettings>): void {
    this.compressorSettings = { ...this.compressorSettings, ...settings };
    this.applyCompressor();
  }

  /** "Off" = ratio 1 (no gain change), so the chain never has to be re-wired. */
  private applyCompressor(): void {
    const c = this.compressorSettings;
    this.compressor.threshold.value = c.threshold;
    this.compressor.ratio.value = c.enabled ? Math.max(1, c.ratio) : 1;
    this.compressor.attack.value = c.attack;
    this.compressor.release.value = c.release;
    this.compressor.knee.value = c.knee;
  }

  /** Current gain reduction of the bus compressor, in dB (0 = none, negative = reducing). */
  get compressorReduction(): number {
    return this.compressor.reduction;
  }

  // --- Sidechains ------------------------------------------------------------------------------

  /** Everything a sidechain can duck: tracks (mapps) and buses. */
  get sidechainTargets(): { id: string; name: string }[] {
    return [
      ...Array.from(this.tracks.values())
        .filter((t) => !t.isLogo)
        .map((t) => ({ id: t.id, name: t.name })),
      ...Array.from(this.buses.values()).map((b) => ({ id: b.id, name: `Bus: ${b.name}` })),
    ];
  }

  addSidechain(config: SidechainConfig): Sidechain {
    const source = this.tracks.get(config.source);
    if (!source) throw new Error(`Sidechain "${config.id}" references unknown source "${config.source}"`);
    this.sidechains.get(config.id)?.dispose();
    const sidechain = new Sidechain(config.id, source, this.resolveSidechainTarget(config.target), config);
    this.sidechains.set(config.id, sidechain);
    return sidechain;
  }

  removeSidechain(id: string): void {
    this.sidechains.get(id)?.dispose();
    this.sidechains.delete(id);
  }

  get title(): string {
    return this.projectTitle;
  }

  /** Must be called from a user gesture (e.g. a click handler) before any playback. */
  async unlockAudio(): Promise<void> {
    await Tone.start();
  }

  play(): void {
    Tone.getTransport().start();
  }

  pause(): void {
    Tone.getTransport().pause();
  }

  stop(): void {
    Tone.getTransport().stop();
  }

  setBpm(bpm: number): void {
    Tone.getTransport().bpm.value = bpm;
  }

  get bpm(): number {
    return Tone.getTransport().bpm.value;
  }

  /**
   * Where playback ends, in transport (= film) seconds: the end of the last
   * bar, or the end of the logo if it rings on longer. 0 if there's no arrangement.
   */
  get arrangementSeconds(): number {
    const bars = this.arrangement.totalBars;
    if (!bars) return 0;
    const musicEnd = this.arrangement.barStartSeconds(bars + 1);
    return Math.max(musicEnd, this.logoEndSeconds ?? 0);
  }

  get barSeconds(): number {
    return Tone.Time("1m").toSeconds();
  }

  get beatSeconds(): number {
    return Tone.Time("4n").toSeconds();
  }

  /** Transport seconds at which arrangement bar `bar` starts (bar 1 = musicStartSeconds). */
  barStartSeconds(bar: number): number {
    return this.arrangement.barStartSeconds(bar);
  }

  /** Called after every (re-)scheduled arrangement: hand edits, fit-to-length, film changes. */
  onArrangementChange(listener: () => void): void {
    this.arrangementListeners.add(listener);
  }

  /** Long-bounce projects: the inclusive source-bar range of a section. */
  sourceRegionFor(sectionId: string): [number, number] | undefined {
    return this.regions?.[sectionId];
  }

  get musicStartSeconds(): number {
    return this.arrangement.musicStartSeconds;
  }

  // --- Sonic logo ---------------------------------------------------------------------------

  get hasLogo(): boolean {
    return !!this.logoConfig && !!this.logoTrack;
  }

  get logo(): Track | null {
    return this.logoTrack;
  }

  get logoSettings(): LogoConfig | undefined {
    return this.logoConfig;
  }

  /** The logo's anchor ("plopp") in transport seconds: beat `anchorBeat` of the last bar. */
  get logoAnchorSeconds(): number | null {
    const bars = this.arrangement.totalBars;
    if (!this.logoConfig || !bars) return null;
    return this.arrangement.barStartSeconds(bars) + (this.logoConfig.anchorBeat - 1) * this.beatSeconds;
  }

  get logoStartSeconds(): number | null {
    const anchor = this.logoAnchorSeconds;
    return anchor === null ? null : anchor - this.logoConfig!.anchorSeconds;
  }

  get logoDurationSeconds(): number {
    const player = this.logoTrack?.filePlayer;
    return player?.loaded ? player.buffer.duration : 0;
  }

  get logoEndSeconds(): number | null {
    const start = this.logoStartSeconds;
    return start === null ? null : start + this.logoDurationSeconds;
  }

  /** Where the anchor should go so the logo ends exactly when a film of `filmSeconds` ends. */
  defaultAnchorForFilm(filmSeconds: number): number {
    if (!this.logoConfig) return filmSeconds;
    return filmSeconds - (this.logoDurationSeconds - this.logoConfig.anchorSeconds);
  }

  get canFit(): boolean {
    return !!this.fitConfig && this.hasLogo;
  }

  get arrangeMode(): "auto" | "original" {
    return this._arrangeMode;
  }

  /** Switches between auto arrange and original form, keeping the logo where it is. */
  setArrangeMode(mode: "auto" | "original"): void {
    if (mode === this._arrangeMode) return;
    this._arrangeMode = mode;
    const anchor = this.logoAnchorSeconds;
    if (anchor !== null && this.canFit) this.fitToAnchor(anchor);
  }

  /** Result of the most recent fitToAnchor(), or null if the arrangement was edited by hand since. */
  get lastFit(): FitResult | null {
    return this._lastFit;
  }

  /**
   * "Anpassa till längd": rebuilds the arrangement from the creator's rules
   * so the logo's anchor lands on `anchorSeconds` (film time).
   */
  fitToAnchor(anchorSeconds: number): FitResult {
    if (!this.fitConfig || !this.logoConfig) throw new Error("This project has no fit-to-length rules");
    const fit = this._arrangeMode === "original" ? fitOriginal : fitToLength;
    const result = fit(
      this.fitConfig.template,
      anchorSeconds,
      { barSeconds: this.barSeconds, beatSeconds: this.beatSeconds, anchorBeat: this.logoConfig.anchorBeat },
      this.regions,
    );
    this.applyArrangement(result.cues, result.totalBars, result.musicStartSeconds, result);
    return result;
  }

  /**
   * Transport position (seconds) of the audio actually coming out of the
   * speakers right now. `Tone.Transport.seconds` runs ahead of what is heard
   * by the context's lookAhead (~0.1 s) plus the device output latency, so
   * anything that must line up with the *audible* music -- the video -- uses
   * this instead.
   */
  get audibleSeconds(): number {
    const context = Tone.getContext();
    const raw = context.rawContext as unknown as { outputLatency?: number; baseLatency?: number };
    const latency = raw.outputLatency || raw.baseLatency || 0;
    return Tone.getTransport().getSecondsAtTime(Math.max(0, context.currentTime - latency));
  }

  /**
   * Film mode on: the transport stops looping and instead stops (and rewinds)
   * by itself at the end of the arrangement, so the music plays through once
   * alongside the video. Film mode off restores the normal looping behaviour.
   */
  setFilmMode(on: boolean): void {
    this.filmMode = on;
    this.applyPlaybackMode();
  }

  get isFilmMode(): boolean {
    return this.filmMode;
  }

  private applyPlaybackMode(): void {
    const transport = Tone.getTransport();
    if (this.endEventId !== null) {
      transport.clear(this.endEventId);
      this.endEventId = null;
    }
    const bars = this.arrangement.totalBars;
    if (!bars) return;
    // With a film or a logo the song plays once (the logo can't loop); otherwise it loops like before.
    const once = this.filmMode || this.hasLogo;
    transport.loop = !once;
    if (once) this.endEventId = transport.schedule((time) => transport.stop(time), this.arrangementSeconds);
  }

  setMasterGain(db: number): void {
    this.masterBus.volume = db;
  }

  get masterGain(): number {
    return this.masterBus.volume;
  }

  /** dB of gain into the limiter. */
  setLimiterDrive(db: number): void {
    this.limiterDrive.gain.value = Tone.dbToGain(db);
  }

  get limiterDriveDb(): number {
    return Tone.gainToDb(this.limiterDrive.gain.value);
  }

  setLimiterThreshold(db: number): void {
    this.limiter.threshold.value = db;
  }

  get limiterThreshold(): number {
    return this.limiter.threshold.value;
  }

  /** Current gain reduction the limiter is applying, in dB (0 = no limiting). */
  get limiterReduction(): number {
    return this.limiter.reduction;
  }

  /** Resolves a bus or track id (or "master") to something a Sidechain can duck. */
  private resolveSidechainTarget(id: string): SidechainTarget {
    if (id === "master") return this.masterBus;
    return this.buses.get(id) ?? this.tracks.get(id) ?? this.throwUnknown(id);
  }

  private throwUnknown(id: string): never {
    throw new Error(`Unknown bus/track id: ${id}`);
  }

  /** Recomputes effective mute (own mute OR "someone else is soloed") across all tracks. */
  refreshSoloState(): void {
    const anySoloed = Array.from(this.tracks.values()).some((t) => t.solo);
    for (const track of this.tracks.values()) track.applySoloState(anySoloed);
  }

  /** Tears down any previously loaded project so a new one can be loaded cleanly. */
  private clearProject(): void {
    for (const sc of this.sidechains.values()) sc.dispose();
    this.sidechains.clear();
    for (const track of this.tracks.values()) track.dispose();
    this.tracks.clear();
    for (const bus of this.buses.values()) bus.dispose();
    this.buses.clear();
    Tone.getTransport().cancel(0);
    this.endEventId = null;
    this.envelopes = [];
    this.logoTrack = null;
  }

  /**
   * Loads a full project from JSON metadata: sets BPM to match the Logic Pro
   * bounce (no time-stretching needed), builds the bus graph, loads every WAV
   * stem, wires sidechains, and registers arrangement sections.
   */
  async loadProjectFromConfig(config: ProjectConfig): Promise<void> {
    this.clearProject();

    this.projectTitle = config.title;
    this.setBpm(config.bpm);
    const [num, den] = config.timeSignature ?? [4, 4];
    Tone.getTransport().timeSignature = [num, den];

    // Buses: create them all first, then wire parent routing (parents may be declared in any order).
    for (const busConfig of config.buses ?? []) {
      const bus = new Bus(busConfig.id, busConfig.name);
      bus.volume = busConfig.volume ?? 0;
      bus.pan = busConfig.pan ?? 0;
      this.buses.set(bus.id, bus);
    }
    for (const busConfig of config.buses ?? []) {
      const bus = this.buses.get(busConfig.id)!;
      const parentId = busConfig.parent ?? "master";
      const parent = parentId === "master" ? this.masterBus : this.buses.get(parentId);
      if (!parent) throw new Error(`Bus "${busConfig.id}" has unknown parent "${parentId}"`);
      bus.connect(parent.input);
    }

    // Tracks: create + route, then load audio for all of them in parallel.
    for (const trackConfig of config.tracks) {
      const mode: TrackPlayMode =
        trackConfig.role === "logo" ? "oneshot" : config.sourceRegions && trackConfig.file ? "region" : "loop";
      const track = new Track(trackConfig, mode);
      const destBus = trackConfig.bus && trackConfig.bus !== "master" ? this.buses.get(trackConfig.bus) : this.masterBus;
      if (!destBus) throw new Error(`Track "${trackConfig.id}" references unknown bus "${trackConfig.bus}"`);
      track.connect(destBus.input);
      this.tracks.set(track.id, track);
    }
    await Promise.all(config.tracks.map((trackConfig) => this.tracks.get(trackConfig.id)!.load()));

    // Start every player synced to the transport so they all stay phase-locked.
    for (const track of this.tracks.values()) track.syncToTransport();
    this.refreshSoloState();

    // Sidechains.
    for (const scConfig of config.sidechains ?? []) this.addSidechain(scConfig);

    // Master chain settings (creator view).
    if (config.master?.gain !== undefined) this.setMasterGain(config.master.gain);
    if (config.master?.limiterThreshold !== undefined) this.setLimiterThreshold(config.master.limiterThreshold);
    if (config.master?.limiterDrive !== undefined) this.setLimiterDrive(config.master.limiterDrive);
    this.compressorSettings = { ...DEFAULT_COMPRESSOR, ...config.master?.compressor };
    this.applyCompressor();

    // Arrangement: schedule every cue up front (fixed positions, not a live-triggered thing).
    this.sectionsById = new Map((config.sections ?? []).map((section) => [section.id, section]));
    this.regions = config.sourceRegions;
    this.fitConfig = config.fit;
    this.logoConfig = config.logo;
    this.logoTrack = config.logo ? (this.tracks.get(config.logo.track) ?? null) : null;
    if (config.logo && !this.logoTrack) throw new Error(`Logo references unknown track "${config.logo.track}"`);
    this._lastFit = null;
    if (!config.arrangement && config.fit && this.hasLogo) {
      // No fixed arrangement: start from the creator's full template.
      const bars = config.fit.template.reduce((sum, block) => sum + block.bars, 0);
      this.fitToAnchor((bars - 1) * this.barSeconds + (config.logo!.anchorBeat - 1) * this.beatSeconds);
    } else if (config.arrangement && config.loopBars) {
      this.applyArrangement(config.arrangement, config.loopBars);
    } else {
      // No arrangement given: fall back to a static initial section, no scheduling.
      const initialSection = config.initialSection ?? config.sections?.[0]?.id;
      const section = initialSection ? this.sectionsById.get(initialSection) : undefined;
      if (section) {
        for (const track of this.tracks.values()) {
          if (!track.isSectioned) track.sectionGain.gain.value = !section.activeTracks || section.activeTracks.includes(track.id) ? 1 : 0;
        }
      }
    }
  }

  /**
   * (Re-)schedules the arrangement on the current project's tracks -- used
   * both for the initial load and whenever the timeline UI edits the song
   * form (reorder/resize/add/remove a section). Rewinds the transport to
   * bar 1 and clears any previously scheduled cues/take start-stop state
   * before scheduling the new one, so edits never leave stale automation
   * or a section-take player started twice.
   */
  applyArrangement(
    cues: CueConfig[],
    loopBars: number,
    musicStartSeconds = this.arrangement.musicStartSeconds,
    fit: FitResult | null = null,
  ): void {
    Tone.getTransport().stop(); // also resets position to 0
    Tone.getTransport().cancel(0);
    this.endEventId = null; // cancel(0) just removed it
    this._lastFit = fit; // null = edited by hand
    for (const track of this.tracks.values()) track.resyncSectionTakes();
    this.envelopes = this.arrangement.schedule(
      cues.map((cue) => ({ ...cue, transition: normalizeTransition(cue.transition) })),
      loopBars,
      this.sectionsById,
      Array.from(this.tracks.values()),
      { musicStartSeconds, barSeconds: this.barSeconds },
      this.regions,
    );
    this.scheduleLogo();
    this.envelopes.forEach((e) => e.reset(Tone.now()));
    this.applyPlaybackMode(); // schedule() always turns looping on; re-apply film/logo mode on top
    for (const listener of this.arrangementListeners) listener();
  }

  /** Places the logo so its anchor hits beat `anchorBeat` of the last bar, and adds the mute/fade envelopes. */
  private scheduleLogo(): void {
    for (const track of this.tracks.values()) track.autoGain.gain.value = 1;
    const player = this.logoTrack?.filePlayer;
    const logo = this.logoConfig;
    const anchor = this.logoAnchorSeconds;
    if (!player?.loaded || !logo || anchor === null) return;

    const start = anchor - logo.anchorSeconds;
    // If the arrangement is so short that the logo would start before 0, start the file part-way in.
    player.start(Math.max(0, start), Math.max(0, -start));

    // Per track: at most one mute (fast ramp) and one fade (to silence at the anchor); the
    // envelope follows whichever is lower at every point.
    const mutedIds = new Set(logo.mute?.tracks ?? []);
    const muteAt = logo.mute ? anchor - Tone.Time(logo.mute.before).toSeconds() : null;
    const fadeFrom = logo.fadeMusic ? anchor - Tone.Time(logo.fadeMusic).toSeconds() : null;
    for (const track of this.tracks.values()) {
      if (track.isLogo) continue;
      const muted = muteAt !== null && (mutedIds.has(track.id) || mutedIds.has(track.busId));
      const points: EnvelopePoint[] = [];
      if (muted && (fadeFrom === null || muteAt! <= fadeFrom)) {
        points.push({ t: muteAt!, v: 1 }, { t: muteAt! + MUTE_RAMP_SECONDS, v: 0 });
      } else if (fadeFrom !== null) {
        points.push({ t: fadeFrom, v: 1 });
        if (muted) {
          // Muted part-way through the fade.
          const at = Math.max(fadeFrom, muteAt!);
          const v = 1 - (at - fadeFrom) / (anchor - fadeFrom);
          points.push({ t: at, v }, { t: at + MUTE_RAMP_SECONDS, v: 0 });
        } else {
          points.push({ t: anchor, v: 0 });
        }
      } else if (muted) {
        points.push({ t: muteAt!, v: 1 }, { t: muteAt! + MUTE_RAMP_SECONDS, v: 0 });
      }
      if (points.length) this.envelopes.push(new GainEnvelope(track.autoGain.gain, 1, points));
    }
  }

  /** Creator view: change the melody mute / fade settings and re-place everything. */
  setLogoSettings(settings: Partial<Pick<LogoConfig, "mute" | "fadeMusic" | "anchorSeconds" | "anchorBeat">>): void {
    if (!this.logoConfig) return;
    this.logoConfig = { ...this.logoConfig, ...settings };
    const segments = this.arrangement.arrangementSegments;
    const cues: CueConfig[] = segments.map((s) => ({
      bar: s.startBar,
      section: s.sectionId,
      transition: s.transition,
      ...(s.sourceBar !== undefined ? { sourceBar: s.sourceBar } : {}),
    }));
    this.applyArrangement(cues, this.arrangement.totalBars, this.arrangement.musicStartSeconds, this._lastFit);
  }

  /**
   * Bounces the current mix (whatever the live mixer/arrangement state
   * actually sounds like right now -- mute/solo, volume/pan, local file
   * swaps, sidechain, transitions, the works) down to a stereo WAV, by
   * recording the real master output for exactly one loop from the top.
   *
   * This is a real-time capture (MediaRecorder via Tone.Recorder), not an
   * offline render: sidechain ducking depends on Tone.Meter/AnalyserNode,
   * which only produces meaningful readings against a live AudioContext --
   * an OfflineAudioContext render would silently drop the ducking. The
   * tradeoff is the export takes as long as the arrangement itself (and is
   * audible while it runs), which also makes "what you hear is what you get"
   * an accurate description.
   */
  async exportStereoMix(onProgress?: (fraction: number) => void): Promise<Blob> {
    if (!Tone.Recorder.supported) {
      throw new Error("This browser doesn't support MediaRecorder, can't export.");
    }
    const loopBars = this.arrangement.totalBars;
    if (!loopBars) throw new Error("No arrangement to export.");

    await this.unlockAudio();
    const loopSeconds = this.arrangementSeconds; // includes the logo's ring-out

    const recorder = new Tone.Recorder();
    this.limiter.connect(recorder);

    this.stop(); // rewind to bar 1 so the export always captures exactly one full loop from the top
    await recorder.start();
    this.play();

    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const interval = window.setInterval(() => {
        const elapsed = (performance.now() - startedAt) / 1000;
        onProgress?.(Math.min(1, elapsed / loopSeconds));
        if (elapsed >= loopSeconds) {
          window.clearInterval(interval);
          resolve();
        }
      }, 100);
    });

    this.pause();
    const recordedBlob = await recorder.stop();
    this.limiter.disconnect(recorder);
    recorder.dispose();

    return reencodeBlobAsWav(recordedBlob);
  }

  dispose(): void {
    this.clearProject();
    this.masterBus.dispose();
    this.limiter.dispose();
    this.compressor.dispose();
    this.limiterDrive.dispose();
    this.loudness.dispose();
  }
}

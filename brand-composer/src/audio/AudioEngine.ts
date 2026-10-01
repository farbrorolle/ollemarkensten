import * as Tone from "tone";
import { Bus } from "./Bus.ts";
import { Track } from "./Track.ts";
import type { TrackPlayMode } from "./Track.ts";
import { Sidechain } from "./Sidechain.ts";
import type { SidechainTarget } from "./Sidechain.ts";
import { ArrangementManager } from "./ArrangementManager.ts";
import type { SwellEdits, SwellMark, SwellSize } from "./ArrangementManager.ts";
import { GainEnvelope } from "./GainEnvelope.ts";
import { LoudnessMeter } from "./LoudnessMeter.ts";
import type { EnvelopePoint } from "./GainEnvelope.ts";
import { reencodeBlobAsWav } from "./wav.ts";
import { captureOutput, capturedToWav } from "./captureOutput.ts";
import type {
  CompressorSettings,
  CueConfig,
  FitConfig,
  LayerConfig,
  LogoConfig,
  ProjectConfig,
  SectionConfig,
  SidechainConfig,
  TransitionType,
} from "../project/types.ts";
import { anchorOffsetInMusic, expandLongSections, fitAllParts, fitOriginal, fitToLength, regionChunks } from "../project/fitToLength.ts";
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
  /** Film audio + music meet here, then go through the output limiter to the speakers. */
  readonly outputBus: Tone.Gain;
  /** Gain into the output limiter. */
  readonly outputDrive: Tone.Gain;
  readonly outputLimiter: Tone.Limiter;
  /** Brick wall after the limiter: whatever overshoots its attack is clipped at the ceiling. */
  readonly outputClip: Tone.WaveShaper;
  readonly loudness: LoudnessMeter;
  /** Taps the final output (after the master limiter) for the peak meters. */
  private readonly outputAnalyser: Tone.Analyser;
  private musicLimiterOn = true;
  private musicLimiterThreshold = -1;
  private outputLimiterOn = true;
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
    this.outputBus = new Tone.Gain(1);
    this.outputDrive = new Tone.Gain(1);
    this.outputLimiter = new Tone.Limiter(0);
    // Tone's Limiter is a compressor with the default 30 dB soft knee, which barely limits at all
    // near the threshold (peaks went +6 dB over at high gain). Hard knee + fastest attack.
    const outComp = (this.outputLimiter as unknown as { _compressor: Tone.Compressor })._compressor;
    outComp.knee.value = 0;
    outComp.attack.value = 0.001;
    outComp.release.value = 0.05;
    this.limiter.connect(this.outputBus);
    this.outputBus.connect(this.outputDrive);
    this.outputClip = new Tone.WaveShaper(clipCurve(0));
    this.outputClip.oversample = "4x";
    this.outputDrive.connect(this.outputLimiter);
    this.outputLimiter.connect(this.outputClip);
    this.outputClip.connect(Tone.getDestination());
    this.loudness = new LoudnessMeter(this.outputClip);
    this.outputAnalyser = new Tone.Analyser({ type: "waveform", size: 2048, channels: 2 });
    this.outputClip.connect(this.outputAnalyser);

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

  /** A logo is configured and switched on (it can be removed and put back). */
  get hasLogo(): boolean {
    return !!this.logoConfig && !!this.logoTrack && this.logoEnabled;
  }

  private logoEnabled = true;

  get isLogoEnabled(): boolean {
    return this.logoEnabled;
  }

  /** Removes (or puts back) the sonic logo, keeping where the music ends. */
  setLogoEnabled(on: boolean): void {
    if (on === this.logoEnabled || !this.logoConfig) return;
    const end = this.arrangementSeconds;
    this.logoEnabled = on;
    if (this.canFit && end > 0) this.fitToAnchor(this.anchorForEnd(end));
    else this.setLogoSettings({});
  }

  /**
   * Where the anchor (beat `anchorBeat` of the last bar) must be for the whole thing to end at
   * `endSeconds`: the logo's end with a logo, the end of the last bar without one.
   */
  anchorForEnd(endSeconds: number): number {
    const logo = this.logoConfig;
    if (!logo) return endSeconds;
    if (this.hasLogo) return endSeconds - (this.logoDurationSeconds - logo.anchorSeconds);
    return endSeconds - (this.barSeconds - (logo.anchorBeat - 1) * this.beatSeconds);
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
    if (!this.hasLogo) return null;
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
    return this.anchorForEnd(filmSeconds);
  }

  sectionName(id: string): string {
    return this.sectionsById.get(id)?.name ?? id;
  }

  /** The creator's shorten/extend rules per section (empty if the project has none). */
  get fitTemplate(): FitConfig["template"] {
    return this.fitConfig?.template ?? [];
  }

  get canFit(): boolean {
    return !!this.fitConfig && !!this.logoConfig && !!this.logoTrack;
  }

  private _fitAllParts = false;

  /** Auto arrange option: keep every part in the music, each with its original share of the length. */
  get fitAllParts(): boolean {
    return this._fitAllParts;
  }

  setFitAllParts(on: boolean): void {
    if (on === this._fitAllParts) return;
    this._fitAllParts = on;
    const anchor = this.logoAnchorSeconds;
    if (anchor !== null && this.canFit && this._arrangeMode === "auto") this.fitToAnchor(anchor);
  }

  /** Back to the track exactly as composed: every part once, at full length, from the start. */
  resetToOriginalForm(): void {
    if (!this.fitConfig || !this.logoConfig) return;
    const template = this.fitConfig.template;
    const total = template.reduce((sum, b) => sum + b.bars, 0);
    const timing = { barSeconds: this.barSeconds, beatSeconds: this.beatSeconds, anchorBeat: this.logoConfig.anchorBeat };
    const result = fitOriginal(template, anchorOffsetInMusic(total, timing), timing, this.regions);
    this.applyArrangement(result.cues, result.totalBars, result.musicStartSeconds, result);
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
    const fit = this._arrangeMode === "original" ? fitOriginal : this._fitAllParts ? fitAllParts : fitToLength;
    const result = fit(
      this.fitConfig.template,
      anchorSeconds,
      { barSeconds: this.barSeconds, beatSeconds: this.beatSeconds, anchorBeat: this.logoConfig.anchorBeat, loopFrom: this.loopFromIndex },
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
    const once = this.filmMode || !!this.logoConfig;
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
    this.musicLimiterThreshold = db;
    this.limiter.threshold.value = this.musicLimiterOn ? db : 0;
  }

  /** Music limiter on/off ("off" = threshold 0 dBFS: it only catches overs). */
  setMusicLimiterOn(on: boolean): void {
    this.musicLimiterOn = on;
    this.limiter.threshold.value = on ? this.musicLimiterThreshold : 0;
  }

  get isMusicLimiterOn(): boolean {
    return this.musicLimiterOn;
  }

  /** The output limiter (music + film audio) -- dB of gain into it. */
  setOutputDrive(db: number): void {
    this.outputDrive.gain.value = Tone.dbToGain(db);
  }

  get outputDriveDb(): number {
    return Tone.gainToDb(this.outputDrive.gain.value);
  }

  setOutputLimiterOn(on: boolean): void {
    this.outputLimiterOn = on;
    this.outputLimiter.threshold.value = on ? this.outputCeiling : 0;
    this.outputClip.curve = clipCurve(on ? this.outputCeiling : 0);
  }

  private outputCeiling = 0;

  /** The output limiter's ceiling (dBFS). Default 0: the customer only pushes gain into it. */
  setOutputCeiling(db: number): void {
    this.outputCeiling = Math.min(0, db);
    if (this.outputLimiterOn) {
      this.outputLimiter.threshold.value = this.outputCeiling;
      this.outputClip.curve = clipCurve(this.outputCeiling);
    }
  }

  get outputCeilingDb(): number {
    return this.outputCeiling;
  }

  get isOutputLimiterOn(): boolean {
    return this.outputLimiterOn;
  }

  /** Sample peaks (linear, L and R) of the final output over the last ~40 ms. */
  outputPeaks(): [number, number] {
    const value = this.outputAnalyser.getValue();
    const chans = Array.isArray(value) ? value : [value, value];
    const peak = (a: Float32Array | undefined): number => {
      let m = 0;
      if (a) for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
      return m;
    };
    return [peak(chans[0]), peak(chans[1] ?? chans[0])];
  }

  get outputLimiterReduction(): number {
    return this.outputLimiter.reduction;
  }

  get limiterThreshold(): number {
    return this.musicLimiterThreshold;
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
    this.layerConfigs = config.layers ?? [];
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
    // A section longer than its material loops (auto arrange) or runs on into the next part
    // (original form) -- as separate, visible parts of the form.
    if (this.regions) cues = expandLongSections(cues, loopBars, this.regions, this._arrangeMode === "original" ? "continue" : "loop", this.sectionEndings(), this.fitConfig?.loopFrom);
    if (!this.restoring && this.currentState) {
      this.undoStack.push(this.currentState);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.currentState = {
      swellEdits: { removed: [...this._swellEdits.removed], added: this._swellEdits.added.map((a) => ({ ...a })) },
      layers: this._layers.map((l) => ({ ...l })),
      volumeCues: this._volumeCues.map((c) => ({ ...c })),
      cues: cues.map((c) => ({ ...c })),
      loopBars,
      musicStartSeconds,
      fit,
      logoEnabled: this.logoEnabled,
      arrangeMode: this._arrangeMode,
      fitAllParts: this._fitAllParts,
    };
    // Edited while playing: keep playing from the same spot in the new arrangement.
    const wasPlaying = Tone.getTransport().state === "started";
    const playedFrom = Tone.getTransport().seconds;
    Tone.getTransport().stop(); // also resets position to 0
    Tone.getTransport().cancel(0);
    this.endEventId = null; // cancel(0) just removed it
    this._lastFit = fit; // null = edited by hand
    for (const track of this.tracks.values()) track.resyncSectionTakes();
    this.arrangement.swellCutoffBeat = this.hasLogo ? this.logoConfig!.anchorBeat : 0;
    this.arrangement.swellEdits = { removed: [...this._swellEdits.removed], added: this._swellEdits.added.map((a) => ({ ...a })) };
    const ring = new Set(this.logoConfig?.ringOut ?? []);
    this.arrangement.logoRingOut = new Set(
      Array.from(this.tracks.values())
        .filter((t) => ring.has(t.id) || ring.has(t.busId))
        .map((t) => t.id),
    );
    this.envelopes = this.arrangement.schedule(
      cues.map((cue) => ({ ...cue, transition: normalizeTransition(cue.transition) })),
      loopBars,
      this.sectionsById,
      Array.from(this.tracks.values()),
      { musicStartSeconds, barSeconds: this.barSeconds },
      this.regions,
    );
    this.scheduleLogo();
    this.cueEnvelopes = this.buildCueEnvelopes();
    this.envelopes.push(...this.cueEnvelopes);
    this.envelopes.push(...this.scheduleLayers());
    this.envelopes.forEach((e) => e.reset(Tone.now()));
    this.applyPlaybackMode(); // schedule() always turns looping on; re-apply film/logo mode on top
    if (wasPlaying && (this.filmMode || playedFrom < this.arrangementSeconds - 0.1)) Tone.getTransport().start(undefined, playedFrom);
    for (const listener of this.arrangementListeners) listener();
  }

  /** Template index the music goes round again from (config `fit.loopFrom`). */
  private get loopFromIndex(): number | undefined {
    const id = this.fitConfig?.loopFrom;
    const i = id ? (this.fitConfig?.template.findIndex((b) => b.section === id) ?? -1) : -1;
    return i >= 0 ? i : undefined;
  }

  /** Per section: how many bars at its end lead into the next part (the most any track picks up). */
  private sectionEndings(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, region] of Object.entries(this.regions ?? {})) {
      let bars = 0;
      for (const t of this.tracks.values()) bars = Math.max(bars, t.pickups[String(region[1] + 1)] ?? 0);
      out[id] = bars;
    }
    return out;
  }

  // --- Swells: the automatic ones can be switched off, and extra ones added anywhere -------------

  private _swellEdits: SwellEdits = { removed: [], added: [] };

  /** Where swells play now (by the bar they lead into), including switched-off automatic ones. */
  get swellMarks(): SwellMark[] {
    return Array.from(this.arrangement.swellMarks.values()).sort((a, b) => a.bar - b.bar);
  }

  get hasSwellTracks(): boolean {
    return Array.from(this.tracks.values()).some((t) => t.isSwell);
  }

  /** Switches the swell into `bar` off (an automatic one) or removes it (an added one). */
  removeSwell(bar: number): void {
    const wasAdded = this._swellEdits.added.some((a) => a.bar === bar);
    const added = this._swellEdits.added.filter((a) => a.bar !== bar);
    const removed = wasAdded ? this._swellEdits.removed : [...new Set([...this._swellEdits.removed, bar])];
    this.setSwellEdits({ removed, added });
  }

  /** Puts a swell into `bar` (back): un-removes an automatic one, or adds one. */
  addSwell(bar: number, size?: SwellSize): void {
    if (this._swellEdits.removed.includes(bar) && !size) {
      this.setSwellEdits({ removed: this._swellEdits.removed.filter((b) => b !== bar), added: this._swellEdits.added });
      return;
    }
    // A new swell (or one of another size) into this bar.
    this.setSwellEdits({
      removed: this._swellEdits.removed.filter((b) => b !== bar),
      added: [...this._swellEdits.added.filter((a) => a.bar !== bar), { bar, size: size ?? "big" }],
    });
  }

  private setSwellEdits(edits: SwellEdits): void {
    const state = this.currentState;
    if (!state) return;
    this.undoStack.push(state);
    this.redoStack.length = 0;
    this._swellEdits = { removed: [...edits.removed], added: edits.added.map((a) => ({ ...a })) };
    this.restoring = true;
    try {
      this.applyArrangement(state.cues, state.loopBars, state.musicStartSeconds, state.fit);
    } finally {
      this.restoring = false;
    }
  }

  // --- Layers: e.g. the melody dragged over another part ---------------------------------------

  private layerConfigs: LayerConfig[] = [];
  private _layers: LayerBlock[] = [];

  get layerTypes(): readonly LayerConfig[] {
    return this.layerConfigs;
  }

  get layers(): readonly LayerBlock[] {
    return this._layers;
  }

  /** Replaces all layer blocks (undoable) and re-schedules the music (keeps playing). */
  setLayers(layers: LayerBlock[]): void {
    const state = this.currentState;
    if (!state) return;
    this.undoStack.push(state);
    this.redoStack.length = 0;
    this._layers = layers.map((l) => ({ ...l })).sort((a, b) => a.startBar - b.startBar);
    this.restoring = true;
    try {
      this.applyArrangement(state.cues, state.loopBars, state.musicStartSeconds, state.fit);
    } finally {
      this.restoring = false;
    }
  }

  /**
   * Plays each layer block on its tracks' extra voice -- from the layer's section (with its pickup
   * just before, looping if the block is longer) -- while the tracks' normal playback is faded out
   * underneath, so nothing doubles. Under the logo the layer stops at the hit.
   */
  private scheduleLayers(): GainEnvelope[] {
    if (!this._layers.length || !this.regions) return [];
    const envelopes: GainEnvelope[] = [];
    const barSec = this.barSeconds;
    const FADE = 0.06;
    const hit = this.hasLogo ? this.logoAnchorSeconds : null;
    const musicEnd = this.arrangement.barStartSeconds(this.arrangement.totalBars + 1);
    for (const config of this.layerConfigs) {
      const blocks = this._layers.filter((l) => l.layerId === config.id && l.bars > 0);
      const region = this.regions[config.section];
      if (!blocks.length || !region) continue;
      for (const trackId of config.tracks) {
        const track = this.tracks.get(trackId);
        const voice = track?.layerVoice;
        const bus = track?.regionBus;
        if (!track || !voice || !bus || !voice.player.loaded) continue;
        const bufferSeconds = voice.player.buffer.duration;
        const layerPts: EnvelopePoint[] = [];
        const busPts: EnvelopePoint[] = [];
        let lastStart = -Infinity;
        for (const block of blocks) {
          const start = this.arrangement.barStartSeconds(block.startBar);
          let end = Math.min(this.arrangement.barStartSeconds(block.startBar + block.bars), musicEnd);
          if (hit !== null) end = Math.min(end, hit);
          if (end <= start + 0.05) continue;
          // The melody's own pickup (upbeat) leads into the block.
          const pickup = track.pickups[String(region[0])] ?? 0;
          const pickStart = start - pickup * barSec;
          const pickOffset = (region[0] - pickup - track.fileStartBar) * barSec;
          let fadeInAt = start;
          if (pickup && pickStart >= 0 && pickStart > lastStart + 1e-3 && pickOffset >= 0) {
            voice.player.start(pickStart, pickOffset, pickup * barSec);
            lastStart = pickStart;
            fadeInAt = pickStart;
          }
          for (const chunk of regionChunks(block.startBar, block.bars, region, region[0])) {
            const when = this.arrangement.barStartSeconds(chunk.startBar);
            if (when >= end || when <= lastStart + 1e-3) continue;
            const offset = (chunk.sourceBar - track.fileStartBar) * barSec;
            if (offset < 0 || offset >= bufferSeconds) continue;
            const tail = Math.min(2, track.tails[chunk.sourceBar + chunk.bars - 2] ?? 0);
            const duration = Math.min(end - when + tail, bufferSeconds - offset);
            voice.player.start(when, offset, duration);
            lastStart = when;
          }
          const tail = hit !== null && end >= hit - 1e-3 ? 0.03 : 0.25;
          layerPts.push({ t: fadeInAt, v: 0 }, { t: fadeInAt + FADE, v: 1 }, { t: end, v: 1 }, { t: end + tail, v: 0 });
          busPts.push({ t: start - FADE, v: 1 }, { t: start, v: 0 }, { t: end, v: 0 }, { t: end + FADE, v: 1 });
        }
        envelopes.push(new GainEnvelope(voice.gain.gain, 0, layerPts), new GainEnvelope(bus.gain, 1, busPts));
      }
    }
    return envelopes;
  }

  // --- Volume cue points: per-instrument level changes along the timeline ---------------------

  private _volumeCues: VolumeCue[] = [];
  private cueEnvelopes: GainEnvelope[] = [];

  get volumeCues(): readonly VolumeCue[] {
    return this._volumeCues;
  }

  /** Replaces all volume cues (undoable) and applies them right away, also while playing. */
  setVolumeCues(cues: VolumeCue[]): void {
    if (this.currentState) {
      this.undoStack.push(this.currentState);
      this.redoStack.length = 0;
    }
    this._volumeCues = cues.map((c) => ({ ...c })).sort((a, b) => a.bar - b.bar);
    if (this.currentState) this.currentState = { ...this.currentState, volumeCues: this._volumeCues.map((c) => ({ ...c })) };
    this.refreshCueEnvelopes();
    for (const listener of this.arrangementListeners) listener();
  }

  /** The level (dB) an instrument has just before `bar` (0 = as mixed). */
  volumeAt(trackId: string, bar: number): number {
    let db = 0;
    for (const cue of this._volumeCues) if (cue.trackId === trackId && cue.bar < bar - 1e-9) db = cue.db;
    return db;
  }

  /** Transport seconds of a (fractional, 1-indexed) arrangement bar position. */
  secondsAtBar(bar: number): number {
    const whole = Math.floor(bar);
    return this.arrangement.barStartSeconds(whole) + (bar - whole) * this.barSeconds;
  }

  private buildCueEnvelopes(): GainEnvelope[] {
    const byTrack = new Map<string, VolumeCue[]>();
    for (const cue of this._volumeCues) {
      if (!this.tracks.has(cue.trackId)) continue;
      byTrack.set(cue.trackId, [...(byTrack.get(cue.trackId) ?? []), cue]);
    }
    const envelopes: GainEnvelope[] = [];
    for (const track of this.tracks.values()) {
      const cues = byTrack.get(track.id);
      if (!cues) {
        track.cueGain.gain.cancelScheduledValues(0);
        track.cueGain.gain.value = 1;
        continue;
      }
      const points: { t: number; v: number }[] = [];
      let level = 1;
      for (const cue of cues) {
        const t = this.secondsAtBar(cue.bar);
        const v = cue.db <= VOLUME_CUE_MUTE_DB ? 0 : Tone.dbToGain(cue.db);
        points.push({ t: Math.max(0, t - VOLUME_CUE_RAMP), v: level }, { t, v });
        level = v;
      }
      envelopes.push(new GainEnvelope(track.cueGain.gain, 1, points));
    }
    return envelopes;
  }

  private refreshCueEnvelopes(): void {
    this.envelopes = this.envelopes.filter((e) => !this.cueEnvelopes.includes(e));
    this.cueEnvelopes = this.buildCueEnvelopes();
    this.envelopes.push(...this.cueEnvelopes);
    const transport = Tone.getTransport();
    const now = Tone.now();
    if (transport.state === "started") this.cueEnvelopes.forEach((e) => e.applyFrom(now, transport.seconds));
    else this.cueEnvelopes.forEach((e) => e.reset(now));
  }

  // --- Undo / redo of the arrangement (form, length, logo on/off, arrange mode) ---------------

  private undoStack: ArrangementState[] = [];
  private redoStack: ArrangementState[] = [];
  private currentState: ArrangementState | null = null;
  private restoring = false;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const state = this.undoStack.pop();
    if (!state) return;
    if (this.currentState) this.redoStack.push(this.currentState);
    this.restoreState(state);
  }

  redo(): void {
    const state = this.redoStack.pop();
    if (!state) return;
    if (this.currentState) this.undoStack.push(this.currentState);
    this.restoreState(state);
  }

  private restoreState(state: ArrangementState): void {
    this._volumeCues = state.volumeCues.map((c) => ({ ...c }));
    this._layers = state.layers.map((l) => ({ ...l }));
    this._swellEdits = { removed: [...state.swellEdits.removed], added: state.swellEdits.added.map((a) => ({ ...a })) };
    this.logoEnabled = state.logoEnabled;
    this._arrangeMode = state.arrangeMode;
    this._fitAllParts = state.fitAllParts;
    this.restoring = true;
    try {
      this.applyArrangement(state.cues, state.loopBars, state.musicStartSeconds, state.fit);
    } finally {
      this.restoring = false;
    }
  }

  /** Places the logo so its anchor hits beat `anchorBeat` of the last bar, and adds the mute/fade envelopes. */
  private scheduleLogo(): void {
    for (const track of this.tracks.values()) track.autoGain.gain.value = 1;
    const player = this.hasLogo ? this.logoTrack?.filePlayer : undefined;
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
  setLogoSettings(
    settings: Partial<Pick<LogoConfig, "mute" | "fadeMusic" | "anchorSeconds" | "anchorBeat" | "ringOut">>,
  ): void {
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

  /**
   * Renders the output (music, plus the film's sound if it is on) from the very start of the
   * timeline (0 = the film's first frame) for `seconds`, sample-exact, as a 24-bit WAV. Plays
   * through once in real time (sidechain ducking needs a live context) -- silently.
   */
  async renderOutput(seconds: number, onProgress?: (fraction: number) => void): Promise<Blob> {
    if (!this.arrangement.totalBars) throw new Error("No arrangement to export.");
    await this.unlockAudio();
    const destination = Tone.getDestination();
    const wasMuted = destination.mute;
    this.stop();
    destination.mute = true; // the capture taps before the speakers
    try {
      const startAt = Tone.now() + 0.25;
      const capture = captureOutput(this.outputClip, startAt, seconds, onProgress);
      Tone.getTransport().start(startAt, 0);
      const result = await capture;
      return capturedToWav(result);
    } finally {
      this.stop();
      destination.mute = wasMuted;
    }
  }

  dispose(): void {
    this.clearProject();
    this.masterBus.dispose();
    this.limiter.dispose();
    this.compressor.dispose();
    this.limiterDrive.dispose();
    this.outputBus.dispose();
    this.outputDrive.dispose();
    this.outputLimiter.dispose();
    this.outputClip.dispose();
    this.loudness.dispose();
    this.outputAnalyser.dispose();
  }
}

/** Everything needed to put an arrangement back (undo/redo). */
interface ArrangementState {
  swellEdits: SwellEdits;
  layers: LayerBlock[];
  volumeCues: VolumeCue[];
  cues: CueConfig[];
  loopBars: number;
  musicStartSeconds: number;
  fit: FitResult | null;
  logoEnabled: boolean;
  arrangeMode: "auto" | "original";
  fitAllParts: boolean;
}

/** A volume cue point: from `bar` on, the instrument plays at `db` (until its next cue). */
export interface VolumeCue {
  id: string;
  trackId: string;
  /** 1-indexed arrangement bar, with beats as fractions (bar 3, beat 2 = 3.25). */
  bar: number;
  /** Level relative to the mix (0 = as mixed); at or below VOLUME_CUE_MUTE_DB = silent. */
  db: number;
}

export const VOLUME_CUE_MUTE_DB = -40;
/** Seconds the level glides into a cue's new value (ending on the cue). */
const VOLUME_CUE_RAMP = 0.12;

/** A layer block in the timeline: layer `layerId` plays from `startBar` for `bars` bars. */
export interface LayerBlock {
  id: string;
  layerId: string;
  startBar: number;
  bars: number;
}

/** A hard-clip transfer curve at `ceilingDb` dBFS (input range -1..1, which is also 0 dBFS). */
function clipCurve(ceilingDb: number): Float32Array {
  const c = Math.min(1, Tone.dbToGain(ceilingDb));
  const n = 4097;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(-c, Math.min(c, x));
  }
  return curve;
}

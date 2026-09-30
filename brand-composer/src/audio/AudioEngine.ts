import * as Tone from "tone";
import { Bus } from "./Bus.ts";
import { Track } from "./Track.ts";
import type { TrackPlayMode } from "./Track.ts";
import { Sidechain } from "./Sidechain.ts";
import type { SidechainTarget } from "./Sidechain.ts";
import { ArrangementManager } from "./ArrangementManager.ts";
import { TransitionFx } from "./TransitionFx.ts";
import { reencodeBlobAsWav } from "./wav.ts";
import type { CueConfig, FitConfig, LogoConfig, ProjectConfig, SectionConfig } from "../project/types.ts";
import { fitToLength } from "../project/fitToLength.ts";
import type { FitResult } from "../project/fitToLength.ts";

/** A gain move on one track, in transport seconds: a short mute, or a linear fade to silence. */
interface AutomationEvent {
  track: Track;
  from: number;
  to: number;
}

const MUTE_RAMP_SECONDS = 0.03;

/**
 * Owns Tone.Transport, the MasterBus (-> filter -> Limiter -> speakers) and
 * every Track/Bus/Sidechain in the currently loaded project.
 */
export class AudioEngine {
  readonly masterBus: Bus;
  readonly limiter: Tone.Limiter;
  readonly transitionFx: TransitionFx;

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
  private automation: AutomationEvent[] = [];
  private _lastFit: FitResult | null = null;
  private readonly arrangementListeners = new Set<() => void>();

  constructor() {
    this.masterBus = new Bus("master", "MasterBus");
    this.limiter = new Tone.Limiter(-1);
    this.transitionFx = new TransitionFx();

    this.masterBus.connect(this.transitionFx.filter);
    this.transitionFx.filter.connect(this.limiter);
    this.limiter.connect(Tone.getDestination());
    this.transitionFx.connectRiser(this.masterBus.channel);

    Tone.getTransport().bpm.value = 120;

    // Arrangement automation (melody mute, fade into the logo) is written straight onto the
    // tracks' autoGain from wherever playback starts, so it's also right after a seek.
    const transport = Tone.getTransport();
    transport.on("start", (time, offset) => this.applyAutomationFrom(time, offset ?? 0));
    transport.on("stop", (time) => this.resetAutomation(time));
    transport.on("pause", (time) => this.holdAutomation(time));
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

  /** Result of the most recent fitToAnchor(), or null if the arrangement was edited by hand since. */
  get lastFit(): FitResult | null {
    return this._lastFit;
  }

  /**
   * "Anpassa till längd": rebuilds the arrangement from the creator's rules
   * so the logo's anchor lands on `anchorSeconds` (film time).
   */
  fitToAnchor(anchorSeconds: number): FitResult {
    if (!this.fitConfig || !this.logoConfig) throw new Error("Projektet saknar regler för längdanpassning");
    const result = fitToLength(
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
    this.automation = [];
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
    for (const scConfig of config.sidechains ?? []) {
      const source = this.tracks.get(scConfig.source);
      if (!source) throw new Error(`Sidechain "${scConfig.id}" references unknown source "${scConfig.source}"`);
      const target = this.resolveSidechainTarget(scConfig.target);
      this.sidechains.set(scConfig.id, new Sidechain(scConfig.id, source, target, scConfig));
    }

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
    this.arrangement.schedule(
      cues,
      loopBars,
      this.sectionsById,
      Array.from(this.tracks.values()),
      this.transitionFx,
      { musicStartSeconds, barSeconds: this.barSeconds },
      this.regions,
    );
    this.scheduleLogo();
    this.applyPlaybackMode(); // schedule() always turns looping on; re-apply film/logo mode on top
    for (const listener of this.arrangementListeners) listener();
  }

  /** Places the logo so its anchor hits beat `anchorBeat` of the last bar, and sets up mute/fade automation. */
  private scheduleLogo(): void {
    this.automation = [];
    const player = this.logoTrack?.filePlayer;
    const logo = this.logoConfig;
    const anchor = this.logoAnchorSeconds;
    if (!player?.loaded || !logo || anchor === null) return;

    const start = anchor - logo.anchorSeconds;
    // If the arrangement is so short that the logo would start before 0, start the file part-way in.
    player.start(Math.max(0, start), Math.max(0, -start));

    const musicTracks = Array.from(this.tracks.values()).filter((t) => !t.isLogo);
    if (logo.mute && logo.mute.tracks.length) {
      const ids = new Set(logo.mute.tracks);
      const at = anchor - Tone.Time(logo.mute.before).toSeconds();
      for (const track of musicTracks) {
        if (ids.has(track.id) || ids.has(track.busId)) this.automation.push({ track, from: at, to: at + MUTE_RAMP_SECONDS });
      }
    }
    if (logo.fadeMusic) {
      const from = anchor - Tone.Time(logo.fadeMusic).toSeconds();
      for (const track of musicTracks) this.automation.push({ track, from, to: anchor });
    }
  }

  /** Gain an automated track should have at transport time `t` (product of all its moves). */
  private automationValueAt(track: Track, t: number): number {
    let value = 1;
    for (const e of this.automation) {
      if (e.track !== track || t <= e.from) continue;
      value *= t >= e.to ? 0 : 1 - (t - e.from) / (e.to - e.from);
    }
    return value;
  }

  private applyAutomationFrom(time: number, offset: number): void {
    const tracks = new Set(this.automation.map((e) => e.track));
    for (const track of tracks) {
      const gain = track.autoGain.gain;
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(this.automationValueAt(track, offset), time);
    }
    for (const e of this.automation) {
      if (e.to <= offset) continue;
      const gain = e.track.autoGain.gain;
      const from = Math.max(e.from, offset);
      gain.setValueAtTime(this.automationValueAt(e.track, from), time + (from - offset));
      gain.linearRampToValueAtTime(this.automationValueAt(e.track, e.to), time + (e.to - offset));
    }
  }

  private holdAutomation(time: number): void {
    for (const track of this.tracks.values()) {
      track.autoGain.gain.cancelScheduledValues(time);
    }
  }

  private resetAutomation(time: number): void {
    for (const track of this.tracks.values()) {
      track.autoGain.gain.cancelScheduledValues(time);
      track.autoGain.gain.setValueAtTime(1, time);
    }
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
      throw new Error("Den här webbläsaren saknar stöd för MediaRecorder, kan inte exportera.");
    }
    const loopBars = this.arrangement.totalBars;
    if (!loopBars) throw new Error("Inget arrangemang att exportera.");

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
    this.transitionFx.dispose();
  }
}

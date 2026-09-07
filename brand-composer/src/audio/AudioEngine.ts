import * as Tone from "tone";
import { Bus } from "./Bus.ts";
import { Track } from "./Track.ts";
import { Sidechain } from "./Sidechain.ts";
import type { SidechainTarget } from "./Sidechain.ts";
import { TransitionManager } from "./TransitionManager.ts";
import type { ProjectConfig } from "../project/types.ts";

/**
 * Owns Tone.Transport, the MasterBus (-> Limiter -> speakers) and every
 * Track/Bus/Sidechain in the currently loaded project.
 */
export class AudioEngine {
  readonly masterBus: Bus;
  readonly limiter: Tone.Limiter;

  readonly buses = new Map<string, Bus>();
  readonly tracks = new Map<string, Track>();
  readonly sidechains = new Map<string, Sidechain>();
  readonly transitions: TransitionManager;

  private projectTitle = "";

  constructor() {
    this.masterBus = new Bus("master", "MasterBus");
    this.limiter = new Tone.Limiter(-1);
    this.masterBus.connect(this.limiter);
    this.limiter.connect(Tone.getDestination());

    this.transitions = new TransitionManager(() => Array.from(this.tracks.values()));

    Tone.getTransport().bpm.value = 120;
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
      const track = new Track(trackConfig);
      const destBus = trackConfig.bus && trackConfig.bus !== "master" ? this.buses.get(trackConfig.bus) : this.masterBus;
      if (!destBus) throw new Error(`Track "${trackConfig.id}" references unknown bus "${trackConfig.bus}"`);
      track.connect(destBus.input);
      this.tracks.set(track.id, track);
    }
    await Promise.all(
      config.tracks.map((trackConfig) => this.tracks.get(trackConfig.id)!.load(trackConfig.file)),
    );

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

    // Sections / transitions.
    for (const section of config.sections ?? []) this.transitions.registerSection(section);
    const initialSection = config.initialSection ?? config.sections?.[0]?.id;
    if (initialSection) this.transitions.applySectionImmediately(initialSection);
  }

  dispose(): void {
    this.clearProject();
    this.masterBus.dispose();
    this.limiter.dispose();
  }
}

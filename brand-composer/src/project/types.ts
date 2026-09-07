/** JSON project metadata describing a song's stems, bus routing and BPM. */

export interface BusConfig {
  /** Unique bus id, referenced by TrackConfig.bus and SidechainConfig.target. */
  id: string;
  name: string;
  /** Parent bus id to route into. Omit (or "master") to route straight to MasterBus. */
  parent?: string;
  volume?: number; // dB, default 0
  pan?: number; // -1..1, default 0
}

export interface TrackConfig {
  id: string;
  name: string;
  /** Path to the WAV stem, relative to the app root (e.g. exported from Logic Pro). */
  file: string;
  /** Bus id this track routes into. Omit (or "master") to route straight to MasterBus. */
  bus?: string;
  volume?: number; // dB, default 0
  pan?: number; // -1..1, default 0
  mute?: boolean;
  solo?: boolean;
}

export interface SidechainConfig {
  id: string;
  /** Track id whose signal level drives the ducking. */
  source: string;
  /** Track or bus id whose gain gets ducked. */
  target: string;
  /** dBFS level above which ducking kicks in. */
  threshold: number;
  /** Compression ratio applied above the threshold (e.g. 4 = 4:1). */
  ratio: number;
  /** Seconds to duck down when the source crosses the threshold. */
  attack: number;
  /** Seconds to recover back to unity gain once the source drops below it. */
  release: number;
}

/** A named arrangement section: which tracks are audible while it's active. */
export interface SectionConfig {
  id: string;
  name: string;
  activeTracks: string[];
}

export interface ProjectConfig {
  title: string;
  /** Tempo the WAV stems were bounced at in Logic Pro. Drives Tone.Transport.bpm 1:1. */
  bpm: number;
  timeSignature?: [number, number]; // default [4, 4]
  buses?: BusConfig[];
  tracks: TrackConfig[];
  sidechains?: SidechainConfig[];
  sections?: SectionConfig[];
  /** Section id active immediately on load. Defaults to the first entry in `sections`. */
  initialSection?: string;
}

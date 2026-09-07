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
  /**
   * Path to the WAV stem, relative to the app root (e.g. exported from Logic Pro).
   * Use this for a track whose audio is identical across every section it appears
   * in (it just gets muted/unmuted per section). Omit in favor of `sections` when
   * the track plays genuinely different audio per section (e.g. a different
   * bassline in the chorus).
   */
  file?: string;
  /**
   * Per-section audio for this track: section id -> WAV file. A section id not
   * present here means this track is silent during that section. Takes
   * precedence over `file` when set.
   */
  sections?: Record<string, string>;
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

/**
 * A named arrangement section (Verse, Chorus, ...). For tracks that use a
 * single `file` across sections, `activeTracks` says which of them are
 * audible while this section plays. Tracks that use `sections` (per-section
 * audio) don't need to be listed here -- their membership in a section is
 * implied by having a file entry for it.
 */
export interface SectionConfig {
  id: string;
  name: string;
  activeTracks: string[];
}

/**
 * How playback bridges into a cue:
 * - "cut": near-instant switch, no blend.
 * - "crossfade": a short musical blend (outgoing fades out / incoming fades in).
 * - "filter-sweep": the master lowpass filter sweeps closed then pops back open, on top of a crossfade.
 * - "riser": a synthesized noise riser builds and peaks at the cue, on top of a crossfade.
 */
export type TransitionType = "cut" | "crossfade" | "filter-sweep" | "riser";

/** A fixed point in the arrangement where playback switches to a different section. */
export interface CueConfig {
  /** 1-indexed bar number, absolute from the start of the arrangement. */
  bar: number;
  /** Section id (from `sections`) that becomes active at this bar. */
  section: string;
  /** Transition into this cue. Ignored for the arrangement's first cue. Defaults to "crossfade". */
  transition?: TransitionType;
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
  /**
   * The song's arrangement as a sorted list of cues, e.g.
   * [{bar: 1, section: "verse"}, {bar: 9, section: "chorus"}]. Scheduled once
   * at load time on Tone.Transport -- no live triggering needed. Requires
   * `loopBars` so the transport knows where the arrangement repeats.
   */
  arrangement?: CueConfig[];
  /** Total arrangement length in bars; Tone.Transport loops [0, loopBars) when `arrangement` is set. */
  loopBars?: number;
  /**
   * Section id active immediately on load when no `arrangement` is given
   * (legacy/live mode). Defaults to the first entry in `sections`.
   */
  initialSection?: string;
}

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
  /**
   * Long-bounce projects (`ProjectConfig.sourceRegions` set): the bar of the
   * original bounce at which this (silence-trimmed) file starts. Default 1.
   */
  fileStartBar?: number;
  /** "logo": the sonic logo -- played once, positioned by `ProjectConfig.logo`, never by sections. */
  role?: "logo";
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
  /** Most the target is ever turned down, in dB ("how much"). Default 24. */
  depth?: number;
  /**
   * Shape of the duck/recovery ramps:
   * "linear" (even), "exponential" (fast start, long tail -- classic "pump"),
   * "smooth" (RC curve like an analogue compressor). Default "smooth".
   */
  curve?: SidechainCurve;
}

export type SidechainCurve = "linear" | "exponential" | "smooth";

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
  /** Omit to mean "every track" (the usual case for long-bounce projects, where the bounce itself decides what plays). */
  activeTracks?: string[];
}

/**
 * How playback bridges into a cue:
 * - "cut": near-instant switch (a few ms, just enough to avoid a click).
 * - "crossfade": the outgoing section rings on for an 8th note while fading out.
 * (Risers/sweeps are the creator's own audio files, not generated.)
 */
export type TransitionType = "cut" | "crossfade";

/** A fixed point in the arrangement where playback switches to a different section. */
export interface CueConfig {
  /** 1-indexed bar number, absolute from the start of the arrangement. */
  bar: number;
  /** Section id (from `sections`) that becomes active at this bar. */
  section: string;
  /** Transition into this cue. Ignored for the arrangement's first cue. Defaults to "crossfade". */
  transition?: TransitionType;
  /**
   * Long-bounce projects only: which bar of the section's source region to
   * start playing from (default: the region's first bar). Lets a shortened
   * section keep its *end* (e.g. the swell into the next section).
   */
  sourceBar?: number;
}

/** One section in the creator's template arrangement, with the rules for shortening/extending it. */
export interface FitBlock {
  section: string;
  /** Length in the full template. */
  bars: number;
  /** Shortest allowed (0 = may be dropped). Default: `bars`. */
  minBars?: number;
  /** Longest allowed (longer than the source region = the region repeats). Default: `bars`. */
  maxBars?: number;
  /** Shorten/extend only in steps of this many bars (e.g. 4 = whole phrases). Default 1. */
  stepBars?: number;
  /** Lower = changed first when the music must get shorter/longer. Default 1. */
  priority?: number;
  /** Transition into this section. Default "cut" (the bounce already has its own swells). */
  transition?: TransitionType;
  /** Which part of the source region survives when shortened. Default "end" (keeps the lead-in to the next section). */
  keep?: "start" | "end";
}

export interface FitConfig {
  template: FitBlock[];
}

/**
 * The sonic logo: its own audio file, placed so that `anchorSeconds` into the
 * file (its first "plopp") lands on beat `anchorBeat` of the arrangement's
 * last bar. Everything is set by the creator per project; the customer only
 * drags the logo's start line.
 */
export interface LogoConfig {
  /** Track id (a track with `role: "logo"`). */
  track: string;
  /** Where the logo's anchor (first plopp) is inside the logo file, in seconds. */
  anchorSeconds: number;
  /** Beat of the last music bar the anchor lands on (1-indexed, e.g. 3). */
  anchorBeat: number;
  /** Mute these tracks/buses (e.g. the melody) this long before the anchor. Tone.js time: "2n" = half bar, "1m" = 1 bar. */
  mute?: { tracks: string[]; before: string } | null;
  /** Optional: fade all music (not the logo) down over this long, reaching silence at the anchor. */
  fadeMusic?: string | null;
}

export interface CompressorSettings {
  /** Off = ratio forced to 1 (transparent). */
  enabled: boolean;
  threshold: number; // dB
  ratio: number;
  attack: number; // s
  release: number; // s
  knee: number; // dB
}

export interface MasterConfig {
  gain?: number; // dB
  limiterThreshold?: number; // dB
  compressor?: Partial<CompressorSettings>;
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
  /**
   * Long-bounce projects: where each section lives in the original bounce,
   * as inclusive bar ranges, e.g. { "verse": [1, 8], "chorus": [9, 16] }.
   * When set, every track with a `file` plays the matching slice of its file
   * for each cue (a repeated section replays its slice).
   */
  sourceRegions?: Record<string, [number, number]>;
  /** Rules for "fit to length" (see src/project/fitToLength.ts). */
  fit?: FitConfig;
  logo?: LogoConfig;
  master?: MasterConfig;
}

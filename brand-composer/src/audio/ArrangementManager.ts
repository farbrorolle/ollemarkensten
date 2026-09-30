import * as Tone from "tone";
import type { Track } from "./Track.ts";
import { GainEnvelope } from "./GainEnvelope.ts";
import type { EnvelopePoint } from "./GainEnvelope.ts";
import type { CueConfig, SectionConfig, TransitionType } from "../project/types.ts";
import { regionChunks } from "../project/fitToLength.ts";

const CUT_FADE_SECONDS = 0.003; // "cut": just enough to avoid a hard click, no audible blend
/** Fade at the very end of the music (under the logo's ring-out). */
const END_FADE = "8n";

export interface ArrangementSegment {
  /** 1-indexed, inclusive. */
  startBar: number;
  /** 1-indexed, exclusive (can be loopBars + 1, i.e. the loop point). */
  endBar: number;
  sectionId: string;
  /** Transition used entering this segment. Meaningless for the arrangement's first segment. */
  transition: TransitionType;
  /** Long-bounce projects: source bar the segment starts reading from (see CueConfig.sourceBar). */
  sourceBar?: number;
}

/**
 * Where the arrangement sits on the transport. Bar 1 starts `musicStartSeconds`
 * into the transport (= into the film), which is how the logo can hit an exact
 * point in the film with a fixed tempo.
 */
export interface ArrangementTiming {
  musicStartSeconds: number;
  barSeconds: number;
}

/** Musical blend duration for a transition type -- scales with BPM since it's expressed in Tone.Time notation. */
function fadeSecondsFor(type: TransitionType): number {
  return type === "cut" ? CUT_FADE_SECONDS : Tone.Time("8n").toSeconds();
}

function buildSegments(cues: CueConfig[], loopBars: number): ArrangementSegment[] {
  const sorted = [...cues].sort((a, b) => a.bar - b.bar);
  return sorted.map((cue, i) => ({
    startBar: cue.bar,
    endBar: i + 1 < sorted.length ? sorted[i + 1]!.bar : loopBars + 1,
    sectionId: cue.section,
    transition: cue.transition ?? "crossfade",
    sourceBar: cue.sourceBar,
  }));
}

/**
 * Schedules a song's whole arrangement once, at project-load time, directly
 * on Tone.Transport -- this is arrangement, not a live performance tool:
 * every section change is a fixed cue at an absolute bar, not something
 * triggered by a button while playing.
 *
 * - Legacy (single-file) tracks get their on/off `sectionGain` ramped at
 *   every cue boundary.
 * - Sectioned tracks (different audio per section, same track name) get
 *   each section's own Player started/stopped for exactly its bar range,
 *   with a click-free crossfade at the edges (`takeGain`).
 * - Region tracks (long bounces) play the right slice of their file per
 *   section, alternating between two voices so a "crossfade" can overlap the
 *   outgoing section (which rings on for an 8th note) with the incoming one.
 *   Their gains are returned as GainEnvelopes (seek-safe).
 * - Every cue (other than the arrangement's first) carries a `transition`:
 *   "cut" (a few ms) or "crossfade" (an 8th note).
 *
 * Tone.Transport loops over [0, loopBars) so the arrangement repeats.
 * Player start/stop only needs to be scheduled once each -- Tone's
 * Source.sync() replays a synced source's recorded start/stop state on
 * every "loopStart"/"loopEnd" event. Gain automation (a plain AudioParam)
 * has no such built-in replay, so those are wrapped in Transport.schedule()
 * (a *repeating* transport event) instead of scheduled once directly.
 */
export class ArrangementManager {
  private segments: ArrangementSegment[] = [];
  private loopBars = 0;
  private currentSectionId: string | null = null;
  private timing: ArrangementTiming = { musicStartSeconds: 0, barSeconds: 2 };
  private onSectionChange?: (sectionId: string) => void;

  setOnSectionChange(callback: (sectionId: string) => void): void {
    this.onSectionChange = callback;
  }

  get activeSectionId(): string | null {
    return this.currentSectionId;
  }

  get arrangementSegments(): readonly ArrangementSegment[] {
    return this.segments;
  }

  get totalBars(): number {
    return this.loopBars;
  }

  get musicStartSeconds(): number {
    return this.timing.musicStartSeconds;
  }

  /** Transport seconds at which a (1-indexed, possibly fractional) arrangement bar starts. */
  barStartSeconds(bar: number): number {
    return this.timing.musicStartSeconds + (bar - 1) * this.timing.barSeconds;
  }

  schedule(
    cues: CueConfig[],
    loopBars: number,
    sections: Map<string, SectionConfig>,
    tracks: Track[],
    timing: ArrangementTiming,
    regions?: Record<string, [number, number]>,
  ): GainEnvelope[] {
    const envelopes: GainEnvelope[] = [];
    const segments = buildSegments(cues, loopBars);
    this.segments = segments;
    this.loopBars = loopBars;
    this.timing = timing;
    const transport = Tone.getTransport();
    // Numbers are transport seconds (converted to ticks by Tone at schedule time).
    const barTime = (bar: number): number => this.barStartSeconds(bar);

    transport.setLoopPoints(0, barTime(loopBars + 1));
    transport.loop = true;

    segments.forEach((segment, index) => {
      const section = sections.get(segment.sectionId);
      if (!section) throw new Error(`Arrangement references unknown section "${segment.sectionId}"`);

      const isFirst = index === 0;
      const fadeSeconds = fadeSecondsFor(segment.transition);

      transport.schedule((time) => {
        this.currentSectionId = segment.sectionId;
        Tone.getDraw().schedule(() => this.onSectionChange?.(segment.sectionId), time);
      }, barTime(segment.startBar));

      for (const track of tracks) {
        if (track.playMode === "oneshot" || track.playMode === "region") continue; // logo: AudioEngine; regions: below
        void isFirst;
        if (track.isSectioned) {
          const player = track.takeFor(segment.sectionId);
          const takeGain = track.takeGainFor(segment.sectionId);
          if (!player || !takeGain) continue; // this track has no audio for this section: stays silent

          player.start(barTime(segment.startBar));
          player.stop(barTime(segment.endBar));

          transport.schedule((time) => {
            takeGain.gain.cancelScheduledValues(time);
            takeGain.gain.setValueAtTime(0, time);
            takeGain.gain.linearRampToValueAtTime(1, time + fadeSeconds);
          }, barTime(segment.startBar));

          transport.schedule((time) => {
            takeGain.gain.cancelScheduledValues(time - fadeSeconds);
            takeGain.gain.setValueAtTime(1, time - fadeSeconds);
            takeGain.gain.linearRampToValueAtTime(0, time);
          }, barTime(segment.endBar));
        } else {
          const active = !section.activeTracks || section.activeTracks.includes(track.id);
          transport.schedule((time) => {
            track.sectionGain.gain.setValueAtTime(track.sectionGain.gain.value, time);
            track.sectionGain.gain.linearRampToValueAtTime(active ? 1 : 0, time + fadeSeconds);
          }, barTime(segment.startBar));
        }
      }
    });

    for (const track of tracks) {
      if (track.playMode === "region") envelopes.push(...this.scheduleRegionTrack(track, segments, timing, regions));
    }

    // Set the correct initial state up front, since the transport hasn't reached bar 1's
    // scheduled events yet on the very first frame after loading.
    const first = segments[0];
    if (first) {
      this.currentSectionId = first.sectionId;
      const firstSection = sections.get(first.sectionId)!;
      for (const track of tracks) {
        if (track.isSectioned || track.playMode !== "loop") continue; // takeGain defaults to 0; logo/regions aren't gated
        track.sectionGain.gain.value = !firstSection.activeTracks || firstSection.activeTracks.includes(track.id) ? 1 : 0;
      }
    }
    return envelopes;
  }

  /**
   * Long-bounce track: for every section, start the matching slice(s) of the
   * file on one of the track's two voices (alternating), and return each
   * voice's gain envelope: fade in at the section start (cut: a few ms,
   * crossfade: an 8th note) and -- when the *next* section crossfades -- let
   * this one ring on past the boundary while fading out.
   */
  private scheduleRegionTrack(
    track: Track,
    segments: ArrangementSegment[],
    timing: ArrangementTiming,
    regions?: Record<string, [number, number]>,
  ): GainEnvelope[] {
    const voices = [track.regionVoice(0), track.regionVoice(1)];
    const points: EnvelopePoint[][] = [[], []];
    const bufferSeconds = voices[0]?.player.loaded ? voices[0].player.buffer.duration : 0;
    if (!voices[0] || !voices[1] || !bufferSeconds) return [];

    segments.forEach((segment, index) => {
      const region = regions?.[segment.sectionId];
      if (!region) return;
      const voice = voices[index % 2]!;
      const pts = points[index % 2]!;
      const next = segments[index + 1];
      const fadeIn = index === 0 ? CUT_FADE_SECONDS : fadeSecondsFor(segment.transition);
      const fadeOut = next ? fadeSecondsFor(next.transition) : Tone.Time(END_FADE).toSeconds();
      const start = this.barStartSeconds(segment.startBar);
      const end = this.barStartSeconds(segment.endBar);

      const chunks = regionChunks(segment.startBar, segment.endBar - segment.startBar, region, segment.sourceBar);
      chunks.forEach((chunk, chunkIndex) => {
        // The file may be silence-trimmed: it starts at `fileStartBar` of the bounce.
        let startBar = chunk.startBar;
        let fromBar = chunk.sourceBar;
        let bars = chunk.bars;
        if (fromBar < track.fileStartBar) {
          const skip = track.fileStartBar - fromBar;
          startBar += skip;
          fromBar += skip;
          bars -= skip;
        }
        if (bars <= 0) return;
        const offset = (fromBar - track.fileStartBar) * timing.barSeconds;
        if (offset >= bufferSeconds) return;
        // The section's last chunk rings on through the outgoing fade (the bounce's own continuation).
        const ringOn = chunkIndex === chunks.length - 1 ? fadeOut : 0;
        const duration = Math.min(bars * timing.barSeconds + ringOn, bufferSeconds - offset);
        voice.player.start(this.barStartSeconds(startBar), offset, duration);
      });

      pts.push({ t: start, v: 0 }, { t: start + fadeIn, v: 1 }, { t: end, v: 1 }, { t: end + fadeOut, v: 0 });
    });

    return voices.map((voice, i) => new GainEnvelope(voice!.gain.gain, 0, points[i]!));
  }
}

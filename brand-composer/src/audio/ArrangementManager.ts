import * as Tone from "tone";
import type { Track } from "./Track.ts";
import { GainEnvelope } from "./GainEnvelope.ts";
import type { EnvelopePoint } from "./GainEnvelope.ts";
import type { CueConfig, SectionConfig, TransitionType } from "../project/types.ts";
import { regionChunks } from "../project/fitToLength.ts";
import { planSwells } from "../project/swellPlan.ts";
import type { PlayedChunk } from "../project/swellPlan.ts";

const CUT_FADE_SECONDS = 0.003; // "cut": just enough to avoid a hard click, no audible blend
/** Longest ring-out after a section (sustained pads/bass would otherwise hang on too long). */
const MAX_RING_OUT_SECONDS = 2;
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
      if (track.playMode !== "region") continue;
      if (track.isSwell) envelopes.push(...this.scheduleSwellTrack(track, segments, timing, regions));
      else envelopes.push(...this.scheduleRegionTrack(track, segments, timing, regions));
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

    const chunkLists = segments.map((segment) => {
      const region = regions?.[segment.sectionId];
      return region ? regionChunks(segment.startBar, segment.endBar - segment.startBar, region, segment.sourceBar) : [];
    });

    segments.forEach((segment, index) => {
      const chunks = chunkLists[index]!;
      if (!chunks.length) return;
      const voice = voices[index % 2]!;
      const pts = points[index % 2]!;
      const next = segments[index + 1];
      const lastChunk = chunks[chunks.length - 1]!;
      const sourceEnd = lastChunk.sourceBar + lastChunk.bars - 1;
      const prevChunks = chunkLists[index - 1];
      const prevLast = prevChunks?.[prevChunks.length - 1];
      const nextFirst = chunkLists[index + 1]?.[0];
      // Where the source simply continues (untouched form), join seamlessly: no ring-out, no fade.
      const continuesFromPrev = !!prevLast && prevLast.sourceBar + prevLast.bars === chunks[0]!.sourceBar;
      const continuesIntoNext = !!nextFirst && nextFirst.sourceBar === sourceEnd + 1;

      const fadeIn = index === 0 || continuesFromPrev ? CUT_FADE_SECONDS : fadeSecondsFor(segment.transition);
      // Ring-out: let the track sound on after the section, until its next attack or silence (analysed
      // per source bar), then fade. Swell-free tracks only; capped so sustained pads don't hang on.
      const tail = Math.min(MAX_RING_OUT_SECONDS, track.tails[sourceEnd - 1] ?? 0);
      const ringOut = continuesIntoNext
        ? CUT_FADE_SECONDS
        : next
          ? Math.max(CUT_FADE_SECONDS, track.tails.length ? tail : fadeSecondsFor(next.transition))
          : Math.max(Tone.Time(END_FADE).toSeconds(), tail);
      const start = this.barStartSeconds(segment.startBar);
      const end = this.barStartSeconds(segment.endBar);

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
        // The section's last chunk rings on (the bounce's own continuation after that bar).
        const ringOn = chunkIndex === chunks.length - 1 ? ringOut : 0;
        const duration = Math.min(bars * timing.barSeconds + ringOn, bufferSeconds - offset);
        voice.player.start(this.barStartSeconds(startBar), offset, duration);
      });

      pts.push(
        { t: start, v: 0 },
        { t: start + fadeIn, v: 1 },
        { t: end + ringOut * 0.5, v: 1 },
        { t: end + ringOut, v: 0 },
      );
    });

    return voices.map((voice, i) => new GainEnvelope(voice!.gain.gain, 0, points[i]!));
  }

  /**
   * Swell track: not played per section. Its swell clips are placed at the
   * transitions instead (src/project/swellPlan.ts): each lands on the downbeat
   * it led into in the bounce -- exactly as in the original where the form is
   * untouched, with a stand-in where the form was changed.
   */
  private scheduleSwellTrack(
    track: Track,
    segments: ArrangementSegment[],
    timing: ArrangementTiming,
    regions?: Record<string, [number, number]>,
  ): GainEnvelope[] {
    const voices = [track.regionVoice(0), track.regionVoice(1)];
    const bufferSeconds = voices[0]?.player.loaded ? voices[0].player.buffer.duration : 0;
    if (!voices[0] || !voices[1] || !bufferSeconds || !regions) return [];

    const chunks: PlayedChunk[] = [];
    for (const segment of segments) {
      const region = regions[segment.sectionId];
      if (!region) continue;
      regionChunks(segment.startBar, segment.endBar - segment.startBar, region, segment.sourceBar).forEach((c, i) =>
        chunks.push({ ...c, isCueStart: i === 0 }),
      );
    }
    const sectionStarts = Object.values(regions).map((r) => r[0]);
    const fileStart = (track.fileStartBar - 1) * timing.barSeconds;
    const musicEnd = this.barStartSeconds(this.loopBars + 1);

    planSwells(chunks, track.swellEvents, sectionStarts).forEach(({ event, arrangementBar }, i) => {
      const anchorTime = this.barStartSeconds(arrangementBar);
      if (anchorTime >= musicEnd) return;
      const anchorSource = (event.anchorBar - 1) * timing.barSeconds;
      let when = anchorTime - (anchorSource - event.start);
      let offset = event.start - fileStart;
      let duration = event.end - event.start;
      if (when < 0) {
        // Would start before 0: start part-way into the swell.
        offset -= when;
        duration += when;
        when = 0;
      }
      if (duration <= 0 || offset >= bufferSeconds) return;
      voices[i % 2]!.player.start(when, Math.max(0, offset), Math.min(duration, bufferSeconds - offset));
    });

    // Both voices always at full level (the clips carry their own shape).
    return voices.map((voice) => new GainEnvelope(voice!.gain.gain, 1, []));
  }
}

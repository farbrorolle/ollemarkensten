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
/** Into a *different* part (other chords): the outgoing part only rings on this long. */
const CROSSFADE_RING_OUT_SECONDS = 0.35;
/** "Cut": the outgoing part stops right at the boundary (just enough to avoid a click). */
const CUT_RING_OUT_SECONDS = 0.03;
/** How long the chosen tracks fade away under the logo after its hit. */
const LOGO_RING_OUT_SECONDS = 1.5;
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
  /** Tracks that cut (no ring-over) into this segment. */
  cutTracks?: string[];
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
    cutTracks: cue.cutTracks,
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
  /** Per section: tracks that never ring over into it (from the project config). */
  private sectionCutInto = new Map<string, string[]>();
  private segments: ArrangementSegment[] = [];
  private loopBars = 0;
  private currentSectionId: string | null = null;
  private timing: ArrangementTiming = { musicStartSeconds: 0, barSeconds: 2 };
  /** Beat of the last bar where the logo hits (swells are cut there); 0 = no logo. Set by AudioEngine. */
  swellCutoffBeat = 0;
  /** Tracks that may ring out under the logo (everything else stops at its hit). Set by AudioEngine. */
  logoRingOut = new Set<string>();

  /** Transport seconds of the logo's hit, or null without a logo. */
  private logoHitSeconds(timing: ArrangementTiming): number | null {
    if (!this.swellCutoffBeat) return null;
    return this.barStartSeconds(this.loopBars) + (this.swellCutoffBeat - 1) * (timing.barSeconds / 4);
  }
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
    this.sectionCutInto = new Map(Array.from(sections.values()).map((sec) => [sec.id, sec.cutInto ?? []]));
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

    // Tone players only accept starts in time order: anything that would go back in time on a
    // voice is moved to just after its previous start (and skipped if nothing is left of it).
    const lastStart = [-Infinity, -Infinity];
    const startIn = (v: number, when: number, offset: number, duration: number): boolean => {
      const min = lastStart[v]! + 1e-3;
      if (when < min) {
        const shift = min - when;
        if (duration - shift <= 0.01) return false;
        when = min;
        offset += shift;
        duration -= shift;
      }
      voices[v]!.player.start(when, offset, duration);
      lastStart[v] = when;
      return true;
    };
    const chunkLists = segments.map((segment) => {
      const region = regions?.[segment.sectionId];
      return region ? regionChunks(segment.startBar, segment.endBar - segment.startBar, region, segment.sourceBar) : [];
    });

    segments.forEach((segment, index) => {
      const chunks = chunkLists[index]!;
      if (!chunks.length) return;
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
      const barSec = timing.barSeconds;
      const beatSec = barSec / 4;

      // Pickups (upbeats, e.g. the melody leading into Main motif) belong to the section they lead
      // into. This section starts at a pickup target but the pickup wasn't just played: play it now,
      // over the end of the previous section.
      const firstSource = chunks[0]!.sourceBar;
      const ownPickup = !track.isSwell && index > 0 && !continuesFromPrev ? (track.pickups[String(firstSource)] ?? 0) : 0;
      // This section's end holds a pickup into a section that doesn't come next: silence it.
      const strayPickup = !track.isSwell && !continuesIntoNext ? (track.pickups[String(sourceEnd + 1)] ?? 0) : 0;

      const fadeIn = index === 0 || continuesFromPrev || ownPickup ? CUT_FADE_SECONDS : fadeSecondsFor(segment.transition);
      // Ring-out: let the track sound on after the section, until its next attack or silence (analysed
      // per source bar), then fade. Capped so sustained pads don't hang on.
      const tail = Math.min(MAX_RING_OUT_SECONDS, track.tails[sourceEnd - 1] ?? 0);
      // How far the outgoing part may ring over: a loop of the same part (same chords) as analysed;
      // into another part only briefly; not at all with a cut, or for tracks that must not ring
      // into that part (e.g. the bass into a part in other chords).
      const nextIsLoop = !!next && next.sectionId === segment.sectionId;
      const cutsHere =
        !!next &&
        (next.transition === "cut" || (next.cutTracks ?? this.sectionCutInto.get(next.sectionId) ?? []).includes(track.id));
      let ringOut = continuesIntoNext
        ? CUT_FADE_SECONDS
        : next
          ? cutsHere
            ? CUT_RING_OUT_SECONDS
            : nextIsLoop
              ? Math.max(CUT_FADE_SECONDS, track.tails.length ? tail : fadeSecondsFor(next.transition))
              : Math.max(fadeSecondsFor(next.transition), Math.min(CROSSFADE_RING_OUT_SECONDS, tail))
          : Tone.Time(END_FADE).toSeconds();
      const start = this.barStartSeconds(segment.startBar);
      let end = this.barStartSeconds(segment.endBar);
      let hold = 0.5; // share of the ring-out held at full level before fading
      if (strayPickup) {
        // Stop before the pickup bar(s) instead (a short ring-out of what came before).
        end -= strayPickup * barSec;
        ringOut = Math.max(CUT_FADE_SECONDS, Math.min(MAX_RING_OUT_SECONDS, track.tails[sourceEnd - strayPickup - 1] ?? 0));
      }
      let playPastEnd = Math.max(0, end + ringOut - this.barStartSeconds(segment.endBar));

      const hit = !next ? this.logoHitSeconds(timing) : null;
      if (hit !== null) {
        // The music meets the logo. Grooves/beats fade out quickly at the hit; tracks chosen to ring
        // out may let what is already sounding decay naturally into the logo (until their next attack
        // in the bounce, analysed per beat) -- nothing new starts under the logo.
        const beatsIn = Math.round((hit - this.barStartSeconds(lastChunk.startBar)) / beatSec);
        const sourceBeat = (lastChunk.sourceBar - 1) * 4 + beatsIn; // beat boundary in the bounce
        const natural = Math.min(LOGO_RING_OUT_SECONDS, track.beatTails[sourceBeat - 1] ?? 0);
        const rings = this.logoRingOut.has(track.id) && natural > 0.05;
        end = hit;
        ringOut = rings ? natural : Tone.Time(END_FADE).toSeconds();
        hold = rings ? 0.7 : 0;
        playPastEnd = Math.max(0, hit + ringOut - this.barStartSeconds(segment.endBar));
      }

      // (Scheduled before the section's own chunks: a player's starts must come in time order.)
      let pickedUp = false;
      if (ownPickup) {
        const pickStart = start - ownPickup * barSec;
        const offset = (firstSource - ownPickup - track.fileStartBar) * barSec;
        if (pickStart >= 0 && offset >= 0 && offset < bufferSeconds && startIn(index % 2, pickStart, offset, Math.min(ownPickup * barSec, bufferSeconds - offset))) {
          pts.push({ t: pickStart, v: 0 }, { t: pickStart + CUT_FADE_SECONDS, v: 1 });
          pickedUp = true;
        }
      }
      if (!pickedUp) pts.push({ t: start, v: 0 });

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
        const offset = (fromBar - track.fileStartBar) * barSec;
        if (offset >= bufferSeconds) return;
        // The section's last chunk rings on (the bounce's own continuation after that bar).
        const ringOn = chunkIndex === chunks.length - 1 ? playPastEnd : 0;
        const duration = Math.min(bars * barSec + ringOn, bufferSeconds - offset);
        if (duration > 0) startIn(index % 2, this.barStartSeconds(startBar), offset, duration);
      });

      pts.push(
        { t: start + fadeIn, v: 1 },
        { t: end + ringOut * hold, v: 1 },
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
    segments.forEach((segment, index) => {
      const region = regions[segment.sectionId];
      if (!region) return;
      // The same part straight after itself = a loop: no swell builds up into it.
      const repeatsPrevious = index > 0 && segments[index - 1]!.sectionId === segment.sectionId;
      regionChunks(segment.startBar, segment.endBar - segment.startBar, region, segment.sourceBar).forEach((c, i) =>
        chunks.push({ ...c, isCueStart: i === 0, isLoop: i > 0 || repeatsPrevious }),
      );
    });
    const sectionStarts = Object.values(regions).map((r) => r[0]);
    const fileStart = (track.fileStartBar - 1) * timing.barSeconds;
    const musicEnd = this.barStartSeconds(this.loopBars + 1);
    // Swells never ring into the logo: nothing of them after `swellCutoff` (the logo's hit when
    // there is one -- beat `swellCutoffBeat` of the last bar -- else the end of the music).
    const hit = this.logoHitSeconds(timing);
    const ringsOut = hit !== null && this.logoRingOut.has(track.id);
    const beatSec = timing.barSeconds / 4;
    let fadeEnd: number | null = null;

    const swellLast = [-Infinity, -Infinity];
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
      if (hit !== null) {
        // Nothing new starts under the logo; a swell already sounding stops at the hit, or -- if this
        // track may ring out -- decays naturally until its next attack in the bounce.
        if (when >= hit - 0.05) return;
        const sourceAtHit = event.start + (hit - when);
        const natural = Math.min(LOGO_RING_OUT_SECONDS, track.beatTails[Math.round(sourceAtHit / beatSec) - 1] ?? 0);
        const cutoff = hit + (ringsOut ? natural : 0.03);
        if (ringsOut && hit < when + duration) fadeEnd = Math.max(fadeEnd ?? 0, cutoff);
        duration = Math.min(duration, cutoff - when);
      } else {
        duration = Math.min(duration, musicEnd - when);
      }
      if (duration <= 0.02 || offset >= bufferSeconds) return;
      const v = i % 2;
      if (when < swellLast[v]! + 1e-3) return; // (starts must come in time order per voice)
      voices[v]!.player.start(when, Math.max(0, offset), Math.min(duration, bufferSeconds - offset));
      swellLast[v] = when;
    });

    // Both voices at full level (the clips carry their own shape) -- faded out under the logo if
    // this track rings out there.
    const fade =
      hit !== null
        ? ringsOut && fadeEnd !== null
          ? [{ t: hit + (fadeEnd - hit) * 0.7, v: 1 }, { t: fadeEnd, v: 0 }]
          : [{ t: hit, v: 1 }, { t: hit + 0.03, v: 0 }]
        : [];
    return voices.map((voice) => new GainEnvelope(voice!.gain.gain, 1, fade));
  }
}

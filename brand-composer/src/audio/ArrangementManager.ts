import * as Tone from "tone";
import { TAKE_FADE_SECONDS } from "./Track.ts";
import type { Track } from "./Track.ts";
import type { CueConfig, SectionConfig } from "../project/types.ts";

const GATE_RAMP_SECONDS = 0.008; // legacy on/off tracks: click-free ramp at a cue boundary

export interface ArrangementSegment {
  /** 1-indexed, inclusive. */
  startBar: number;
  /** 1-indexed, exclusive (can be loopBars + 1, i.e. the loop point). */
  endBar: number;
  sectionId: string;
}

function barTime(bar: number): string {
  return `${bar - 1}m`;
}

function buildSegments(cues: CueConfig[], loopBars: number): ArrangementSegment[] {
  const sorted = [...cues].sort((a, b) => a.bar - b.bar);
  return sorted.map((cue, i) => ({
    startBar: cue.bar,
    endBar: i + 1 < sorted.length ? sorted[i + 1]!.bar : loopBars + 1,
    sectionId: cue.section,
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
 *   with a short click-free crossfade at the edges (`takeGain`).
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

  schedule(cues: CueConfig[], loopBars: number, sections: Map<string, SectionConfig>, tracks: Track[]): void {
    const segments = buildSegments(cues, loopBars);
    this.segments = segments;
    this.loopBars = loopBars;
    const transport = Tone.getTransport();

    transport.setLoopPoints(0, barTime(loopBars + 1));
    transport.loop = true;

    for (const segment of segments) {
      const section = sections.get(segment.sectionId);
      if (!section) throw new Error(`Arrangement references unknown section "${segment.sectionId}"`);

      transport.schedule((time) => {
        this.currentSectionId = segment.sectionId;
        Tone.getDraw().schedule(() => this.onSectionChange?.(segment.sectionId), time);
      }, barTime(segment.startBar));

      for (const track of tracks) {
        if (track.isSectioned) {
          const player = track.takeFor(segment.sectionId);
          const takeGain = track.takeGainFor(segment.sectionId);
          if (!player || !takeGain) continue; // this track has no audio for this section: stays silent

          player.start(barTime(segment.startBar));
          player.stop(barTime(segment.endBar));

          transport.schedule((time) => {
            takeGain.gain.cancelScheduledValues(time);
            takeGain.gain.setValueAtTime(0, time);
            takeGain.gain.linearRampToValueAtTime(1, time + TAKE_FADE_SECONDS);
          }, barTime(segment.startBar));

          transport.schedule((time) => {
            takeGain.gain.cancelScheduledValues(time - TAKE_FADE_SECONDS);
            takeGain.gain.setValueAtTime(1, time - TAKE_FADE_SECONDS);
            takeGain.gain.linearRampToValueAtTime(0, time);
          }, barTime(segment.endBar));
        } else {
          const active = section.activeTracks.includes(track.id);
          transport.schedule((time) => {
            track.sectionGain.gain.setValueAtTime(track.sectionGain.gain.value, time);
            track.sectionGain.gain.linearRampToValueAtTime(active ? 1 : 0, time + GATE_RAMP_SECONDS);
          }, barTime(segment.startBar));
        }
      }
    }

    // Set the correct initial state up front, since the transport hasn't reached bar 1's
    // scheduled events yet on the very first frame after loading.
    const first = segments[0];
    if (first) {
      this.currentSectionId = first.sectionId;
      const firstSection = sections.get(first.sectionId)!;
      for (const track of tracks) {
        if (track.isSectioned) continue; // takeGain already defaults to 0; first fade-in handles it
        track.sectionGain.gain.value = firstSection.activeTracks.includes(track.id) ? 1 : 0;
      }
    }
  }
}

import * as Tone from "tone";
import type { Track } from "./Track.ts";
import type { SectionConfig } from "../project/types.ts";

const GAIN_RAMP_SECONDS = 0.008; // short crossfade so bar-locked gating never clicks

/**
 * Schedules section changes (which stems are audible) to land exactly on the
 * next bar boundary of Tone.Transport, ELIAS-style.
 *
 * Tracks are never stopped or restarted -- every Track.player is started
 * once, synced to the Transport, and left running for the whole session.
 * A transition only gates each track's `sectionGain`, sample-accurately
 * scheduled via Tone.Param automation. Because nothing is re-triggered,
 * every stem stays 100% phase-locked across transitions.
 */
export class TransitionManager {
  private readonly getTracks: () => Track[];
  private readonly sections = new Map<string, SectionConfig>();
  private currentSectionId: string | null = null;
  private onSectionChange?: (sectionId: string) => void;

  constructor(getTracks: () => Track[]) {
    this.getTracks = getTracks;
  }

  registerSection(section: SectionConfig): void {
    this.sections.set(section.id, section);
  }

  setOnSectionChange(callback: (sectionId: string) => void): void {
    this.onSectionChange = callback;
  }

  get activeSectionId(): string | null {
    return this.currentSectionId;
  }

  /** Applies a section immediately (no scheduling) -- used for initial project state. */
  applySectionImmediately(sectionId: string): void {
    const section = this.sections.get(sectionId);
    if (!section) throw new Error(`Unknown section: ${sectionId}`);
    for (const track of this.getTracks()) {
      track.sectionGain.gain.value = section.activeTracks.includes(track.id) ? 1 : 0;
    }
    this.currentSectionId = sectionId;
  }

  /**
   * Schedules a switch to `targetSectionId` on the next bar boundary
   * (default) or `bars` bars from now. Returns the Transport event id, so a
   * queued-but-not-yet-fired transition can be cancelled if needed.
   */
  queueTransition(targetSectionId: string, bars = 1): number {
    const section = this.sections.get(targetSectionId);
    if (!section) throw new Error(`Unknown section: ${targetSectionId}`);

    return Tone.getTransport().scheduleOnce((time) => {
      for (const track of this.getTracks()) {
        const target = section.activeTracks.includes(track.id) ? 1 : 0;
        track.sectionGain.gain.setValueAtTime(track.sectionGain.gain.value, time);
        track.sectionGain.gain.linearRampToValueAtTime(target, time + GAIN_RAMP_SECONDS);
      }
      this.currentSectionId = targetSectionId;
      Tone.getDraw().schedule(() => this.onSectionChange?.(targetSectionId), time);
    }, `+${bars}m`);
  }

  cancelTransition(eventId: number): void {
    Tone.getTransport().clear(eventId);
  }
}

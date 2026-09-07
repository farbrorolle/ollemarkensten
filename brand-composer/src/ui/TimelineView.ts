import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { SectionConfig } from "../project/types.ts";

export interface TimelineHandle {
  update(): void;
  /** Re-draws one track's waveform (call after a local file replaces its audio). */
  redrawTrack(trackId: string): void;
}

const LANE_HEIGHT = 40;
const WAVE_COLOR = "#7c5cff";

function drawWaveformSlice(ctx: CanvasRenderingContext2D, data: Float32Array, x0: number, x1: number, height: number): void {
  const w = Math.max(1, Math.round(x1) - Math.round(x0));
  const mid = height / 2;
  const step = Math.max(1, Math.floor(data.length / w));
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const start = x * step;
    for (let j = 0; j < step; j++) {
      const v = data[start + j];
      if (v === undefined) break;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) {
      min = 0;
      max = 0;
    }
    const px = Math.round(x0) + x + 0.5;
    ctx.moveTo(px, mid + min * mid);
    ctx.lineTo(px, mid + max * mid);
  }
  ctx.stroke();
}

/**
 * Renders the song's fixed arrangement as a horizontal timeline: a bar
 * ruler, section blocks (from ArrangementManager's scheduled cues), one
 * waveform lane per track, and a playhead synced to Tone.Transport. Clicking
 * anywhere in the lane area seeks the transport there.
 */
export function mountTimeline(root: HTMLElement, engine: AudioEngine, sections: SectionConfig[]): TimelineHandle {
  const totalBars = Math.max(1, engine.arrangement.totalBars);
  const segments = engine.arrangement.arrangementSegments;
  const sectionNameById = new Map(sections.map((s) => [s.id, s.name]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const tracks = Array.from(engine.tracks.values());

  root.innerHTML = `
    <div class="timeline-ruler" data-ruler></div>
    <div class="timeline-sections" data-sections></div>
    <div class="timeline-body" data-body>
      <div class="timeline-lanes" data-lanes></div>
      <div class="timeline-playhead" data-playhead></div>
    </div>
  `;

  const ruler = root.querySelector<HTMLElement>("[data-ruler]")!;
  const sectionsRow = root.querySelector<HTMLElement>("[data-sections]")!;
  const body = root.querySelector<HTMLElement>("[data-body]")!;
  const lanesEl = root.querySelector<HTMLElement>("[data-lanes]")!;
  const playhead = root.querySelector<HTMLElement>("[data-playhead]")!;

  const barStep = totalBars > 32 ? Math.ceil(totalBars / 32) : 1;
  for (let bar = 1; bar <= totalBars; bar += barStep) {
    const tick = document.createElement("span");
    tick.className = "timeline-tick";
    tick.textContent = String(bar);
    tick.style.left = `${((bar - 1) / totalBars) * 100}%`;
    ruler.appendChild(tick);
  }

  for (const segment of segments) {
    const block = document.createElement("div");
    block.className = "timeline-section-block";
    block.style.left = `${((segment.startBar - 1) / totalBars) * 100}%`;
    block.style.width = `${((segment.endBar - segment.startBar) / totalBars) * 100}%`;
    block.textContent = sectionNameById.get(segment.sectionId) ?? segment.sectionId;
    sectionsRow.appendChild(block);
  }

  const lanesByTrack = new Map<string, { canvas: HTMLCanvasElement; lane: HTMLElement }>();

  function drawTrackLane(track: Track, canvas: HTMLCanvasElement): void {
    const width = canvas.clientWidth || 800;
    canvas.width = width;
    canvas.height = LANE_HEIGHT;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, LANE_HEIGHT);
    ctx.strokeStyle = WAVE_COLOR;

    if (segments.length === 0) {
      // No arrangement scheduled: just show the whole buffer once, full width.
      const player = track.displayPlayer;
      if (player.loaded) drawWaveformSlice(ctx, player.buffer.getChannelData(0), 0, width, LANE_HEIGHT);
      return;
    }

    for (const segment of segments) {
      const x0 = ((segment.startBar - 1) / totalBars) * width;
      const x1 = ((segment.endBar - 1) / totalBars) * width;

      if (track.isSectioned) {
        const player = track.takeFor(segment.sectionId);
        if (!player?.loaded) continue;
        drawWaveformSlice(ctx, player.buffer.getChannelData(0), x0, x1, LANE_HEIGHT);
      } else {
        const player = track.displayPlayer;
        if (!player.loaded) continue;
        const section = sectionById.get(segment.sectionId);
        const active = section ? section.activeTracks.includes(track.id) : true;
        ctx.save();
        ctx.globalAlpha = active ? 1 : 0.15;
        drawWaveformSlice(ctx, player.buffer.getChannelData(0), x0, x1, LANE_HEIGHT);
        ctx.restore();
      }
    }
  }

  for (const track of tracks) {
    const lane = document.createElement("div");
    lane.className = "timeline-lane";
    lane.innerHTML = `<span class="timeline-lane-name">${track.name}</span><canvas></canvas>`;
    lanesEl.appendChild(lane);
    const canvas = lane.querySelector("canvas")!;
    lanesByTrack.set(track.id, { canvas, lane });
    drawTrackLane(track, canvas);
  }

  body.addEventListener("click", (event) => {
    const rect = body.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const loopSeconds = Tone.Time(`${totalBars}m`).toSeconds();
    Tone.getTransport().seconds = fraction * loopSeconds;
  });

  return {
    update() {
      const loopSeconds = Tone.Time(`${totalBars}m`).toSeconds();
      const fraction = loopSeconds > 0 ? (Tone.getTransport().seconds / loopSeconds) % 1 : 0;
      playhead.style.left = `${fraction * 100}%`;

      for (const track of tracks) {
        const entry = lanesByTrack.get(track.id);
        if (entry) entry.lane.classList.toggle("timeline-lane-muted", track.channel.mute);
      }
    },
    redrawTrack(trackId: string) {
      const track = engine.tracks.get(trackId);
      const entry = lanesByTrack.get(trackId);
      if (track && entry) drawTrackLane(track, entry.canvas);
    },
  };
}

import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { CueConfig, SectionConfig } from "../project/types.ts";

export interface TimelineHandle {
  update(): void;
  /** Re-draws one track's waveform (call after a local file replaces its audio). */
  redrawTrack(trackId: string): void;
}

interface EditableSegment {
  sectionId: string;
  lengthBars: number;
}

const LANE_HEIGHT = 40;
const WAVE_COLOR = "#7c5cff";
const DEFAULT_NEW_SEGMENT_BARS = 4;

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
 * Renders the song's arrangement as an editable horizontal timeline: a bar
 * ruler, section blocks you can drag to reorder, resize (drag the right
 * edge) or remove, a palette to append new section instances, one waveform
 * lane per track, and a playhead synced to Tone.Transport. Clicking the
 * lane area seeks the transport there.
 *
 * Every edit recomputes the arrangement's cue list from the current block
 * order/lengths and pushes it straight to AudioEngine.applyArrangement --
 * there's no separate "save" step.
 */
export function mountTimeline(root: HTMLElement, engine: AudioEngine, sections: SectionConfig[]): TimelineHandle {
  const sectionNameById = new Map(sections.map((s) => [s.id, s.name]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const tracks = Array.from(engine.tracks.values());

  let totalBars = Math.max(1, engine.arrangement.totalBars);
  let segments = engine.arrangement.arrangementSegments;
  let editableSegments: EditableSegment[] = segments.map((s) => ({
    sectionId: s.sectionId,
    lengthBars: s.endBar - s.startBar,
  }));

  root.innerHTML = `
    <div class="timeline-palette" data-palette></div>
    <div class="timeline-ruler" data-ruler></div>
    <div class="timeline-sections" data-sections></div>
    <div class="timeline-body" data-body>
      <div class="timeline-lanes" data-lanes></div>
      <div class="timeline-playhead" data-playhead></div>
    </div>
  `;

  const palette = root.querySelector<HTMLElement>("[data-palette]")!;
  const ruler = root.querySelector<HTMLElement>("[data-ruler]")!;
  const sectionsRow = root.querySelector<HTMLElement>("[data-sections]")!;
  const body = root.querySelector<HTMLElement>("[data-body]")!;
  const lanesEl = root.querySelector<HTMLElement>("[data-lanes]")!;
  const playhead = root.querySelector<HTMLElement>("[data-playhead]")!;

  for (const section of sections) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "timeline-palette-chip";
    chip.textContent = `+ ${section.name}`;
    chip.title = `Lägg till en ${section.name}-sektion i slutet av arrangemanget`;
    chip.addEventListener("click", () => {
      editableSegments.push({ sectionId: section.id, lengthBars: DEFAULT_NEW_SEGMENT_BARS });
      commit();
    });
    palette.appendChild(chip);
  }

  function renderRuler(): void {
    ruler.innerHTML = "";
    const barStep = totalBars > 32 ? Math.ceil(totalBars / 32) : 1;
    for (let bar = 1; bar <= totalBars; bar += barStep) {
      const tick = document.createElement("span");
      tick.className = "timeline-tick";
      tick.textContent = String(bar);
      tick.style.left = `${((bar - 1) / totalBars) * 100}%`;
      ruler.appendChild(tick);
    }
  }

  const blockEls: HTMLElement[] = [];
  let draggedIndex: number | null = null;
  let dropIndicatorEl: HTMLElement | null = null;

  function showDropIndicator(target: HTMLElement, before: boolean): void {
    if (!dropIndicatorEl) {
      dropIndicatorEl = document.createElement("div");
      dropIndicatorEl.className = "timeline-drop-indicator";
      sectionsRow.appendChild(dropIndicatorEl);
    }
    const rect = target.getBoundingClientRect();
    const rowRect = sectionsRow.getBoundingClientRect();
    dropIndicatorEl.style.left = `${(before ? rect.left : rect.right) - rowRect.left}px`;
  }

  function clearDropIndicator(): void {
    dropIndicatorEl?.remove();
    dropIndicatorEl = null;
  }

  /** Live, cheap re-flow of existing block elements' left/width during a resize drag (no DOM rebuild). */
  function reflowSectionPositions(): void {
    const liveTotal = editableSegments.reduce((sum, s) => sum + s.lengthBars, 0) || 1;
    let bar = 1;
    editableSegments.forEach((seg, i) => {
      const startBar = bar;
      bar += seg.lengthBars;
      const el = blockEls[i];
      if (!el) return;
      el.style.left = `${((startBar - 1) / liveTotal) * 100}%`;
      el.style.width = `${(seg.lengthBars / liveTotal) * 100}%`;
    });
  }

  function attachResize(handle: HTMLElement, index: number): void {
    handle.addEventListener("dragstart", (e) => e.preventDefault());
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startLength = editableSegments[index]!.lengthBars;
      const widthPx = body.getBoundingClientRect().width || 1;
      const barsPerPixel = totalBars / widthPx;

      const onMove = (ev: PointerEvent): void => {
        const deltaBars = Math.round((ev.clientX - startX) * barsPerPixel);
        editableSegments[index]!.lengthBars = Math.max(1, startLength + deltaBars);
        reflowSectionPositions();
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        commit();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  function attachDrag(block: HTMLElement, index: number): void {
    block.addEventListener("dragstart", (e) => {
      draggedIndex = index;
      block.classList.add("timeline-section-dragging");
      e.dataTransfer?.setData("text/plain", String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    block.addEventListener("dragend", () => {
      block.classList.remove("timeline-section-dragging");
      draggedIndex = null;
      clearDropIndicator();
    });
    block.addEventListener("dragover", (e) => {
      if (draggedIndex === null) return;
      e.preventDefault();
      const rect = block.getBoundingClientRect();
      showDropIndicator(block, e.clientX - rect.left < rect.width / 2);
    });
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      if (draggedIndex === null) return;
      const rect = block.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      let targetIndex = index + (before ? 0 : 1);
      const [moved] = editableSegments.splice(draggedIndex, 1);
      if (draggedIndex < targetIndex) targetIndex--;
      editableSegments.splice(targetIndex, 0, moved!);
      draggedIndex = null;
      clearDropIndicator();
      commit();
    });
  }

  function renderSections(): void {
    sectionsRow.innerHTML = "";
    blockEls.length = 0;
    let bar = 1;
    editableSegments.forEach((seg, index) => {
      const startBar = bar;
      bar += seg.lengthBars;

      const block = document.createElement("div");
      block.className = "timeline-section-block";
      block.draggable = true;
      block.style.left = `${((startBar - 1) / totalBars) * 100}%`;
      block.style.width = `${(seg.lengthBars / totalBars) * 100}%`;

      const label = document.createElement("span");
      label.className = "timeline-section-label";
      label.textContent = sectionNameById.get(seg.sectionId) ?? seg.sectionId;
      block.appendChild(label);

      if (editableSegments.length > 1) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "timeline-section-remove";
        removeBtn.textContent = "×";
        removeBtn.title = "Ta bort sektion";
        removeBtn.draggable = false;
        removeBtn.addEventListener("dragstart", (e) => e.preventDefault());
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          editableSegments.splice(index, 1);
          commit();
        });
        block.appendChild(removeBtn);
      }

      const resizeHandle = document.createElement("span");
      resizeHandle.className = "timeline-section-resize";
      resizeHandle.title = "Dra för att ändra längd";
      block.appendChild(resizeHandle);

      attachResize(resizeHandle, index);
      attachDrag(block, index);

      blockEls.push(block);
      sectionsRow.appendChild(block);
    });
  }

  function drawTrackLane(track: Track, canvas: HTMLCanvasElement): void {
    const width = canvas.clientWidth || 800;
    canvas.width = width;
    canvas.height = LANE_HEIGHT;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, LANE_HEIGHT);
    ctx.strokeStyle = WAVE_COLOR;

    if (segments.length === 0) {
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

  const lanesByTrack = new Map<string, { canvas: HTMLCanvasElement; lane: HTMLElement }>();
  for (const track of tracks) {
    const lane = document.createElement("div");
    lane.className = "timeline-lane";
    lane.innerHTML = `<span class="timeline-lane-name">${track.name}</span><canvas></canvas>`;
    lanesEl.appendChild(lane);
    const canvas = lane.querySelector("canvas")!;
    lanesByTrack.set(track.id, { canvas, lane });
    drawTrackLane(track, canvas);
  }

  function commit(): void {
    let bar = 1;
    const cues: CueConfig[] = editableSegments.map((seg) => {
      const cue = { bar, section: seg.sectionId };
      bar += seg.lengthBars;
      return cue;
    });
    const loopBars = Math.max(1, bar - 1);

    engine.applyArrangement(cues, loopBars);
    totalBars = Math.max(1, engine.arrangement.totalBars);
    segments = engine.arrangement.arrangementSegments;

    renderRuler();
    renderSections();
    for (const track of tracks) {
      const entry = lanesByTrack.get(track.id);
      if (entry) drawTrackLane(track, entry.canvas);
    }
  }

  renderRuler();
  renderSections();

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

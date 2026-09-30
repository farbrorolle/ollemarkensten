import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { CueConfig, SectionConfig, TransitionType } from "../project/types.ts";
import type { FilmInfo, VideoSync } from "../video/VideoSync.ts";
import { formatFilmTime, formatSecondsSv } from "../video/syncMath.ts";
import { regionChunks } from "../project/fitToLength.ts";

export interface TimelineHandle {
  update(): void;
  /** Re-reads the arrangement from the engine (after a fit or any change made elsewhere) and redraws. */
  refresh(): void;
  /** Re-draws one track's waveform (call after a local file replaces its audio). */
  redrawTrack(trackId: string): void;
}

interface EditableSegment {
  sourceBar?: number;
  sectionId: string;
  lengthBars: number;
  /** Transition used entering this segment. Meaningless (and hidden) for whichever segment is currently first. */
  transition: TransitionType;
}

const LANE_HEIGHT = 40;
const MIX_LANE_HEIGHT = 64;
const WAVE_COLOR = "#7c5cff";
const FILM_WAVE_COLOR = "#ffb84d";
const LOGO_WAVE_COLOR = "#33d17a";
const DIM_TEXT_COLOR = "#8b8fa3";
const DEFAULT_NEW_SEGMENT_BARS = 4;
const TRANSITION_LABELS: Record<TransitionType, string> = {
  cut: "Cut",
  crossfade: "Crossfade",
};

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

/** Draws samples [s0, s1) of `data` into the x-range [x0, x1) (min/max per pixel column). */
function drawBufferRange(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  s0: number,
  s1: number,
  x0: number,
  x1: number,
  height: number,
): void {
  const px0 = Math.round(x0);
  const w = Math.max(1, Math.round(x1) - px0);
  const mid = height / 2;
  const perPx = (s1 - s0) / w;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.max(0, Math.floor(s0 + x * perPx));
    const b = Math.min(data.length, Math.max(a + 1, Math.floor(s0 + (x + 1) * perPx)));
    let min = 0;
    let max = 0;
    for (let i = a; i < b; i++) {
      const v = data[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(px0 + x + 0.5, mid + min * mid);
    ctx.lineTo(px0 + x + 0.5, mid + max * mid);
  }
  ctx.stroke();
}

/**
 * Draws the film's own audio (min/max peaks over the whole film) on the
 * timeline's time scale: x = 0..width spans `spanSeconds` of music, so the
 * waveform ends exactly where the film ends.
 */
function drawFilmPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  filmSeconds: number,
  spanSeconds: number,
  width: number,
  height: number,
): void {
  const buckets = peaks.length / 2;
  const mid = height / 2;
  const xEnd = Math.min(width, Math.ceil((filmSeconds / spanSeconds) * width));
  ctx.beginPath();
  for (let x = 0; x < xEnd; x++) {
    const b0 = Math.floor((((x / width) * spanSeconds) / filmSeconds) * buckets);
    const b1 = Math.min(buckets, Math.max(b0 + 1, Math.floor(((((x + 1) / width) * spanSeconds) / filmSeconds) * buckets)));
    let min = 0;
    let max = 0;
    for (let b = b0; b < b1; b++) {
      min = Math.min(min, peaks[b * 2]!);
      max = Math.max(max, peaks[b * 2 + 1]!);
    }
    ctx.moveTo(x + 0.5, mid + min * mid);
    ctx.lineTo(x + 0.5, mid + max * mid);
  }
  ctx.stroke();
}

function filmAudioMessage(info: FilmInfo): string {
  switch (info.audioState) {
    case "decoding":
      return "Läser in filmens ljud…";
    case "none":
      return "Hittade inget ljudspår i filmen";
    case "too-long":
      return "Filmen är för lång för att visa ljudvågen";
    default:
      return "";
  }
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
export function mountTimeline(
  root: HTMLElement,
  engine: AudioEngine,
  sections: SectionConfig[],
  film?: VideoSync,
): TimelineHandle {
  const sectionNameById = new Map(sections.map((s) => [s.id, s.name]));
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const tracks = Array.from(engine.tracks.values());

  let totalBars = Math.max(1, engine.arrangement.totalBars);
  let segments = engine.arrangement.arrangementSegments;
  const readSegments = (): EditableSegment[] =>
    engine.arrangement.arrangementSegments.map((s) => ({
      sectionId: s.sectionId,
      lengthBars: s.endBar - s.startBar,
      transition: s.transition,
      sourceBar: s.sourceBar,
    }));
  let editableSegments: EditableSegment[] = readSegments();

  /**
   * Timeline length in transport (= film) seconds: the music (incl. any late start and the logo's
   * ring-out) or the film, whichever is longer. Without a film, logo projects get some headroom so
   * the logo line can be dragged later.
   */
  const computeSpan = (): number => {
    const music = engine.arrangementSeconds;
    const filmSeconds = film?.info?.duration;
    const content = Math.max(music, filmSeconds ?? 0);
    // Headroom after the music/film so the length can be dragged longer.
    return Math.max(0.001, engine.canFit ? content * 1.2 : content);
  };
  let spanSeconds = computeSpan();
  /** x position (0..1) of a transport time, and of the start of a (1-indexed) arrangement bar. */
  const xOfSeconds = (seconds: number): number => seconds / spanSeconds;
  const xOfBar = (bar: number): number => xOfSeconds(engine.barStartSeconds(bar));

  root.classList.add("timeline-mode-block");
  root.innerHTML = `
    <div class="timeline-toolbar">
      <button type="button" class="btn" data-mode-toggle>Visa sektioner</button>
      <span class="timeline-toolbar-status" data-status></span>
    </div>
    <div class="timeline-palette" data-palette></div>
    <div class="timeline-ruler" data-ruler></div>
    <div class="timeline-sections" data-sections></div>
    <div class="timeline-body" data-body>
      <div class="timeline-lanes" data-lanes></div>
      <div class="timeline-overlay" data-overlay>
        <div class="timeline-lead-in" data-lead-in hidden><span class="timeline-lead-in-label" data-lead-in-label></span></div>
        <div class="timeline-after-film" data-after-film hidden></div>
        <div class="timeline-logo-anchor" data-logo-anchor hidden>
          <span class="timeline-logo-anchor-label" data-logo-anchor-label></span>
          <span class="timeline-logo-anchor-handle" data-logo-anchor-handle></span>
        </div>
        <div class="timeline-film-end" data-film-end hidden><span class="timeline-film-end-label" data-film-end-label></span></div>
        <div class="timeline-music-block" data-music-block>
          <span class="timeline-music-block-label" data-music-block-label></span>
          <span class="timeline-music-block-handle" data-music-block-handle title="Dra för att ändra musikens längd"></span>
        </div>
        <div class="timeline-playhead" data-playhead></div>
      </div>
    </div>
    <div class="timeline-segment-list" data-segment-list></div>
  `;

  const palette = root.querySelector<HTMLElement>("[data-palette]")!;
  const ruler = root.querySelector<HTMLElement>("[data-ruler]")!;
  const sectionsRow = root.querySelector<HTMLElement>("[data-sections]")!;
  const body = root.querySelector<HTMLElement>("[data-body]")!;
  const lanesEl = root.querySelector<HTMLElement>("[data-lanes]")!;
  const playhead = root.querySelector<HTMLElement>("[data-playhead]")!;
  // Playhead/markers live in an overlay that spans exactly the waveform canvases (right of the lane names),
  // so they line up with the waveforms, the ruler and the section blocks.
  const overlay = root.querySelector<HTMLElement>("[data-overlay]")!;
  const afterFilm = root.querySelector<HTMLElement>("[data-after-film]")!;
  const filmEnd = root.querySelector<HTMLElement>("[data-film-end]")!;
  const filmEndLabel = root.querySelector<HTMLElement>("[data-film-end-label]")!;
  const leadIn = root.querySelector<HTMLElement>("[data-lead-in]")!;
  const leadInLabel = root.querySelector<HTMLElement>("[data-lead-in-label]")!;
  const logoAnchor = root.querySelector<HTMLElement>("[data-logo-anchor]")!;
  const logoAnchorLabel = root.querySelector<HTMLElement>("[data-logo-anchor-label]")!;
  const logoAnchorHandle = root.querySelector<HTMLElement>("[data-logo-anchor-handle]")!;
  const modeToggle = root.querySelector<HTMLButtonElement>("[data-mode-toggle]")!;
  const statusEl = root.querySelector<HTMLElement>("[data-status]")!;
  const musicBlock = root.querySelector<HTMLElement>("[data-music-block]")!;
  const musicBlockLabel = root.querySelector<HTMLElement>("[data-music-block-label]")!;
  const musicBlockHandle = root.querySelector<HTMLElement>("[data-music-block-handle]")!;

  // Main view = the music as one block; the section view is secondary.
  let showSections = false;
  modeToggle.addEventListener("click", () => {
    showSections = !showSections;
    root.classList.toggle("timeline-mode-block", !showSections);
    root.classList.toggle("timeline-mode-sections", showSections);
    modeToggle.textContent = showSections ? "Dölj sektioner" : "Visa sektioner";
    redrawAll(); // canvases that were hidden have no width until shown
  });
  const segmentList = root.querySelector<HTMLElement>("[data-segment-list]")!;

  for (const section of sections) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "timeline-palette-chip";
    chip.textContent = `+ ${section.name}`;
    chip.title = `Lägg till en ${section.name}-sektion i slutet av arrangemanget`;
    chip.addEventListener("click", () => {
      editableSegments.push({ sectionId: section.id, lengthBars: DEFAULT_NEW_SEGMENT_BARS, transition: "crossfade" });
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
      tick.style.left = `${xOfBar(bar) * 100}%`;
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
    let bar = 1;
    editableSegments.forEach((seg, i) => {
      const startBar = bar;
      bar += seg.lengthBars;
      const el = blockEls[i];
      if (!el) return;
      el.style.left = `${xOfBar(startBar) * 100}%`;
      el.style.width = `${(xOfBar(startBar + seg.lengthBars) - xOfBar(startBar)) * 100}%`;
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
      const widthPx = overlay.getBoundingClientRect().width || 1;
      const barsPerPixel = spanSeconds / engine.barSeconds / widthPx;

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
      block.style.left = `${xOfBar(startBar) * 100}%`;
      block.style.width = `${(xOfBar(startBar + seg.lengthBars) - xOfBar(startBar)) * 100}%`;

      const label = document.createElement("span");
      label.className = "timeline-section-label";
      label.textContent = sectionNameById.get(seg.sectionId) ?? seg.sectionId;
      block.appendChild(label);

      if (index > 0) {
        const transitionSelect = document.createElement("select");
        transitionSelect.className = "timeline-section-transition";
        transitionSelect.title = "Övergång in i den här sektionen";
        transitionSelect.draggable = false;
        for (const [value, text] of Object.entries(TRANSITION_LABELS)) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          if (value === seg.transition) option.selected = true;
          transitionSelect.appendChild(option);
        }
        transitionSelect.addEventListener("pointerdown", (e) => e.stopPropagation());
        transitionSelect.addEventListener("dragstart", (e) => e.preventDefault());
        transitionSelect.addEventListener("change", () => {
          editableSegments[index]!.transition = transitionSelect.value as TransitionType;
          commit();
        });
        block.appendChild(transitionSelect);
      }

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

  /**
   * A plain, full-width list mirroring the timeline blocks with the same
   * edits (length, order, remove) as normal buttons -- unlike the drag
   * gestures on the blocks above, this works reliably on touch/mobile.
   */
  function renderSegmentList(): void {
    segmentList.innerHTML = "";
    editableSegments.forEach((seg, index) => {
      const row = document.createElement("div");
      row.className = "segment-row";

      const name = document.createElement("span");
      name.className = "segment-row-name";
      name.textContent = sectionNameById.get(seg.sectionId) ?? seg.sectionId;
      row.appendChild(name);

      const lengthGroup = document.createElement("span");
      lengthGroup.className = "segment-row-length";
      const decBtn = document.createElement("button");
      decBtn.type = "button";
      decBtn.className = "btn btn-step";
      decBtn.textContent = "−";
      decBtn.title = "Korta av en takt";
      decBtn.addEventListener("click", () => {
        seg.lengthBars = Math.max(1, seg.lengthBars - 1);
        commit();
      });
      const barsLabel = document.createElement("span");
      barsLabel.className = "segment-row-bars";
      barsLabel.textContent = `${seg.lengthBars} takt${seg.lengthBars === 1 ? "" : "er"}`;
      const incBtn = document.createElement("button");
      incBtn.type = "button";
      incBtn.className = "btn btn-step";
      incBtn.textContent = "+";
      incBtn.title = "Förläng en takt";
      incBtn.addEventListener("click", () => {
        seg.lengthBars += 1;
        commit();
      });
      lengthGroup.append(decBtn, barsLabel, incBtn);
      row.appendChild(lengthGroup);

      const moveGroup = document.createElement("span");
      moveGroup.className = "segment-row-move";
      const leftBtn = document.createElement("button");
      leftBtn.type = "button";
      leftBtn.className = "btn btn-step";
      leftBtn.textContent = "◀";
      leftBtn.title = "Flytta tidigare i arrangemanget";
      leftBtn.disabled = index === 0;
      leftBtn.addEventListener("click", () => {
        if (index === 0) return;
        [editableSegments[index - 1], editableSegments[index]] = [editableSegments[index]!, editableSegments[index - 1]!];
        commit();
      });
      const rightBtn = document.createElement("button");
      rightBtn.type = "button";
      rightBtn.className = "btn btn-step";
      rightBtn.textContent = "▶";
      rightBtn.title = "Flytta senare i arrangemanget";
      rightBtn.disabled = index === editableSegments.length - 1;
      rightBtn.addEventListener("click", () => {
        if (index === editableSegments.length - 1) return;
        [editableSegments[index], editableSegments[index + 1]] = [editableSegments[index + 1]!, editableSegments[index]!];
        commit();
      });
      moveGroup.append(leftBtn, rightBtn);
      row.appendChild(moveGroup);

      if (editableSegments.length > 1) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-step";
        removeBtn.textContent = "×";
        removeBtn.title = "Ta bort sektion";
        removeBtn.addEventListener("click", () => {
          editableSegments.splice(index, 1);
          commit();
        });
        row.appendChild(removeBtn);
      }

      segmentList.appendChild(row);
    });
  }

  function drawTrackLane(track: Track, canvas: HTMLCanvasElement): void {
    const width = canvas.clientWidth || 800;
    canvas.width = width;
    canvas.height = LANE_HEIGHT;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, LANE_HEIGHT);
    drawTrackInto(ctx, track, width, LANE_HEIGHT);
  }

  function drawTrackInto(ctx: CanvasRenderingContext2D, track: Track, width: number, LANE_HEIGHT: number): void {
    ctx.strokeStyle = WAVE_COLOR;

    if (track.playMode === "oneshot") {
      // The sonic logo: its whole file, where it will actually play.
      const player = track.filePlayer;
      const start = engine.logoStartSeconds;
      if (!player?.loaded || start === null) return;
      ctx.strokeStyle = LOGO_WAVE_COLOR;
      const data = player.buffer.getChannelData(0);
      const skip = Math.max(0, -start);
      drawBufferRange(ctx, data, skip * player.buffer.sampleRate, data.length, xOfSeconds(Math.max(0, start)) * width, xOfSeconds(start + player.buffer.duration) * width, LANE_HEIGHT);
      return;
    }

    if (segments.length === 0) {
      const player = track.displayPlayer;
      if (player.loaded) drawWaveformSlice(ctx, player.buffer.getChannelData(0), 0, width, LANE_HEIGHT);
      return;
    }

    for (const segment of segments) {
      const x0 = xOfBar(segment.startBar) * width;
      const x1 = xOfBar(segment.endBar) * width;

      if (track.playMode === "region") {
        const player = track.filePlayer;
        const region = engine.sourceRegionFor(segment.sectionId);
        if (!player?.loaded || !region) continue;
        const data = player.buffer.getChannelData(0);
        const samplesPerBar = engine.barSeconds * player.buffer.sampleRate;
        for (const chunk of regionChunks(segment.startBar, segment.endBar - segment.startBar, region, segment.sourceBar)) {
          const s0 = (chunk.sourceBar - track.fileStartBar) * samplesPerBar;
          drawBufferRange(ctx, data, s0, s0 + chunk.bars * samplesPerBar, xOfBar(chunk.startBar) * width, xOfBar(chunk.startBar + chunk.bars) * width, LANE_HEIGHT);
        }
        continue;
      }

      if (track.isSectioned) {
        const player = track.takeFor(segment.sectionId);
        if (!player?.loaded) continue;
        drawWaveformSlice(ctx, player.buffer.getChannelData(0), x0, x1, LANE_HEIGHT);
      } else {
        const player = track.displayPlayer;
        if (!player.loaded) continue;
        const section = sectionById.get(segment.sectionId);
        const active = section?.activeTracks ? section.activeTracks.includes(track.id) : true;
        ctx.save();
        ctx.globalAlpha = active ? 1 : 0.15;
        drawWaveformSlice(ctx, player.buffer.getChannelData(0), x0, x1, LANE_HEIGHT);
        ctx.restore();
      }
    }
  }

  // The film's own audio track, shown as the top lane while a film is loaded.
  const filmLane = document.createElement("div");
  filmLane.className = "timeline-lane timeline-lane-film";
  filmLane.hidden = true;
  filmLane.innerHTML = `<button type="button" class="timeline-lane-name timeline-film-toggle"></button><canvas></canvas>`;
  lanesEl.appendChild(filmLane);
  const filmToggle = filmLane.querySelector<HTMLButtonElement>("button")!;
  const filmCanvas = filmLane.querySelector("canvas")!;
  filmToggle.addEventListener("click", (event) => {
    event.stopPropagation(); // don't also seek the transport
    film?.setAudioOn(!film.audioOn);
  });
  let filmDrawKey = "";
  let filmToggleText = "";
  let filmEndText = "";

  function drawFilmLane(info: FilmInfo, spanSeconds: number): void {
    const width = filmCanvas.clientWidth || 800;
    const key = `${width}|${spanSeconds.toFixed(3)}|${info.duration}|${info.audioState}`;
    if (key === filmDrawKey) return;
    filmDrawKey = key;
    filmCanvas.width = width;
    filmCanvas.height = LANE_HEIGHT;
    const ctx = filmCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, LANE_HEIGHT);
    if (info.peaks) {
      ctx.strokeStyle = FILM_WAVE_COLOR;
      drawFilmPeaks(ctx, info.peaks, info.duration, spanSeconds, width, LANE_HEIGHT);
    } else {
      ctx.fillStyle = DIM_TEXT_COLOR;
      ctx.font = "12px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(filmAudioMessage(info), 8, LANE_HEIGHT / 2);
    }
  }

  function updateFilm(spanSeconds: number): void {
    const info = film?.info ?? null;
    filmLane.hidden = !info;
    filmEnd.hidden = !info;
    if (!info || spanSeconds <= 0) {
      afterFilm.hidden = true;
      filmDrawKey = "";
      return;
    }

    drawFilmLane(info, spanSeconds);
    const audioOn = film!.audioOn;
    filmLane.classList.toggle("timeline-lane-muted", !audioOn);
    const toggleText = audioOn ? "🔊 Filmljud" : "🔇 Filmljud";
    if (toggleText !== filmToggleText) {
      filmToggle.textContent = toggleText;
      filmToggle.title = audioOn ? "Filmens eget ljud är PÅ – klicka för att stänga av" : "Filmens eget ljud är AV – klicka för att slå på";
      filmToggleText = toggleText;
    }

    const fraction = info.duration / spanSeconds;
    const beyond = fraction > 1.0005;
    filmEnd.style.left = `${Math.min(1, fraction) * 100}%`;
    filmEnd.classList.toggle("timeline-film-end-beyond", beyond);
    const endText = beyond ? `Filmen fortsätter ${formatSecondsSv(info.duration - spanSeconds)} s →` : "Filmen slutar";
    if (endText !== filmEndText) {
      filmEndLabel.textContent = endText;
      filmEndText = endText;
    }
    afterFilm.hidden = fraction >= 0.9995;
    afterFilm.style.left = `${Math.min(1, fraction) * 100}%`;
  }

  // All of the music in one lane (the customer's main view): every folder faintly on top of each other.
  const mixLane = document.createElement("div");
  mixLane.className = "timeline-lane timeline-lane-mix";
  mixLane.innerHTML = `<span class="timeline-lane-name">Musik</span><canvas></canvas>`;
  lanesEl.appendChild(mixLane);
  const mixCanvas = mixLane.querySelector("canvas")!;

  function drawMixLane(): void {
    const width = mixCanvas.clientWidth || 800;
    mixCanvas.width = width;
    mixCanvas.height = MIX_LANE_HEIGHT;
    const ctx = mixCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, MIX_LANE_HEIGHT);
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (const track of tracks) {
      if (track.isLogo) continue;
      drawTrackInto(ctx, track, width, MIX_LANE_HEIGHT);
    }
    ctx.globalAlpha = 0.9;
    for (const track of tracks) if (track.isLogo) drawTrackInto(ctx, track, width, MIX_LANE_HEIGHT);
    ctx.restore();
  }

  const lanesByTrack = new Map<string, { canvas: HTMLCanvasElement; lane: HTMLElement }>();
  for (const track of tracks) {
    const lane = document.createElement("div");
    lane.className = "timeline-lane timeline-lane-track";
    lane.innerHTML = `<span class="timeline-lane-name">${track.name}</span><canvas></canvas>`;
    lanesEl.appendChild(lane);
    const canvas = lane.querySelector("canvas")!;
    lanesByTrack.set(track.id, { canvas, lane });
    drawTrackLane(track, canvas);
  }
  drawMixLane();

  function commit(): void {
    let bar = 1;
    const cues: CueConfig[] = editableSegments.map((seg) => {
      const cue: CueConfig = { bar, section: seg.sectionId, transition: seg.transition };
      if (seg.sourceBar !== undefined) cue.sourceBar = seg.sourceBar;
      bar += seg.lengthBars;
      return cue;
    });
    const loopBars = Math.max(1, bar - 1);

    engine.applyArrangement(cues, loopBars); // -> onArrangementChange -> redrawAll()
  }

  function redrawAll(): void {
    totalBars = Math.max(1, engine.arrangement.totalBars);
    segments = engine.arrangement.arrangementSegments;
    editableSegments = readSegments();
    spanSeconds = computeSpan();

    renderRuler();
    renderSections();
    renderSegmentList();
    if (showSections) {
      for (const track of tracks) {
        const entry = lanesByTrack.get(track.id);
        if (entry) drawTrackLane(track, entry.canvas);
      }
    } else {
      drawMixLane();
    }
  }

  // --- Music block: drag its right edge to set the length. The music is re-arranged so the
  // logo ends exactly there (same as dragging the logo line, just thinking in "total length").
  let draggingEnd: number | null = null;
  musicBlockHandle.addEventListener("pointerdown", (e) => {
    if (!engine.canFit) return;
    e.preventDefault();
    e.stopPropagation();
    musicBlockHandle.setPointerCapture(e.pointerId);
    const rect = overlay.getBoundingClientRect();
    const minEnd = engine.musicStartSeconds + 2 * engine.barSeconds;
    const toSeconds = (clientX: number): number =>
      Math.max(minEnd, Math.min(1, (clientX - rect.left) / rect.width) * spanSeconds);
    draggingEnd = toSeconds(e.clientX);
    const onMove = (ev: PointerEvent): void => {
      draggingEnd = toSeconds(ev.clientX);
    };
    const onUp = (): void => {
      musicBlockHandle.removeEventListener("pointermove", onMove);
      musicBlockHandle.removeEventListener("pointerup", onUp);
      musicBlockHandle.removeEventListener("pointercancel", onUp);
      const end = draggingEnd;
      draggingEnd = null;
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 0);
      const logo = engine.logoSettings;
      if (end !== null && logo) engine.fitToAnchor(end - (engine.logoDurationSeconds - logo.anchorSeconds));
    };
    musicBlockHandle.addEventListener("pointermove", onMove);
    musicBlockHandle.addEventListener("pointerup", onUp);
    musicBlockHandle.addEventListener("pointercancel", onUp);
  });

  let lastBlockText = "";
  function updateMusicBlock(): void {
    const start = engine.musicStartSeconds;
    const end = draggingEnd ?? engine.arrangementSeconds;
    musicBlock.style.left = `${xOfSeconds(start) * 100}%`;
    musicBlock.style.top = `${mixLane.offsetTop}px`;
    musicBlock.style.height = `${mixLane.offsetHeight}px`;
    musicBlock.style.width = `${Math.max(0, xOfSeconds(end) - xOfSeconds(start)) * 100}%`;
    musicBlock.classList.toggle("timeline-music-block-dragging", draggingEnd !== null);
    musicBlockHandle.hidden = !engine.canFit;
    const text =
      draggingEnd !== null
        ? `Släpp för att anpassa till ${formatFilmTime(end)}`
        : `${formatFilmTime(end - start)} · ${totalBars} takter`;
    if (text !== lastBlockText) {
      musicBlockLabel.textContent = text;
      statusEl.textContent = draggingEnd !== null ? "" : `Musiken slutar ${formatFilmTime(end)}`;
      lastBlockText = text;
    }
  }

  renderRuler();
  renderSections();
  renderSegmentList();
  engine.onArrangementChange(redrawAll);
  film?.onChange(() => {
    if (Math.abs(computeSpan() - spanSeconds) > 1e-3) redrawAll();
  });

  body.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    Tone.getTransport().seconds = fraction * spanSeconds;
  });

  // --- Logo anchor: the line where the logo's first "plopp" hits. Drag it to a sync point in the
  // film; on release the music is re-arranged (fitToAnchor) so the logo lands exactly there.
  let draggingAnchor: number | null = null;
  let suppressClick = false;
  logoAnchorHandle.addEventListener("pointerdown", (e) => {
    if (!engine.canFit) return;
    e.preventDefault();
    e.stopPropagation();
    logoAnchorHandle.setPointerCapture(e.pointerId);
    const rect = overlay.getBoundingClientRect();
    const toSeconds = (clientX: number): number =>
      Math.max(0.5, Math.min(1, (clientX - rect.left) / rect.width) * spanSeconds);
    draggingAnchor = toSeconds(e.clientX);
    const onMove = (ev: PointerEvent): void => {
      draggingAnchor = toSeconds(ev.clientX);
    };
    const onUp = (): void => {
      logoAnchorHandle.removeEventListener("pointermove", onMove);
      logoAnchorHandle.removeEventListener("pointerup", onUp);
      logoAnchorHandle.removeEventListener("pointercancel", onUp);
      const target = draggingAnchor;
      draggingAnchor = null;
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 0);
      if (target !== null) engine.fitToAnchor(target); // -> onArrangementChange -> redrawAll()
    };
    logoAnchorHandle.addEventListener("pointermove", onMove);
    logoAnchorHandle.addEventListener("pointerup", onUp);
    logoAnchorHandle.addEventListener("pointercancel", onUp);
  });

  let lastAnchorText = "";
  function updateLogo(): void {
    const anchor = draggingAnchor ?? engine.logoAnchorSeconds;
    logoAnchor.hidden = anchor === null;
    logoAnchor.classList.toggle("timeline-logo-anchor-dragging", draggingAnchor !== null);
    logoAnchor.classList.toggle("timeline-logo-anchor-fixed", !engine.canFit);
    if (anchor !== null) {
      logoAnchor.style.left = `${Math.min(1, xOfSeconds(anchor)) * 100}%`;
      logoAnchor.classList.toggle("timeline-logo-anchor-flip", xOfSeconds(anchor) > 0.8);
      const text = `Loggans start ${formatFilmTime(anchor)}`;
      if (text !== lastAnchorText) {
        logoAnchorLabel.textContent = text;
        logoAnchorHandle.title = engine.canFit
          ? "Dra till en synpunkt i filmen – musiken anpassas så att loggan startar exakt där"
          : "";
        lastAnchorText = text;
      }
    }
    const lead = engine.musicStartSeconds;
    leadIn.hidden = lead < 0.05;
    if (!leadIn.hidden) {
      leadIn.style.width = `${xOfSeconds(lead) * 100}%`;
      leadInLabel.textContent = `Musiken startar ${formatSecondsSv(lead)} s in`;
    }
  }

  return {
    refresh() {
      redrawAll();
    },
    update() {
      const fraction = spanSeconds > 0 ? (Tone.getTransport().seconds / spanSeconds) % 1 : 0;
      playhead.style.left = `${fraction * 100}%`;
      updateFilm(spanSeconds);
      updateLogo();
      updateMusicBlock();

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

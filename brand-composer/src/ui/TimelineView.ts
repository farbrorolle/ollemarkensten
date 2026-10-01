import * as Tone from "tone";
import { VOLUME_CUE_MUTE_DB } from "../audio/AudioEngine.ts";
import type { AudioEngine, LayerBlock, VolumeCue } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";
import type { CueConfig, SectionConfig, TransitionType } from "../project/types.ts";
import type { FilmInfo, VideoSync } from "../video/VideoSync.ts";
import { formatFilmTime, formatSeconds } from "../video/syncMath.ts";
import { keepEndSourceBar, regionChunks } from "../project/fitToLength.ts";

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
  /** Tracks that stop right at the change into this segment (overrides the section's default). */
  cutTracks?: string[];
}

const LANE_HEIGHT = 40;
const MIX_LANE_HEIGHT = 64;
const WAVE_COLOR = "#7c5cff";
const FILM_WAVE_COLOR = "#ffb84d";
const LOGO_WAVE_COLOR = "#33d17a";
const DIM_TEXT_COLOR = "#8b8fa3";
const LOOP_COLOR = "#4dd4ff";
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
      return "Reading the film audio…";
    case "none":
      return "No audio track found in the film";
    case "too-long":
      return "The film is too long to show its waveform";
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
  /** A section's colour (from the project config, or a fallback by position). */
  const FALLBACK_COLORS = ["#5b8def", "#4fb3d9", "#3fbf8f", "#e0a43a", "#a77bf3", "#e8687a", "#8a95a8", "#d97fb8"];
  const sectionColor = (id: string): string =>
    sectionById.get(id)?.color ?? FALLBACK_COLORS[Math.max(0, sections.findIndex((s) => s.id === id)) % FALLBACK_COLORS.length]!;
  const tracks = Array.from(engine.tracks.values());

  let totalBars = Math.max(1, engine.arrangement.totalBars);
  let segments = engine.arrangement.arrangementSegments;
  const readSegments = (): EditableSegment[] =>
    engine.arrangement.arrangementSegments.map((s) => ({
      sectionId: s.sectionId,
      lengthBars: s.endBar - s.startBar,
      transition: s.transition,
      sourceBar: s.sourceBar,
      cutTracks: s.cutTracks,
    }));
  let editableSegments: EditableSegment[] = readSegments();

  /**
   * Timeline length in transport (= film) seconds: the music (incl. any late start and the logo's
   * ring-out) or the film, whichever is longer. Without a film, logo projects get some headroom so
   * the logo line can be dragged later.
   */
  /** While the music's end is dragged, the visible span grows on its own (no need to let go). */
  let spanOverride: number | null = null;
  const computeSpan = (): number => {
    if (spanOverride !== null) return spanOverride;
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
      <div class="arrange-switch" role="group" aria-label="How the music is fitted" data-arrange>
        <button type="button" class="arrange-btn" data-arrange-mode="auto" title="The track as composed, in its own order, ending cleanly at the logo (no stubs of a part); longer music goes round again">Auto arrange</button>
        <button type="button" class="arrange-btn" data-arrange-mode="original" title="The track plays as written and is simply cut at the end">Original form</button>
      </div>
      <button type="button" class="btn toggle-btn" data-fit-all aria-pressed="false" title="Keep every part of the track in the music, each with the same share of the length as in the original">Include all parts</button>
      <button type="button" class="btn lock-btn is-active" data-lock aria-pressed="true" hidden title="While on, adding, removing or resizing parts never changes the total length: other parts are shortened or lengthened to make room">🔒 Always lock to video length</button>
      <span class="reset-group">
        <button type="button" class="btn" data-reset-original title="Back to the track exactly as composed: every part once, at full length">↺ Reset to original form</button>
        <button type="button" class="btn" data-reset-film hidden title="Re-arrange from scratch to the film's length (logo on the film's last cut)">↺ Reset to film length</button>
      </span>
    </div>
    <div class="timeline-toolbar timeline-toolbar-2">
      <span class="undo-group">
        <button type="button" class="btn btn-icon" data-undo title="Undo (⌘Z / Ctrl+Z)">↶ Undo</button>
        <button type="button" class="btn btn-icon" data-redo title="Redo (⇧⌘Z / Ctrl+Y)">↷ Redo</button>
      </span>
      <button type="button" class="btn" data-mode-toggle>Show sections</button>
      <span class="zoom-group" title="Zoom the timeline (or ⌘/Ctrl + scroll, or pinch)">
        <button type="button" class="btn btn-icon" data-zoom-out aria-label="Zoom out">−</button>
        <span class="zoom-value" data-zoom-value>100%</span>
        <button type="button" class="btn btn-icon" data-zoom-in aria-label="Zoom in">+</button>
      </span>
      <span class="timeline-toolbar-status" data-status></span>
    </div>
    <div class="timeline-palette-row"><span class="palette-label">Parts</span><div class="timeline-palette" data-palette></div></div>
    <div class="timeline-palette-row" data-layer-row><span class="palette-label">Layers</span><div class="timeline-palette" data-layer-palette></div></div>
    <div class="timeline-scroll" data-scroll><div class="timeline-zoom" data-zoom-inner>
    <div class="timeline-timeruler" data-timeruler></div>
    <div class="timeline-ruler" data-ruler></div>
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
          <span class="timeline-music-block-handle" data-music-block-handle title="Drag to change the length of the music"></span>
        </div>
        <div class="timeline-playhead" data-playhead></div>
      </div>
    </div>
    </div></div>
    <div class="timeline-segment-list" data-segment-list></div>
  `;

  const palette = root.querySelector<HTMLElement>("[data-palette]")!;
  const ruler = root.querySelector<HTMLElement>("[data-ruler]")!;
  // The form (section blocks) lives in its own lane between the film and the music.
  const sectionsRow = document.createElement("div");
  sectionsRow.className = "timeline-sections";
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

  // --- Zoom: the timeline content gets wider and scrolls sideways (lane names stay put).
  const scrollEl = root.querySelector<HTMLElement>("[data-scroll]")!;
  const zoomInner = root.querySelector<HTMLElement>("[data-zoom-inner]")!;
  const zoomValue = root.querySelector<HTMLElement>("[data-zoom-value]")!;
  const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8];
  let zoom = 1;
  function setZoom(next: number, focusClientX?: number): void {
    next = Math.max(ZOOMS[0]!, Math.min(ZOOMS[ZOOMS.length - 1]!, next));
    if (next === zoom) return;
    const rect = scrollEl.getBoundingClientRect();
    const focusX = (focusClientX ?? rect.left + rect.width / 2) - rect.left;
    const contentX = (scrollEl.scrollLeft + focusX) / zoom; // content position at zoom 1
    zoom = next;
    zoomInner.style.width = `${zoom * 100}%`;
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    scrollEl.scrollLeft = contentX * zoom - focusX;
    if (!zoomRedraw) {
      zoomRedraw = true;
      requestAnimationFrame(() => {
        zoomRedraw = false;
        redrawAll();
      });
    }
  }
  let zoomRedraw = false;
  const stepZoom = (dir: 1 | -1, clientX?: number): void => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-9);
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (ZOOMS[i] === zoom ? i : dir > 0 ? i - 1 : i) + dir))]!, clientX);
  };
  root.querySelector("[data-zoom-in]")!.addEventListener("click", () => stepZoom(1));
  root.querySelector("[data-zoom-out]")!.addEventListener("click", () => stepZoom(-1));
  scrollEl.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX);
    },
    { passive: false },
  );

  // Undo / redo of every change to the music's form and length (also ⌘Z/⇧⌘Z, Ctrl+Z/Ctrl+Y).
  const undoBtn = root.querySelector<HTMLButtonElement>("[data-undo]")!;
  const redoBtn = root.querySelector<HTMLButtonElement>("[data-redo]")!;
  undoBtn.addEventListener("click", () => engine.undo());
  redoBtn.addEventListener("click", () => engine.redo());
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const target = e.target as HTMLElement | null;
    // Leave text fields their own undo.
    if (target && (target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && !["range", "checkbox", "button", "file"].includes((target as HTMLInputElement).type)))) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      engine.undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      engine.redo();
    }
  });

  // "Include all parts" (auto arrange option) and the two resets.
  const fitAllBtn = root.querySelector<HTMLButtonElement>("[data-fit-all]")!;
  const resetOriginalBtn = root.querySelector<HTMLButtonElement>("[data-reset-original]")!;
  const resetFilmBtn = root.querySelector<HTMLButtonElement>("[data-reset-film]")!;
  fitAllBtn.addEventListener("click", () => engine.setFitAllParts(!engine.fitAllParts));
  resetOriginalBtn.addEventListener("click", () => engine.resetToOriginalForm());
  resetFilmBtn.addEventListener("click", () => {
    const info = film?.info;
    if (!info || !engine.canFit) return;
    engine.fitToAnchor(film!.detectedCut ?? engine.defaultAnchorForFilm(info.duration));
  });
  const syncFitButtons = (): void => {
    fitAllBtn.hidden = !engine.canFit || engine.arrangeMode !== "auto";
    fitAllBtn.classList.toggle("is-active", engine.fitAllParts);
    fitAllBtn.setAttribute("aria-pressed", String(engine.fitAllParts));
    resetOriginalBtn.hidden = !engine.canFit;
    resetFilmBtn.hidden = !engine.canFit || !film?.info;
  };

  // Auto arrange / original form.
  const arrangeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-arrange-mode]"));
  const syncArrangeButtons = (): void => {
    for (const btn of arrangeButtons) btn.classList.toggle("is-active", btn.dataset.arrangeMode === engine.arrangeMode);
    syncFitButtons();
  };
  for (const btn of arrangeButtons) {
    btn.hidden = !engine.canFit;
    btn.addEventListener("click", () => {
      engine.setArrangeMode(btn.dataset.arrangeMode === "original" ? "original" : "auto");
      syncArrangeButtons();
    });
  }
  syncArrangeButtons();

  // Main view = the music as one block; the section view is secondary.
  let showSections = false;
  modeToggle.addEventListener("click", () => {
    showSections = !showSections;
    root.classList.toggle("timeline-mode-block", !showSections);
    root.classList.toggle("timeline-mode-sections", showSections);
    modeToggle.textContent = showSections ? "Hide sections" : "Show sections";
    redrawAll(); // canvases that were hidden have no width until shown
  });
  const segmentList = root.querySelector<HTMLElement>("[data-segment-list]")!;

  // --- "Always lock to video length": while on (and a film is loaded), every edit that would
  // change the total length is compensated by shortening/lengthening the other parts.
  const lockBtn = root.querySelector<HTMLButtonElement>("[data-lock]")!;
  let lockOn = true;
  const lockActive = (): boolean => lockOn && !!film?.info;
  lockBtn.addEventListener("click", () => {
    lockOn = !lockOn;
    lockBtn.classList.toggle("is-active", lockOn);
    lockBtn.setAttribute("aria-pressed", String(lockOn));
    lockBtn.textContent = lockOn ? "🔒 Always lock to video length" : "🔓 Always lock to video length";
  });
  let lockMessage = "";

  const fitRule = (sectionId: string) => engine.fitTemplate.find((b) => b.section === sectionId);
  /** Re-points a segment's source after its length changed (keeps its end unless the rules say start). */
  const fixSource = (seg: EditableSegment): void => {
    const region = engine.sourceRegionFor(seg.sectionId);
    if (!region) return;
    const regionLength = region[1] - region[0] + 1;
    if (seg.lengthBars >= regionLength) seg.sourceBar = region[0];
    else if (fitRule(seg.sectionId)?.keep === "start") seg.sourceBar = region[0];
    else seg.sourceBar = keepEndSourceBar(region, seg.lengthBars);
  };

  /**
   * Keeps the total length after an edit that changed it by `delta` bars (positive = got longer):
   * the other parts (never `keep`) are shortened/lengthened, whole phrases first. Returns the bars
   * that could not be compensated.
   */
  function compensate(delta: number, keep: EditableSegment | null): number {
    const others = editableSegments.filter((s) => s !== keep);
    const prio = (s: EditableSegment): number => fitRule(s.sectionId)?.priority ?? 1;
    let left = Math.abs(delta);
    // Whole 4-bar phrases first (passes 0-1); only the last pass moves single bars.
    let pass = 0;
    const take = (want: number, available: number): number => {
      const n = Math.min(want, available);
      if (n <= 0) return 0;
      return pass < 2 ? n - (n % 4) : n;
    };
    if (delta > 0) {
      // Shorten: the least important (then the longest) parts first, not below 4 bars.
      const order = [...others].sort((a, b) => prio(a) - prio(b) || b.lengthBars - a.lengthBars);
      for (pass = 0; pass < 3 && left > 0; pass++) {
        for (const seg of order) {
          if (left <= 0) break;
          const min = Math.min(seg.lengthBars, Math.max(4, fitRule(seg.sectionId)?.minBars ?? 4));
          const n = take(left, seg.lengthBars - min);
          if (n > 0) {
            seg.lengthBars -= n;
            left -= n;
            fixSource(seg);
          }
        }
      }
      // Still too long: drop whole parts the rules allow to be dropped (least important first).
      for (const seg of order) {
        if (left <= 0) break;
        if ((fitRule(seg.sectionId)?.minBars ?? 1) === 0 && seg.lengthBars <= left + 3) {
          left = Math.max(0, left - seg.lengthBars);
          editableSegments.splice(editableSegments.indexOf(seg), 1);
        }
      }
    } else if (delta < 0) {
      // Lengthen: the most important parts in the middle first (the melody), then the ends.
      const first = editableSegments[0];
      const last = editableSegments[editableSegments.length - 1];
      const order = [...others].sort(
        (a, b) =>
          Number(a === first || a === last) - Number(b === first || b === last) ||
          prio(b) - prio(a) ||
          b.lengthBars - a.lengthBars,
      );
      for (pass = 0; pass < 3 && left > 0; pass++) {
        for (const seg of order) {
          if (left <= 0) break;
          const max = Math.max(seg.lengthBars, fitRule(seg.sectionId)?.maxBars ?? seg.lengthBars * 2);
          const n = take(left, max - seg.lengthBars);
          if (n > 0) {
            seg.lengthBars += n;
            left -= n;
            fixSource(seg);
          }
        }
      }
    }
    return left;
  }

  /** Commits an edit that changed the total by `delta` bars, compensating when the length is locked. */
  function commitEdit(delta: number, keep: EditableSegment | null): void {
    lockMessage = "";
    if (delta !== 0 && lockActive()) {
      const left = compensate(delta, keep);
      if (left > 0) lockMessage = `Couldn't keep the length: ${left} bar${left === 1 ? "" : "s"} ${delta > 0 ? "longer" : "shorter"}`;
    }
    commit();
  }

  // Section cards: drag one down into the form lane (or click it to add it at the end). On
  // release a small menu asks how long it should be -- original, shorter or longer -- with a
  // shadow on the timeline showing the room it will take before you press Add.
  const SECTION_MIME = "application/x-brand-section";
  const regionLength = (sectionId: string): number => {
    const region = engine.sourceRegionFor(sectionId);
    return region ? region[1] - region[0] + 1 : DEFAULT_NEW_SEGMENT_BARS;
  };
  const newSegment = (sectionId: string, lengthBars = regionLength(sectionId)): EditableSegment => {
    const region = engine.sourceRegionFor(sectionId);
    return {
      sectionId,
      lengthBars,
      transition: "crossfade",
      ...(region ? { sourceBar: region[0] } : {}),
    };
  };
  let paletteDrag: string | null = null;

  const insertSection = (index: number, sectionId: string, bars: number): void => {
    const seg = newSegment(sectionId, bars);
    editableSegments.splice(index, 0, seg);
    commitEdit(seg.lengthBars, seg);
  };

  for (const section of sections) {
    const full = regionLength(section.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "timeline-palette-chip";
    card.draggable = true;
    card.innerHTML = `<span class="chip-name"></span><span class="chip-bars">${full} bars</span>`;
    card.querySelector(".chip-name")!.textContent = section.name;
    card.style.setProperty("--sec", sectionColor(section.id));
    card.title = `Drag ${section.name} into the form (or click to add it at the end)`;
    card.addEventListener("dragstart", (e) => {
      closeLengthMenu();
      paletteDrag = section.id;
      e.dataTransfer?.setData(SECTION_MIME, section.id);
      e.dataTransfer?.setData("text/plain", section.name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    });
    card.addEventListener("dragend", () => {
      paletteDrag = null;
      if (!lengthMenu) clearDropIndicator();
    });
    card.addEventListener("click", () => {
      const rowRect = sectionsRow.getBoundingClientRect();
      const x = rowRect.left + Math.min(1, xOfBar(totalBars + 1)) * rowRect.width;
      openLengthMenu(editableSegments.length, section.id, x);
    });
    palette.appendChild(card);
  }

  // "+ Logo": puts a removed sonic logo back.
  const logoCard = document.createElement("button");
  logoCard.type = "button";
  logoCard.className = "timeline-palette-chip timeline-palette-logo";
  logoCard.textContent = "+ Logo";
  logoCard.title = "Put the sonic logo back at the end";
  logoCard.addEventListener("click", () => engine.setLogoEnabled(true));
  palette.appendChild(logoCard);
  const syncLogoCard = (): void => {
    logoCard.hidden = !engine.logoSettings || !engine.logo || engine.isLogoEnabled;
  };
  syncLogoCard();

  /** Length choices for a part: shorter (whole 4-bar phrases), original, longer. */
  function lengthChoices(sectionId: string): { shorter: number[]; original: number; longer: number[] } {
    const original = regionLength(sectionId);
    const shorter: number[] = [];
    for (let n = 4; n < original; n += 4) shorter.push(n);
    const longer = Array.from(new Set([original + 4, original + 8, original * 2]))
      .filter((n) => n > original && n <= 64)
      .sort((a, b) => a - b);
    return { shorter, original, longer };
  }

  let lengthMenu: HTMLElement | null = null;
  let lengthMenuCleanup: (() => void) | null = null;
  function closeLengthMenu(): void {
    lengthMenuCleanup?.();
    lengthMenuCleanup = null;
    lengthMenu?.remove();
    lengthMenu = null;
    clearDropIndicator();
  }

  function openLengthMenu(index: number, sectionId: string, clientX: number): void {
    closeLengthMenu();
    const name = sectionNameById.get(sectionId) ?? sectionId;
    const { shorter, original, longer } = lengthChoices(sectionId);
    let selected = original;
    const menu = document.createElement("div");
    menu.className = "length-menu";
    menu.setAttribute("role", "dialog");
    menu.innerHTML = `<div class="length-menu-title"></div><div class="length-menu-rows"></div>
      <div class="length-menu-hint"></div>
      <div class="length-menu-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-add>Add</button></div>`;
    menu.querySelector(".length-menu-title")!.textContent = `${name} – how long?`;
    const hint = menu.querySelector<HTMLElement>(".length-menu-hint")!;
    hint.textContent = lockActive()
      ? "The music keeps the video's length: other parts make room."
      : "The music gets longer or shorter by this much.";
    const rows = menu.querySelector<HTMLElement>(".length-menu-rows")!;
    const buttons: HTMLButtonElement[] = [];
    const preview = (bars: number): void => showGhost(index, sectionId, bars);
    const select = (bars: number): void => {
      selected = bars;
      for (const b of buttons) b.classList.toggle("is-active", Number(b.dataset.bars) === bars);
      preview(bars);
    };
    const addRow = (label: string, values: number[], note: (n: number) => string): void => {
      if (!values.length) return;
      const row = document.createElement("div");
      row.className = "length-menu-row";
      row.innerHTML = `<span class="length-menu-label"></span>`;
      row.querySelector("span")!.textContent = label;
      for (const bars of values) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "length-menu-option";
        btn.dataset.bars = String(bars);
        btn.textContent = `${bars} bars`;
        btn.title = note(bars);
        btn.addEventListener("mouseenter", () => preview(bars));
        btn.addEventListener("mouseleave", () => preview(selected));
        btn.addEventListener("click", () => select(bars));
        btn.addEventListener("dblclick", () => {
          select(bars);
          add();
        });
        buttons.push(btn);
        row.appendChild(btn);
      }
      rows.appendChild(row);
    };
    addRow("Shorter", shorter, (n) => `Cut to its first ${n} bars`);
    addRow("Original", [original], () => "The whole part, as written");
    addRow("Longer", longer, (n) =>
      engine.arrangeMode === "original"
        ? `Runs on ${n - original} bars into the next part of the track`
        : `Loops: plays ${n - original} more bars of ${name} (crossfaded)`,
    );
    const longerRow = rows.lastElementChild;
    if (longer.length && longerRow) {
      const note = document.createElement("span");
      note.className = "length-menu-note";
      note.textContent = engine.arrangeMode === "original" ? "→ runs on into the next part" : "↻ loops";
      longerRow.appendChild(note);
    }

    const add = (): void => {
      const bars = selected;
      closeLengthMenu();
      insertSection(index, sectionId, bars);
    };
    menu.querySelector("[data-add]")!.addEventListener("click", add);
    menu.querySelector("[data-cancel]")!.addEventListener("click", closeLengthMenu);

    document.body.appendChild(menu);
    lengthMenu = menu;
    // Under the form lane, next to where the part lands (kept on screen).
    const rowRect = sectionsRow.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX - w / 2))}px`;
    menu.style.top = `${rowRect.bottom + window.scrollY + 8}px`;
    select(original);
    (menu.querySelector("[data-add]") as HTMLButtonElement).focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeLengthMenu();
      else if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    };
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node && menu.contains(e.target))) closeLengthMenu();
    };
    window.addEventListener("keydown", onKey);
    window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    lengthMenuCleanup = () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }

  /** Index to insert at for a drop at clientX: before the first block whose middle is right of it. */
  const insertIndexAt = (clientX: number): number => {
    for (let i = 0; i < blockEls.length; i++) {
      const r = blockEls[i]!.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return blockEls.length;
  };
  /** A ghost of the part being dragged, where (and as long as) it will land. */
  let ghostEl: HTMLElement | null = null;
  function showGhost(index: number, sectionId: string, bars: number): void {
    if (!ghostEl) {
      ghostEl = document.createElement("div");
      ghostEl.className = "timeline-section-ghost";
    }
    if (!ghostEl.isConnected) sectionsRow.appendChild(ghostEl);
    const startBar = 1 + editableSegments.slice(0, index).reduce((sum, s) => sum + s.lengthBars, 0);
    ghostEl.style.left = `${xOfBar(startBar) * 100}%`;
    ghostEl.style.width = `${(bars * engine.barSeconds * 100) / spanSeconds}%`;
    const name = sectionNameById.get(sectionId) ?? sectionId;
    ghostEl.textContent = `+ ${name} · ${bars} bars`;
  }
  sectionsRow.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(SECTION_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const i = insertIndexAt(e.clientX);
    if (paletteDrag) showGhost(i, paletteDrag, regionLength(paletteDrag));
  });
  sectionsRow.addEventListener("dragleave", (e) => {
    if (!(e.relatedTarget instanceof Node && sectionsRow.contains(e.relatedTarget))) clearDropIndicator();
  });
  sectionsRow.addEventListener("drop", (e) => {
    const sectionId = e.dataTransfer?.getData(SECTION_MIME);
    if (!sectionId) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropIndicator();
    paletteDrag = null;
    openLengthMenu(insertIndexAt(e.clientX), sectionId, e.clientX);
  });

  /** The time ruler: minutes and seconds, ticks as dense as the zoom allows. */
  const timeRuler = root.querySelector<HTMLElement>("[data-timeruler]")!;
  function renderTimeRuler(): void {
    timeRuler.innerHTML = "";
    const width = timeRuler.clientWidth || 800;
    const pxPerSecond = width / spanSeconds;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const labelStep = steps.find((s) => s * pxPerSecond >= 56) ?? 120;
    const minorStep = steps.slice().reverse().find((s) => s < labelStep && s * pxPerSecond >= 10) ?? labelStep;
    const fmt = (t: number): string => {
      const m = Math.floor(t / 60);
      const sec = t - m * 60;
      return `${m}:${(labelStep < 1 ? sec.toFixed(1) : String(Math.round(sec))).padStart(labelStep < 1 ? 4 : 2, "0")}`;
    };
    for (let t = 0; t <= spanSeconds + 1e-6; t += minorStep) {
      const major = Math.abs(t / labelStep - Math.round(t / labelStep)) < 1e-6;
      const tick = document.createElement("span");
      tick.className = major ? "time-tick time-tick-major" : "time-tick";
      tick.style.left = `${xOfSeconds(t) * 100}%`;
      if (major) tick.textContent = fmt(t);
      timeRuler.appendChild(tick);
    }
  }

  timeRuler.addEventListener("click", (e) => {
    const rect = timeRuler.getBoundingClientRect();
    Tone.getTransport().seconds = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * spanSeconds;
  });

  function renderRuler(): void {
    renderTimeRuler();
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
    ghostEl?.remove();
    ghostEl = null;
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
      const seg = editableSegments[index]!;
      const startLength = seg.lengthBars;
      const following = editableSegments.slice(index + 1);
      const startFollowing = following.map((s) => s.lengthBars);
      const room = startFollowing.reduce((a, b) => a + b, 0);
      const widthPx = overlay.getBoundingClientRect().width || 1;
      const barsPerPixel = spanSeconds / engine.barSeconds / widthPx;

      // Dragging the edge moves the boundary: this part eats into the parts after it -- all the
      // way, so a part that gets covered completely disappears -- and gives bars back the other
      // way. The total length (and the logo) stays put. The last part just gets longer/shorter.
      const onMove = (ev: PointerEvent): void => {
        let delta = Math.round((ev.clientX - startX) * barsPerPixel);
        delta = Math.max(1 - startLength, delta);
        if (following.length) delta = Math.min(room, delta);
        seg.lengthBars = startLength + delta;
        if (following.length) {
          if (delta >= 0) {
            let eat = delta;
            following.forEach((f, k) => {
              const take = Math.min(eat, startFollowing[k]!);
              f.lengthBars = startFollowing[k]! - take;
              eat -= take;
            });
          } else {
            following.forEach((f, k) => (f.lengthBars = startFollowing[k]!));
            following[0]!.lengthBars = startFollowing[0]! - delta;
          }
        }
        reflowSectionPositions();
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const region = engine.sourceRegionFor(seg.sectionId);
        if (region) {
          const from = seg.sourceBar ?? region[0];
          if (from + seg.lengthBars - 1 > region[1]) seg.sourceBar = keepEndSourceBar(region, seg.lengthBars);
        }
        // Parts that lost their beginning keep their ending (the lead-in onwards); covered ones go.
        following.forEach((f, k) => {
          if (f.lengthBars === startFollowing[k]) return;
          const r = engine.sourceRegionFor(f.sectionId);
          if (r && f.lengthBars > 0) f.sourceBar = keepEndSourceBar(r, f.lengthBars);
        });
        editableSegments = editableSegments.filter((s) => s.lengthBars > 0);
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
      formLane.classList.add("timeline-form-dragging");
      e.dataTransfer?.setData("text/plain", String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    block.addEventListener("dragend", (e) => {
      block.classList.remove("timeline-section-dragging");
      formLane.classList.remove("timeline-form-dragging");
      const from = draggedIndex;
      draggedIndex = null;
      clearDropIndicator();
      // Dropped outside the form (anywhere away from it): the part is removed.
      const r = formLane.getBoundingClientRect();
      const away = !(e.clientX === 0 && e.clientY === 0) && (e.clientY < r.top - 24 || e.clientY > r.bottom + 24);
      if (from !== null && e.dataTransfer?.dropEffect === "none" && away && editableSegments.length > 1) removeSegment(from);
    });
    block.addEventListener("dragover", (e) => {
      if (draggedIndex === null) return; // (section cards are handled by the row)
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

  function removeSegment(index: number): void {
    const [removed] = editableSegments.splice(index, 1);
    commitEdit(-(removed?.lengthBars ?? 0), null);
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
      block.style.setProperty("--sec", sectionColor(seg.sectionId));
      block.style.left = `${xOfBar(startBar) * 100}%`;
      block.style.width = `${(xOfBar(startBar + seg.lengthBars) - xOfBar(startBar)) * 100}%`;

      const name = sectionNameById.get(seg.sectionId) ?? seg.sectionId;
      // The same part again straight after itself = a loop (auto arrange lengthens by looping).
      const isLoop = index > 0 && editableSegments[index - 1]!.sectionId === seg.sectionId;
      block.classList.toggle("timeline-section-loop", isLoop);
      const fade = index > 0 && seg.transition === "crossfade";
      block.title = `${isLoop ? `${name} loops` : name} · ${seg.lengthBars} bar${seg.lengthBars === 1 ? "" : "s"}${index > 0 ? (fade ? " · crossfades in" : " · no crossfade") : ""} – click for options, drag to move, drag away to remove`;

      if (fade) {
        const icon = document.createElement("span");
        icon.className = "timeline-section-fade";
        icon.textContent = "≈";
        icon.title = "Crossfades in from the part before";
        block.appendChild(icon);
      }

      const label = document.createElement("span");
      label.className = "timeline-section-label";
      label.textContent = isLoop ? `↻ ${name}` : name;
      block.appendChild(label);

      if (editableSegments.length > 1) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "timeline-section-remove";
        removeBtn.textContent = "×";
        removeBtn.title = "Remove section";
        removeBtn.draggable = false;
        removeBtn.addEventListener("dragstart", (e) => e.preventDefault());
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeSegment(index);
        });
        block.appendChild(removeBtn);
      }

      const resizeHandle = document.createElement("span");
      resizeHandle.className = "timeline-section-resize";
      resizeHandle.title = "Drag to change the length (eats into the parts after it)";
      resizeHandle.addEventListener("click", (e) => e.stopPropagation());
      block.appendChild(resizeHandle);

      block.addEventListener("click", (e) => {
        e.stopPropagation();
        openSectionMenu(index, e.clientX);
      });

      attachResize(resizeHandle, index);
      attachDrag(block, index);

      blockEls.push(block);
      sectionsRow.appendChild(block);
    });

    // The sonic logo as its own part of the form, from its hit (the green line) to its end. It
    // lies under the last section, so that one stays clickable; × removes the logo.
    const logoHit = engine.hasLogo ? engine.logoAnchorSeconds : null;
    const logoEnd = engine.logoEndSeconds;
    if (logoHit !== null && logoEnd !== null) {
      const logoBlock = document.createElement("div");
      logoBlock.className = "timeline-section-block timeline-section-logo";
      logoBlock.style.left = `${xOfSeconds(logoHit) * 100}%`;
      logoBlock.style.width = `${(xOfSeconds(logoEnd) - xOfSeconds(logoHit)) * 100}%`;
      logoBlock.title = "The sonic logo – move it with the green line";
      logoBlock.innerHTML = `<span class="timeline-section-label">Logo</span>`;
      const removeLogo = document.createElement("button");
      removeLogo.type = "button";
      removeLogo.className = "timeline-section-remove";
      removeLogo.textContent = "×";
      removeLogo.title = "Remove the sonic logo (the music then ends on its own)";
      removeLogo.addEventListener("click", (e) => {
        e.stopPropagation();
        engine.setLogoEnabled(false);
      });
      logoBlock.appendChild(removeLogo);
      sectionsRow.appendChild(logoBlock);
    }
  }

  // --- Section options (click a part): crossfade in or not, instruments that must not ring over
  // into it, delete.
  let sectionMenu: HTMLElement | null = null;
  let sectionMenuCleanup: (() => void) | null = null;
  function closeSectionMenu(): void {
    sectionMenuCleanup?.();
    sectionMenuCleanup = null;
    sectionMenu?.remove();
    sectionMenu = null;
  }
  function openSectionMenu(index: number, clientX: number): void {
    closeSectionMenu();
    const seg = editableSegments[index];
    if (!seg) return;
    const name = sectionNameById.get(seg.sectionId) ?? seg.sectionId;
    const prev = editableSegments[index - 1];
    const prevName = prev ? (sectionNameById.get(prev.sectionId) ?? prev.sectionId) : "";
    const defaults = sectionById.get(seg.sectionId)?.cutInto ?? [];
    const cutNow = new Set(seg.cutTracks ?? defaults);
    const menu = document.createElement("div");
    menu.className = "length-menu section-menu";
    menu.style.setProperty("--sec", sectionColor(seg.sectionId));
    menu.innerHTML = `
      <div class="length-menu-title"></div>
      <label class="cue-menu-check section-menu-fade"${index === 0 ? " hidden" : ""}><input type="checkbox" data-fade /> <span>Crossfade from <b data-prev></b></span></label>
      <details class="section-menu-cut"${index === 0 ? " hidden" : ""}>
        <summary>Instruments that stop right at the change</summary>
        <p class="section-menu-help">Ticked instruments don't ring over into this part (e.g. the bass, if this part is in other chords).</p>
        <div class="section-menu-tracks" data-tracks></div>
      </details>
      <div class="length-menu-actions">
        <button type="button" class="btn cue-delete" data-delete${editableSegments.length > 1 ? "" : " disabled"}>Delete section</button>
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>Save</button>
      </div>`;
    menu.querySelector(".length-menu-title")!.textContent = `${name} · ${seg.lengthBars} bars`;
    menu.querySelector("[data-prev]")!.textContent = prevName;
    const fadeBox = menu.querySelector<HTMLInputElement>("[data-fade]")!;
    fadeBox.checked = seg.transition === "crossfade";
    const trackBox = menu.querySelector<HTMLElement>("[data-tracks]")!;
    const boxes: HTMLInputElement[] = [];
    for (const t of tracks) {
      if (t.isLogo || t.isSwell) continue;
      const row = document.createElement("label");
      row.className = "cue-menu-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = t.id;
      box.checked = cutNow.has(t.id);
      row.append(box, document.createTextNode(` ${t.name}`));
      trackBox.appendChild(row);
      boxes.push(box);
    }
    const save = (): void => {
      seg.transition = fadeBox.checked ? "crossfade" : "cut";
      const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
      const sameAsDefault = chosen.length === defaults.length && chosen.every((id) => defaults.includes(id));
      seg.cutTracks = sameAsDefault ? undefined : chosen;
      closeSectionMenu();
      commit();
    };
    menu.querySelector("[data-save]")!.addEventListener("click", save);
    menu.querySelector("[data-cancel]")!.addEventListener("click", closeSectionMenu);
    menu.querySelector("[data-delete]")!.addEventListener("click", () => {
      closeSectionMenu();
      if (editableSegments.length > 1) removeSegment(index);
    });
    document.body.appendChild(menu);
    sectionMenu = menu;
    const rowRect = sectionsRow.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX - w / 2))}px`;
    menu.style.top = `${rowRect.bottom + window.scrollY + 8}px`;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeSectionMenu();
      else if (e.key === "Enter") {
        e.preventDefault();
        save();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        closeSectionMenu();
        if (editableSegments.length > 1) removeSegment(index);
      }
    };
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node && menu.contains(e.target))) closeSectionMenu();
    };
    window.addEventListener("keydown", onKey);
    window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    sectionMenuCleanup = () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
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
      decBtn.title = "One bar shorter";
      decBtn.addEventListener("click", () => {
        if (seg.lengthBars <= 1) return;
        seg.lengthBars -= 1;
        commitEdit(-1, seg);
      });
      const barsLabel = document.createElement("span");
      barsLabel.className = "segment-row-bars";
      barsLabel.textContent = `${seg.lengthBars} bar${seg.lengthBars === 1 ? "" : "s"}`;
      const incBtn = document.createElement("button");
      incBtn.type = "button";
      incBtn.className = "btn btn-step";
      incBtn.textContent = "+";
      incBtn.title = "One bar longer";
      incBtn.addEventListener("click", () => {
        seg.lengthBars += 1;
        commitEdit(1, seg);
      });
      lengthGroup.append(decBtn, barsLabel, incBtn);
      row.appendChild(lengthGroup);

      const moveGroup = document.createElement("span");
      moveGroup.className = "segment-row-move";
      const leftBtn = document.createElement("button");
      leftBtn.type = "button";
      leftBtn.className = "btn btn-step";
      leftBtn.textContent = "◀";
      leftBtn.title = "Move earlier";
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
      rightBtn.title = "Move later";
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
        removeBtn.title = "Remove section";
        removeBtn.addEventListener("click", () => {
          const [removed] = editableSegments.splice(index, 1);
          commitEdit(-(removed?.lengthBars ?? 0), null);
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
    if (track.isSwell) return; // swells are placed at the transitions, not per section

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
  const formLane = document.createElement("div");
  formLane.className = "timeline-lane timeline-lane-form";
  formLane.innerHTML = `<span class="timeline-lane-name">Form</span>`;
  formLane.appendChild(sectionsRow);
  lanesEl.appendChild(formLane);
  formLane.addEventListener("click", (e) => e.stopPropagation()); // editing the form doesn't seek

  // --- Layers: instrument groups (e.g. the melody) that can be dragged over any part. They play
  // their own section's material on top of whatever part is there (replacing their normal playback).
  const LAYER_MIME = "application/x-brand-layer";
  const layerTypes = engine.layerTypes;
  const layerPalette = root.querySelector<HTMLElement>("[data-layer-palette]")!;
  root.querySelector<HTMLElement>("[data-layer-row]")!.hidden = layerTypes.length === 0;
  const layerLane = document.createElement("div");
  layerLane.className = "timeline-lane timeline-lane-layers";
  layerLane.hidden = layerTypes.length === 0;
  layerLane.innerHTML = `<span class="timeline-lane-name" title="Drag e.g. the melody here to play it over any part">Layers</span><div class="timeline-layers" data-layers><span class="timeline-layers-hint" data-layers-hint>Drag ♪ Melody here to play it over any part</span></div>`;
  formLane.after(layerLane);
  const layersEl = layerLane.querySelector<HTMLElement>("[data-layers]")!;
  const layersHint = layerLane.querySelector<HTMLElement>("[data-layers-hint]")!;
  layerLane.addEventListener("click", (e) => e.stopPropagation());
  const layerName = (id: string): string => layerTypes.find((l) => l.id === id)?.name ?? id;
  const layerDefaultBars = (id: string): number => {
    const type = layerTypes.find((l) => l.id === id);
    const region = type ? engine.sourceRegionFor(type.section) : undefined;
    return region ? region[1] - region[0] + 1 : 8;
  };
  const barAtLayerX = (clientX: number): number => {
    const rect = layersEl.getBoundingClientRect();
    const seconds = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * spanSeconds;
    return Math.max(1, Math.min(totalBars, Math.round(1 + (seconds - engine.musicStartSeconds) / engine.barSeconds)));
  };
  let layerIdCounter = 0;
  /** Fits a block in between the other blocks of its layer (no overlaps) and inside the music. */
  function placeBlock(block: LayerBlock, others: readonly LayerBlock[]): LayerBlock | null {
    let start = Math.max(1, Math.min(totalBars, block.startBar));
    const same = others.filter((o) => o.layerId === block.layerId && o.id !== block.id).sort((a, b) => a.startBar - b.startBar);
    const inside = same.find((o) => start >= o.startBar && start < o.startBar + o.bars);
    if (inside) start = inside.startBar + inside.bars;
    const next = same.find((o) => o.startBar >= start);
    const limit = Math.min(totalBars + 1, next ? next.startBar : Infinity);
    const bars = Math.min(block.bars, limit - start);
    return bars >= 1 ? { ...block, startBar: start, bars } : null;
  }
  function addLayer(layerId: string, startBar: number): void {
    const placed = placeBlock({ id: `layer-${Date.now().toString(36)}-${layerIdCounter++}`, layerId, startBar, bars: layerDefaultBars(layerId) }, engine.layers);
    if (placed) engine.setLayers([...engine.layers, placed]);
  }

  for (const type of layerTypes) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "timeline-palette-chip timeline-palette-layer";
    card.draggable = true;
    card.innerHTML = `<span class="chip-name"></span><span class="chip-bars">plays over any part · ${layerDefaultBars(type.id)} bars</span>`;
    card.querySelector(".chip-name")!.textContent = `♪ ${type.name}`;
    card.title = `Drag ${type.name} into the Layers lane to play it over any part (or click to put it at the start)`;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(LAYER_MIME, type.id);
      e.dataTransfer?.setData("text/plain", type.name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      layerDrag = type.id;
    });
    card.addEventListener("dragend", () => {
      layerDrag = null;
      layerGhost?.remove();
      layerGhost = null;
    });
    card.addEventListener("click", () => addLayer(type.id, 1));
    layerPalette.appendChild(card);
  }

  let layerDrag: string | null = null;
  let layerGhost: HTMLElement | null = null;
  layersEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(LAYER_MIME) || !layerDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const placed = placeBlock({ id: "ghost", layerId: layerDrag, startBar: barAtLayerX(e.clientX), bars: layerDefaultBars(layerDrag) }, engine.layers);
    if (!layerGhost) {
      layerGhost = document.createElement("div");
      layerGhost.className = "timeline-section-ghost";
      layersEl.appendChild(layerGhost);
    }
    if (!placed) {
      layerGhost.hidden = true;
      return;
    }
    layerGhost.hidden = false;
    layerGhost.style.left = `${xOfBar(placed.startBar) * 100}%`;
    layerGhost.style.width = `${(xOfBar(placed.startBar + placed.bars) - xOfBar(placed.startBar)) * 100}%`;
    layerGhost.textContent = `+ ${layerName(layerDrag)} · ${placed.bars} bars`;
  });
  layersEl.addEventListener("dragleave", (e) => {
    if (e.relatedTarget instanceof Node && layersEl.contains(e.relatedTarget)) return;
    layerGhost?.remove();
    layerGhost = null;
  });
  layersEl.addEventListener("drop", (e) => {
    const layerId = e.dataTransfer?.getData(LAYER_MIME);
    if (!layerId) return;
    e.preventDefault();
    layerGhost?.remove();
    layerGhost = null;
    layerDrag = null;
    addLayer(layerId, barAtLayerX(e.clientX));
  });

  function renderLayers(): void {
    layersEl.querySelectorAll(".timeline-layer-block").forEach((el) => el.remove());
    layersHint.hidden = engine.layers.length > 0;
    for (const block of engine.layers) {
      const el = document.createElement("div");
      el.className = "timeline-layer-block";
      const place = (startBar: number, bars: number): void => {
        el.style.left = `${xOfBar(startBar) * 100}%`;
        el.style.width = `${(xOfBar(startBar + bars) - xOfBar(startBar)) * 100}%`;
      };
      place(block.startBar, block.bars);
      el.title = `${layerName(block.layerId)} · ${block.bars} bars – drag to move, drag the right edge to change the length`;
      el.innerHTML = `<span class="timeline-section-label"></span><button type="button" class="timeline-section-remove" title="Remove">×</button><span class="timeline-section-resize" title="Drag to change the length"></span>`;
      el.querySelector(".timeline-section-label")!.textContent = `♪ ${layerName(block.layerId)} · ${block.bars}`;
      el.querySelector(".timeline-section-remove")!.addEventListener("click", (e) => {
        e.stopPropagation();
        engine.setLayers(engine.layers.filter((l) => l.id !== block.id));
      });
      el.querySelector(".timeline-section-remove")!.addEventListener("pointerdown", (e) => e.stopPropagation());
      const barWidthPx = (): number => (layersEl.getBoundingClientRect().width * engine.barSeconds) / spanSeconds || 1;
      // Move (body) or resize (right edge), in whole bars.
      el.addEventListener("pointerdown", (e) => {
        const resizing = (e.target as HTMLElement).classList.contains("timeline-section-resize");
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        let next = { ...block };
        const onMove = (ev: PointerEvent): void => {
          const delta = Math.round((ev.clientX - startX) / barWidthPx());
          next = resizing ? { ...block, bars: Math.max(1, block.bars + delta) } : { ...block, startBar: block.startBar + delta };
          const placed = placeBlock(next, engine.layers);
          if (placed) {
            next = placed;
            place(placed.startBar, placed.bars);
          }
        };
        const onUp = (): void => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          if (next.startBar !== block.startBar || next.bars !== block.bars) {
            engine.setLayers(engine.layers.map((l) => (l.id === block.id ? next : l)));
          }
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
      });
      layersEl.appendChild(el);
    }
  }
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
    const toggleText = audioOn ? "🔊 Film audio" : "🔇 Film audio";
    if (toggleText !== filmToggleText) {
      filmToggle.textContent = toggleText;
      filmToggle.title = audioOn ? "Film audio is ON – click to turn it off" : "Film audio is OFF – click to turn it on";
      filmToggleText = toggleText;
    }

    const fraction = info.duration / spanSeconds;
    const beyond = fraction > 1.0005;
    filmEnd.style.left = `${Math.min(1, fraction) * 100}%`;
    filmEnd.classList.toggle("timeline-film-end-beyond", beyond);
    const endText = beyond ? `Film continues ${formatSeconds(info.duration - spanSeconds)} s →` : "Film ends";
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
  mixLane.innerHTML = `<span class="timeline-lane-name">Music</span><canvas></canvas>`;
  lanesEl.appendChild(mixLane);
  const mixCanvas = mixLane.querySelector("canvas")!;

  // --- Volume cue points: an instrument's level changes from a point in the timeline onward.
  // Click the lane to add one (by default only for that part: it comes back after it), click a
  // cue to change or delete it, drag it sideways to move it (snaps to beats).
  const cueTracks = tracks.filter((t) => !t.isLogo);
  const cueLane = document.createElement("div");
  cueLane.className = "timeline-lane timeline-lane-cues";
  cueLane.innerHTML = `<span class="timeline-lane-name" title="Volume cue points: click the lane to turn an instrument up or down from that point">Volume cues</span><div class="timeline-cues" data-cues></div>`;
  lanesEl.appendChild(cueLane);
  const cuesEl = cueLane.querySelector<HTMLElement>("[data-cues]")!;
  cueLane.addEventListener("click", (e) => e.stopPropagation()); // no seeking from here
  const trackName = (id: string): string => engine.tracks.get(id)?.name ?? id;
  const dbText = (db: number): string => (db <= VOLUME_CUE_MUTE_DB ? "mute" : db === 0 ? "0 dB" : `${db > 0 ? "+" : ""}${db} dB`);
  const barAtClientX = (clientX: number): number => {
    const rect = cuesEl.getBoundingClientRect();
    const seconds = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * spanSeconds;
    const bar = 1 + (seconds - engine.musicStartSeconds) / engine.barSeconds;
    const snapped = Math.round((bar - 1) * 4) / 4 + 1; // whole beats
    return Math.max(1, Math.min(totalBars + 0.75, snapped));
  };
  const barLabel = (bar: number): string => {
    const whole = Math.floor(bar);
    const beat = Math.round((bar - whole) * 4) + 1;
    return `bar ${whole}${beat > 1 ? `, beat ${beat}` : ""}`;
  };
  let cueIdCounter = 0;
  const newCueId = (): string => `cue-${Date.now().toString(36)}-${cueIdCounter++}`;

  function renderCues(): void {
    cuesEl.innerHTML = "";
    const cues = [...engine.volumeCues].sort((a, b) => a.bar - b.bar);
    const width = cuesEl.clientWidth || 800;
    const rowEnds: number[] = [];
    for (const cue of cues) {
      const x = xOfSeconds(engine.secondsAtBar(cue.bar));
      const px = x * width;
      let row = rowEnds.findIndex((end) => end < px);
      if (row < 0) {
        row = rowEnds.length;
        rowEnds.push(0);
      }
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `cue-marker${cue.db <= VOLUME_CUE_MUTE_DB ? " cue-marker-mute" : cue.db < 0 ? " cue-marker-down" : cue.db > 0 ? " cue-marker-up" : " cue-marker-back"}`;
      marker.style.left = `${x * 100}%`;
      marker.style.top = `${2 + row * 18}px`;
      marker.textContent = `${trackName(cue.trackId)} ${dbText(cue.db)}`;
      marker.title = `${trackName(cue.trackId)}: ${dbText(cue.db)} from ${barLabel(cue.bar)} – click to change, drag to move`;
      rowEnds[row] = px + Math.min(180, marker.textContent.length * 6.2 + 16);
      attachCueDrag(marker, cue);
      cuesEl.appendChild(marker);
    }
    cueLane.style.height = `${Math.max(34, 6 + rowEnds.length * 18)}px`;
  }

  function attachCueDrag(marker: HTMLElement, cue: VolumeCue): void {
    marker.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      marker.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      let moved = false;
      let bar = cue.bar;
      const onMove = (ev: PointerEvent): void => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (!moved) return;
        bar = barAtClientX(ev.clientX);
        marker.style.left = `${xOfSeconds(engine.secondsAtBar(bar)) * 100}%`;
      };
      const onUp = (ev: PointerEvent): void => {
        marker.removeEventListener("pointermove", onMove);
        marker.removeEventListener("pointerup", onUp);
        if (moved) {
          engine.setVolumeCues(engine.volumeCues.map((c) => (c.id === cue.id ? { ...c, bar } : c)));
        } else {
          openCueMenu(cue.bar, ev.clientX, cue);
        }
      };
      marker.addEventListener("pointermove", onMove);
      marker.addEventListener("pointerup", onUp);
    });
  }

  cuesEl.addEventListener("click", (e) => {
    if (e.target !== cuesEl) return;
    openCueMenu(barAtClientX(e.clientX), e.clientX);
  });

  let cueMenu: HTMLElement | null = null;
  let cueMenuCleanup: (() => void) | null = null;
  function closeCueMenu(): void {
    cueMenuCleanup?.();
    cueMenuCleanup = null;
    cueMenu?.remove();
    cueMenu = null;
  }

  /** The part (segment) that plays at a bar position. */
  const segmentAt = (bar: number) => segments.find((s) => bar >= s.startBar && bar < s.endBar);

  function openCueMenu(bar: number, clientX: number, editing?: VolumeCue): void {
    closeCueMenu();
    const menu = document.createElement("div");
    menu.className = "length-menu cue-menu";
    menu.setAttribute("role", "dialog");
    const part = segmentAt(bar);
    const partName = part ? (sectionNameById.get(part.sectionId) ?? part.sectionId) : "";
    menu.innerHTML = `
      <div class="length-menu-title"></div>
      <label class="cue-menu-row"><span>Instrument</span><select data-cue-track></select></label>
      <label class="cue-menu-row"><span>Level</span><input type="range" min="${VOLUME_CUE_MUTE_DB}" max="6" step="1" data-cue-db /><span class="cue-menu-value" data-cue-value></span></label>
      <div class="cue-menu-presets">
        <button type="button" class="length-menu-option" data-db="${VOLUME_CUE_MUTE_DB}">Mute</button>
        <button type="button" class="length-menu-option" data-db="-12">−12 dB</button>
        <button type="button" class="length-menu-option" data-db="-6">−6 dB</button>
        <button type="button" class="length-menu-option" data-db="0">As mixed</button>
        <button type="button" class="length-menu-option" data-db="3">+3 dB</button>
      </div>
      <label class="cue-menu-check" data-cue-only-wrap><input type="checkbox" data-cue-only checked /> <span data-cue-only-label></span></label>
      <div class="length-menu-actions">
        ${editing ? `<button type="button" class="btn cue-delete" data-cue-delete>Delete</button>` : ""}
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-cue-save>${editing ? "Save" : "Add"}</button>
      </div>`;
    menu.querySelector(".length-menu-title")!.textContent = `${editing ? "Volume cue" : "New volume cue"} · ${formatFilmTime(engine.secondsAtBar(bar))} (${barLabel(bar)}${partName ? `, ${partName}` : ""})`;
    const select = menu.querySelector<HTMLSelectElement>("[data-cue-track]")!;
    for (const t of cueTracks) {
      const option = document.createElement("option");
      option.value = t.id;
      option.textContent = t.name;
      select.appendChild(option);
    }
    select.value = editing?.trackId ?? lastCueTrack ?? cueTracks[0]?.id ?? "";
    const dbInput = menu.querySelector<HTMLInputElement>("[data-cue-db]")!;
    const dbValue = menu.querySelector<HTMLElement>("[data-cue-value]")!;
    const setDb = (db: number): void => {
      dbInput.value = String(db);
      dbValue.textContent = dbText(db);
    };
    setDb(editing?.db ?? (engine.volumeAt(select.value, bar) === 0 ? -12 : 0));
    dbInput.addEventListener("input", () => setDb(Number(dbInput.value)));
    menu.querySelectorAll<HTMLButtonElement>("[data-db]").forEach((b) => b.addEventListener("click", () => setDb(Number(b.dataset.db))));
    const onlyWrap = menu.querySelector<HTMLElement>("[data-cue-only-wrap]")!;
    const onlyBox = menu.querySelector<HTMLInputElement>("[data-cue-only]")!;
    const onlyLabel = menu.querySelector<HTMLElement>("[data-cue-only-label]")!;
    const syncOnly = (): void => {
      const back = engine.volumeAt(select.value, bar);
      onlyLabel.textContent = part ? `Only in this part – back to ${dbText(back)} after ${partName}` : "";
    };
    onlyWrap.hidden = !!editing || !part;
    syncOnly();
    select.addEventListener("change", syncOnly);

    const save = (): void => {
      const trackId = select.value;
      const db = Number(dbInput.value);
      lastCueTrack = trackId;
      let cues = engine.volumeCues.map((c) => ({ ...c }));
      if (editing) {
        cues = cues.map((c) => (c.id === editing.id ? { ...c, trackId, db } : c));
      } else {
        const back = engine.volumeAt(trackId, bar);
        // A cue for the same instrument at the same spot is replaced.
        cues = cues.filter((c) => !(c.trackId === trackId && Math.abs(c.bar - bar) < 1e-6));
        cues.push({ id: newCueId(), trackId, bar, db });
        if (onlyBox.checked && part && !onlyWrap.hidden) {
          const endBar = part.endBar;
          const hasLater = cues.some((c) => c.trackId === trackId && c.bar > bar + 1e-6 && c.bar <= endBar + 1e-6);
          if (!hasLater && endBar <= totalBars) cues.push({ id: newCueId(), trackId, bar: endBar, db: back });
        }
      }
      closeCueMenu();
      engine.setVolumeCues(cues);
    };
    menu.querySelector("[data-cue-save]")!.addEventListener("click", save);
    menu.querySelector("[data-cancel]")!.addEventListener("click", closeCueMenu);
    menu.querySelector("[data-cue-delete]")?.addEventListener("click", () => {
      closeCueMenu();
      engine.setVolumeCues(engine.volumeCues.filter((c) => c.id !== editing!.id));
    });

    document.body.appendChild(menu);
    cueMenu = menu;
    const laneRect = cueLane.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX - w / 2))}px`;
    menu.style.top = `${laneRect.bottom + window.scrollY + 6}px`;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeCueMenu();
      else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        save();
      }
    };
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node && menu.contains(e.target))) closeCueMenu();
    };
    window.addEventListener("keydown", onKey);
    window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    cueMenuCleanup = () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }
  let lastCueTrack: string | null = null;

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

    // Section names right on the music, with a divider at each section start.
    ctx.save();
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    segments.forEach((segment, i) => {
      const x0 = xOfBar(segment.startBar) * width;
      const x1 = xOfBar(segment.endBar) * width;
      const isLoop = i > 0 && segments[i - 1]!.sectionId === segment.sectionId;
      if (isLoop) {
        // Loop point: a clear dashed marker in the loop colour.
        ctx.fillStyle = LOOP_COLOR;
        for (let y = 0; y < MIX_LANE_HEIGHT; y += 6) ctx.fillRect(Math.round(x0) - 1, y, 2, 3);
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
        ctx.fillRect(Math.round(x0), 0, 1, MIX_LANE_HEIGHT);
      }
      const name = (isLoop ? "↻ " : "") + (sectionNameById.get(segment.sectionId) ?? segment.sectionId);
      // A thin bar in the section's colour along the bottom ties the music to the form above.
      ctx.fillStyle = sectionColor(segment.sectionId);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x0, MIX_LANE_HEIGHT - 3, x1 - x0, 3);
      ctx.globalAlpha = 1;
      ctx.fillStyle = isLoop ? LOOP_COLOR : sectionColor(segment.sectionId);
      if (x1 - x0 > 24) ctx.fillText(name, x0 + 4, MIX_LANE_HEIGHT - 6, x1 - x0 - 8);
    });
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
      if (seg.cutTracks) cue.cutTracks = [...seg.cutTracks];
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
    syncLogoCard();
    syncArrangeButtons();
    renderCues();
    renderLayers();
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
    const minEnd = engine.musicStartSeconds + 2 * engine.barSeconds;
    const fractionAt = (clientX: number): number => {
      const rect = overlay.getBoundingClientRect();
      return (clientX - rect.left) / rect.width;
    };
    const toSeconds = (clientX: number): number => Math.max(minEnd, Math.min(1, fractionAt(clientX)) * spanSeconds);
    let lastX = e.clientX;
    spanOverride = spanSeconds;
    draggingEnd = toSeconds(e.clientX);
    const onMove = (ev: PointerEvent): void => {
      lastX = ev.clientX;
      draggingEnd = toSeconds(ev.clientX);
    };
    // Near (or past) the right edge the timeline keeps zooming out, so one drag can go from
    // a minute to several; the ruler, form and waveforms follow live.
    let lastDrawnSpan = spanSeconds;
    const tick = (): void => {
      if (draggingEnd === null || spanOverride === null) return;
      const fraction = fractionAt(lastX);
      if (fraction > 0.9 && spanOverride < 20 * 60) {
        spanOverride *= 1 + 0.035 * Math.min(1.5, (fraction - 0.9) / 0.1);
        spanSeconds = spanOverride;
        draggingEnd = toSeconds(lastX);
      }
      if (Math.abs(spanSeconds / lastDrawnSpan - 1) > 0.004) {
        lastDrawnSpan = spanSeconds;
        renderRuler();
        renderSections();
        if (!showSections) drawMixLane();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const onUp = (): void => {
      musicBlockHandle.removeEventListener("pointermove", onMove);
      musicBlockHandle.removeEventListener("pointerup", onUp);
      musicBlockHandle.removeEventListener("pointercancel", onUp);
      const end = draggingEnd;
      draggingEnd = null;
      spanOverride = null;
      lockMessage = "";
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 0);
      if (end !== null) engine.fitToAnchor(engine.anchorForEnd(end));
    };
    musicBlockHandle.addEventListener("pointermove", onMove);
    musicBlockHandle.addEventListener("pointerup", onUp);
    musicBlockHandle.addEventListener("pointercancel", onUp);
  });

  let lastBlockText = "";
  let lastStatus = "";
  function updateMusicBlock(): void {
    const start = engine.musicStartSeconds;
    const end = draggingEnd ?? engine.arrangementSeconds;
    musicBlock.style.left = `${xOfSeconds(start) * 100}%`;
    musicBlock.style.top = `${mixLane.offsetTop}px`;
    musicBlock.style.height = `${mixLane.offsetHeight}px`;
    musicBlock.style.width = `${Math.max(0, xOfSeconds(end) - xOfSeconds(start)) * 100}%`;
    musicBlock.classList.toggle("timeline-music-block-dragging", draggingEnd !== null);
    musicBlockHandle.hidden = !engine.canFit;
    undoBtn.disabled = !engine.canUndo;
    redoBtn.disabled = !engine.canRedo;
    lockBtn.hidden = !film?.info;
    const status = draggingEnd !== null ? "" : lockMessage || `Music ends at ${formatFilmTime(end)}`;
    if (status !== lastStatus) {
      statusEl.textContent = status;
      statusEl.classList.toggle("timeline-toolbar-warning", !!lockMessage);
      lastStatus = status;
    }
    const text =
      draggingEnd !== null
        ? `Release to fit to ${formatFilmTime(end)}`
        : `${formatFilmTime(end - start)} · ${totalBars} bars`;
    if (text !== lastBlockText) {
      musicBlockLabel.textContent = text;
      lastBlockText = text;
    }
  }

  renderRuler();
  renderSections();
  renderSegmentList();
  renderCues();
  renderLayers();
  engine.onArrangementChange(redrawAll);
  film?.onChange(() => {
    syncFitButtons();
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
    const anchor = engine.hasLogo ? (draggingAnchor ?? engine.logoAnchorSeconds) : null;
    logoAnchor.hidden = anchor === null;
    logoAnchor.classList.toggle("timeline-logo-anchor-dragging", draggingAnchor !== null);
    logoAnchor.classList.toggle("timeline-logo-anchor-fixed", !engine.canFit);
    // The drag handle only covers the music lane (not the form lane, where the × buttons are).
    logoAnchorHandle.style.top = `${mixLane.offsetTop}px`;
    logoAnchorHandle.style.bottom = "auto";
    logoAnchorHandle.style.height = `${mixLane.offsetHeight}px`;
    if (anchor !== null) {
      logoAnchor.style.left = `${Math.min(1, xOfSeconds(anchor)) * 100}%`;
      logoAnchor.classList.toggle("timeline-logo-anchor-flip", xOfSeconds(anchor) > 0.8);
      const text = `Logo start ${formatFilmTime(anchor)}`;
      if (text !== lastAnchorText) {
        logoAnchorLabel.textContent = text;
        logoAnchorHandle.title = engine.canFit
          ? "Drag to a sync point in the film – the music is re-arranged so the logo starts exactly there"
          : "";
        lastAnchorText = text;
      }
    }
    const lead = engine.musicStartSeconds;
    leadIn.hidden = lead < 0.05;
    if (!leadIn.hidden) {
      leadIn.style.width = `${xOfSeconds(lead) * 100}%`;
      leadInLabel.textContent = `Music starts ${formatSeconds(lead)} s in`;
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

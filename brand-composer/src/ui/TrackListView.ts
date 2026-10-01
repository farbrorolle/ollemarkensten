import * as Tone from "tone";
import { MUSIC_CUE_TRACK, VOLUME_CUE_MUTE_DB } from "../audio/AudioEngine.ts";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";

/** Buttons whose state can also be changed elsewhere (e.g. solo from the sidechain panel). */
const liveButtons: {
  track: Track;
  solo: HTMLButtonElement;
  mute: HTMLButtonElement;
  volume: HTMLInputElement;
  partLevel: HTMLElement;
}[] = [];

function mountTrackRow(
  container: HTMLElement,
  track: Track,
  engine: AudioEngine,
  onTrackChanged?: (trackId: string) => void,
): void {
  const row = document.createElement("div");
  row.className = "track-row";
  const loadControls = track.isSectioned
    ? `<span class="track-name-hint" title="Tracks with different audio per section can't be replaced by a single local file">per section</span>`
    : `<button data-load class="btn btn-file creator-only" title="Load a local audio file (or drag and drop)">📁</button>
       <input data-file-input type="file" accept="audio/*" hidden />`;
  row.innerHTML = `
    <span class="track-name-cell">
      <span class="track-name" data-name>${track.name}</span>
      ${loadControls}
      <span class="track-part-level" data-part-level></span>
    </span>
    <input data-volume type="range" min="-60" max="6" step="0.5" title="Volume (dB)" />
    <input data-pan class="creator-only" type="range" min="-1" max="1" step="0.05" title="Pan" />
    <button data-mute class="btn btn-toggle">M</button>
    <button data-solo class="btn btn-toggle creator-only">S</button>
  `;
  container.appendChild(row);

  const nameEl = row.querySelector<HTMLElement>("[data-name]")!;
  const loadBtn = row.querySelector<HTMLButtonElement>("[data-load]");
  const fileInput = row.querySelector<HTMLInputElement>("[data-file-input]");
  const volumeInput = row.querySelector<HTMLInputElement>("[data-volume]")!;
  const panInput = row.querySelector<HTMLInputElement>("[data-pan]")!;
  const muteBtn = row.querySelector<HTMLButtonElement>("[data-mute]")!;
  const soloBtn = row.querySelector<HTMLButtonElement>("[data-solo]")!;

  liveButtons.push({ track, solo: soloBtn, mute: muteBtn, volume: volumeInput, partLevel: row.querySelector<HTMLElement>("[data-part-level]")! });
  volumeInput.value = String(track.volume);
  panInput.value = String(track.pan);
  muteBtn.classList.toggle("btn-toggle-active", track.mute);
  soloBtn.classList.toggle("btn-toggle-active", track.solo);

  volumeInput.addEventListener("input", () => (track.volume = Number(volumeInput.value)));
  panInput.addEventListener("input", () => (track.pan = Number(panInput.value)));
  muteBtn.addEventListener("click", () => {
    track.mute = !track.mute;
    muteBtn.classList.toggle("btn-toggle-active", track.mute);
    engine.refreshSoloState();
  });
  soloBtn.addEventListener("click", () => {
    track.solo = !track.solo;
    soloBtn.classList.toggle("btn-toggle-active", track.solo);
    engine.refreshSoloState();
  });

  if (track.isSectioned) return; // no single-file replacement for a per-section track

  const loadLocalFile = async (file: File): Promise<void> => {
    engine.pause(); // buffer swaps don't retrigger an already-playing source; force a clean restart
    await track.loadFromFile(file);
    nameEl.textContent = `${track.name} (local file)`;
    row.classList.add("track-row-local-file");
    onTrackChanged?.(track.id);
  };

  loadBtn!.addEventListener("click", () => fileInput!.click());
  fileInput!.addEventListener("change", () => {
    const file = fileInput!.files?.[0];
    if (file) void loadLocalFile(file);
    fileInput!.value = "";
  });

  row.addEventListener("dragover", (event) => {
    event.preventDefault();
    row.classList.add("track-row-drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("track-row-drag-over"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("track-row-drag-over");
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadLocalFile(file);
  });
}

/**
 * Levels per part: try things with the faders while listening, then "Set levels for this part" --
 * the faders' changes become volume cues at the start of that part (and the levels come back after
 * it), and the faders return to the mix. Copy/paste a part's levels to another part, or apply
 * them to the whole music.
 */
function mountPartLevels(panel: HTMLElement, engine: AudioEngine, base: Map<string, number>): () => void {
  const bar = document.createElement("div");
  bar.className = "part-levels";
  bar.innerHTML = `
    <span class="part-levels-label">Levels per part</span>
    <select data-part title="The part the buttons work on"></select>
    <button type="button" class="btn btn-primary" data-set title="Turn the faders' changes into this part's levels (they come back to normal after the part)">Set levels for this part</button>
    <button type="button" class="btn" data-copy title="Copy this part's levels (as you hear them)">Copy</button>
    <button type="button" class="btn" data-paste disabled title="Give this part the copied levels">Paste</button>
    <button type="button" class="btn" data-all title="Use these levels (as you hear them now) for the whole music">Apply to all parts</button>
    <button type="button" class="btn" data-clear title="Remove this part's own levels">Clear part</button>
    <span class="part-levels-status" data-status></span>`;
  const header = panel.querySelector(".track-list-header");
  panel.insertBefore(bar, header ?? panel.firstChild);
  const select = bar.querySelector<HTMLSelectElement>("[data-part]")!;
  const status = bar.querySelector<HTMLElement>("[data-status]")!;
  const pasteBtn = bar.querySelector<HTMLButtonElement>("[data-paste]")!;
  let clipboard: Map<string, number> | null = null;
  const tracks = (): Track[] => Array.from(engine.tracks.values()).filter((t) => !t.isLogo);
  const segments = () => engine.arrangement.arrangementSegments;
  const nameOf = (id: string): string => engine.sectionName(id);
  let optionsKey = "";

  /** The part the buttons act on: the chosen one, or the one under the playhead. */
  const currentPart = () => {
    const segs = segments();
    if (select.value !== "auto") return segs[Number(select.value)] ?? null;
    const t = Tone.getTransport().seconds;
    return segs.find((s) => t >= engine.barStartSeconds(s.startBar) && t < engine.barStartSeconds(s.endBar)) ?? segs[0] ?? null;
  };
  const trialOffset = (t: Track): number => t.volume - (base.get(t.id) ?? 0);
  const levelIn = (trackId: string, startBar: number): number => engine.volumeAt(trackId, startBar + 0.001);
  const resetFaders = (): void => {
    for (const t of tracks()) t.volume = base.get(t.id) ?? 0;
    for (const lb of liveButtons) lb.volume.value = String(lb.track.volume);
  };
  const clampDb = (db: number): number => Math.max(VOLUME_CUE_MUTE_DB, Math.min(12, Math.round(db * 2) / 2));

  /** Gives a part these levels (dB vs the mix, per track): cues at its start, back after it. */
  function applyToPart(part: { startBar: number; endBar: number }, levels: Map<string, number>): void {
    let cues = engine.volumeCues.map((c) => ({ ...c }));
    const after = new Map(tracks().map((t) => [t.id, engine.volumeAt(t.id, part.endBar + 0.001)]));
    const before = new Map(tracks().map((t) => [t.id, engine.volumeAt(t.id, part.startBar)]));
    // This part's own cues are replaced.
    cues = cues.filter((c) => c.trackId === MUSIC_CUE_TRACK || !(c.bar >= part.startBar - 1e-6 && c.bar < part.endBar - 1e-6));
    let n = 0;
    for (const t of tracks()) {
      const db = clampDb(levels.get(t.id) ?? 0);
      if (Math.abs(db - (before.get(t.id) ?? 0)) > 0.01) {
        cues.push({ id: `lv-${t.id}-${part.startBar}-${n++}`, trackId: t.id, bar: part.startBar, db });
      }
      const hasEndCue = cues.some((c) => c.trackId === t.id && Math.abs(c.bar - part.endBar) < 1e-6);
      if (!hasEndCue && part.endBar <= engine.arrangement.totalBars && Math.abs(db - (after.get(t.id) ?? 0)) > 0.01) {
        cues.push({ id: `lv-${t.id}-${part.endBar}-${n++}`, trackId: t.id, bar: part.endBar, db: after.get(t.id) ?? 0 });
      }
    }
    engine.setVolumeCues(cues);
  }
  /** What you hear in a part right now (its levels + the faders' trial changes). */
  const heardLevels = (part: { startBar: number }): Map<string, number> =>
    new Map(tracks().map((t) => [t.id, levelIn(t.id, part.startBar) + trialOffset(t)]));

  bar.querySelector("[data-set]")!.addEventListener("click", () => {
    const part = currentPart();
    if (!part) return;
    applyToPart(part, heardLevels(part));
    resetFaders();
    status.textContent = `Levels set for ${nameOf(part.sectionId)} ✓`;
  });
  bar.querySelector("[data-copy]")!.addEventListener("click", () => {
    const part = currentPart();
    if (!part) return;
    clipboard = heardLevels(part);
    pasteBtn.disabled = false;
    status.textContent = `Copied the levels of ${nameOf(part.sectionId)}`;
  });
  pasteBtn.addEventListener("click", () => {
    const part = currentPart();
    if (!part || !clipboard) return;
    applyToPart(part, clipboard);
    status.textContent = `Pasted into ${nameOf(part.sectionId)} ✓`;
  });
  bar.querySelector("[data-all]")!.addEventListener("click", () => {
    const part = currentPart();
    const levels = clipboard ?? (part ? heardLevels(part) : new Map<string, number>());
    const cues = [
      ...engine.volumeCues.filter((c) => c.trackId === MUSIC_CUE_TRACK),
      ...tracks()
        .filter((t) => Math.abs(levels.get(t.id) ?? 0) > 0.01)
        .map((t, i) => ({ id: `lv-all-${t.id}-${i}`, trackId: t.id, bar: 1, db: clampDb(levels.get(t.id) ?? 0) })),
    ];
    engine.setVolumeCues(cues);
    resetFaders();
    status.textContent = "These levels now apply to the whole music ✓";
  });
  bar.querySelector("[data-clear]")!.addEventListener("click", () => {
    const part = currentPart();
    if (!part) return;
    engine.setVolumeCues(engine.volumeCues.filter((c) => c.trackId === MUSIC_CUE_TRACK || !(c.bar >= part.startBar - 1e-6 && c.bar <= part.endBar + 1e-6)));
    status.textContent = `${nameOf(part.sectionId)} is back to the normal mix`;
  });

  // Keeps the part list current and shows each track's level in the chosen part.
  return () => {
    const segs = segments();
    const key = segs.map((s) => `${s.sectionId}${s.startBar}`).join(",");
    if (key !== optionsKey) {
      optionsKey = key;
      const keep = select.value || "auto";
      select.innerHTML = `<option value="auto">Part under the playhead</option>`;
      segs.forEach((seg, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `${i + 1}. ${nameOf(seg.sectionId)} (bar ${seg.startBar})`;
        select.appendChild(o);
      });
      select.value = Array.from(select.options).some((o) => o.value === keep) ? keep : "auto";
    }
    const part = currentPart();
    for (const lb of liveButtons) {
      const db = part ? levelIn(lb.track.id, part.startBar) : 0;
      const text = Math.abs(db) < 0.01 ? "" : db <= VOLUME_CUE_MUTE_DB ? "muted in this part" : `${db > 0 ? "+" : ""}${db} dB in this part`;
      if (lb.partLevel.textContent !== text) lb.partLevel.textContent = text;
    }
  };
}

export function mountTrackList(
  root: HTMLElement,
  engine: AudioEngine,
  onTrackChanged?: (trackId: string) => void,
): { update(): void } {
  root.innerHTML = "";
  liveButtons.length = 0;
  const base = new Map(Array.from(engine.tracks.values()).map((t) => [t.id, t.volume]));
  for (const track of engine.tracks.values()) mountTrackRow(root, track, engine, onTrackChanged);
  const updateLevels = root.parentElement ? mountPartLevels(root.parentElement, engine, base) : () => {};
  let frame = 0;
  return {
    update() {
      if (++frame % 10 === 0) updateLevels();
      for (const { track, solo, mute } of liveButtons) {
        solo.classList.toggle("btn-toggle-active", track.solo);
        mute.classList.toggle("btn-toggle-active", track.mute);
      }
    },
  };
}

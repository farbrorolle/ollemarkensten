import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";

function mountTrackRow(container: HTMLElement, track: Track, engine: AudioEngine): void {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    <span class="track-name-cell">
      <span class="track-name" data-name>${track.name}</span>
      <button data-load class="btn btn-file" title="Ladda lokal WAV-fil (eller dra och släpp)">📁</button>
      <input data-file-input type="file" accept="audio/*" hidden />
    </span>
    <input data-volume type="range" min="-60" max="6" step="0.5" title="Volume (dB)" />
    <input data-pan type="range" min="-1" max="1" step="0.05" title="Pan" />
    <button data-mute class="btn btn-toggle">M</button>
    <button data-solo class="btn btn-toggle">S</button>
  `;
  container.appendChild(row);

  const nameEl = row.querySelector<HTMLElement>("[data-name]")!;
  const loadBtn = row.querySelector<HTMLButtonElement>("[data-load]")!;
  const fileInput = row.querySelector<HTMLInputElement>("[data-file-input]")!;
  const volumeInput = row.querySelector<HTMLInputElement>("[data-volume]")!;
  const panInput = row.querySelector<HTMLInputElement>("[data-pan]")!;
  const muteBtn = row.querySelector<HTMLButtonElement>("[data-mute]")!;
  const soloBtn = row.querySelector<HTMLButtonElement>("[data-solo]")!;

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

  const loadLocalFile = async (file: File): Promise<void> => {
    engine.pause(); // buffer swaps don't retrigger an already-playing source; force a clean restart
    await track.loadFromFile(file);
    nameEl.textContent = `${track.name} (lokal fil)`;
    row.classList.add("track-row-local-file");
  };

  loadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadLocalFile(file);
    fileInput.value = "";
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

export function mountTrackList(root: HTMLElement, engine: AudioEngine): void {
  root.innerHTML = "";
  for (const track of engine.tracks.values()) mountTrackRow(root, track, engine);
}

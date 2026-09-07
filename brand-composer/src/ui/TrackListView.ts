import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Track } from "../audio/Track.ts";

function mountTrackRow(container: HTMLElement, track: Track, engine: AudioEngine): void {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    <span class="track-name">${track.name}</span>
    <input data-volume type="range" min="-60" max="6" step="0.5" title="Volume (dB)" />
    <input data-pan type="range" min="-1" max="1" step="0.05" title="Pan" />
    <button data-mute class="btn btn-toggle">M</button>
    <button data-solo class="btn btn-toggle">S</button>
  `;
  container.appendChild(row);

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
}

export function mountTrackList(root: HTMLElement, engine: AudioEngine): void {
  root.innerHTML = "";
  for (const track of engine.tracks.values()) mountTrackRow(root, track, engine);
}

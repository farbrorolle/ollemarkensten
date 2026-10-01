import type { AudioEngine } from "../audio/AudioEngine.ts";
import { downloadBlob } from "../audio/wav.ts";
import type { VideoSync } from "../video/VideoSync.ts";

/**
 * Export: the music as a WAV (from the film's first frame, so it lines up when laid under the
 * film in any editor), and the film itself with the new sound.
 */
export function mountExportBar(root: HTMLElement, engine: AudioEngine, film: VideoSync): { update(): void } {
  const bar = document.createElement("div");
  bar.className = "export-bar";
  bar.innerHTML = `
    <span class="position-label">Export</span>
    <button type="button" class="btn export-option" data-export-music title="The music (with the logo) as a 24-bit WAV, starting at the film's first frame"><span class="export-option-title">Export music (WAV)</span><span class="export-option-sub">24-bit · lines up with the film's first frame</span></button>
    <button type="button" class="btn btn-accent export-option" data-export-film title="Your film with the new sound (music + the film's own sound if it is on)"><span class="export-option-title">Export film with music</span><span class="export-option-sub" data-export-film-sub>Same picture, new sound</span></button>
    <span class="export-status" data-export-status></span>`;
  root.appendChild(bar);
  const musicBtn = bar.querySelector<HTMLButtonElement>("[data-export-music]")!;
  const filmBtn = bar.querySelector<HTMLButtonElement>("[data-export-film]")!;
  const status = bar.querySelector<HTMLElement>("[data-export-status]")!;
  const filmSub = bar.querySelector<HTMLElement>("[data-export-film-sub]")!;
  let busy = false;
  const setBusy = (on: boolean): void => {
    busy = on;
    musicBtn.disabled = on;
    filmBtn.disabled = on || !film.info;
  };
  const baseName = (): string => (film.info?.name ?? engine.title).replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");

  musicBtn.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    const filmAudio = film.audioOn;
    try {
      if (filmAudio) film.setAudioOn(false); // the music alone
      const blob = await engine.renderOutput(engine.arrangementSeconds + 0.5, (f) => {
        status.textContent = `Rendering the music… ${Math.round(f * 100)}% (plays through once, silently)`;
      });
      downloadBlob(blob, `${baseName()} – music.wav`);
      status.textContent = "Music exported ✓";
    } catch (error) {
      console.error(error);
      status.textContent = "Export failed – see the console.";
    } finally {
      if (filmAudio) film.setAudioOn(true);
      setBusy(false);
    }
  });

  filmBtn.addEventListener("click", async () => {
    const info = film.info;
    const url = film.sourceUrl;
    if (busy || !info || !url) return;
    film.primeFromGesture(); // the film plays through once while its sound is captured
    setBusy(true);
    try {
      const wav = await engine.renderOutput(info.duration, (f) => {
        status.textContent = `Rendering the sound… ${Math.round(f * 100)}% (plays through once, silently)`;
      });
      const source = await (await fetch(url)).blob();
      const { muxFilmWithAudio } = await import("../video/muxFilm.ts");
      const result = await muxFilmWithAudio(source, info.name, wav, (text) => (status.textContent = text));
      downloadBlob(result.blob, result.name);
      status.textContent = "Film exported ✓";
    } catch (error) {
      console.error(error);
      status.textContent = "Film export failed – see the console. (The music export still works.)";
    } finally {
      setBusy(false);
    }
  });

  return {
    update() {
      if (!busy) filmBtn.disabled = !film.info;
      const sub = film.info ? "Same picture, new sound (the film's own format)" : "Add a film first";
      if (filmSub.textContent !== sub) filmSub.textContent = sub;
    },
  };
}

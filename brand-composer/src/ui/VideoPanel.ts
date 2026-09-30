import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { SectionConfig } from "../project/types.ts";
import type { VideoSync } from "../video/VideoSync.ts";
import { formatFilmTime, formatSeconds } from "../video/syncMath.ts";

export interface VideoPanelHandle {
  update(): void;
}

/**
 * The customer-facing film view: a big drop zone until a film is loaded,
 * then the film itself with the current music section and film time on top,
 * a clear on/off switch for the film's own sound, and a plain-language line
 * saying whether the music covers the whole film.
 *
 * Clicking the picture plays/pauses (same as the transport's Play/Pause).
 */
export function mountVideoPanel(
  root: HTMLElement,
  engine: AudioEngine,
  film: VideoSync,
  sections: SectionConfig[],
  togglePlay: () => void,
): VideoPanelHandle {
  const sectionNameById = new Map(sections.map((s) => [s.id, s.name]));

  root.innerHTML = `
    <div class="video-drop" data-empty>
      <div class="video-drop-icon" aria-hidden="true">🎬</div>
      <p class="video-drop-title">Add your film</p>
      <p class="video-drop-text">Drag a video file here, or</p>
      <button type="button" class="btn btn-primary" data-pick>Choose film…</button>
      <p class="video-drop-note">
        The film is never uploaded anywhere – it only plays here, in your browser.<br />
        Best supported: <strong>MP4 (H.264 + AAC)</strong>
      </p>
    </div>
    <div class="video-loaded" data-loaded hidden>
      <div class="video-stage" data-stage title="Click to play/pause">
        <div class="video-overlay video-overlay-section" data-section></div>
        <div class="video-overlay video-overlay-time" data-time></div>
        <div class="video-overlay video-overlay-ended" data-ended hidden>Film ended · music plays out</div>
        <div class="video-play-hint" data-play-hint aria-hidden="true">▶</div>
      </div>
      <div class="video-bar">
        <span class="video-file">
          <span class="video-file-name" data-name></span>
          <span class="video-file-length" data-length></span>
        </span>
        <span class="video-fit" data-fit></span>
        <span class="video-bar-actions">
          <button type="button" class="btn video-audio-toggle" data-audio></button>
          <label class="video-volume" title="Film audio level (separate from the music)">
            <span>Film audio</span>
            <input type="range" min="-40" max="6" step="0.5" data-film-volume />
            <span class="video-volume-value" data-film-volume-value></span>
          </label>
          <button type="button" class="btn" data-replace>Replace film</button>
          <button type="button" class="btn" data-remove>Remove</button>
        </span>
      </div>
      <p class="video-notice" data-notice hidden></p>
    </div>
    <p class="video-error" data-error hidden></p>
    <input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" hidden data-input />
  `;

  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const emptyEl = q("[data-empty]");
  const loadedEl = q("[data-loaded]");
  const stage = q("[data-stage]");
  const sectionEl = q("[data-section]");
  const timeEl = q("[data-time]");
  const endedEl = q("[data-ended]");
  const playHint = q("[data-play-hint]");
  const nameEl = q("[data-name]");
  const lengthEl = q("[data-length]");
  const fitEl = q("[data-fit]");
  const audioBtn = q<HTMLButtonElement>("[data-audio]");
  const noticeEl = q("[data-notice]");
  const errorEl = q("[data-error]");
  const input = q<HTMLInputElement>("[data-input]");

  stage.prepend(film.video);

  const showError = (message: string | null): void => {
    errorEl.hidden = !message;
    errorEl.textContent = message ?? "";
  };

  const loadFile = async (file: File): Promise<void> => {
    showError(null);
    if (file.type && !file.type.startsWith("video/")) {
      showError(`"${file.name}" is not a video file.`);
      return;
    }
    root.classList.add("video-loading");
    try {
      await film.load(file);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      root.classList.remove("video-loading");
    }
  };

  q("[data-pick]").addEventListener("click", () => input.click());
  q("[data-replace]").addEventListener("click", () => input.click());
  q("[data-remove]").addEventListener("click", () => {
    showError(null);
    film.clear();
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void loadFile(file);
    input.value = "";
  });

  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    root.classList.add("video-drag-over");
  });
  root.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
    root.classList.remove("video-drag-over");
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    root.classList.remove("video-drag-over");
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });

  stage.addEventListener("click", () => togglePlay());
  audioBtn.addEventListener("click", () => film.setAudioOn(!film.audioOn));
  const volumeInput = q<HTMLInputElement>("[data-film-volume]");
  const volumeValue = q("[data-film-volume-value]");
  volumeInput.value = String(film.volumeDb);
  volumeInput.addEventListener("input", () => film.setVolumeDb(Number(volumeInput.value)));

  function renderFilmState(): void {
    const info = film.info;
    emptyEl.hidden = !!info;
    loadedEl.hidden = !info;
    if (!info) return;

    nameEl.textContent = info.name;
    nameEl.title = info.name;
    lengthEl.textContent = formatFilmTime(info.duration);

    volumeValue.textContent = `${film.volumeDb > 0 ? "+" : ""}${film.volumeDb.toFixed(1)} dB`;
    const on = film.audioOn;
    audioBtn.textContent = on ? "🔊 Film audio: ON" : "🔇 Film audio: OFF";
    audioBtn.classList.toggle("video-audio-on", on);
    audioBtn.setAttribute("aria-pressed", String(on));
    audioBtn.title =
      info.audioState === "none"
        ? "No audio track found in the film"
        : on
          ? "Click to turn off the film's own audio (the music is not affected)"
          : "Click to hear the film's own audio together with the music";

    noticeEl.hidden = !film.autoplayBlocked;
    noticeEl.textContent = film.autoplayBlocked
      ? "The browser blocked the film audio from starting automatically. Click “Film audio” to turn it back on."
      : "";
  }

  film.onChange(renderFilmState);
  renderFilmState();

  // Only touch the DOM when a value actually changes -- update() runs every frame.
  let lastSection = "";
  let lastTime = "";
  let lastFit = "";
  let lastFitClass = "";

  return {
    update() {
      const info = film.info;
      if (!info) return;

      const transport = Tone.getTransport();
      const running = transport.state === "started";
      const position = Math.max(0, engine.audibleSeconds);
      const filmOver = position >= info.duration;

      const sectionId = engine.arrangement.activeSectionId;
      const intoMusic = position - engine.musicStartSeconds;
      const bar = Math.floor(intoMusic / engine.barSeconds) + 1;
      const sectionText =
        sectionId && intoMusic >= 0 && bar <= engine.arrangement.totalBars
          ? `${sectionNameById.get(sectionId) ?? sectionId} · bar ${bar}`
          : "";
      if (sectionText !== lastSection) {
        sectionEl.textContent = sectionText;
        sectionEl.hidden = !sectionText;
        lastSection = sectionText;
      }

      const timeText = `${formatFilmTime(Math.min(position, info.duration))} / ${formatFilmTime(info.duration)}`;
      if (timeText !== lastTime) {
        timeEl.textContent = timeText;
        lastTime = timeText;
      }

      playHint.hidden = running;
      endedEl.hidden = !(running && filmOver);

      let fitText: string;
      let fitClass: string;
      const logoEnd = engine.logoEndSeconds;
      if (logoEnd !== null) {
        // Logo projects: what matters is where the logo lands relative to the film.
        const diff = logoEnd - info.duration;
        const warning = engine.lastFit?.warnings[0];
        if (warning) {
          fitText = `⚠ ${warning}`;
          fitClass = "video-fit-warn";
        } else if (film.detectedCut !== null && Math.abs((engine.logoAnchorSeconds ?? -1) - film.detectedCut) < 0.05) {
          fitText = `✓ Logo hit synced to the film's last cut (${formatFilmTime(film.detectedCut)})`;
          fitClass = "video-fit-ok";
        } else if (Math.abs(diff) < 0.05) {
          fitText = "✓ The logo ends when the film ends";
          fitClass = "video-fit-ok";
        } else if (diff > 0) {
          fitText = `✓ The logo ends ${formatSeconds(diff)} s after the film`;
          fitClass = diff > 2 ? "video-fit-warn" : "video-fit-ok";
        } else {
          fitText = `✓ The logo ends ${formatSeconds(-diff)} s before the end of the film`;
          fitClass = "video-fit-ok";
        }
      } else {
        const diff = engine.arrangementSeconds - info.duration;
        if (Math.abs(diff) < 0.05) {
          fitText = "✓ Music and film are the same length";
          fitClass = "video-fit-ok";
        } else if (diff > 0) {
          fitText = `✓ The music covers the whole film (and plays ${formatSeconds(diff)} s longer)`;
          fitClass = "video-fit-ok";
        } else {
          fitText = `⚠ The music ends ${formatSeconds(-diff)} s before the film – make it longer`;
          fitClass = "video-fit-warn";
        }
      }
      if (fitText !== lastFit || fitClass !== lastFitClass) {
        fitEl.textContent = fitText;
        fitEl.className = `video-fit ${fitClass}`;
        lastFit = fitText;
        lastFitClass = fitClass;
      }
    },
  };
}

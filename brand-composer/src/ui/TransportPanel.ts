import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import { formatBarsBeats } from "./formatPosition.ts";

export interface TransportPanelHandle {
  update(): void;
}

/**
 * @param onPlayGesture called synchronously inside the Play click, before audio starts -- used to
 *   "unlock" the film's <video> for playback with sound (browsers require a user gesture for that).
 */
export function mountTransportPanel(root: HTMLElement, engine: AudioEngine, onPlayGesture?: () => void): TransportPanelHandle {
  root.innerHTML = `
    <div class="transport-buttons">
      <button data-home class="btn transport-btn" title="To the start (Home)">⏮</button>
      <button data-back class="btn transport-btn" title="Back 5 seconds (←)">⏪</button>
      <button data-play class="btn btn-primary transport-play" title="Play / pause (space)">▶ Play</button>
      <button data-stop class="btn transport-btn" title="Stop and go to the start">⏹</button>
      <button data-fwd class="btn transport-btn" title="Forward 5 seconds (→)">⏩</button>
    </div>
    <div class="position-display">
      <span class="position-label">Time</span>
      <span data-transport-time class="position-value">0:00.0</span>
    </div>
    <label class="field creator-only">
      <span>BPM</span>
      <input data-bpm type="number" min="20" max="300" step="1" />
    </label>
    <div class="position-display">
      <span class="position-label">Bar:Beat</span>
      <span data-position class="position-value">1:1</span>
    </div>
    <div class="section-display">
      <span class="position-label">Section</span>
      <span data-section class="section-value">–</span>
    </div>
  `;

  const playBtn = root.querySelector<HTMLButtonElement>("[data-play]")!;
  const homeBtn = root.querySelector<HTMLButtonElement>("[data-home]")!;
  const backBtn = root.querySelector<HTMLButtonElement>("[data-back]")!;
  const fwdBtn = root.querySelector<HTMLButtonElement>("[data-fwd]")!;
  const timeEl = root.querySelector<HTMLElement>("[data-transport-time]")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("[data-stop]")!;
  const bpmInput = root.querySelector<HTMLInputElement>("[data-bpm]")!;
  const positionEl = root.querySelector<HTMLElement>("[data-position]")!;
  const sectionEl = root.querySelector<HTMLElement>("[data-section]")!;

  bpmInput.value = String(engine.bpm);

  const playing = (): boolean => Tone.getTransport().state === "started";
  const togglePlay = async (): Promise<void> => {
    if (playing()) {
      engine.pause();
      return;
    }
    onPlayGesture?.();
    await engine.unlockAudio();
    engine.play();
  };
  const seekBy = (seconds: number): void => {
    const transport = Tone.getTransport();
    transport.seconds = Math.max(0, transport.seconds + seconds);
  };
  playBtn.addEventListener("click", () => void togglePlay());
  stopBtn.addEventListener("click", () => engine.stop());
  homeBtn.addEventListener("click", () => (Tone.getTransport().seconds = 0));
  backBtn.addEventListener("click", () => seekBy(-5));
  fwdBtn.addEventListener("click", () => seekBy(5));
  // Keyboard: ← → = 5 s, Home = start (not while typing in a field).
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // (Space = play/pause is handled in main.ts.)
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekBy(-5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekBy(5);
    } else if (e.key === "Home") {
      e.preventDefault();
      Tone.getTransport().seconds = 0;
    }
  });
  bpmInput.addEventListener("change", () => {
    const value = Number(bpmInput.value);
    if (Number.isFinite(value) && value > 0) engine.setBpm(value);
  });


  return {
    update() {
      positionEl.textContent = formatBarsBeats(String(Tone.getTransport().position));
      const t = Tone.getTransport().seconds;
      const m = Math.floor(t / 60);
      timeEl.textContent = `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
      const sectionId = engine.sectionAtSeconds(Math.max(0, engine.audibleSeconds));
      const sectionText = sectionId ? engine.sectionName(sectionId) : "–";
      if (sectionEl.textContent !== sectionText) sectionEl.textContent = sectionText;
      const label = playing() ? "⏸ Pause" : "▶ Play";
      if (playBtn.textContent !== label) playBtn.textContent = label;
    },
  };
}

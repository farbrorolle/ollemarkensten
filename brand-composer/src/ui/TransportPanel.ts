import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import { formatBarsBeats } from "./formatPosition.ts";

export interface TransportPanelHandle {
  update(): void;
}

export function mountTransportPanel(root: HTMLElement, engine: AudioEngine): TransportPanelHandle {
  root.innerHTML = `
    <div class="transport-buttons">
      <button data-play class="btn btn-primary">▶ Play</button>
      <button data-pause class="btn">⏸ Pause</button>
      <button data-stop class="btn">⏹ Stop</button>
    </div>
    <label class="field">
      <span>BPM</span>
      <input data-bpm type="number" min="20" max="300" step="1" />
    </label>
    <div class="position-display">
      <span class="position-label">Bar:Beat</span>
      <span data-position class="position-value">1:1</span>
    </div>
    <div class="section-display">
      <span class="position-label">Sektion</span>
      <span data-section class="section-value">–</span>
    </div>
  `;

  const playBtn = root.querySelector<HTMLButtonElement>("[data-play]")!;
  const pauseBtn = root.querySelector<HTMLButtonElement>("[data-pause]")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("[data-stop]")!;
  const bpmInput = root.querySelector<HTMLInputElement>("[data-bpm]")!;
  const positionEl = root.querySelector<HTMLElement>("[data-position]")!;
  const sectionEl = root.querySelector<HTMLElement>("[data-section]")!;

  bpmInput.value = String(engine.bpm);

  playBtn.addEventListener("click", async () => {
    await engine.unlockAudio();
    engine.play();
  });
  pauseBtn.addEventListener("click", () => engine.pause());
  stopBtn.addEventListener("click", () => engine.stop());
  bpmInput.addEventListener("change", () => {
    const value = Number(bpmInput.value);
    if (Number.isFinite(value) && value > 0) engine.setBpm(value);
  });

  engine.arrangement.setOnSectionChange((sectionId) => {
    sectionEl.textContent = sectionId;
  });

  return {
    update() {
      positionEl.textContent = formatBarsBeats(String(Tone.getTransport().position));
    },
  };
}

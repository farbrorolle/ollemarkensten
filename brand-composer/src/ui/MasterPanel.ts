import type { AudioEngine } from "../audio/AudioEngine.ts";
import { downloadBlob } from "../audio/wav.ts";

export interface MasterPanelHandle {
  update(): void;
}

function sanitizeFilename(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .replace(/\s+/g, "-") || "brand-composer"
  );
}

export function mountMasterPanel(root: HTMLElement, engine: AudioEngine): MasterPanelHandle {
  root.innerHTML = `
    <label class="field">
      <span>Master Gain (dB)</span>
      <input data-gain type="range" min="-24" max="6" step="0.5" />
    </label>
    <label class="field">
      <span>Limiter Threshold (dB)</span>
      <input data-threshold type="range" min="-24" max="0" step="0.5" />
    </label>
    <div class="limiter-meter">
      <span class="position-label">Limiter GR</span>
      <div class="meter-track"><div data-meter-fill class="meter-fill"></div></div>
      <span data-meter-value class="meter-value">0.0 dB</span>
    </div>
    <div class="export-row">
      <button data-export class="btn btn-accent">⇩ Exportera stereo-WAV</button>
      <span data-export-status class="export-status"></span>
    </div>
  `;

  const gainInput = root.querySelector<HTMLInputElement>("[data-gain]")!;
  const thresholdInput = root.querySelector<HTMLInputElement>("[data-threshold]")!;
  const meterFill = root.querySelector<HTMLElement>("[data-meter-fill]")!;
  const meterValue = root.querySelector<HTMLElement>("[data-meter-value]")!;
  const exportBtn = root.querySelector<HTMLButtonElement>("[data-export]")!;
  const exportStatus = root.querySelector<HTMLElement>("[data-export-status]")!;

  gainInput.value = String(engine.masterGain);
  thresholdInput.value = String(engine.limiterThreshold);

  gainInput.addEventListener("input", () => engine.setMasterGain(Number(gainInput.value)));
  thresholdInput.addEventListener("input", () => engine.setLimiterThreshold(Number(thresholdInput.value)));

  let statusResetTimer: number | undefined;
  exportBtn.addEventListener("click", async () => {
    window.clearTimeout(statusResetTimer);
    exportBtn.disabled = true;
    exportStatus.textContent = "Exporterar… 0%";
    try {
      const blob = await engine.exportStereoMix((fraction) => {
        exportStatus.textContent = `Exporterar… ${Math.round(fraction * 100)}%`;
      });
      exportStatus.textContent = "Klart!";
      downloadBlob(blob, `${sanitizeFilename(engine.title)}.wav`);
    } catch (error) {
      console.error(error);
      exportStatus.textContent = "Export misslyckades – se konsolen.";
    } finally {
      exportBtn.disabled = false;
      statusResetTimer = window.setTimeout(() => (exportStatus.textContent = ""), 4000);
    }
  });

  return {
    update() {
      const reduction = engine.limiterReduction; // 0 (no limiting) .. negative dB
      const magnitude = Math.min(24, Math.abs(reduction));
      meterFill.style.width = `${(magnitude / 24) * 100}%`;
      meterFill.classList.toggle("meter-fill-active", magnitude > 0.05);
      meterValue.textContent = `${reduction.toFixed(1)} dB`;
    },
  };
}

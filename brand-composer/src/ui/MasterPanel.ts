import type { AudioEngine } from "../audio/AudioEngine.ts";
import { downloadBlob } from "../audio/wav.ts";
import type { CompressorSettings } from "../project/types.ts";

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

/** A labelled range slider that shows its value; `format` turns the raw value into text. */
function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onInput: (v: number) => void,
): HTMLLabelElement {
  const el = document.createElement("label");
  el.innerHTML = `<span>${label} <span class="value-tag"></span></span><input type="range" min="${min}" max="${max}" step="${step}" />`;
  const input = el.querySelector("input")!;
  const tag = el.querySelector<HTMLElement>(".value-tag")!;
  input.value = String(value);
  tag.textContent = format(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    tag.textContent = format(v);
    onInput(v);
  });
  return el;
}

function meter(label: string): { el: HTMLElement; set(reductionDb: number): void } {
  const el = document.createElement("div");
  el.className = "limiter-meter";
  el.innerHTML = `
    <span class="position-label">${label}</span>
    <div class="meter-track"><div class="meter-fill"></div></div>
    <span class="meter-value">0.0 dB</span>`;
  const fill = el.querySelector<HTMLElement>(".meter-fill")!;
  const value = el.querySelector<HTMLElement>(".meter-value")!;
  return {
    el,
    set(reduction: number) {
      const magnitude = Math.min(24, Math.abs(reduction));
      fill.style.width = `${(magnitude / 24) * 100}%`;
      fill.classList.toggle("meter-fill-active", magnitude > 0.05);
      value.textContent = `${reduction.toFixed(1)} dB`;
    },
  };
}

const dB = (v: number): string => `${v.toFixed(1)} dB`;
const ms = (v: number): string => `${Math.round(v * 1000)} ms`;

/**
 * Creator view: master gain, bus compressor (with gain-reduction meter),
 * limiter (with meter) and the stereo export.
 */
export function mountMasterPanel(root: HTMLElement, engine: AudioEngine): MasterPanelHandle {
  root.innerHTML = "";

  const gainGrid = document.createElement("div");
  gainGrid.className = "creator-grid";
  gainGrid.append(slider("Master gain", -24, 6, 0.5, engine.masterGain, dB, (v) => engine.setMasterGain(v)));
  root.append(gainGrid);

  // Bus compressor.
  const compHead = document.createElement("div");
  compHead.className = "creator-subhead";
  compHead.innerHTML = `Busskompressor <label class="checkbox-row"><label><input type="checkbox" data-comp-on /> På</label></label>`;
  const compOn = compHead.querySelector<HTMLInputElement>("[data-comp-on]")!;
  const comp = engine.compressorState;
  compOn.checked = comp.enabled;
  const set = (patch: Partial<CompressorSettings>): void => engine.setCompressor(patch);
  compOn.addEventListener("change", () => set({ enabled: compOn.checked }));
  const compGrid = document.createElement("div");
  compGrid.className = "creator-grid";
  compGrid.append(
    slider("Threshold", -48, 0, 0.5, comp.threshold, dB, (v) => set({ threshold: v })),
    slider("Ratio", 1, 20, 0.5, comp.ratio, (v) => `${v.toFixed(1)}:1`, (v) => set({ ratio: v })),
    slider("Attack", 0.001, 0.2, 0.001, comp.attack, ms, (v) => set({ attack: v })),
    slider("Release", 0.02, 1, 0.01, comp.release, ms, (v) => set({ release: v })),
    slider("Knee", 0, 24, 1, comp.knee, dB, (v) => set({ knee: v })),
  );
  const compMeter = meter("Komp. GR");
  root.append(compHead, compGrid, compMeter.el);

  // Limiter.
  const limHead = document.createElement("div");
  limHead.className = "creator-subhead";
  limHead.textContent = "Limiter";
  const limGrid = document.createElement("div");
  limGrid.className = "creator-grid";
  limGrid.append(
    slider("Gain in", -12, 18, 0.5, engine.limiterDriveDb, (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`, (v) =>
      engine.setLimiterDrive(v),
    ),
    slider("Threshold (tak)", -24, 0, 0.5, engine.limiterThreshold, dB, (v) => engine.setLimiterThreshold(v)),
  );
  const limMeter = meter("Limiter GR");
  root.append(limHead, limGrid, limMeter.el);

  // Loudness after the limiter.
  const lufsHead = document.createElement("div");
  lufsHead.className = "creator-subhead";
  lufsHead.innerHTML = `Loudness efter limitern (LUFS) <button type="button" class="btn btn-step" data-lufs-reset title="Nollställ integrerat värde">↺</button>`;
  const lufs = document.createElement("div");
  lufs.className = "lufs-meter";
  lufs.innerHTML = `
    <div class="lufs-cell"><span class="lufs-label">Momentary</span><span class="lufs-value" data-m>–</span><div class="meter-track"><div class="lufs-fill" data-mf></div></div></div>
    <div class="lufs-cell"><span class="lufs-label">Short-term</span><span class="lufs-value" data-s>–</span><div class="meter-track"><div class="lufs-fill" data-sf></div></div></div>
    <div class="lufs-cell"><span class="lufs-label">Integrerat</span><span class="lufs-value lufs-integrated" data-i>–</span></div>`;
  root.append(lufsHead, lufs);
  lufsHead.querySelector("[data-lufs-reset]")!.addEventListener("click", () => engine.loudness.reset());
  const lufsEls = {
    m: lufs.querySelector<HTMLElement>("[data-m]")!,
    s: lufs.querySelector<HTMLElement>("[data-s]")!,
    i: lufs.querySelector<HTMLElement>("[data-i]")!,
    mf: lufs.querySelector<HTMLElement>("[data-mf]")!,
    sf: lufs.querySelector<HTMLElement>("[data-sf]")!,
  };
  const fmtLufs = (v: number): string => (Number.isFinite(v) && v > -70 ? v.toFixed(1) : "–");
  // Bar scale: -40 .. 0 LUFS.
  const fillWidth = (v: number): string => `${Number.isFinite(v) ? Math.max(0, Math.min(100, ((v + 40) / 40) * 100)) : 0}%`;
  let lufsFrame = 0;

  // Export.
  const exportRow = document.createElement("div");
  exportRow.className = "export-row";
  exportRow.innerHTML = `
    <button data-export class="btn btn-accent">⇩ Exportera stereo-WAV</button>
    <span data-export-status class="export-status"></span>`;
  root.append(exportRow);
  const exportBtn = exportRow.querySelector<HTMLButtonElement>("[data-export]")!;
  const exportStatus = exportRow.querySelector<HTMLElement>("[data-export-status]")!;

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
      compMeter.set(engine.compressorReduction);
      limMeter.set(engine.limiterReduction);
      if (++lufsFrame % 6 === 0) {
        const L = engine.loudness;
        lufsEls.m.textContent = fmtLufs(L.momentary);
        lufsEls.s.textContent = fmtLufs(L.shortTerm);
        lufsEls.i.textContent = fmtLufs(L.integrated);
        lufsEls.mf.style.width = fillWidth(L.momentary);
        lufsEls.sf.style.width = fillWidth(L.shortTerm);
      }
    },
  };
}

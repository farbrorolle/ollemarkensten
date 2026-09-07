import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Sidechain } from "../audio/Sidechain.ts";

function mountSidechainRow(container: HTMLElement, sidechain: Sidechain): void {
  const row = document.createElement("div");
  row.className = "sidechain-row";
  row.innerHTML = `
    <span class="sidechain-name">${sidechain.id}</span>
    <label class="field-inline"><span>Threshold</span><input data-threshold type="range" min="-48" max="0" step="1" /></label>
    <label class="field-inline"><span>Ratio</span><input data-ratio type="range" min="1" max="20" step="0.5" /></label>
    <label class="field-inline"><span>Attack</span><input data-attack type="range" min="0.001" max="0.2" step="0.001" /></label>
    <label class="field-inline"><span>Release</span><input data-release type="range" min="0.02" max="1" step="0.01" /></label>
  `;
  container.appendChild(row);

  const thresholdInput = row.querySelector<HTMLInputElement>("[data-threshold]")!;
  const ratioInput = row.querySelector<HTMLInputElement>("[data-ratio]")!;
  const attackInput = row.querySelector<HTMLInputElement>("[data-attack]")!;
  const releaseInput = row.querySelector<HTMLInputElement>("[data-release]")!;

  thresholdInput.value = String(sidechain.params.threshold);
  ratioInput.value = String(sidechain.params.ratio);
  attackInput.value = String(sidechain.params.attack);
  releaseInput.value = String(sidechain.params.release);

  thresholdInput.addEventListener("input", () => (sidechain.params.threshold = Number(thresholdInput.value)));
  ratioInput.addEventListener("input", () => (sidechain.params.ratio = Number(ratioInput.value)));
  attackInput.addEventListener("input", () => (sidechain.params.attack = Number(attackInput.value)));
  releaseInput.addEventListener("input", () => (sidechain.params.release = Number(releaseInput.value)));
}

export function mountSidechainPanel(root: HTMLElement, engine: AudioEngine): void {
  root.innerHTML = "";
  for (const sidechain of engine.sidechains.values()) mountSidechainRow(root, sidechain);
}

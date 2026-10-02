import { TAIL_DEFAULTS } from "../audio/AudioEngine.ts";
import type { AudioEngine } from "../audio/AudioEngine.ts";

const fmt = (v: number, unit: string): string =>
  unit === "Hz" ? `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} kHz` : unit === "dB" ? `${v} dB` : `${v.toFixed(2)} s`;
const slider = (attr: string, label: string, min: number, max: number, step: number, value: number, unit: string): string =>
  `<label class="tail-slider"><span>${label} <b data-out>${fmt(value, unit)}</b></span><input type="range" ${attr} data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;

const MUTE_BEFORE: [string, string][] = [
  ["4n", "1 beat"],
  ["2n", "½ bar"],
  ["1m", "1 bar"],
  ["2m", "2 bars"],
  ["4m", "4 bars"],
];

const FADE: [string, string][] = [
  ["", "No fade"],
  ["2n", "½ bar"],
  ["1m", "1 bar"],
  ["2m", "2 bars"],
];

/**
 * Creator view: how the music meets the sonic logo -- which folders ("the
 * melody") are muted and how long before the logo's first hit, an optional
 * fade of all music into the logo, and where the hit is in the logo file.
 * The customer never sees any of this.
 */
export function mountLogoPanel(root: HTMLElement, engine: AudioEngine): void {
  const logo = engine.logoSettings;
  if (!logo) {
    root.innerHTML = `<p class="hint">This project has no sonic logo.</p>`;
    return;
  }
  const folders = Array.from(engine.tracks.values()).filter((t) => !t.isLogo);
  const muted = new Set(logo.mute?.tracks ?? []);
  const ringing = new Set(logo.ringOut ?? []);
  const tailing = new Set(logo.tail ?? []);

  root.innerHTML = `
    <div class="creator-subhead">Mute melody before the logo</div>
    <div class="checkbox-row" data-folders>
      ${folders
        .map((t) => `<label><input type="checkbox" value="${t.id}"${muted.has(t.id) ? " checked" : ""} /> ${t.name}</label>`)
        .join("")}
    </div>
    <div class="creator-subhead">How each folder ends at the logo</div>
    <p class="hint logo-ending-hint">Stops at the hit: cut tight (drums, bass). Rings out: what's already sounding decays naturally, nothing new starts. Reverb tail: the dry sound stops and its last moment rings on in a reverb under the logo.</p>
    <div class="logo-endings" data-endings>
      ${folders
        .map(
          (t) => `<label class="logo-ending-row"><span>${t.name}</span><select data-ending="${t.id}">
            <option value="stop"${!ringing.has(t.id) && !tailing.has(t.id) ? " selected" : ""}>Stops at the hit</option>
            <option value="ring"${ringing.has(t.id) ? " selected" : ""}>Rings out</option>
            <option value="tail"${tailing.has(t.id) && !ringing.has(t.id) ? " selected" : ""}>Reverb tail</option>
          </select></label>`,
        )
        .join("")}
    </div>
    <details class="tail-settings">
      <summary>Reverb tail settings <span>– advanced, the defaults are a good start</span></summary>
      <div class="tail-grid">
        ${slider("data-tail-db", "Level under the logo", -30, 0, 1, logo.tailDb ?? TAIL_DEFAULTS.db, "dB")}
        ${slider("data-tail-seconds", "Length", 1, 6, 0.1, logo.tailSeconds ?? TAIL_DEFAULTS.seconds, "s")}
        ${slider("data-tail-send", "Starts before the hit", 0.05, 1, 0.05, logo.tailSendSeconds ?? TAIL_DEFAULTS.sendSeconds, "s")}
        ${slider("data-tail-dry", "Dry sound fades out over", 0.05, 1, 0.05, logo.tailDryFadeSeconds ?? TAIL_DEFAULTS.dryFadeSeconds, "s")}
        ${slider("data-tail-tone", "Brightness", 1000, 12000, 250, logo.tailToneHz ?? TAIL_DEFAULTS.toneHz, "Hz")}
      </div>
      <button type="button" class="btn btn-small" data-tail-reset>Reset to the defaults</button>
    </details>
    <div class="creator-grid" style="margin-top:12px">
      <label><span>Muted how long before the logo hit</span>
        <select data-before>${MUTE_BEFORE.map(([v, t]) => `<option value="${v}"${v === (logo.mute?.before ?? "1m") ? " selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label><span>Fade the music into the logo</span>
        <select data-fade>${FADE.map(([v, t]) => `<option value="${v}"${v === (logo.fadeMusic ?? "") ? " selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label><span>Logo hit position (s into the file)</span>
        <input data-anchor type="number" min="0" step="0.005" value="${logo.anchorSeconds}" />
      </label>
      <label><span>Hit lands on beat</span>
        <select data-beat>${[1, 2, 3, 4].map((b) => `<option value="${b}"${b === logo.anchorBeat ? " selected" : ""}>${b}</option>`).join("")}</select>
      </label>
    </div>`;

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const apply = (): void => {
    const tracks = Array.from(root.querySelectorAll<HTMLInputElement>("[data-folders] input:checked")).map((i) => i.value);
    const fade = q<HTMLSelectElement>("[data-fade]").value;
    const endings = Array.from(root.querySelectorAll<HTMLSelectElement>("[data-ending]"));
    const ringOut = endings.filter((e) => e.value === "ring").map((e) => e.dataset.ending!);
    const tail = endings.filter((e) => e.value === "tail").map((e) => e.dataset.ending!);
    engine.setLogoSettings({
      ringOut,
      tail,
      tailSeconds: Number(q<HTMLInputElement>("[data-tail-seconds]").value),
      tailDb: Number(q<HTMLInputElement>("[data-tail-db]").value),
      tailSendSeconds: Number(q<HTMLInputElement>("[data-tail-send]").value),
      tailDryFadeSeconds: Number(q<HTMLInputElement>("[data-tail-dry]").value),
      tailToneHz: Number(q<HTMLInputElement>("[data-tail-tone]").value),
      mute: tracks.length ? { tracks, before: q<HTMLSelectElement>("[data-before]").value } : null,
      fadeMusic: fade || null,
      anchorSeconds: Math.max(0, Number(q<HTMLInputElement>("[data-anchor]").value) || 0),
      anchorBeat: Number(q<HTMLSelectElement>("[data-beat]").value),
    });
  };
  root.addEventListener("change", apply);
  // Show slider values while dragging (the change itself is applied on release).
  root.querySelectorAll<HTMLInputElement>(".tail-slider input").forEach((input) => {
    input.addEventListener("input", () => {
      input.closest("label")!.querySelector("[data-out]")!.textContent = fmt(Number(input.value), input.dataset.unit ?? "");
    });
  });
  q("[data-tail-reset]").addEventListener("click", () => {
    const set = (sel: string, v: number): void => {
      const input = q<HTMLInputElement>(sel);
      input.value = String(v);
      input.dispatchEvent(new Event("input"));
    };
    set("[data-tail-db]", TAIL_DEFAULTS.db);
    set("[data-tail-seconds]", TAIL_DEFAULTS.seconds);
    set("[data-tail-send]", TAIL_DEFAULTS.sendSeconds);
    set("[data-tail-dry]", TAIL_DEFAULTS.dryFadeSeconds);
    set("[data-tail-tone]", TAIL_DEFAULTS.toneHz);
    apply();
  });
}

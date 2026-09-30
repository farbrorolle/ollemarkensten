import type { AudioEngine } from "../audio/AudioEngine.ts";

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

  root.innerHTML = `
    <div class="creator-subhead">Mute melody before the logo</div>
    <div class="checkbox-row" data-folders>
      ${folders
        .map((t) => `<label><input type="checkbox" value="${t.id}"${muted.has(t.id) ? " checked" : ""} /> ${t.name}</label>`)
        .join("")}
    </div>
    <div class="creator-subhead">Ring out under the logo <span class="hint" style="margin:0;text-transform:none;letter-spacing:0">(everything else stops at the logo hit)</span></div>
    <div class="checkbox-row" data-ring>
      ${folders
        .map((t) => `<label><input type="checkbox" value="${t.id}"${ringing.has(t.id) ? " checked" : ""} /> ${t.name}</label>`)
        .join("")}
    </div>
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
    const ringOut = Array.from(root.querySelectorAll<HTMLInputElement>("[data-ring] input:checked")).map((i) => i.value);
    engine.setLogoSettings({
      ringOut,
      mute: tracks.length ? { tracks, before: q<HTMLSelectElement>("[data-before]").value } : null,
      fadeMusic: fade || null,
      anchorSeconds: Math.max(0, Number(q<HTMLInputElement>("[data-anchor]").value) || 0),
      anchorBeat: Number(q<HTMLSelectElement>("[data-beat]").value),
    });
  };
  root.addEventListener("change", apply);
}

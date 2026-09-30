import type { AudioEngine } from "../audio/AudioEngine.ts";

const MUTE_BEFORE: [string, string][] = [
  ["4n", "1 slag"],
  ["2n", "½ takt"],
  ["1m", "1 takt"],
  ["2m", "2 takter"],
  ["4m", "4 takter"],
];

const FADE: [string, string][] = [
  ["", "Ingen fade"],
  ["2n", "½ takt"],
  ["1m", "1 takt"],
  ["2m", "2 takter"],
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
    root.innerHTML = `<p class="hint">Projektet har ingen ljudlogga.</p>`;
    return;
  }
  const folders = Array.from(engine.tracks.values()).filter((t) => !t.isLogo);
  const muted = new Set(logo.mute?.tracks ?? []);

  root.innerHTML = `
    <div class="creator-subhead">Muta melodi före loggan</div>
    <div class="checkbox-row" data-folders>
      ${folders
        .map((t) => `<label><input type="checkbox" value="${t.id}"${muted.has(t.id) ? " checked" : ""} /> ${t.name}</label>`)
        .join("")}
    </div>
    <div class="creator-grid" style="margin-top:12px">
      <label><span>Mutas hur långt före loggans plopp</span>
        <select data-before>${MUTE_BEFORE.map(([v, t]) => `<option value="${v}"${v === (logo.mute?.before ?? "1m") ? " selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label><span>Fada musiken in i loggan</span>
        <select data-fade>${FADE.map(([v, t]) => `<option value="${v}"${v === (logo.fadeMusic ?? "") ? " selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label><span>Loggans plopp ligger (s in i filen)</span>
        <input data-anchor type="number" min="0" step="0.005" value="${logo.anchorSeconds}" />
      </label>
      <label><span>Plopp landar på slag</span>
        <select data-beat>${[1, 2, 3, 4].map((b) => `<option value="${b}"${b === logo.anchorBeat ? " selected" : ""}>${b}</option>`).join("")}</select>
      </label>
    </div>`;

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const apply = (): void => {
    const tracks = Array.from(root.querySelectorAll<HTMLInputElement>("[data-folders] input:checked")).map((i) => i.value);
    const fade = q<HTMLSelectElement>("[data-fade]").value;
    engine.setLogoSettings({
      mute: tracks.length ? { tracks, before: q<HTMLSelectElement>("[data-before]").value } : null,
      fadeMusic: fade || null,
      anchorSeconds: Math.max(0, Number(q<HTMLInputElement>("[data-anchor]").value) || 0),
      anchorBeat: Number(q<HTMLSelectElement>("[data-beat]").value),
    });
  };
  root.addEventListener("change", apply);
}

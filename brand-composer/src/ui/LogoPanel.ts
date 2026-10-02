import { TAIL_DEFAULTS } from "../audio/AudioEngine.ts";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { LogoEnding } from "../project/types.ts";

const ENDINGS: [LogoEnding, string][] = [
  ["stop", "Stops at the hit"],
  ["fade", "Fades out"],
  ["ring", "Rings out"],
  ["tail", "Reverb tail"],
];

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
  // How each folder ends, and its own tracks where they differ from it ("Custom").
  const base = new Map(folders.map((t) => [t.id, engine.folderEnding(t)]));
  const overrides: Record<string, LogoEnding> = { ...(logo.partEndings ?? {}) };
  const open = new Set<string>();
  const hasParts = (t: (typeof folders)[number]): boolean => t.parts.length > 1 && !t.isSwell;
  const isCustom = (t: (typeof folders)[number]): boolean => t.parts.some((p) => (overrides[p.id] ?? base.get(t.id)) !== base.get(t.id));
  const options = (value: string, custom = false): string =>
    (custom ? `<option value="custom" selected>Custom</option>` : "") +
    ENDINGS.map(([v, label]) => `<option value="${v}"${!custom && value === v ? " selected" : ""}>${label}</option>`).join("");
  const endingRow = (t: (typeof folders)[number]): string => {
    const custom = hasParts(t) && isCustom(t);
    const expanded = open.has(t.id);
    const toggle = hasParts(t)
      ? `<button type="button" class="logo-parts-toggle${expanded ? " is-open" : ""}" data-parts-toggle="${t.id}" aria-expanded="${expanded}" title="${expanded ? "Hide" : "Show"} the folder's own tracks">${expanded ? "▾" : "▸"} ${t.parts.length} tracks</button>`
      : "";
    const parts = expanded
      ? `<div class="logo-parts">${t.parts
          .map(
            (p) => `<label class="logo-part-row"><span></span><select data-part-ending="${p.id}" data-folder="${t.id}">${options(overrides[p.id] ?? base.get(t.id)!)}</select></label>`,
          )
          .join("")}</div>`
      : "";
    return `<div class="logo-ending-cell${custom ? " is-custom" : ""}">
      <div class="logo-ending-row"><span class="logo-ending-name"><span></span>${toggle}</span><select data-ending="${t.id}">${options(base.get(t.id)!, custom)}</select></div>
      ${parts}
    </div>`;
  };
  const renderEndings = (): void => {
    const box = root.querySelector<HTMLElement>("[data-endings]")!;
    box.innerHTML = folders.map(endingRow).join("");
    // Names as text (never markup).
    box.querySelectorAll<HTMLElement>(".logo-ending-cell").forEach((cell, i) => {
      const t = folders[i]!;
      cell.querySelector(".logo-ending-name > span")!.textContent = t.name;
      cell.querySelectorAll<HTMLElement>(".logo-part-row > span").forEach((el, j) => (el.textContent = t.parts[j]!.name));
    });
  };

  root.innerHTML = `
    <div class="creator-subhead">Mute melody before the logo</div>
    <div class="checkbox-row" data-folders>
      ${folders
        .map((t) => `<label><input type="checkbox" value="${t.id}"${muted.has(t.id) ? " checked" : ""} /> ${t.name}</label>`)
        .join("")}
    </div>
    <div class="creator-subhead">How each folder ends at the logo</div>
    <p class="hint logo-ending-hint">Stops at the hit: cut tight (drums, bass). Fades out: a smooth fade into the logo (length below). Rings out: what's already sounding decays naturally, nothing new starts. Reverb tail: the dry sound is cut at the hit and only a reverb of the last beat rings on under the logo. Open ▸ to set each of a folder's own tracks; when they differ the folder shows Custom.</p>
    <div class="logo-endings" data-endings></div>
    <div class="tail-fade">
      <div class="creator-subhead">Fade-out into the logo <span class="hint" style="margin:0;text-transform:none;letter-spacing:0">(the folders set to Fades out)</span></div>
      <div class="tail-grid">
        ${slider("data-fade-len", "Fade-out length", 0.05, 4, 0.05, logo.fadeOutSeconds ?? TAIL_DEFAULTS.fadeSeconds, "s")}
        ${slider("data-fade-before", "Fade starts before the hit", 0, 3, 0.05, logo.fadeOutBeforeSeconds ?? TAIL_DEFAULTS.fadeBeforeSeconds, "s")}
      </div>
    </div>
    <details class="tail-settings">
      <summary>Reverb tail settings <span>– advanced, the defaults are a good start</span></summary>
      <div class="tail-grid">
        ${slider("data-tail-db", "Level under the logo", -30, 0, 1, logo.tailDb ?? TAIL_DEFAULTS.db, "dB")}
        ${slider("data-tail-seconds", "Length", 1, 6, 0.1, logo.tailSeconds ?? TAIL_DEFAULTS.seconds, "s")}
        ${slider("data-tail-send", "Fed from (before the hit)", 0.05, 1.5, 0.05, logo.tailSendSeconds ?? engine.beatSeconds, "s")}
        ${slider("data-tail-tone", "Brightness", 1000, 12000, 250, logo.tailToneHz ?? TAIL_DEFAULTS.toneHz, "Hz")}
      </div>
      <button type="button" class="btn btn-small" data-tail-reset>Reset fade + reverb to the defaults</button>
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
    const ids = (mode: LogoEnding): string[] => folders.filter((t) => base.get(t.id) === mode).map((t) => t.id);
    engine.setLogoSettings({
      ringOut: ids("ring"),
      tail: ids("tail"),
      fadeOut: ids("fade"),
      partEndings: { ...overrides },
      tailSeconds: Number(q<HTMLInputElement>("[data-tail-seconds]").value),
      tailDb: Number(q<HTMLInputElement>("[data-tail-db]").value),
      tailSendSeconds: Number(q<HTMLInputElement>("[data-tail-send]").value),
      fadeOutSeconds: Number(q<HTMLInputElement>("[data-fade-len]").value),
      fadeOutBeforeSeconds: Number(q<HTMLInputElement>("[data-fade-before]").value),
      tailToneHz: Number(q<HTMLInputElement>("[data-tail-tone]").value),
      mute: tracks.length ? { tracks, before: q<HTMLSelectElement>("[data-before]").value } : null,
      fadeMusic: fade || null,
      anchorSeconds: Math.max(0, Number(q<HTMLInputElement>("[data-anchor]").value) || 0),
      anchorBeat: Number(q<HTMLSelectElement>("[data-beat]").value),
    });
  };
  for (const t of folders) if (hasParts(t) && isCustom(t)) open.add(t.id);
  renderEndings();
  root.addEventListener("change", (event) => {
    const el = event.target as HTMLElement;
    if (el instanceof HTMLSelectElement && el.dataset.ending) {
      // A folder: all its tracks follow it again.
      const t = folders.find((f) => f.id === el.dataset.ending)!;
      if (el.value === "custom") return;
      base.set(t.id, el.value as LogoEnding);
      for (const p of t.parts) delete overrides[p.id];
      renderEndings();
    } else if (el instanceof HTMLSelectElement && el.dataset.partEnding) {
      // One of a folder's own tracks: differs from the folder -> the folder shows "Custom".
      const t = folders.find((f) => f.id === el.dataset.folder)!;
      const value = el.value as LogoEnding;
      if (value === base.get(t.id)) delete overrides[el.dataset.partEnding];
      else overrides[el.dataset.partEnding] = value;
      // Every track the same again: that is simply the folder's ending.
      const all = new Set(t.parts.map((p) => overrides[p.id] ?? base.get(t.id)));
      if (all.size === 1) {
        base.set(t.id, [...all][0]!);
        for (const p of t.parts) delete overrides[p.id];
      }
      renderEndings();
    }
    apply();
  });
  root.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-parts-toggle]");
    if (!btn) return;
    const id = btn.dataset.partsToggle!;
    if (open.has(id)) open.delete(id);
    else open.add(id);
    renderEndings();
  });
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
    set("[data-tail-send]", engine.beatSeconds);
    set("[data-fade-len]", TAIL_DEFAULTS.fadeSeconds);
    set("[data-fade-before]", TAIL_DEFAULTS.fadeBeforeSeconds);
    set("[data-tail-tone]", TAIL_DEFAULTS.toneHz);
    apply();
  });
}

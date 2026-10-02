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
    <div class="creator-grid" style="margin-top:10px">
      <label><span>Reverb tail length</span>
        <select data-tail-seconds>${[1.5, 2, 3, 4, 6].map((v) => `<option value="${v}"${v === (logo.tailSeconds ?? 3) ? " selected" : ""}>${v} s</option>`).join("")}</select>
      </label>
      <label><span>Reverb tail level under the logo</span>
        <select data-tail-db>${[-12, -6, -3, 0, 3, 6, 9].map((v) => `<option value="${v}"${v === (logo.tailDb ?? 0) ? " selected" : ""}>${v > 0 ? "+" : ""}${v} dB</option>`).join("")}</select>
      </label>
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
    const endings = Array.from(root.querySelectorAll<HTMLSelectElement>("[data-ending]"));
    const ringOut = endings.filter((e) => e.value === "ring").map((e) => e.dataset.ending!);
    const tail = endings.filter((e) => e.value === "tail").map((e) => e.dataset.ending!);
    engine.setLogoSettings({
      ringOut,
      tail,
      tailSeconds: Number(q<HTMLSelectElement>("[data-tail-seconds]").value),
      tailDb: Number(q<HTMLSelectElement>("[data-tail-db]").value),
      mute: tracks.length ? { tracks, before: q<HTMLSelectElement>("[data-before]").value } : null,
      fadeMusic: fade || null,
      anchorSeconds: Math.max(0, Number(q<HTMLInputElement>("[data-anchor]").value) || 0),
      anchorBeat: Number(q<HTMLSelectElement>("[data-beat]").value),
    });
  };
  root.addEventListener("change", apply);
}

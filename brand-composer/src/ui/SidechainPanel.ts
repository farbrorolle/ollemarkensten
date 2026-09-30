import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Sidechain } from "../audio/Sidechain.ts";
import type { SidechainConfig, SidechainCurve } from "../project/types.ts";

const CURVES: Record<SidechainCurve, string> = {
  smooth: "Mjuk (analog)",
  exponential: "Pump (exponentiell)",
  linear: "Linjär",
};

let nextId = 1;

/**
 * Creator view: sidechains between folders (e.g. kick -> bass). Each has a
 * source, a target (folder or bus), how much it ducks, how sensitive it is,
 * attack/release and the shape of the curve. Changing source/target rebuilds
 * the sidechain; the other settings apply live.
 */
export interface SidechainPanelHandle {
  update(): void;
}

export function mountSidechainPanel(root: HTMLElement, engine: AudioEngine): SidechainPanelHandle {
  const sources = Array.from(engine.tracks.values()).filter((t) => !t.isLogo);
  /** Live meters/solo buttons of the rendered cards, refreshed every frame. */
  let live: { update(): void }[] = [];

  /** The tracks behind a sidechain end: the track itself, or every track on a bus. */
  const tracksFor = (id: string) => {
    const track = engine.tracks.get(id);
    if (track) return [track];
    return Array.from(engine.tracks.values()).filter((t) => t.busId === id);
  };

  function render(): void {
    root.innerHTML = "";
    live = [];
    for (const sidechain of engine.sidechains.values()) root.appendChild(card(sidechain));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn";
    add.textContent = "+ Lägg till sidechain";
    add.disabled = sources.length < 2;
    add.addEventListener("click", () => {
      const source = sources[0]!;
      const target = sources.find((t) => t.id !== source.id)!;
      engine.addSidechain({
        id: `sc-${Date.now().toString(36)}-${nextId++}`,
        source: source.id,
        target: target.id,
        threshold: -24,
        ratio: 4,
        attack: 0.005,
        release: 0.2,
        depth: 6,
        curve: "smooth",
      });
      render();
    });
    root.appendChild(add);
  }

  function options(items: { id: string; name: string }[], selected: string): string {
    return items
      .map((i) => `<option value="${i.id}"${i.id === selected ? " selected" : ""}>${i.name}</option>`)
      .join("");
  }

  function card(sidechain: Sidechain): HTMLElement {
    const p = sidechain.params;
    const el = document.createElement("div");
    el.className = "sc-card";
    el.innerHTML = `
      <div class="sc-card-head">
        <select data-source title="Källa (det som styr)">${options(sources.map((t) => ({ id: t.id, name: t.name })), sidechain.sourceId)}</select>
        <button type="button" class="btn btn-toggle sc-solo" data-solo-source title="Solo källan">S</button>
        <span class="sc-arrow"> duckar →</span>
        <select data-target title="Mål (det som sänks)">${options(engine.sidechainTargets, sidechain.targetId)}</select>
        <button type="button" class="btn btn-toggle sc-solo" data-solo-target title="Solo målet">S</button>
        <button type="button" class="btn btn-toggle sc-solo" data-solo-both title="Solo källa + mål – lyssna på duckningen">Solo båda</button>
        <button type="button" class="btn btn-step" data-remove title="Ta bort">×</button>
      </div>
      <div class="creator-grid">
        <label><span>Mängd <span class="value-tag" data-v="depth"></span></span><input data-depth type="range" min="0" max="24" step="0.5" /></label>
        <label><span>Känslighet <span class="value-tag" data-v="threshold"></span></span><input data-threshold type="range" min="-60" max="0" step="1" /></label>
        <label><span>Attack <span class="value-tag" data-v="attack"></span></span><input data-attack type="range" min="0.001" max="0.2" step="0.001" /></label>
        <label><span>Release <span class="value-tag" data-v="release"></span></span><input data-release type="range" min="0.02" max="1" step="0.01" /></label>
        <label><span>Kurva</span><select data-curve>${Object.entries(CURVES)
          .map(([v, t]) => `<option value="${v}"${v === p.curve ? " selected" : ""}>${t}</option>`)
          .join("")}</select></label>
      </div>
      <div class="sc-meter">
        <span>Målet trycks ned</span>
        <div class="meter-track"><div class="meter-fill" data-gr></div></div>
        <span class="meter-value" data-gr-value>0.0 dB</span>
      </div>`;

    const q = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
    const tag = (name: string, text: string): void => {
      q(`[data-v="${name}"]`).textContent = text;
    };
    const bind = (name: "depth" | "threshold" | "attack" | "release", fmt: (v: number) => string): void => {
      const input = q<HTMLInputElement>(`[data-${name}]`);
      input.value = String(p[name]);
      tag(name, fmt(p[name]));
      input.addEventListener("input", () => {
        p[name] = Number(input.value);
        tag(name, fmt(p[name]));
      });
    };
    bind("depth", (v) => `${v.toFixed(1)} dB`);
    bind("threshold", (v) => `${v} dB`);
    bind("attack", (v) => `${Math.round(v * 1000)} ms`);
    bind("release", (v) => `${Math.round(v * 1000)} ms`);
    q<HTMLSelectElement>("[data-curve]").addEventListener("change", (e) => {
      p.curve = (e.target as HTMLSelectElement).value as SidechainCurve;
    });

    const rebuild = (): void => {
      const config: SidechainConfig = {
        id: sidechain.id,
        source: q<HTMLSelectElement>("[data-source]").value,
        target: q<HTMLSelectElement>("[data-target]").value,
        ...p,
      };
      if (config.source === config.target) return;
      engine.addSidechain(config);
      render();
    };
    q("[data-source]").addEventListener("change", rebuild);
    q("[data-target]").addEventListener("change", rebuild);
    // Solo: source, target, or both (to hear the ducking on its own).
    const sourceTracks = tracksFor(sidechain.sourceId);
    const targetTracks = tracksFor(sidechain.targetId);
    const soloSource = q<HTMLButtonElement>("[data-solo-source]");
    const soloTarget = q<HTMLButtonElement>("[data-solo-target]");
    const soloBoth = q<HTMLButtonElement>("[data-solo-both]");
    const setSolo = (tracks: typeof sourceTracks, on: boolean): void => {
      for (const t of tracks) t.solo = on;
      engine.refreshSoloState();
    };
    const allSolo = (tracks: typeof sourceTracks): boolean => tracks.length > 0 && tracks.every((t) => t.solo);
    soloSource.addEventListener("click", () => setSolo(sourceTracks, !allSolo(sourceTracks)));
    soloTarget.addEventListener("click", () => setSolo(targetTracks, !allSolo(targetTracks)));
    soloBoth.addEventListener("click", () => {
      const on = !(allSolo(sourceTracks) && allSolo(targetTracks));
      setSolo([...sourceTracks, ...targetTracks], on);
    });

    const grFill = q("[data-gr]");
    const grValue = q("[data-gr-value]");
    live.push({
      update() {
        const db = sidechain.reductionDb;
        const magnitude = Math.min(24, Math.abs(db));
        grFill.style.width = `${(magnitude / 24) * 100}%`;
        grFill.classList.toggle("meter-fill-active", magnitude > 0.05);
        grValue.textContent = `${db.toFixed(1)} dB`;
        soloSource.classList.toggle("btn-toggle-active", allSolo(sourceTracks));
        soloTarget.classList.toggle("btn-toggle-active", allSolo(targetTracks));
        soloBoth.classList.toggle("btn-toggle-active", allSolo(sourceTracks) && allSolo(targetTracks));
      },
    });

    q("[data-remove]").addEventListener("click", () => {
      engine.removeSidechain(sidechain.id);
      render();
    });
    return el;
  }

  render();
  return {
    update() {
      for (const item of live) item.update();
    },
  };
}

import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { VideoSync } from "../video/VideoSync.ts";
import { presetsApi } from "../project/presets.ts";
import type { Preset, PresetIndex } from "../project/presets.ts";

/**
 * Composer view, "Saved settings": save every composer setting (logo rules, fit rules, music
 * master, sidechain, folder levels) as a named version on the site, load one, and pick the
 * default -- the version everyone gets when they open the app.
 */
export function mountPresetsPanel(root: HTMLElement, engine: AudioEngine, film: VideoSync, project: string, loaded: Preset | null): void {
  root.innerHTML = `
    <p class="presets-now" data-preset-now></p>
    <div class="presets-save">
      <input type="text" maxlength="80" placeholder="Name, e.g. Broadcom – softer logo" aria-label="Name of the saved version" data-preset-name />
      <label class="presets-default-check"><input type="checkbox" data-preset-make-default checked /> Make it the default</label>
      <button type="button" class="btn btn-primary btn-small" data-preset-save>Save current settings</button>
    </div>
    <p class="presets-status" data-preset-status aria-live="polite"></p>
    <ul class="presets-list" data-preset-list></ul>
    <p class="side-note">The default is what everyone gets when they open the app. Loading a version reloads the page (a loaded film has to be dropped in again).</p>
  `;
  const q = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;
  const nowEl = q<HTMLElement>("[data-preset-now]");
  const statusEl = q<HTMLElement>("[data-preset-status]");
  const listEl = q<HTMLUListElement>("[data-preset-list]");
  const nameEl = q<HTMLInputElement>("[data-preset-name]");
  let index: PresetIndex | null = null;
  let armedDelete: string | null = null;

  const status = (text: string, error = false): void => {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-error", error);
  };
  const when = (iso: string): string =>
    new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const showNow = (): void => {
    const isDefault = !!loaded && index?.defaultId === loaded.id;
    nowEl.innerHTML = loaded
      ? `Now using: <strong></strong>${isDefault ? " <span class=\"presets-badge\">default</span>" : ""}`
      : "Now using: <strong>the project file</strong> (factory settings)";
    if (loaded) nowEl.querySelector("strong")!.textContent = loaded.name;
  };

  const go = (id: string | null): void => {
    const url = new URL(location.href);
    url.searchParams.set("preset", id ?? "factory");
    location.href = url.toString();
  };

  const render = (): void => {
    showNow();
    listEl.innerHTML = "";
    if (!index) return;
    const rows: { id: string | null; name: string; savedAt?: string }[] = [
      { id: null, name: "Project file (factory settings)" },
      ...[...index.presets].reverse(),
    ];
    for (const p of rows) {
      const li = document.createElement("li");
      const isDefault = p.id === null ? !index.defaultId : index.defaultId === p.id;
      const isLoaded = p.id === null ? !loaded : loaded?.id === p.id;
      li.className = "presets-row" + (isLoaded ? " is-loaded" : "");
      li.innerHTML = `
        <span class="presets-name"></span>
        <span class="presets-date">${p.savedAt ? when(p.savedAt) : ""}</span>
        ${isDefault ? `<span class="presets-badge">default</span>` : `<button type="button" class="btn btn-small" data-preset-default>Make default</button>`}
        <button type="button" class="btn btn-small" data-preset-load ${isLoaded ? "disabled" : ""}>${isLoaded ? "Loaded" : "Load"}</button>
        ${p.id ? `<button type="button" class="btn btn-small presets-delete" data-preset-delete>${armedDelete === p.id ? "Click again to delete" : "Delete"}</button>` : ""}
      `;
      li.querySelector(".presets-name")!.textContent = p.name;
      li.querySelector("[data-preset-default]")?.addEventListener("click", () => void run(async () => {
        index = await presetsApi.setDefault(project, p.id);
        status(`“${p.name}” is now the default.`);
      }));
      li.querySelector("[data-preset-load]")?.addEventListener("click", () => {
        if (film.info && !loadArmed) {
          loadArmed = true;
          status("Your film will be removed when the page reloads – click Load again to go ahead.");
          return;
        }
        go(p.id);
      });
      li.querySelector("[data-preset-delete]")?.addEventListener("click", () => {
        if (armedDelete !== p.id) {
          armedDelete = p.id;
          render();
          return;
        }
        armedDelete = null;
        void run(async () => {
          index = await presetsApi.remove(project, p.id!);
          status(`Deleted “${p.name}”.`);
        });
      });
      listEl.appendChild(li);
    }
  };
  let loadArmed = false;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    root.classList.add("is-busy");
    try {
      await fn();
    } catch (error) {
      status(error instanceof Error ? error.message : String(error), true);
    } finally {
      root.classList.remove("is-busy");
      render();
    }
  };

  q<HTMLButtonElement>("[data-preset-save]").addEventListener("click", () => {
    const name = nameEl.value.trim();
    if (!name) {
      status("Give it a name first.", true);
      nameEl.focus();
      return;
    }
    const makeDefault = q<HTMLInputElement>("[data-preset-make-default]").checked;
    void run(async () => {
      const meta = await presetsApi.save(project, name, engine.settingsSnapshot(), makeDefault);
      loaded = { ...meta, settings: engine.settingsSnapshot() };
      index = await presetsApi.list(project);
      nameEl.value = "";
      status(makeDefault ? `Saved “${name}” – it's now the default for everyone.` : `Saved “${name}”.`);
    });
  });

  void run(async () => {
    index = await presetsApi.list(project);
  });
}

import type { ComposerSettings, ProjectConfig } from "./types.ts";

/**
 * "Saved settings" (composer view): named versions of the composer's settings, kept on the site
 * by the Netlify function netlify/functions/presets.mts (Netlify Blobs), so they're the same in
 * every browser. One of them can be the default: loaded for everyone who opens the app.
 */
export interface PresetMeta {
  id: string;
  name: string;
  savedAt: string;
}
export interface PresetIndex {
  defaultId: string | null;
  presets: PresetMeta[];
}
export interface Preset extends PresetMeta {
  settings: ComposerSettings;
}

const API = "/api/presets";

async function call<T>(project: string, init: RequestInit = {}, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ project, ...params });
  const res = await fetch(`${API}?${qs}`, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000) });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error("Saving isn't available here (needs the Netlify site).");
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
  return body;
}

export const presetsApi = {
  list: (project: string) => call<PresetIndex>(project),
  get: (project: string, id: string) => call<Preset>(project, {}, { id }),
  save: (project: string, name: string, settings: ComposerSettings, makeDefault: boolean) =>
    call<PresetMeta & { isDefault: boolean }>(project, { method: "POST", body: JSON.stringify({ name, settings, makeDefault }) }),
  setDefault: (project: string, id: string | null) => call<PresetIndex>(project, { method: "PUT" }, { default: id ?? "none" }),
  remove: (project: string, id: string) => call<PresetIndex>(project, { method: "DELETE" }, { id }),
};

/**
 * The saved version to start from: ?preset=<id> in the address, else the default one.
 * ?preset=factory = the project file as it is. Never throws (no saved settings = the project file).
 */
export async function startupPreset(project: string): Promise<Preset | null> {
  const wanted = new URLSearchParams(location.search).get("preset");
  if (wanted === "factory") return null;
  try {
    return await presetsApi.get(project, wanted ?? "default");
  } catch {
    return null;
  }
}

/** Lays saved settings over the project file (by id, so a changed project file still loads). */
export function applyComposerSettings(config: ProjectConfig, s: ComposerSettings): void {
  if (s.logo && config.logo) config.logo = { ...config.logo, ...s.logo, track: config.logo.track };
  if (s.fit && config.fit) {
    for (const block of config.fit.template) {
      const saved = s.fit.template.find((b) => b.section === block.section);
      if (saved) Object.assign(block, { ...saved, section: block.section, bars: block.bars });
    }
    if (s.fit.loopFrom !== undefined) config.fit.loopFrom = s.fit.loopFrom;
  }
  if (s.master) config.master = { ...config.master, ...s.master, compressor: { ...config.master?.compressor, ...s.master.compressor } };
  const trackIds = new Set(config.tracks.map((t) => t.id));
  const busIds = new Set((config.buses ?? []).map((b) => b.id));
  if (s.sidechains) config.sidechains = s.sidechains.filter((sc) => trackIds.has(sc.source) && (trackIds.has(sc.target) || busIds.has(sc.target)));
  for (const saved of s.tracks ?? []) {
    const track = config.tracks.find((t) => t.id === saved.id);
    if (track) Object.assign(track, { volume: saved.volume, pan: saved.pan, mute: saved.mute });
  }
  for (const saved of s.buses ?? []) {
    const bus = config.buses?.find((b) => b.id === saved.id);
    if (bus) Object.assign(bus, { volume: saved.volume, pan: saved.pan });
  }
}

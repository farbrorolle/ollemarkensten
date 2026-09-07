import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { ProjectConfig } from "./types.ts";

/**
 * Loads a song's metadata (BPM, title, stem paths, bus routing) into an
 * AudioEngine. Sets Tone.Transport.bpm from the config so imported WAV stems
 * exported from Logic Pro line up without any time-stretching.
 */
export async function loadProjectFromConfig(engine: AudioEngine, config: ProjectConfig): Promise<void> {
  await engine.loadProjectFromConfig(config);
}

/** Convenience helper: fetches a project config JSON file and loads it. */
export async function loadProjectFromUrl(engine: AudioEngine, url: string): Promise<ProjectConfig> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch project config: ${url} (${response.status})`);
  const config = (await response.json()) as ProjectConfig;
  await loadProjectFromConfig(engine, config);
  return config;
}

import "./style.css";
import * as Tone from "tone";
import { AudioEngine } from "./audio/AudioEngine.ts";
import { loadProjectFromUrl } from "./project/loadProjectFromConfig.ts";
import { mountTransportPanel } from "./ui/TransportPanel.ts";
import { mountMasterPanel } from "./ui/MasterPanel.ts";
import { mountTrackList } from "./ui/TrackListView.ts";
import { mountSidechainPanel } from "./ui/SidechainPanel.ts";
import { mountTimeline } from "./ui/TimelineView.ts";
import { mountVideoPanel } from "./ui/VideoPanel.ts";
import { VideoSync } from "./video/VideoSync.ts";

const engine = new AudioEngine();
const film = new VideoSync(engine);

// Dev-server only: expose internals for debugging in the console and for scripts/test-video-sync.mjs.
if (import.meta.env.DEV) Object.assign(window, { __brandComposer: { engine, film } });

const titleEl = document.querySelector<HTMLElement>("[data-title]")!;
const videoRoot = document.querySelector<HTMLElement>("#video-panel")!;
const transportRoot = document.querySelector<HTMLElement>("#transport-panel")!;
const timelineRoot = document.querySelector<HTMLElement>("#timeline-view")!;
const masterRoot = document.querySelector<HTMLElement>("#master-panel")!;
const trackListRoot = document.querySelector<HTMLElement>("#track-list")!;
const sidechainRoot = document.querySelector<HTMLElement>("#sidechain-panel")!;

/** Play/pause from a click or key press. Primes the film synchronously (user-gesture rule) before starting audio. */
async function togglePlay(): Promise<void> {
  if (Tone.getTransport().state === "started") {
    engine.pause();
    return;
  }
  film.primeFromGesture();
  await engine.unlockAudio();
  engine.play();
}

async function bootstrap(): Promise<void> {
  // ?config=supabase loads the same demo project with stems served from Supabase
  // Storage instead of the bundled local WAV files -- see public/config/demo-project.supabase.json.
  const useSupabase = new URLSearchParams(location.search).get("config") === "supabase";
  const configUrl = useSupabase ? "/config/demo-project.supabase.json" : "/config/demo-project.json";
  const config = await loadProjectFromUrl(engine, configUrl);
  titleEl.textContent = config.title;

  const videoPanel = mountVideoPanel(videoRoot, engine, film, config.sections ?? [], () => void togglePlay());
  const transportPanel = mountTransportPanel(transportRoot, engine, () => film.primeFromGesture());
  const masterPanel = mountMasterPanel(masterRoot, engine);
  const timeline = mountTimeline(timelineRoot, engine, config.sections ?? [], film);
  mountTrackList(trackListRoot, engine, (trackId) => timeline.redrawTrack(trackId));
  mountSidechainPanel(sidechainRoot, engine);

  // Space = play/pause, like any DAW or video player (ignored while typing in a field).
  // Also swallows Space on a focused button, so it doesn't "click" e.g. Play a second time.
  const isTyping = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    !!target.closest('input:not([type="range"]):not([type="checkbox"]), select, textarea, [contenteditable]');
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || isTyping(event.target)) return;
    event.preventDefault();
    if (!event.repeat) void togglePlay();
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space" && !isTyping(event.target)) event.preventDefault();
  });

  const tick = (): void => {
    film.tick();
    videoPanel.update();
    transportPanel.update();
    masterPanel.update();
    timeline.update();
    requestAnimationFrame(tick);
  };
  tick();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  titleEl.textContent = "Kunde inte ladda projektet – se konsolen.";
});

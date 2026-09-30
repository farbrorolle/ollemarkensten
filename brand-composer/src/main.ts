import "./style.css";
import * as Tone from "tone";
import { AudioEngine } from "./audio/AudioEngine.ts";
import { loadProjectFromUrl } from "./project/loadProjectFromConfig.ts";
import { mountTransportPanel } from "./ui/TransportPanel.ts";
import { mountMasterPanel } from "./ui/MasterPanel.ts";
import { mountTrackList } from "./ui/TrackListView.ts";
import { mountSidechainPanel } from "./ui/SidechainPanel.ts";
import { mountTimeline } from "./ui/TimelineView.ts";
import { mountLogoPanel } from "./ui/LogoPanel.ts";
import { mountVideoPanel } from "./ui/VideoPanel.ts";
import { VideoSync } from "./video/VideoSync.ts";

const engine = new AudioEngine();
const film = new VideoSync(engine);

// Dev-server only: expose internals for debugging in the console and for scripts/test-video-sync.mjs.
if (import.meta.env.DEV) Object.assign(window, { __brandComposer: { engine, film, Tone } });

const titleEl = document.querySelector<HTMLElement>("[data-title]")!;
const videoRoot = document.querySelector<HTMLElement>("#video-panel")!;
const transportRoot = document.querySelector<HTMLElement>("#transport-panel")!;
const timelineRoot = document.querySelector<HTMLElement>("#timeline-view")!;
const masterRoot = document.querySelector<HTMLElement>("#master-panel")!;
const trackListRoot = document.querySelector<HTMLElement>("#track-list")!;
const sidechainRoot = document.querySelector<HTMLElement>("#sidechain-panel")!;
const logoRoot = document.querySelector<HTMLElement>("#logo-panel")!;

/**
 * Customer view (default): film, the music as one block, one fader per folder.
 * Creator view (?view=creator or the switch): also sections, master, sidechain, logo settings.
 */
function setView(view: "customer" | "creator"): void {
  document.body.classList.toggle("view-customer", view === "customer");
  document.body.classList.toggle("view-creator", view === "creator");
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    btn.classList.toggle("is-active", btn.dataset.view === view);
  }
  const url = new URL(location.href);
  if (view === "creator") url.searchParams.set("view", "creator");
  else url.searchParams.delete("view");
  history.replaceState(null, "", url);
}
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  btn.addEventListener("click", () => setView(btn.dataset.view === "creator" ? "creator" : "customer"));
}
setView(new URLSearchParams(location.search).get("view") === "creator" ? "creator" : "customer");

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
  // Default: the Broadcom DNA track (long bounces + sonic logo + fit-to-length rules).
  // ?config=demo loads the old synthetic demo; ?config=supabase the same demo with stems from
  // Supabase Storage (see public/config/demo-project.supabase.json).
  const configName = new URLSearchParams(location.search).get("config");
  const configUrl =
    configName === "supabase"
      ? "/config/demo-project.supabase.json"
      : configName === "demo"
        ? "/config/demo-project.json"
        : "/config/broadcom.json";
  const config = await loadProjectFromUrl(engine, configUrl);
  titleEl.textContent = config.title;

  const videoPanel = mountVideoPanel(videoRoot, engine, film, config.sections ?? [], () => void togglePlay());
  const transportPanel = mountTransportPanel(transportRoot, engine, () => film.primeFromGesture());
  const masterPanel = mountMasterPanel(masterRoot, engine);
  const timeline = mountTimeline(timelineRoot, engine, config.sections ?? [], film);
  const trackList = mountTrackList(trackListRoot, engine, (trackId) => timeline.redrawTrack(trackId));
  const sidechainPanel = mountSidechainPanel(sidechainRoot, engine);
  mountLogoPanel(logoRoot, engine);

  // A new film: re-arrange the music so the logo ends exactly when the film ends.
  // (The customer can then drag the logo's start line to any sync point.)
  let fittedFilm: unknown = null;
  film.onChange(() => {
    const info = film.info;
    const key = info ? `${info.name}|${info.duration}` : null;
    if (!info || key === fittedFilm || !engine.canFit) {
      fittedFilm = key;
      return;
    }
    fittedFilm = key;
    engine.fitToAnchor(engine.defaultAnchorForFilm(info.duration)); // the timeline redraws itself
  });

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
    sidechainPanel.update();
    trackList.update();
    timeline.update();
    requestAnimationFrame(tick);
  };
  tick();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  titleEl.textContent = "Kunde inte ladda projektet – se konsolen.";
});

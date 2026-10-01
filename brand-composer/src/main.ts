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
import { findCuts } from "./video/cutDetect.ts";
import { mountExportBar } from "./ui/ExportBar.ts";
import { mountSidePanel } from "./ui/SidePanel.ts";
import { mountLevelsPanel } from "./ui/LevelsPanel.ts";
import { mountTour } from "./ui/Tour.ts";

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

/** The Export button in the top bar opens a small menu holding the export choices (and their progress). */
function mountExportMenu(): HTMLButtonElement {
  const openBtn = document.querySelector<HTMLButtonElement>("[data-export-open]")!;
  const menu = document.querySelector<HTMLElement>("[data-export-menu]")!;
  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    openBtn.setAttribute("aria-expanded", String(open));
  };
  openBtn.addEventListener("click", () => setOpen(menu.hidden === true));
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden || !(e.target instanceof Node)) return;
    if (!menu.contains(e.target) && !openBtn.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
  return openBtn;
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
  const shortTitle = config.title.replace(/\s*\(\d+\s*BPM\)\s*$/i, "");
  titleEl.textContent = shortTitle;
  document.title = `Custom DAW – ${shortTitle}`;
  const metaEl = document.querySelector<HTMLElement>("[data-meta]");
  if (metaEl) metaEl.textContent = `${config.bpm} BPM · ${(config.sections ?? []).length} parts`;

  const videoPanel = mountVideoPanel(videoRoot, engine, film, config.sections ?? [], () => void togglePlay());
  const transportPanel = mountTransportPanel(transportRoot, engine, () => film.primeFromGesture());
  const exportBar = mountExportBar(document.querySelector<HTMLElement>("#export-bar")!, engine, film);
  const exportBtn = mountExportMenu();
  const exportStatus = document.querySelector<HTMLElement>(".export-menu [data-export-status]");
  const masterPanel = mountMasterPanel(masterRoot, engine);
  const timeline = mountTimeline(timelineRoot, engine, config.sections ?? [], film);
  const trackList = mountTrackList(trackListRoot, engine, (trackId) => timeline.redrawTrack(trackId));
  const sidechainPanel = mountSidechainPanel(sidechainRoot, engine);
  mountLogoPanel(logoRoot, engine);
  const tracksPanel = document.querySelector<HTMLElement>(".panel-tracks")!;
  const tour = mountTour([
    { target: () => document.querySelector("[data-music-block]"), title: "Your film and the music", text: "The music has been re-arranged to fit your film. The top lane is the film's own sound; below it the music, coloured by part." },
    { target: () => document.querySelector(".timeline-logo-anchor:not([hidden])"), title: "This green line is your sonic logo", text: "It's placed on the film's last cut, the end card. Drag it, or use Previous / Next cut to move it." },
    { target: () => document.querySelector("[data-length-chips]"), title: "Try another length", text: "Pick a duration or drag the music's right edge. The track re-arranges itself, always in time." },
    { target: () => document.querySelector('[data-step="tune"]'), title: "Fine-tune when you like", text: "Add, replace or stretch parts, add swells and set levels. Everything stays in sync with the film." },
    { target: () => document.querySelector("[data-export-open]"), title: "Export", text: "Download the film with the new sound, or the music as a WAV." },
  ]);
  document.querySelector("[data-tour]")?.addEventListener("click", () => tour.start());
  let tourTimer = 0;
  const sidePanel = mountSidePanel(
    document.querySelector<HTMLElement>("[data-side-content]")!,
    document.querySelector<HTMLElement>("[data-stepper]")!,
    timelineRoot,
    engine,
    film,
    (seconds) => {
      Tone.getTransport().seconds = seconds;
      if (Tone.getTransport().state !== "started") void togglePlay();
    },
    () => {
      window.clearTimeout(tourTimer);
      tourTimer = window.setTimeout(() => tour.startOnce(), 2500);
    },
  );  mountLevelsPanel(
    document.querySelector<HTMLElement>('[data-tab-panel="levels"]')!,
    videoRoot,
    transportRoot,
    document.querySelector<HTMLElement>(".panel-timeline .panel-head")!,
    tracksPanel,
  );


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
    film.detectedCut = null;
    film.cuts = [];
    engine.fitToAnchor(engine.defaultAnchorForFilm(info.duration)); // the timeline redraws itself
    // Then look for the film's last hard cut (usually the end card) and put the logo's hit on it.
    const url = film.sourceUrl;
    if (!url) return;
    void findCuts(url, info.duration).then(({ cuts, best }) => {
      if (fittedFilm !== key) return; // another film was loaded meanwhile
      film.cuts = cuts.map((c) => c.time);
      if (!best) return; // no clear cut
      film.detectedCut = best.time;
      engine.fitToAnchor(best.time);
    });
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
    exportBar.update();
    // Progress stays visible on the Export button when its menu is closed.
    const pct = /(\d+)%/.exec(exportStatus?.textContent ?? "")?.[1];
    const label = pct !== undefined ? `Exporting… ${pct}%` : "Export";
    if (exportBtn.textContent !== label) exportBtn.textContent = label;
    masterPanel.update();
    sidechainPanel.update();
    trackList.update();
    timeline.update();
    sidePanel.update();
    requestAnimationFrame(tick);
  };
  tick();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  titleEl.textContent = "Couldn't load the project – see the console.";
});

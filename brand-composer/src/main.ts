import "./style.css";
import { AudioEngine } from "./audio/AudioEngine.ts";
import { loadProjectFromUrl } from "./project/loadProjectFromConfig.ts";
import { mountTransportPanel } from "./ui/TransportPanel.ts";
import { mountMasterPanel } from "./ui/MasterPanel.ts";
import { mountTrackList } from "./ui/TrackListView.ts";
import { mountSidechainPanel } from "./ui/SidechainPanel.ts";
import { mountTimeline } from "./ui/TimelineView.ts";

const engine = new AudioEngine();

const titleEl = document.querySelector<HTMLElement>("[data-title]")!;
const transportRoot = document.querySelector<HTMLElement>("#transport-panel")!;
const timelineRoot = document.querySelector<HTMLElement>("#timeline-view")!;
const masterRoot = document.querySelector<HTMLElement>("#master-panel")!;
const trackListRoot = document.querySelector<HTMLElement>("#track-list")!;
const sidechainRoot = document.querySelector<HTMLElement>("#sidechain-panel")!;

async function bootstrap(): Promise<void> {
  // ?config=supabase loads the same demo project with stems served from Supabase
  // Storage instead of the bundled local WAV files -- see public/config/demo-project.supabase.json.
  const useSupabase = new URLSearchParams(location.search).get("config") === "supabase";
  const configUrl = useSupabase ? "/config/demo-project.supabase.json" : "/config/demo-project.json";
  const config = await loadProjectFromUrl(engine, configUrl);
  titleEl.textContent = config.title;

  const transportPanel = mountTransportPanel(transportRoot, engine);
  const masterPanel = mountMasterPanel(masterRoot, engine);
  const timeline = mountTimeline(timelineRoot, engine, config.sections ?? []);
  mountTrackList(trackListRoot, engine, (trackId) => timeline.redrawTrack(trackId));
  mountSidechainPanel(sidechainRoot, engine);

  const tick = (): void => {
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

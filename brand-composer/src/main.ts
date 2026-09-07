import "./style.css";
import { AudioEngine } from "./audio/AudioEngine.ts";
import { loadProjectFromUrl } from "./project/loadProjectFromConfig.ts";
import { mountTransportPanel } from "./ui/TransportPanel.ts";
import { mountMasterPanel } from "./ui/MasterPanel.ts";
import { mountTrackList } from "./ui/TrackListView.ts";
import { mountSidechainPanel } from "./ui/SidechainPanel.ts";

const engine = new AudioEngine();

const titleEl = document.querySelector<HTMLElement>("[data-title]")!;
const transportRoot = document.querySelector<HTMLElement>("#transport-panel")!;
const masterRoot = document.querySelector<HTMLElement>("#master-panel")!;
const trackListRoot = document.querySelector<HTMLElement>("#track-list")!;
const sidechainRoot = document.querySelector<HTMLElement>("#sidechain-panel")!;
const transitionBtn = document.querySelector<HTMLButtonElement>("#transition-btn")!;

async function bootstrap(): Promise<void> {
  const config = await loadProjectFromUrl(engine, "/config/demo-project.json");
  titleEl.textContent = config.title;

  const transportPanel = mountTransportPanel(transportRoot, engine);
  const masterPanel = mountMasterPanel(masterRoot, engine);
  mountTrackList(trackListRoot, engine);
  mountSidechainPanel(sidechainRoot, engine);

  const sectionIds = (config.sections ?? []).map((section) => section.id);
  transitionBtn.addEventListener("click", () => {
    if (sectionIds.length === 0) return;
    const current = engine.transitions.activeSectionId;
    const currentIndex = current ? sectionIds.indexOf(current) : -1;
    const next = sectionIds[(currentIndex + 1) % sectionIds.length]!;
    engine.transitions.queueTransition(next, 1);
  });

  const tick = (): void => {
    transportPanel.update();
    masterPanel.update();
    requestAnimationFrame(tick);
  };
  tick();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  titleEl.textContent = "Kunde inte ladda projektet – se konsolen.";
});

import type { AudioEngine } from "../audio/AudioEngine.ts";

/**
 * The Levels tab (design 2a, Fine-tune → Levels):
 *   Groups  – one fader per mix bus (Rhythm, Bass, Music, Swells, Sonic logo).
 *   Output  – film audio, music, loudness boost (limiter gain) and the master strip; these are
 *             the film panel's own controls, moved here with their listeners.
 *   Individual tracks – the existing mixer with Levels per part, folded away in the customer view.
 *
 * Also tidies the film panel: the film's name and Replace/Remove sit on the picture, the film
 * audio on/off button joins the transport, and the fit message moves to the timeline header.
 */
export function mountLevelsPanel(
  levelsRoot: HTMLElement,
  videoRoot: HTMLElement,
  transportRoot: HTMLElement,
  timelineHead: HTMLElement,
  tracksPanel: HTMLElement,
  engine: AudioEngine,
): void {
  const section = (title: string, note?: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "levels-section";
    el.innerHTML = `<div class="side-label"></div>${note ? `<p class="side-note"></p>` : ""}`;
    el.querySelector(".side-label")!.textContent = title;
    if (note) el.querySelector(".side-note")!.textContent = note;
    levelsRoot.appendChild(el);
    return el;
  };

  // --- Groups: one fader per bus ---
  const buses = [...engine.buses.values()].filter((b) => b.id !== "master");
  if (buses.length) {
    const groups = section("Groups", "Turn a whole group of instruments up or down.");
    const memberNames = (busId: string): string =>
      [...engine.tracks.values()]
        .filter((t) => t.busId === busId)
        .map((t) => t.name.replace(/^\d+\s+/, ""))
        .join(", ");
    for (const bus of buses) {
      const row = document.createElement("label");
      row.className = "level-row";
      row.innerHTML = `<span class="level-name"><span class="level-title"></span><span class="level-sub"></span></span>
        <input type="range" min="-40" max="6" step="0.5" />
        <span class="level-value"></span>`;
      row.querySelector(".level-title")!.textContent = bus.name;
      const sub = memberNames(bus.id);
      row.querySelector(".level-sub")!.textContent = sub;
      row.title = sub ? `${bus.name}: ${sub}` : bus.name;
      const input = row.querySelector("input")!;
      const value = row.querySelector<HTMLElement>(".level-value")!;
      const show = (): void => {
        const muted = bus.mute;
        value.textContent = muted ? "muted" : `${bus.volume > 0 ? "+" : ""}${bus.volume.toFixed(1)}`;
      };
      input.value = String(bus.volume);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        // All the way down = muted.
        const mute = v <= Number(input.min);
        if (bus.mute && !mute) bus.mute = false;
        if (!mute) bus.volume = v;
        else bus.mute = true;
        show();
      });
      show();
      groups.appendChild(row);
    }
  }

  // --- Output: the film panel's level controls ---
  const output = section("Film & output");
  const volumes = Array.from(videoRoot.querySelectorAll<HTMLElement>(".video-bar-actions > .video-volume"));
  for (const v of volumes) output.appendChild(v);
  const strip = videoRoot.querySelector<HTMLElement>(".master-strip");
  if (strip) output.appendChild(strip);
  const limiterLabel = output.querySelector<HTMLElement>(".video-limiter > span:not([class])");
  if (limiterLabel && limiterLabel.textContent === "Limiter gain") limiterLabel.textContent = "Loudness boost";

  // --- Individual tracks + levels per part ---
  const details = document.createElement("details");
  details.className = "levels-tracks";
  const count = [...engine.tracks.values()].length;
  details.innerHTML = `<summary>Individual tracks (${count}) &amp; levels per part</summary>`;
  details.appendChild(tracksPanel);
  levelsRoot.appendChild(details);
  const syncOpen = (): void => {
    if (document.body.classList.contains("view-creator")) details.open = true;
  };
  syncOpen();
  new MutationObserver(syncOpen).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // --- Film panel tidy-up ---
  const stage = videoRoot.querySelector<HTMLElement>("[data-stage]");
  const fileEl = videoRoot.querySelector<HTMLElement>(".video-file");
  const replaceBtn = videoRoot.querySelector<HTMLElement>("[data-replace]");
  const removeBtn = videoRoot.querySelector<HTMLElement>("[data-remove]");
  if (stage && fileEl) {
    const chip = document.createElement("div");
    chip.className = "video-file-chip";
    chip.appendChild(fileEl);
    if (replaceBtn) chip.appendChild(replaceBtn);
    if (removeBtn) chip.appendChild(removeBtn);
    // Clicks here must not play/pause the film.
    chip.addEventListener("click", (e) => e.stopPropagation());
    stage.appendChild(chip);
  }
  const audioBtn = videoRoot.querySelector<HTMLElement>("[data-audio]");
  const loadedEl = videoRoot.querySelector<HTMLElement>("[data-loaded]");
  if (audioBtn) {
    audioBtn.classList.add("transport-film-audio");
    transportRoot.appendChild(audioBtn);
    // Only with a film loaded.
    const sync = (): void => {
      audioBtn.hidden = !!loadedEl?.hidden;
    };
    sync();
    if (loadedEl) new MutationObserver(sync).observe(loadedEl, { attributes: true, attributeFilter: ["hidden"] });
  }
  // Zoom joins the undo row, so the timeline has one row of tools.
  const timelinePanel = timelineHead.closest(".panel-timeline");
  const zoomGroup = timelinePanel?.querySelector<HTMLElement>(".zoom-group");
  const toolRow = timelinePanel?.querySelector<HTMLElement>(".timeline-toolbar-2");
  if (zoomGroup && toolRow) {
    toolRow.appendChild(zoomGroup);
    timelinePanel?.querySelector(".timeline-viewbar")?.classList.add("is-empty");
  }
  const fitEl = videoRoot.querySelector<HTMLElement>("[data-fit]");
  if (fitEl) timelineHead.appendChild(fitEl);
  // The film bar itself is empty now apart from the notice line.
  videoRoot.querySelector(".video-bar")?.classList.add("is-empty");
}

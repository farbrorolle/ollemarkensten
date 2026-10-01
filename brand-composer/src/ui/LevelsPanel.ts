/**
 * The Levels tab (design 2a, Fine-tune → Levels):
 *   Film & output – film audio, music, loudness boost (limiter gain) and the master strip; these
 *                   are the film panel's own controls, moved here with their listeners.
 *   Folders       – the existing mixer: one fader per folder of the track, with Levels per part.
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

  // --- Output: the film panel's level controls ---
  const output = section("Film & output");
  const volumes = Array.from(videoRoot.querySelectorAll<HTMLElement>(".video-bar-actions > .video-volume"));
  for (const v of volumes) output.appendChild(v);
  const strip = videoRoot.querySelector<HTMLElement>(".master-strip");
  if (strip) output.appendChild(strip);
  const limiterLabel = output.querySelector<HTMLElement>(".video-limiter > span:not([class])");
  if (limiterLabel && limiterLabel.textContent === "Limiter gain") limiterLabel.textContent = "Loudness boost";

  // --- The project's folders (one fader each, as exported from the session) + levels per part ---
  const folders = section("Folders", "One fader per folder of the track. Levels per part sets them for just one part.");
  folders.classList.add("levels-folders");
  folders.appendChild(tracksPanel);

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

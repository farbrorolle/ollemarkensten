import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { VideoSync } from "../video/VideoSync.ts";
import { formatFilmTime } from "../video/syncMath.ts";

export type Step = "fit" | "tune";

export interface SidePanelHandle {
  update(): void;
  setStep(step: Step): void;
}

/**
 * The right-hand side panel and the stepper in the top bar (design 2a):
 *   1 Fit the length – length presets, where the logo lands, how the music is arranged.
 *   2 Fine-tune      – parts and layers to drag into the timeline, and levels.
 *
 * The controls themselves are the timeline's own (moved here with their listeners), so every
 * function works exactly as before; this module only arranges, explains and adds the presets.
 */
export function mountSidePanel(
  sideRoot: HTMLElement,
  stepperRoot: HTMLElement,
  timelineRoot: HTMLElement,
  engine: AudioEngine,
  film: VideoSync,
  playFrom: (seconds: number) => void,
  onFitted?: () => void,
): SidePanelHandle {
  const loopName = engine.loopFromSectionId ? engine.sectionName(engine.loopFromSectionId) : "the start";

  // --- Stepper -------------------------------------------------------------------------------
  stepperRoot.innerHTML = `
    <nav class="stepper" aria-label="Steps">
      <button type="button" class="step" data-step="fit">
        <span class="step-num" data-step-num="fit">1</span>
        <span class="step-text"><span class="step-title">Fit the length</span><span class="step-sub">to a film or a duration</span></span>
      </button>
      <span class="step-sep" aria-hidden="true"></span>
      <button type="button" class="step" data-step="tune">
        <span class="step-num">2</span>
        <span class="step-text"><span class="step-title">Fine-tune</span><span class="step-sub">optional</span></span>
      </button>
    </nav>`;

  // --- Step 1: Fit the length ----------------------------------------------------------------
  const fit = document.createElement("section");
  fit.className = "panel side-step side-fit";
  fit.dataset.stepPanel = "fit";
  fit.innerHTML = `
    <div class="aha-card" data-aha hidden>
      <div class="aha-head"><span class="aha-dot" aria-hidden="true">✓</span><span class="aha-title" data-aha-title></span></div>
      <p class="aha-text" data-aha-text></p>
      <button type="button" class="btn btn-small aha-play" data-aha-play>▶ Hear the ending</button>
    </div>
    <h2>Fit the length</h2>
    <p class="side-sub" data-fit-sub></p>
    <div class="side-group" data-logo-group hidden>
      <div class="side-label">Logo lands on</div>
      <div class="logo-cut-row" data-logo-cut-row></div>
      <p class="side-note" data-logo-note></p>
    </div>
    <div class="length-tip" data-length-tip hidden>
      <div class="length-tip-title">Try another length</div>
      <p>Drag the music's right edge in the timeline, or choose a preset below. The track re-arranges itself, always in time – or add your film and it fits itself.</p>
    </div>
    <div class="side-group">
      <div class="side-label">Length</div>
      <div class="chip-row" data-length-chips></div>
      <form class="custom-length" data-custom hidden>
        <input type="text" inputmode="decimal" placeholder="e.g. 45 or 1:20" aria-label="Length in seconds or m:ss" data-custom-input />
        <button type="submit" class="btn btn-small btn-primary">Set</button>
      </form>
      <p class="side-note" data-length-note></p>
    </div>
    <div class="side-group" data-arrange-group>
      <div class="side-label">When the length changes</div>
      <div class="arrange-cards" data-arrange-cards></div>
    </div>
    <div class="side-group side-switches" data-switches></div>
    <div class="side-links" data-links></div>
    <button type="button" class="btn side-next" data-goto-tune>Fine-tune: parts, layers &amp; levels →</button>`;

  // --- Step 2: Fine-tune ---------------------------------------------------------------------
  const tune = document.createElement("section");
  tune.className = "panel side-step side-tune";
  tune.dataset.stepPanel = "tune";
  tune.innerHTML = `
    <div class="side-tab-panel" data-tab-panel="levels"></div>`;

  // Tabs at the top of the panel: switch between fitting the length and the levels at any time.
  const sideTabs = document.createElement("div");
  sideTabs.className = "side-tabs side-tabs-top";
  sideTabs.setAttribute("role", "tablist");
  sideTabs.innerHTML = `<button type="button" class="side-tab" data-side-tab="fit" role="tab">Fit the length</button><button type="button" class="side-tab" data-side-tab="levels" role="tab">Levels</button>`;
  sideRoot.prepend(sideTabs, fit, tune);
  type SideTab = "fit" | "levels";
  const setSideTab = (t: SideTab): void => {
    document.body.classList.toggle("side-tab-fit", t === "fit");
    document.body.classList.toggle("side-tab-levels", t === "levels");
    sideTabs.querySelectorAll<HTMLElement>("[data-side-tab]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.sideTab === t);
      b.setAttribute("aria-selected", String(b.dataset.sideTab === t));
    });
  };
  sideTabs.querySelectorAll<HTMLButtonElement>("[data-side-tab]").forEach((b) =>
    b.addEventListener("click", () => setSideTab(b.dataset.sideTab === "levels" ? "levels" : "fit")),
  );
  const q = <T extends HTMLElement>(el: HTMLElement, sel: string): T | null => el.querySelector<T>(sel);

  // Move the timeline's own controls in (they keep their listeners and state handling).
  const tq = <T extends HTMLElement>(sel: string): T | null => timelineRoot.querySelector<T>(sel);
  const arrangeSwitch = tq<HTMLElement>("[data-arrange]");
  const autoBtn = tq<HTMLButtonElement>('[data-arrange-mode="auto"]');
  const originalBtn = tq<HTMLButtonElement>('[data-arrange-mode="original"]');
  const fitAllBtn = tq<HTMLButtonElement>("[data-fit-all]");
  const lockBtn = tq<HTMLButtonElement>("[data-lock]");
  const resetGroup = tq<HTMLElement>(".reset-group");
  const cutGroup = tq<HTMLElement>("[data-cut-group]");
  const paletteRows = Array.from(timelineRoot.querySelectorAll<HTMLElement>(".timeline-palette-row"));

  const cards = q<HTMLElement>(fit, "[data-arrange-cards]")!;
  const describe = (btn: HTMLButtonElement | null, title: string, text: string): void => {
    if (!btn) return;
    btn.classList.add("arrange-card");
    btn.innerHTML = `<span class="arrange-card-title"></span><span class="arrange-card-text"></span>`;
    btn.querySelector(".arrange-card-title")!.textContent = title;
    btn.querySelector(".arrange-card-text")!.textContent = text;
  };
  describe(
    originalBtn,
    "Original form",
    `Plays the track as written, part after part, and is simply cut at the end. Longer music goes round again from ${loopName}.`,
  );
  describe(
    autoBtn,
    "Auto arrange",
    `Keeps the track's own order but ends cleanly on the logo – no cut-off parts. Longer music goes round again from ${loopName}.`,
  );
  if (originalBtn) cards.appendChild(originalBtn);
  if (autoBtn) cards.appendChild(autoBtn);
  if (fitAllBtn) {
    fitAllBtn.classList.add("switch-row");
    fitAllBtn.innerHTML = `<span class="switch-text"><span class="switch-title">Keep every part of the track</span><span class="switch-sub">All parts stay in, each shortened or stretched in proportion to the original (whole 4-bar phrases). Works with Auto arrange.</span></span><span class="switch" aria-hidden="true"></span>`;
    cards.appendChild(fitAllBtn);
  }
  arrangeSwitch?.remove();
  if (lockBtn) {
    lockBtn.classList.add("switch-row");
    q(fit, "[data-switches]")!.appendChild(lockBtn);
  }
  if (resetGroup) q(fit, "[data-links]")!.appendChild(resetGroup);
  const logoGroup = q<HTMLElement>(fit, "[data-logo-group]")!;
  const logoCutRow = q<HTMLElement>(fit, "[data-logo-cut-row]")!;
  const endCardLabel = document.createElement("span");
  endCardLabel.className = "logo-cut-current";
  if (cutGroup) {
    cutGroup.querySelector(".viewbar-label")?.remove();
    const next = cutGroup.querySelector("[data-cut-next]");
    cutGroup.insertBefore(endCardLabel, next);
    logoCutRow.appendChild(cutGroup);
  }
  const [partsRow, layersRow] = paletteRows;
  // Parts and layers: their own box above the timeline (Fine-tune only), one row each, like before.
  const partsBox = document.createElement("section");
  partsBox.className = "panel panel-parts";
  partsBox.innerHTML = `
    <div class="parts-box-head">
      <h2>Parts &amp; layers</h2>
      <p class="hint">Drag a part into the Form lane – between two parts to add it, onto a part to replace it. Layers play on top of a part. Click a part in the timeline for its options.</p>
    </div>`;
  if (partsRow) partsBox.appendChild(partsRow);
  if (layersRow) partsBox.appendChild(layersRow);
  timelineRoot.closest(".panel-timeline")?.before(partsBox);
  // The toolbar row the arrange switch lived in may now be empty.
  timelineRoot.querySelectorAll<HTMLElement>(".timeline-toolbar").forEach((bar) => {
    if (!bar.querySelector("button:not([hidden]), [data-status]")) bar.classList.add("is-empty");
  });

  // --- Length presets ------------------------------------------------------------------------
  const chipsEl = q<HTMLElement>(fit, "[data-length-chips]")!;
  const customForm = q<HTMLFormElement>(fit, "[data-custom]")!;
  const customInput = q<HTMLInputElement>(fit, "[data-custom-input]")!;
  const lengthNote = q<HTMLElement>(fit, "[data-length-note]")!;
  const fitSub = q<HTMLElement>(fit, "[data-fit-sub]")!;
  type Choice = "film" | "original" | "custom" | number;
  let chosen: { choice: Choice; seconds: number } | null = null;
  const remember = (choice: Choice): void => {
    chosen = { choice, seconds: engine.arrangementSeconds };
  };
  const fitToEnd = (seconds: number): void => {
    if (!engine.canFit) return;
    engine.fitToAnchor(engine.anchorForEnd(seconds));
  };
  const fitToFilm = (): void => {
    const info = film.info;
    if (!info || !engine.canFit) return;
    engine.fitToAnchor(film.detectedCut ?? engine.defaultAnchorForFilm(info.duration));
  };
  const parseLength = (text: string): number | null => {
    const t = text.trim().replace(",", ".");
    const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    const v = m ? Number(m[1]) * 60 + Number(m[2]) : Number(t);
    return Number.isFinite(v) && v >= 5 && v <= 600 ? v : null;
  };
  customForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = parseLength(customInput.value);
    if (v === null) {
      customInput.classList.add("is-invalid");
      return;
    }
    customInput.classList.remove("is-invalid");
    fitToEnd(v);
    remember("custom");
    customForm.hidden = true;
    renderChips();
  });

  function chipActive(choice: Choice): boolean {
    const now = engine.arrangementSeconds;
    if (typeof choice === "number") return Math.abs(now - choice) < 0.25 && !chipActive("film");
    if (choice === "film") {
      const info = film.info;
      if (!info) return false;
      const anchor = engine.logoAnchorSeconds;
      return (film.detectedCut !== null && anchor !== null && Math.abs(anchor - film.detectedCut) < 0.05) || Math.abs(now - info.duration) < 0.05;
    }
    return !!chosen && chosen.choice === choice && Math.abs(chosen.seconds - now) < 0.01;
  }

  function renderChips(): void {
    const items: { label: string; choice: Choice; title: string; run: () => void }[] = [];
    if (film.info) {
      items.push({ label: `Film · ${formatFilmTime(film.info.duration)}`, choice: "film", title: "Fit the music to the film (logo on its end card)", run: fitToFilm });
    }
    items.push({ label: "Original", choice: "original", title: "The track exactly as composed", run: () => engine.resetToOriginalForm() });
    for (const n of [60, 30, 15]) items.push({ label: `${n} s`, choice: n, title: `Make the music ${n} seconds long`, run: () => fitToEnd(n) });
    chipsEl.innerHTML = "";
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = item.label;
      b.title = item.title;
      b.classList.toggle("is-active", chipActive(item.choice));
      b.addEventListener("click", () => {
        customForm.hidden = true;
        item.run();
        remember(item.choice);
        renderChips();
      });
      chipsEl.appendChild(b);
    }
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "chip";
    custom.textContent = "Custom…";
    custom.classList.toggle("is-active", chipActive("custom") || !customForm.hidden);
    custom.addEventListener("click", () => {
      customForm.hidden = !customForm.hidden;
      if (!customForm.hidden) {
        customInput.value = engine.arrangementSeconds.toFixed(1);
        customInput.focus();
        customInput.select();
      }
      renderChips();
    });
    chipsEl.appendChild(custom);
    lengthNote.textContent = film.info
      ? "Fitted to the film. Pick another length to override, or drag the music's right edge."
      : "Or drag the music's right edge to any length. The logo always lands at the end.";
  }

  // --- Aha card ------------------------------------------------------------------------------
  const aha = q<HTMLElement>(fit, "[data-aha]")!;
  const ahaTitle = q<HTMLElement>(fit, "[data-aha-title]")!;
  const ahaText = q<HTMLElement>(fit, "[data-aha-text]")!;
  q(fit, "[data-aha-play]")!.addEventListener("click", () => {
    const anchor = engine.logoAnchorSeconds ?? engine.arrangementSeconds;
    playFrom(Math.max(0, anchor - 6));
  });

  // "Done automatically" across the bottom of the film for a few seconds after a fit (design 2c).
  const filmAha = document.createElement("div");
  filmAha.className = "video-aha";
  filmAha.innerHTML = `<div class="video-aha-kicker">Done automatically</div><div class="video-aha-title"></div><div class="video-aha-text"></div>`;
  document.querySelector("[data-stage]")?.appendChild(filmAha);
  let ahaShownFor = "";
  let ahaTimer = 0;
  const showFilmAha = (title: string, anchor: number | null, onCut: boolean): void => {
    filmAha.querySelector(".video-aha-title")!.textContent = title;
    const text = filmAha.querySelector<HTMLElement>(".video-aha-text")!;
    text.textContent = anchor === null ? "The music ends with the film." : onCut ? "The logo lands on the end card at " : "The logo hits at ";
    if (anchor !== null) {
      const b = document.createElement("b");
      b.textContent = formatFilmTime(anchor);
      text.appendChild(b);
    }
    filmAha.classList.add("is-visible");
    window.clearTimeout(ahaTimer);
    ahaTimer = window.setTimeout(() => filmAha.classList.remove("is-visible"), 7000);
  };

  // --- Steps ---------------------------------------------------------------------------------
  let step: Step = "fit";
  function setStep(next: Step): void {
    step = next;
    setSideTab(step === "fit" ? "fit" : "levels");
    document.body.classList.toggle("step-fit", step === "fit");
    document.body.classList.toggle("step-tune", step === "tune");
    stepperRoot.querySelectorAll<HTMLElement>("[data-step]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.step === step);
      b.setAttribute("aria-current", b.dataset.step === step ? "step" : "false");
    });
    // Lanes that were hidden have no width yet: let the timeline redraw.
    window.dispatchEvent(new Event("resize"));
  }
  stepperRoot.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) =>
    b.addEventListener("click", () => setStep(b.dataset.step === "tune" ? "tune" : "fit")),
  );
  q(fit, "[data-goto-tune]")!.addEventListener("click", () => setStep("tune"));
  setStep("fit");

  // --- Live state ----------------------------------------------------------------------------
  let lastKey = "";
  function update(): void {
    const info = film.info;
    const anchor = engine.logoAnchorSeconds;
    const onCut = info && film.detectedCut !== null && anchor !== null && Math.abs(anchor - film.detectedCut) < 0.05;
    const key = [info?.name, info?.duration, engine.arrangementSeconds.toFixed(2), anchor?.toFixed(2), film.detectedCut, film.cuts.length, engine.hasLogo, customForm.hidden].join("|");
    if (key === lastKey) return;
    lastKey = key;

    q<HTMLElement>(fit, "[data-length-tip]")!.hidden = !!info;
    fitSub.textContent = info
      ? "The music is fitted to your film. Change the length, move the logo to another cut, or choose how it is arranged."
      : "Start from the track as composed – or add your film and the music fits itself.";
    renderChips();

    const fitted = !!info && engine.canFit;
    aha.hidden = !fitted;
    stepperRoot.querySelector("[data-step-num=fit]")?.classList.toggle("is-done", fitted);
    if (fitted && info) {
      ahaTitle.textContent = `Music fitted to your ${formatFilmTime(info.duration)} film`;
      // Once per film, and again when the cut search has put the logo on the end card.
      const ahaKey = `${info.name}|${info.duration}|${onCut ? "cut" : "end"}`;
      if (ahaKey !== ahaShownFor) {
        ahaShownFor = ahaKey;
        showFilmAha(ahaTitle.textContent, anchor, !!onCut);
        onFitted?.();
      }
      ahaText.textContent =
        anchor === null
          ? "The music ends with the film."
          : onCut
            ? `The logo lands on the end card at ${formatFilmTime(anchor)}.`
            : `The logo hits at ${formatFilmTime(anchor)}.`;
    }
    logoGroup.hidden = !cutGroup || cutGroup.hidden;
    q<HTMLElement>(fit, "[data-logo-note]")!.textContent = film.cuts.length
      ? "Previous / Next cut moves the music so the logo hits another cut in the film. You can also drag the green line."
      : "Looking for cuts in the film (takes a few seconds)… You can also drag the green line.";
    endCardLabel.textContent = anchor === null ? "" : `${onCut ? "End card" : "Logo"} ${formatFilmTime(anchor)}`;
  }

  // Cut detection finishes a little after the film loads: keep the panel in step.
  engine.onArrangementChange(() => (lastKey = ""));
  film.onChange(() => (lastKey = ""));
  if (!film.info) remember("original"); // the track starts in its original form
  update();
  return { update, setStep };
}

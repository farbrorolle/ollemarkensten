import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { FitBlock } from "../project/types.ts";

/**
 * Composer view: the fit-to-length rules per part (how each part may be shortened or stretched
 * when the music is fitted to a film or a length). Edits re-fit the music right away; "Copy as
 * JSON" gives the rules for the project file. Only the rules in memory change.
 */
export function mountRulesPanel(root: HTMLElement, engine: AudioEngine): void {
  const template = engine.fitTemplate;
  if (!template.length) {
    root.innerHTML = `<p class="side-note">This project has no fit-to-length rules.</p>`;
    return;
  }
  const original = JSON.stringify(template.map((b) => ({ ...b })));
  const originalLoopFrom = engine.loopFromSectionId;
  root.innerHTML = `
    <p class="rules-intro">How each part may change when the music is fitted to a film or a length. A change re-fits the music straight away. <b>Lower priority</b> = changed first; <b>min 0</b> = the part may be left out; a <b>max</b> longer than the part = it repeats.</p>
    <div class="rules-table-wrap"><table class="rules-table">
      <thead><tr>
        <th>Part</th><th title="Length in the original form">Bars</th><th>Min</th><th>Max</th>
        <th title="Shorten / lengthen only in steps of this many bars">Step</th>
        <th title="Lower = shortened or lengthened first">Priority</th>
        <th title="Which end of the part survives when it is shortened">Keep when shortened</th>
        <th>Into this part</th>
      </tr></thead>
      <tbody data-rules-body></tbody>
    </table></div>
    <div class="rules-footer">
      <label class="rules-loop">Longer music goes round again from <select data-loop-from></select></label>
      <span class="rules-actions">
        <button type="button" class="btn btn-small" data-rules-reset>Reset to the project file</button>
        <button type="button" class="btn btn-small" data-rules-copy>Copy rules as JSON</button>
        <span class="rules-status" data-rules-status></span>
      </span>
    </div>`;
  const body = root.querySelector<HTMLElement>("[data-rules-body]")!;
  const loopSel = root.querySelector<HTMLSelectElement>("[data-loop-from]")!;
  const status = root.querySelector<HTMLElement>("[data-rules-status]")!;

  const num = (value: number | undefined, fallback: number, min: number, max: number, onChange: (v: number) => void): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value ?? fallback);
    input.addEventListener("change", () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v)) return;
      const clamped = Math.max(min, Math.min(max, v));
      input.value = String(clamped);
      onChange(clamped);
    });
    return input;
  };
  const select = (value: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement => {
    const sel = document.createElement("select");
    for (const [v, label] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };

  function render(): void {
    body.innerHTML = "";
    for (const block of engine.fitTemplate) {
      const set = (patch: Partial<FitBlock>): void => {
        engine.setFitRule(block.section, patch);
        status.textContent = "Re-fitted ✓";
      };
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.className = "rules-part";
      name.textContent = engine.sectionName(block.section);
      const bars = document.createElement("td");
      bars.className = "rules-bars";
      bars.textContent = String(block.bars);
      const cells: (HTMLElement | Node)[] = [
        num(block.minBars, block.bars, 0, 128, (v) => set({ minBars: v })),
        num(block.maxBars, block.bars, 1, 256, (v) => set({ maxBars: v })),
        num(block.stepBars, 1, 1, 16, (v) => set({ stepBars: v })),
        num(block.priority, 1, 1, 9, (v) => set({ priority: v })),
        select(block.keep ?? "end", [["end", "the end (lead-in to the next part)"], ["start", "the start"]], (v) => set({ keep: v === "start" ? "start" : "end" })),
        select(block.transition ?? "cut", [["crossfade", "crossfade"], ["cut", "cut"]], (v) => set({ transition: v === "cut" ? "cut" : "crossfade" })),
      ];
      tr.append(name, bars);
      for (const c of cells) {
        const td = document.createElement("td");
        td.appendChild(c);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    loopSel.innerHTML = "";
    for (const block of engine.fitTemplate) {
      const o = document.createElement("option");
      o.value = block.section;
      o.textContent = engine.sectionName(block.section);
      loopSel.appendChild(o);
    }
    loopSel.value = engine.loopFromSectionId ?? engine.fitTemplate[1]?.section ?? "";
  }
  loopSel.addEventListener("change", () => {
    engine.setLoopFrom(loopSel.value);
    status.textContent = "Re-fitted ✓";
  });
  root.querySelector("[data-rules-copy]")!.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(engine.fitRulesJson);
      status.textContent = "Copied – paste it to Claude for the project file";
    } catch {
      status.textContent = "Couldn't copy (the browser blocked the clipboard)";
    }
  });
  root.querySelector("[data-rules-reset]")!.addEventListener("click", () => {
    const blocks = JSON.parse(original) as FitBlock[];
    for (const b of blocks) {
      const { section, bars: _bars, ...rest } = b;
      const clear: Partial<FitBlock> = { minBars: undefined, maxBars: undefined, stepBars: undefined, priority: undefined, keep: undefined, transition: undefined };
      engine.setFitRule(section, { ...clear, ...rest });
    }
    if (originalLoopFrom) engine.setLoopFrom(originalLoopFrom);
    render();
    status.textContent = "Back to the project file ✓";
  });
  render();
}

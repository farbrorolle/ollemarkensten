import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { SectionConfig } from "../project/types.ts";
import type { VideoSync } from "../video/VideoSync.ts";
import { formatFilmTime, formatSeconds } from "../video/syncMath.ts";
import { faderLabel, setupFader } from "./fader.ts";

export interface VideoPanelHandle {
  update(): void;
}

/**
 * The customer-facing film view: a big drop zone until a film is loaded,
 * then the film itself with the current music section and film time on top,
 * a clear on/off switch for the film's own sound, and a plain-language line
 * saying whether the music covers the whole film.
 *
 * Clicking the picture plays/pauses (same as the transport's Play/Pause).
 */
export function mountVideoPanel(
  root: HTMLElement,
  engine: AudioEngine,
  film: VideoSync,
  sections: SectionConfig[],
  togglePlay: () => void,
): VideoPanelHandle {
  const sectionNameById = new Map(sections.map((s) => [s.id, s.name]));

  root.innerHTML = `
    <div class="video-drop" data-empty>
      <div class="video-drop-icon" aria-hidden="true">🎬</div>
      <p class="video-drop-title">Add your film</p>
      <p class="video-drop-text">Drag a video file here, or</p>
      <button type="button" class="btn btn-primary" data-pick>Choose film…</button>
      <p class="video-drop-note">
        The film is never uploaded anywhere – it only plays here, in your browser.<br />
        Best supported: <strong>MP4 (H.264 + AAC)</strong>
      </p>
    </div>
    <div class="video-loaded" data-loaded hidden>
      <div class="video-stage" data-stage title="Click to play/pause">
        <div class="video-overlay video-overlay-section" data-section></div>
        <div class="video-overlay video-overlay-time" data-time></div>
        <div class="video-overlay video-overlay-ended" data-ended hidden>Film ended · music plays out</div>
        <div class="video-play-hint" data-play-hint aria-hidden="true">▶</div>
      </div>
      <div class="video-bar">
        <span class="video-file">
          <span class="video-file-name" data-name></span>
          <span class="video-file-length" data-length></span>
        </span>
        <span class="video-fit" data-fit></span>
        <span class="video-bar-actions">
          <button type="button" class="btn video-audio-toggle" data-audio></button>
          <label class="video-volume" title="Film audio level (separate from the music)">
            <span>Film audio</span>
            <input type="range" data-film-volume />
            <span class="video-volume-value" data-film-volume-value></span>
          </label>
          <label class="video-volume" title="Music level">
            <span>Music</span>
            <input type="range" data-music-volume />
            <span class="video-volume-value" data-music-volume-value></span>
          </label>
          <span class="video-volume video-limiter" title="Master limiter on the film audio and the music together: turn up to make everything louder without clipping">
            <label class="video-limiter-toggle creator-only"><input type="checkbox" data-out-lim-on /> Final limiter on (film + music)</label>
            <span>Limiter gain</span>
            <input type="range" min="0" max="18" step="0.5" data-out-lim title="Gain into the master limiter" />
            <span class="video-volume-value" data-out-lim-value></span>
            <span class="creator-only video-limiter-ceiling">Ceiling <input type="range" min="-6" max="0" step="0.1" data-out-ceil title="Master limiter ceiling (dBFS)" /> <span class="video-volume-value" data-out-ceil-value></span></span>
          </span>
          <span class="master-strip" title="Master output: peak level (L/R, 0 dB = the limit), how much the limiter turns down (GR), and loudness (LUFS)">
            <span class="ms-scale" aria-hidden="true">
              <span data-ms-tick="0">0</span><span data-ms-tick="-6">-6</span><span data-ms-tick="-12">-12</span><span data-ms-tick="-24">-24</span><span data-ms-tick="-48">-48</span>
            </span>
            <span class="ms-meter" data-ms-ch="0"><span class="ms-fill"></span><span class="ms-hold"></span><span class="ms-zero"></span><span class="ms-label">L</span></span>
            <span class="ms-meter" data-ms-ch="1"><span class="ms-fill"></span><span class="ms-hold"></span><span class="ms-zero"></span><span class="ms-label">R</span></span>
            <span class="ms-meter ms-gr" title="Gain reduction: how much the limiter is turning the sound down"><span class="ms-fill" data-ms-gr></span><span class="ms-label">GR</span></span>
            <span class="ms-readout">
              <span class="ms-row"><span>Peak</span><b data-ms-peak>–</b></span>
              <span class="ms-row"><span>GR</span><b data-ms-grv>0.0</b></span>
              <span class="ms-row"><span>LUFS M</span><b data-ms-m>–</b></span>
              <span class="ms-row"><span>LUFS S</span><b data-ms-s>–</b></span>
              <span class="ms-row"><span>LUFS I</span><b data-ms-i>–</b></span>
            </span>
          </span>
          <button type="button" class="btn" data-replace>Replace film</button>
          <button type="button" class="btn" data-remove>Remove</button>
        </span>
      </div>
      <p class="video-notice" data-notice hidden></p>
    </div>
    <p class="video-error" data-error hidden></p>
    <input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" hidden data-input />
  `;

  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const emptyEl = q("[data-empty]");
  const loadedEl = q("[data-loaded]");
  const stage = q("[data-stage]");
  const sectionEl = q("[data-section]");
  const timeEl = q("[data-time]");
  const endedEl = q("[data-ended]");
  const playHint = q("[data-play-hint]");
  const nameEl = q("[data-name]");
  const lengthEl = q("[data-length]");
  const fitEl = q("[data-fit]");
  const audioBtn = q<HTMLButtonElement>("[data-audio]");
  const noticeEl = q("[data-notice]");
  const errorEl = q("[data-error]");
  const input = q<HTMLInputElement>("[data-input]");

  stage.prepend(film.video);

  const showError = (message: string | null): void => {
    errorEl.hidden = !message;
    errorEl.textContent = message ?? "";
  };

  const loadFile = async (file: File): Promise<void> => {
    showError(null);
    if (file.type && !file.type.startsWith("video/")) {
      showError(`"${file.name}" is not a video file.`);
      return;
    }
    root.classList.add("video-loading");
    try {
      await film.load(file);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      root.classList.remove("video-loading");
    }
  };

  q("[data-pick]").addEventListener("click", () => input.click());
  q("[data-replace]").addEventListener("click", () => input.click());
  q("[data-remove]").addEventListener("click", () => {
    showError(null);
    film.clear();
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void loadFile(file);
    input.value = "";
  });

  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    root.classList.add("video-drag-over");
  });
  root.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
    root.classList.remove("video-drag-over");
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    root.classList.remove("video-drag-over");
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });

  stage.addEventListener("click", () => togglePlay());
  audioBtn.addEventListener("click", () => film.setAudioOn(!film.audioOn));
  const volumeInput = q<HTMLInputElement>("[data-film-volume]");
  const volumeValue = q("[data-film-volume-value]");
  // Console-style faders (Logic-like taper); all the way down = muted, double-click = 0 dB.
  const dbLabel = faderLabel;
  setupFader(volumeInput, film.volumeDb, (db) => {
    // The fader is the only control now: moving it also turns the film's sound back on.
    if (!film.audioOn && db !== -Infinity) film.setAudioOn(true);
    film.setVolumeDb(db);
  });

  // Music level + the output limiter over film audio and music together.
  const signed = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  const musicInput = q<HTMLInputElement>("[data-music-volume]");
  const musicValue = q("[data-music-volume-value]");
  musicValue.textContent = dbLabel(engine.masterGain);
  setupFader(musicInput, engine.masterGain, (db) => {
    engine.setMasterGain(db);
    musicValue.textContent = dbLabel(db);
  });
  const limOn = q<HTMLInputElement>("[data-out-lim-on]");
  const limInput = q<HTMLInputElement>("[data-out-lim]");
  const limValue = q("[data-out-lim-value]");
  limOn.checked = engine.isOutputLimiterOn;
  limOn.addEventListener("change", () => engine.setOutputLimiterOn(limOn.checked));
  limInput.value = String(engine.outputDriveDb);
  limValue.textContent = signed(engine.outputDriveDb);
  limInput.addEventListener("input", () => {
    engine.setOutputDrive(Number(limInput.value));
    limValue.textContent = signed(Number(limInput.value));
  });
  const ceilInput = q<HTMLInputElement>("[data-out-ceil]");
  const ceilValue = q("[data-out-ceil-value]");
  ceilInput.value = String(engine.outputCeilingDb);
  ceilValue.textContent = `${engine.outputCeilingDb.toFixed(1)} dB`;
  ceilInput.addEventListener("input", () => {
    engine.setOutputCeiling(Number(ceilInput.value));
    ceilValue.textContent = `${Number(ceilInput.value).toFixed(1)} dB`;
  });

  function renderFilmState(): void {
    const info = film.info;
    emptyEl.hidden = !!info;
    loadedEl.hidden = !info;
    if (!info) return;

    nameEl.textContent = info.name;
    nameEl.title = info.name;
    lengthEl.textContent = formatFilmTime(info.duration);

    volumeValue.textContent = dbLabel(film.volumeDb);
    const on = film.audioOn;
    audioBtn.textContent = on ? "🔊 Film audio: ON" : "🔇 Film audio: OFF";
    audioBtn.classList.toggle("video-audio-on", on);
    audioBtn.setAttribute("aria-pressed", String(on));
    audioBtn.title =
      info.audioState === "none"
        ? "No audio track found in the film"
        : on
          ? "Click to turn off the film's own audio (the music is not affected)"
          : "Click to hear the film's own audio together with the music";

    noticeEl.hidden = !film.autoplayBlocked;
    noticeEl.textContent = film.autoplayBlocked
      ? "The browser blocked the film audio from starting automatically. Move the Film audio fader to turn it back on."
      : "";
  }

  film.onChange(renderFilmState);
  renderFilmState();

  // Master strip: peak meters (-48..+3 dB, 0 dB marked), peak hold, GR (0..12 dB) and LUFS.
  const METER_MIN = -48;
  const METER_MAX = 3;
  // Classic meter scale: more room near the top (piecewise linear in dB).
  const SCALE: [number, number][] = [[METER_MIN, 0], [-24, 0.2], [-12, 0.45], [-6, 0.65], [0, 0.92], [METER_MAX, 1]];
  const meterPos = (db: number): number => {
    if (!(db > METER_MIN)) return 0;
    if (db >= METER_MAX) return 1;
    for (let i = 1; i < SCALE.length; i++) {
      const [d1, p1] = SCALE[i]!;
      const [d0, p0] = SCALE[i - 1]!;
      if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
    return 1;
  };
  root.querySelectorAll<HTMLElement>("[data-ms-tick]").forEach((el) => {
    el.style.bottom = `${meterPos(Number(el.dataset.msTick)) * 100}%`;
  });
  root.querySelectorAll<HTMLElement>(".ms-zero").forEach((el) => (el.style.bottom = `${meterPos(0) * 100}%`));
  const channels = [0, 1].map((ch) => {
    const el = root.querySelector<HTMLElement>(`[data-ms-ch="${ch}"]`)!;
    return { fill: el.querySelector<HTMLElement>(".ms-fill")!, hold: el.querySelector<HTMLElement>(".ms-hold")!, level: -Infinity, holdDb: -Infinity, holdAt: 0 };
  });
  const grFill = q("[data-ms-gr]");
  const strip = q(".master-strip");
  const peakEl = q("[data-ms-peak]");
  const grValEl = q("[data-ms-grv]");
  const lufsEls = [q("[data-ms-m]"), q("[data-ms-s]"), q("[data-ms-i]")];
  let maxPeak = -Infinity;
  let lastMeterTime = performance.now();
  let lastReadout = 0;
  const fmtDb = (db: number): string => (Number.isFinite(db) ? db.toFixed(1) : "–");
  function updateMeters(): void {
    const now = performance.now();
    const dt = Math.min(0.2, (now - lastMeterTime) / 1000);
    lastMeterTime = now;
    const peaks = engine.outputPeaks();
    channels.forEach((c, i) => {
      const db = peaks[i]! > 0 ? 20 * Math.log10(peaks[i]!) : -Infinity;
      // Instant attack, ~20 dB/s fall (like a classic peak meter).
      c.level = Math.max(db, (Number.isFinite(c.level) ? c.level : METER_MIN) - 20 * dt);
      if (db >= c.holdDb || now - c.holdAt > 1500) {
        c.holdDb = db;
        c.holdAt = now;
      }
      maxPeak = Math.max(maxPeak, db);
      c.fill.style.height = `${meterPos(c.level) * 100}%`;
      c.fill.classList.toggle("is-hot", c.level > -6);
      c.fill.classList.toggle("is-over", c.level > -0.1);
      c.hold.style.bottom = `${meterPos(c.holdDb) * 100}%`;
      c.hold.hidden = !Number.isFinite(c.holdDb) || c.holdDb < METER_MIN;
    });
    const gr = Math.min(12, Math.abs(engine.outputLimiterReduction));
    grFill.style.height = `${(gr / 12) * 100}%`;
    strip.style.setProperty("--gr", (gr / 12).toFixed(3));
    if (now - lastReadout > 200) {
      lastReadout = now;
      peakEl.textContent = fmtDb(maxPeak);
      peakEl.classList.toggle("is-over", maxPeak > -0.1);
      grValEl.textContent = gr > 0.05 ? `-${gr.toFixed(1)}` : "0.0";
      const l = engine.loudness;
      const vals = l.available ? [l.momentary, l.shortTerm, l.integrated] : [-Infinity, -Infinity, -Infinity];
      vals.forEach((v, i) => (lufsEls[i]!.textContent = Number.isFinite(v) && v > -70 ? v.toFixed(1) : "–"));
    }
  }
  // Click the readout to reset the peak value.
  q(".ms-readout").addEventListener("click", () => {
    maxPeak = -Infinity;
    peakEl.textContent = "–";
  });

  // Only touch the DOM when a value actually changes -- update() runs every frame.
  let lastSection = "";
  let lastTime = "";
  let lastFit = "";
  let lastFitClass = "";

  return {
    update() {
      updateMeters();
      const info = film.info;
      if (!info) return;

      const transport = Tone.getTransport();
      const running = transport.state === "started";
      const position = Math.max(0, engine.audibleSeconds);
      const filmOver = position >= info.duration;

      const sectionId = engine.sectionAtSeconds(position);
      const intoMusic = position - engine.musicStartSeconds;
      const bar = Math.floor(intoMusic / engine.barSeconds) + 1;
      const sectionText =
        sectionId && intoMusic >= 0 && bar <= engine.arrangement.totalBars
          ? document.body.classList.contains("view-creator")
            ? `${sectionNameById.get(sectionId) ?? sectionId} · bar ${bar}`
            : (sectionNameById.get(sectionId) ?? sectionId)
          : "";
      if (sectionText !== lastSection) {
        sectionEl.textContent = sectionText;
        sectionEl.hidden = !sectionText;
        lastSection = sectionText;
      }

      const timeText = `${formatFilmTime(Math.min(position, info.duration))} / ${formatFilmTime(info.duration)}`;
      if (timeText !== lastTime) {
        timeEl.textContent = timeText;
        lastTime = timeText;
      }

      playHint.hidden = running;
      endedEl.hidden = !(running && filmOver);

      let fitText: string;
      let fitClass: string;
      const logoEnd = engine.logoEndSeconds;
      if (logoEnd !== null) {
        // Logo projects: what matters is where the logo lands relative to the film.
        const diff = logoEnd - info.duration;
        const warning = engine.lastFit?.warnings[0];
        if (warning) {
          fitText = `⚠ ${warning}`;
          fitClass = "video-fit-warn";
        } else if (film.detectedCut !== null && Math.abs((engine.logoAnchorSeconds ?? -1) - film.detectedCut) < 0.05) {
          fitText = `✓ Logo hit synced to the film's last cut (${formatFilmTime(film.detectedCut)})`;
          fitClass = "video-fit-ok";
        } else if (Math.abs(diff) < 0.05) {
          fitText = "✓ The logo ends when the film ends";
          fitClass = "video-fit-ok";
        } else if (diff > 0) {
          fitText = `✓ The logo ends ${formatSeconds(diff)} s after the film`;
          fitClass = diff > 2 ? "video-fit-warn" : "video-fit-ok";
        } else {
          fitText = `✓ The logo ends ${formatSeconds(-diff)} s before the end of the film`;
          fitClass = "video-fit-ok";
        }
      } else {
        const diff = engine.arrangementSeconds - info.duration;
        if (Math.abs(diff) < 0.05) {
          fitText = "✓ Music and film are the same length";
          fitClass = "video-fit-ok";
        } else if (diff > 0) {
          fitText = `✓ The music covers the whole film (and plays ${formatSeconds(diff)} s longer)`;
          fitClass = "video-fit-ok";
        } else {
          fitText = `⚠ The music ends ${formatSeconds(-diff)} s before the film – make it longer`;
          fitClass = "video-fit-warn";
        }
      }
      if (fitText !== lastFit || fitClass !== lastFitClass) {
        fitEl.textContent = fitText;
        fitEl.className = `video-fit ${fitClass}`;
        lastFit = fitText;
        lastFitClass = fitClass;
      }
    },
  };
}

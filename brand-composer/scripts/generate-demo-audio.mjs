// Synthesizes 8 short, phase-aligned demo WAV stems (no external deps) so the
// Brand Composer test UI has something real to play. All loops share the
// same BPM/bar grid (120 BPM, 4/4, 4 bars = 8s) so they stay in sync exactly
// like WAV stems bounced together from the same Logic Pro session would.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const BAR = BEAT * 4; // 2s
const BARS = 4;
const DURATION = BAR * BARS; // 8s
const LEN = Math.round(DURATION * SR);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

function newBuffer() {
  return new Float32Array(LEN);
}

function addAt(buf, timeSeconds, value) {
  const i = Math.round(timeSeconds * SR);
  if (i >= 0 && i < buf.length) buf[i] += value;
}

/** Adds a pitch-swept kick thump starting at `time`. */
function addKick(buf, time, { peakFreq = 150, floorFreq = 48, pitchDecay = 0.045, ampDecay = 0.32, amp = 1 } = {}) {
  const dur = Math.min(0.4, DURATION - time);
  let phase = 0;
  for (let n = 0; n < dur * SR; n++) {
    const t = n / SR;
    const freq = floorFreq + (peakFreq - floorFreq) * Math.exp(-t / pitchDecay);
    phase += (2 * Math.PI * freq) / SR;
    const env = Math.exp(-t / ampDecay);
    addAt(buf, time + t, Math.sin(phase) * env * amp);
  }
}

/** Adds a noise burst (snare/hihat) with an exponential decay envelope. */
function addNoiseBurst(buf, time, { decay = 0.15, amp = 1, tone = 0, toneAmp = 0 } = {}) {
  const dur = Math.min(decay * 6, DURATION - time);
  let phase = 0;
  for (let n = 0; n < dur * SR; n++) {
    const t = n / SR;
    const env = Math.exp(-t / decay);
    phase += (2 * Math.PI * tone) / SR;
    const toneSample = tone > 0 ? Math.sin(phase) * toneAmp : 0;
    addAt(buf, time + t, ((Math.random() * 2 - 1) * amp + toneSample) * env);
  }
}

/** Adds a sustained tone (sum of a few harmonics) with an ADSR-ish envelope. */
function addTone(buf, time, duration, freq, { amp = 0.3, attack = 0.01, release = 0.08, harmonics = [1, 0.5, 0.25] } = {}) {
  const dur = Math.min(duration, DURATION - time);
  let phase = 0;
  for (let n = 0; n < dur * SR; n++) {
    const t = n / SR;
    phase += (2 * Math.PI * freq) / SR;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) sample += Math.sin(phase * (h + 1)) * harmonics[h];
    sample /= harmonics.reduce((a, b) => a + b, 0);

    let env = 1;
    if (t < attack) env = t / attack;
    else if (t > dur - release) env = Math.max(0, (dur - t) / release);
    addAt(buf, time + t, sample * amp * env);
  }
}

function toWavBytes(samples) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = SR * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

function save(name, buf) {
  writeFileSync(path.join(outDir, `${name}.wav`), toWavBytes(buf));
  console.log(`wrote ${name}.wav`);
}

// ---- Kick: four-on-the-floor, one hit per beat -----------------------------
const kick = newBuffer();
for (let bar = 0; bar < BARS; bar++) {
  for (let beat = 0; beat < 4; beat++) addKick(kick, bar * BAR + beat * BEAT);
}
save("kick", kick);

// ---- Snare: backbeat on 2 and 4 --------------------------------------------
const snare = newBuffer();
for (let bar = 0; bar < BARS; bar++) {
  addNoiseBurst(snare, bar * BAR + 1 * BEAT, { decay: 0.14, amp: 0.8, tone: 190, toneAmp: 0.3 });
  addNoiseBurst(snare, bar * BAR + 3 * BEAT, { decay: 0.14, amp: 0.8, tone: 190, toneAmp: 0.3 });
}
save("snare", snare);

// ---- Hi-hats: steady eighth notes ------------------------------------------
const hihat = newBuffer();
for (let bar = 0; bar < BARS; bar++) {
  for (let eighth = 0; eighth < 8; eighth++) {
    const openHat = eighth === 7; // slightly longer hat on the "and" of 4
    addNoiseBurst(hihat, bar * BAR + eighth * (BEAT / 2), {
      decay: openHat ? 0.09 : 0.035,
      amp: openHat ? 0.35 : 0.28,
    });
  }
}
save("hihat", hihat);

// ---- Bass: root note per bar, matching the Keys progression ---------------
const progressionRoots = [65.41, 87.31, 98.0, 65.41]; // C2 F2 G2 C2
const bass = newBuffer();
for (let bar = 0; bar < BARS; bar++) {
  addTone(bass, bar * BAR, BAR - 0.03, progressionRoots[bar], {
    amp: 0.55,
    attack: 0.015,
    release: 0.05,
    harmonics: [1, 0.4],
  });
}
save("bass", bass);

// ---- Keys: chord stab on beat 1 of every bar -------------------------------
const chords = [
  [261.63, 329.63, 392.0], // C major
  [349.23, 440.0, 523.25], // F major
  [392.0, 493.88, 587.33], // G major
  [261.63, 329.63, 392.0], // C major
];
const keys = newBuffer();
for (let bar = 0; bar < BARS; bar++) {
  for (const freq of chords[bar]) {
    addTone(keys, bar * BAR, BAR * 0.9, freq, { amp: 0.14, attack: 0.005, release: 0.5, harmonics: [1, 0.3, 0.15] });
  }
}
save("keys", keys);

// ---- Synth: eighth-note arpeggio over the same chords ----------------------
const synth = newBuffer();
for (let bar = 0; bar < BARS; bar++) {
  const chord = chords[bar].map((f) => f * 2); // an octave up
  for (let eighth = 0; eighth < 8; eighth++) {
    const freq = chord[eighth % chord.length];
    addTone(synth, bar * BAR + eighth * (BEAT / 2), BEAT / 2, freq, {
      amp: 0.16,
      attack: 0.003,
      release: 0.09,
      harmonics: [1, 0.6, 0.3, 0.15],
    });
  }
}
save("synth", synth);

// ---- Pad: soft sustained drone across the whole loop -----------------------
const pad = newBuffer();
addTone(pad, 0, DURATION, 65.41, { amp: 0.12, attack: 0.6, release: 0.6, harmonics: [1, 0.5] });
addTone(pad, 0, DURATION, 98.0, { amp: 0.08, attack: 0.8, release: 0.6, harmonics: [1, 0.5] });
save("pad", pad);

// ---- FX: a riser into bar 3, then a short impact ---------------------------
const fx = newBuffer();
{
  const riserStart = 0;
  const riserDur = BAR * 2;
  let phase = 0;
  for (let n = 0; n < riserDur * SR; n++) {
    const t = n / SR;
    const progress = t / riserDur;
    const freq = 250 + progress * 1800;
    phase += (2 * Math.PI * freq) / SR;
    const amp = 0.05 + progress * 0.25;
    addAt(fx, riserStart + t, (Math.sin(phase) * 0.6 + (Math.random() * 2 - 1) * 0.4) * amp);
  }
  addNoiseBurst(fx, BAR * 2, { decay: 0.4, amp: 0.5 });
  addKick(fx, BAR * 2, { peakFreq: 90, floorFreq: 30, ampDecay: 0.5, amp: 0.6 });
}
save("fx", fx);

console.log(`Done. ${DURATION}s loops @ ${SR}Hz, ${BPM} BPM, ${BARS} bars.`);

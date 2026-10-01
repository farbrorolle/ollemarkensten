import * as Tone from "tone";

/**
 * Sample-exact capture of what a node outputs, from a given context time, via an AudioWorklet
 * tap (no MediaRecorder: no lossy re-encode, no start-time guesswork -- important when the result
 * is laid under a film).
 */
export const CAPTURE_WORKLET = `
class CaptureTap extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === "stop") this.on = false; }; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const l = input[0], r = input[1] || input[0];
      this.port.postMessage({ t: currentTime, l: l.slice(0), r: r.slice(0) });
    }
    return this.on;
  }
}
registerProcessor("capture-tap", CaptureTap);
`;


export interface Captured {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

/**
 * Records `source` from context time `from` for `seconds`. Resolves when done.
 * `onProgress` gets 0..1.
 */
export async function captureOutput(
  source: Tone.ToneAudioNode,
  from: number,
  seconds: number,
  onProgress?: (fraction: number) => void,
): Promise<Captured> {
  const context = Tone.getContext();
  // (Tone.js loads one AudioWorklet module per context: the capture processor is part of the
  // loudness meter's module -- see LoudnessMeter -- so this just waits for it.)
  await context.addAudioWorkletModule("");
  const sampleRate = context.sampleRate;
  const total = Math.round(seconds * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const node = context.createAudioWorkletNode("capture-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: "explicit",
  });
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(context.rawContext.destination);
  Tone.connect(source, node);

  return new Promise<Captured>((resolve) => {
    let finished = false;
    node.port.onmessage = (event: MessageEvent<{ t: number; l: Float32Array; r: Float32Array }>) => {
      if (finished) return;
      const { t, l, r } = event.data;
      const startFrame = Math.round((t - from) * sampleRate);
      for (let i = 0; i < l.length; i++) {
        const k = startFrame + i;
        if (k < 0 || k >= total) continue;
        left[k] = l[i]!;
        right[k] = r[i]!;
      }
      onProgress?.(Math.max(0, Math.min(1, (startFrame + l.length) / total)));
      if (startFrame + l.length >= total) {
        finished = true;
        node.port.postMessage("stop");
        try {
          Tone.disconnect(source, node);
        } catch {
          /* already gone */
        }
        node.disconnect();
        sink.disconnect();
        resolve({ left, right, sampleRate });
      }
    };
  });
}

/** 24-bit stereo WAV. */
export function capturedToWav({ left, right, sampleRate }: Captured): Blob {
  const frames = left.length;
  const bytesPerSample = 3;
  const blockAlign = 2 * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  str(36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of [left, right]) {
      const v = Math.max(-1, Math.min(1, ch[i]!));
      const n = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
      view.setUint8(o, n & 0xff);
      view.setUint8(o + 1, (n >> 8) & 0xff);
      view.setUint8(o + 2, (n >> 16) & 0xff);
      o += 3;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

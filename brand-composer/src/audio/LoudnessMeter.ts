import * as Tone from "tone";

/**
 * Loudness (LUFS) per EBU R128 / ITU-R BS.1770, measured after the limiter.
 *
 * An AudioWorklet K-weights the stereo signal (exact BS.1770 pre-filter +
 * RLB high-pass for the context's sample rate) and posts the mean square of
 * every 100 ms block. From those blocks:
 * - momentary  = last 400 ms
 * - short-term = last 3 s
 * - integrated = all 400 ms windows (75 % overlap) since the last reset, gated
 *   at -70 LUFS absolute and -10 LU relative.
 */

const WORKLET = `
class LufsMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    // Stage 1: high shelf (+4 dB around 1.7 kHz). Coefficients as in libebur128.
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    this.s1 = {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
    };
    // Stage 2: RLB high-pass (~38 Hz).
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    this.s2 = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    this.state = [0, 1].map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0, u1: 0, u2: 0, z1: 0, z2: 0 }));
    this.blockSize = Math.round(fs / 10);
    this.count = 0;
    this.sums = [0, 0];
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    for (let ch = 0; ch < 2; ch++) {
      const data = input[Math.min(ch, input.length - 1)];
      const st = this.state[ch];
      const b1 = this.s1.b, a1 = this.s1.a, a2 = this.s2.a;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const x = data[i];
        const y = b1[0] * x + b1[1] * st.x1 + b1[2] * st.x2 - a1[0] * st.y1 - a1[1] * st.y2;
        st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
        const z = y - 2 * st.u1 + st.u2 - a2[0] * st.z1 - a2[1] * st.z2;
        st.u2 = st.u1; st.u1 = y; st.z2 = st.z1; st.z1 = z;
        sum += z * z;
      }
      this.sums[ch] += sum;
    }
    this.count += n;
    if (this.count >= this.blockSize) {
      this.port.postMessage((this.sums[0] + this.sums[1]) / this.count);
      this.sums = [0, 0];
      this.count = 0;
    }
    return true;
  }
}
registerProcessor("lufs-meter", LufsMeter);
`;

const toLufs = (meanSquare: number): number => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

export class LoudnessMeter {
  /** Mean square (channels summed) of each 100 ms block, newest last; only the last 30 are kept. */
  private recent: number[] = [];
  /** 400 ms window energies since the last reset (for integrated loudness). */
  private windows: number[] = [];
  private node: { connect(n: unknown): void; disconnect(): void; port: MessagePort } | null = null;
  private sink: { connect(n: unknown): void; disconnect(): void; gain: { value: number } } | null = null;
  private ready = false;

  constructor(source: Tone.ToneAudioNode) {
    void this.init(source);
  }

  private async init(source: Tone.ToneAudioNode): Promise<void> {
    // Go through Tone's context (it wraps the native one), so nodes are compatible.
    const context = Tone.getContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await context.addAudioWorkletModule(url);
    } catch {
      return; // no AudioWorklet support: no meter
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = context.createAudioWorkletNode("lufs-meter", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: "explicit",
    });
    // A silent sink keeps the node in the rendered graph.
    const sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(context.rawContext.destination);
    Tone.connect(source, node);
    this.node = node as unknown as NonNullable<LoudnessMeter["node"]>;
    this.sink = sink as unknown as NonNullable<LoudnessMeter["sink"]>;
    this.node.port.onmessage = (event: MessageEvent<number>) => this.addBlock(event.data);
    this.ready = true;
  }

  private addBlock(meanSquare: number): void {
    this.recent.push(meanSquare);
    if (this.recent.length > 30) this.recent.shift();
    if (this.recent.length >= 4) {
      const last4 = this.recent.slice(-4);
      this.windows.push(last4.reduce((a, b) => a + b, 0) / 4);
    }
  }

  get available(): boolean {
    return this.ready;
  }

  get momentary(): number {
    if (this.recent.length < 4) return -Infinity;
    return toLufs(this.recent.slice(-4).reduce((a, b) => a + b, 0) / 4);
  }

  get shortTerm(): number {
    if (this.recent.length < 30) return -Infinity;
    return toLufs(this.recent.reduce((a, b) => a + b, 0) / this.recent.length);
  }

  get integrated(): number {
    const absGated = this.windows.filter((e) => toLufs(e) > -70);
    if (!absGated.length) return -Infinity;
    const relGate = toLufs(absGated.reduce((a, b) => a + b, 0) / absGated.length) - 10;
    const gated = absGated.filter((e) => toLufs(e) > relGate);
    if (!gated.length) return -Infinity;
    return toLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  }

  reset(): void {
    this.windows = [];
    this.recent = [];
  }

  dispose(): void {
    this.node?.disconnect();
    this.sink?.disconnect();
  }
}

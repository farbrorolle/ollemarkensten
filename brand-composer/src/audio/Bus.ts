import * as Tone from "tone";

/**
 * A mix bus (e.g. DrumsBus, SynthBus, MasterBus). Groups multiple tracks so
 * they share volume/pan/mute and can act as a single sidechain-ducking target.
 *
 * Signal chain: input -> sidechainGain (ducking insert point) -> channel (volume/pan/mute) -> (parent bus or destination)
 */
export class Bus {
  readonly id: string;
  readonly name: string;

  readonly input: Tone.Gain;
  private readonly sidechainGain: Tone.Gain;
  readonly channel: Tone.Channel;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;

    this.input = new Tone.Gain(1);
    this.sidechainGain = new Tone.Gain(1);
    this.channel = new Tone.Channel({ volume: 0, pan: 0, mute: false });

    this.input.connect(this.sidechainGain);
    this.sidechainGain.connect(this.channel);
  }

  /** Node a Sidechain instance can duck to affect everything routed through this bus. */
  get duckNode(): Tone.Gain {
    return this.sidechainGain;
  }

  connect(destination: Tone.ToneAudioNode): this {
    this.channel.connect(destination);
    return this;
  }

  set volume(db: number) {
    this.channel.volume.value = db;
  }
  get volume(): number {
    return this.channel.volume.value;
  }

  set pan(value: number) {
    this.channel.pan.value = value;
  }
  get pan(): number {
    return this.channel.pan.value;
  }

  set mute(value: boolean) {
    this.channel.mute = value;
  }
  get mute(): boolean {
    return this.channel.mute;
  }

  dispose(): void {
    this.input.dispose();
    this.sidechainGain.dispose();
    this.channel.dispose();
  }
}

import * as Tone from "tone";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import { computePeaks, decideCorrection, smoothDrift, SYNC_TUNING } from "./syncMath.ts";

/** Waveform resolution of the film's audio track (min/max pairs across the whole film). */
const PEAK_BUCKETS = 4000;
/** Don't decode the film's audio for the waveform beyond this -- brand films are short; this only guards memory. */
const MAX_WAVEFORM_SECONDS = 10 * 60;
/** When stopped/paused, re-park the frame if it's further than this from the transport position. */
const PARK_TOLERANCE = 0.01;
/** Where to hold the picture once the film is over (just before the very end, which some browsers show as black). */
const END_HOLD = 0.04;
/** Film audio on by default: the customer usually wants to hear voice-over/sound design together with the music. */
const DEFAULT_FILM_AUDIO_ON = true;

export type FilmAudioState = "decoding" | "ok" | "none" | "too-long";

export interface FilmInfo {
  readonly name: string;
  readonly duration: number;
  /** Status of reading the film's own audio track for the waveform. */
  readonly audioState: FilmAudioState;
  /** Waveform peaks of the film's own audio, see computePeaks. Null until decoded / if there is none. */
  readonly peaks: Float32Array | null;
}

/**
 * A local video file ("the customer's film") locked to Tone.Transport.
 *
 * The transport is the master clock; the video is a follower. Every
 * animation frame `tick()` compares `video.currentTime` with the transport
 * position of the audio that's audible right now (AudioEngine.audibleSeconds)
 * and corrects the difference: a seek for big jumps, a slight playbackRate
 * nudge for small drift. The video's own `timeupdate` event is not used --
 * it fires only ~4 times a second and is too coarse for this.
 *
 * Like the local-audio-file feature, the file never leaves the browser:
 * it's played from a `URL.createObjectURL` object URL.
 *
 * The film plays once from bar 1. Loading one puts the engine in film mode
 * (no looping; playback stops at the end of the arrangement). If the music is
 * longer than the film, the picture holds its last frame while the music
 * finishes.
 */
export class VideoSync {
  readonly video: HTMLVideoElement;

  private film: FilmInfo | null = null;
  private objectUrl: string | null = null;
  private loadToken = 0;
  private readonly listeners = new Set<() => void>();

  /** Context time at which the transport's audio (re)starts; Infinity while stopped/paused. */
  private startAt = Infinity;
  private smoothedDrift = 0;
  private currentRate = 1;
  private lastSeekAt = -Infinity;
  private seekRequestedAt: number | null = null;
  /** How long a seek takes to land (EMA). Seeks aim this far ahead so the picture lands in sync. */
  private seekLead = 0.05;
  private playPending = false;
  /** Set when the browser refused to autoplay the film with sound, so we fell back to muted. */
  private _autoplayBlocked = false;

  private readonly engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.disablePictureInPicture = true;
    this.video.className = "video-element";

    this.video.addEventListener("seeked", () => {
      if (this.seekRequestedAt === null) return;
      const took = (performance.now() - this.seekRequestedAt) / 1000;
      this.seekRequestedAt = null;
      this.seekLead = Math.min(0.3, this.seekLead + (took - this.seekLead) * 0.5);
    });

    const transport = Tone.getTransport();
    transport.on("start", (time) => {
      this.startAt = time;
    });
    transport.on("stop", () => {
      this.startAt = Infinity;
    });
    transport.on("pause", () => {
      this.startAt = Infinity;
    });
  }

  get info(): FilmInfo | null {
    return this.film;
  }

  get audioOn(): boolean {
    return !this.video.muted;
  }

  get autoplayBlocked(): boolean {
    return this._autoplayBlocked;
  }

  /** Called whenever the film, its audio state or the mute state changes. */
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Loads a local video file (from a file picker or drag-and-drop). Rejects with a customer-readable message. */
  async load(file: File): Promise<void> {
    const token = ++this.loadToken;
    const url = URL.createObjectURL(file);
    const video = this.video;

    this.engine.stop(); // a new film always starts from the top
    video.pause();

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          video.removeEventListener("loadedmetadata", onMeta);
          video.removeEventListener("error", onError);
        };
        const onMeta = (): void => {
          cleanup();
          resolve();
        };
        const onError = (): void => {
          cleanup();
          reject(new Error("Webbläsaren kan inte spela upp den här filen. Prova MP4 (H.264 + AAC)."));
        };
        video.addEventListener("loadedmetadata", onMeta);
        video.addEventListener("error", onError);
        video.src = url;
      });
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error("Filmens längd gick inte att läsa ut. Prova att exportera den som MP4 (H.264 + AAC).");
      }
    } catch (error) {
      URL.revokeObjectURL(url);
      if (token === this.loadToken) this.restorePreviousSource();
      throw error;
    }
    if (token !== this.loadToken) {
      URL.revokeObjectURL(url); // a newer file was dropped while this one was loading
      return;
    }

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = url;
    video.currentTime = 0;
    video.playbackRate = 1;
    this.currentRate = 1;
    this.smoothedDrift = 0;
    video.muted = !DEFAULT_FILM_AUDIO_ON;
    this._autoplayBlocked = false;
    this.film = { name: file.name, duration: video.duration, audioState: "decoding", peaks: null };
    this.engine.setFilmMode(true);
    this.emit();

    void this.readFilmAudio(file, video.duration, token);
  }

  /** If loading a new file failed, put the previous film (if any) back in the video element. */
  private restorePreviousSource(): void {
    if (this.objectUrl) this.video.src = this.objectUrl;
    else this.video.removeAttribute("src");
  }

  /** Decodes the film's own audio track in the background, only to draw its waveform. */
  private async readFilmAudio(file: File, duration: number, token: number): Promise<void> {
    let audioState: FilmAudioState;
    let peaks: Float32Array | null = null;
    if (duration > MAX_WAVEFORM_SECONDS) {
      audioState = "too-long";
    } else {
      try {
        const buffer = await Tone.getContext().decodeAudioData(await file.arrayBuffer());
        if (buffer.length > 0) {
          peaks = computePeaks(buffer.getChannelData(0), PEAK_BUCKETS);
          audioState = "ok";
        } else {
          audioState = "none";
        }
      } catch {
        audioState = "none"; // no audio track (or a codec the browser can't decode separately)
      }
    }
    if (token !== this.loadToken || !this.film) return;
    this.film = { ...this.film, audioState, peaks };
    this.emit();
  }

  /** Removes the film and goes back to normal (looping) playback. */
  clear(): void {
    this.loadToken++;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.film = null;
    this._autoplayBlocked = false;
    this.engine.setFilmMode(false);
    this.emit();
  }

  /** Turns the film's own sound on/off. Call from a click handler (it doubles as the browser's required user gesture). */
  setAudioOn(on: boolean): void {
    this.video.muted = !on;
    this._autoplayBlocked = false;
    if (on) this.primeFromGesture();
    this.emit();
  }

  /**
   * Browsers only allow a video to start playing *with sound* from inside a
   * user gesture. The transport itself starts slightly later (lookahead), so
   * call this synchronously from the Play click: it starts the video right
   * away, which "unlocks" it; tick() then holds it until the music is audible.
   */
  primeFromGesture(): void {
    if (!this.film || !this.video.paused) return;
    this.video.play().catch(() => {
      /* AbortError when tick() pauses it again before it started: expected */
    });
  }

  private requestPlay(): void {
    if (this.playPending) return;
    this.playPending = true;
    this.video
      .play()
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError" && !this.video.muted) {
          // Autoplay with sound refused: keep the picture in sync muted, and tell the user.
          this.video.muted = true;
          this._autoplayBlocked = true;
          this.emit();
        }
      })
      .finally(() => {
        this.playPending = false;
      });
  }

  private setRate(rate: number): void {
    if (Math.abs(rate - this.currentRate) < 0.002) return; // don't poke the decoder every frame for nothing
    this.currentRate = rate;
    this.video.playbackRate = rate;
  }

  private seekTo(time: number, measure: boolean): void {
    this.lastSeekAt = performance.now() / 1000;
    this.seekRequestedAt = measure ? performance.now() : null;
    this.smoothedDrift = 0;
    this.video.currentTime = time;
  }

  /** Call once per animation frame. */
  tick(): void {
    const film = this.film;
    const video = this.video;
    if (!film || video.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const duration = film.duration;
    const expected = this.engine.audibleSeconds;
    const transportRunning = Tone.getTransport().state === "started";
    const audible = transportRunning && Tone.getContext().currentTime >= this.startAt;

    if (!audible || expected >= duration) {
      // Stopped, paused, not started yet, or the film is over while the music continues:
      // hold the picture on the frame that belongs to the transport position.
      if (!video.paused) video.pause();
      this.setRate(1);
      this.smoothedDrift = 0;
      if (video.seeking) return;
      if (expected >= duration) {
        if (video.currentTime < duration - 0.25) this.seekTo(Math.max(0, duration - END_HOLD), false);
      } else {
        const park = Math.max(0, expected);
        if (Math.abs(video.currentTime - park) > PARK_TOLERANCE) this.seekTo(park, false);
      }
      return;
    }

    if (video.seeking) return;

    if (video.paused || video.ended) {
      if (Math.abs(video.currentTime - expected) > SYNC_TUNING.deadband) {
        this.seekTo(Math.min(duration, expected + this.seekLead), true);
      }
      this.requestPlay();
      return;
    }

    const drift = video.currentTime - expected;
    this.smoothedDrift = smoothDrift(this.smoothedDrift, drift);
    const canSeek = performance.now() / 1000 - this.lastSeekAt >= SYNC_TUNING.minSeekIntervalSeconds;
    const correction = decideCorrection(drift, this.smoothedDrift, canSeek);
    if (correction.kind === "seek") {
      this.setRate(1);
      this.seekTo(Math.min(duration, expected + this.seekLead), true);
    } else {
      this.setRate(correction.rate);
    }
  }
}

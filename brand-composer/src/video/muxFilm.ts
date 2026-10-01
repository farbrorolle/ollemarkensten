/**
 * Puts new sound under a film, in the browser (ffmpeg.wasm, loaded only when used): the picture
 * is copied as it is (no re-encode, no quality loss), the sound is encoded to AAC (MP4/MOV) or
 * Vorbis (WebM; the wasm Opus encoder crashes).
 */
export async function muxFilmWithAudio(
  film: Blob,
  filmName: string,
  wav: Blob,
  onStatus?: (text: string) => void,
): Promise<{ blob: Blob; name: string }> {
  onStatus?.("Loading the video tools…");
  const [{ FFmpeg }, { fetchFile }, coreURL, wasmURL] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@ffmpeg/core?url").then((m) => m.default as string),
    import("@ffmpeg/core/wasm?url").then((m) => m.default as string),
  ]);
  const ffmpeg = new FFmpeg();
  const log: string[] = [];
  ffmpeg.on("log", ({ message }) => {
    log.push(message);
    if (log.length > 40) log.shift();
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (progress >= 0 && progress <= 1) onStatus?.(`Putting the sound under the film… ${Math.round(progress * 100)}%`);
  });
  await ffmpeg.load({ coreURL, wasmURL });

  const ext = (filmName.match(/\.([a-z0-9]+)$/i)?.[1] ?? "mp4").toLowerCase();
  const isWebm = ext === "webm";
  const outExt = isWebm ? "webm" : ext === "mov" ? "mov" : "mp4";
  const input = `input.${ext}`;
  const output = `output.${outExt}`;
  await ffmpeg.writeFile(input, await fetchFile(film));
  await ffmpeg.writeFile("sound.wav", await fetchFile(wav));
  onStatus?.("Putting the sound under the film…");
  const code = await ffmpeg.exec([
    "-i", input,
    "-i", "sound.wav",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    ...(isWebm ? ["-c:a", "libvorbis", "-q:a", "7"] : ["-c:a", "aac", "-b:a", "256k"]),
    ...(isWebm ? [] : ["-movflags", "+faststart"]),
    output,
  ]);
  if (code !== 0) {
    console.error(log.join("\n"));
    throw new Error(`ffmpeg failed (${code})`);
  }
  const data = await ffmpeg.readFile(output);
  ffmpeg.terminate();
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const base = filmName.replace(/\.[^.]+$/, "");
  const mime = isWebm ? "video/webm" : outExt === "mov" ? "video/quicktime" : "video/mp4";
  return { blob: new Blob([new Uint8Array(bytes)], { type: mime }), name: `${base} – with music.${outExt}` };
}

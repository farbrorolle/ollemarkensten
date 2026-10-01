import { defineConfig } from "vite";

export default defineConfig({
  // ffmpeg.wasm (film export) runs its own worker and loads its core lazily.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
});

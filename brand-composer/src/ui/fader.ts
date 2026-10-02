/**
 * Console-style fader taper (like Logic's channel faders): most of the travel is spent around
 * 0 dB, where small changes matter, and the bottom of the fader is compressed down to silence.
 * The <input type="range"> runs 0..1000 (position); these convert between position and dB.
 *
 *   +6 dB at the top, 0 dB at 80 %, -6 at 66 %, -10 at 56 %, -20 at 38 %, -30 at 24 %,
 *   -40 at 14 %, -60 at 4 %, and the very bottom = silence (-Infinity).
 */
const TAPER: [number, number][] = [
  [0.04, -60],
  [0.14, -40],
  [0.24, -30],
  [0.38, -20],
  [0.56, -10],
  [0.66, -6],
  [0.8, 0],
  [1, 6],
];
export const FADER_MAX = 1000;

export function posToDb(pos: number): number {
  const p = Math.max(0, Math.min(1, pos / FADER_MAX));
  if (p <= 0) return -Infinity;
  if (p < TAPER[0]![0]) return -90 + (p / TAPER[0]![0]) * 30; // -90 .. -60
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, d1] = TAPER[i]!;
    const [p0, d0] = TAPER[i - 1]!;
    if (p <= p1) return Math.round((d0 + ((p - p0) / (p1 - p0)) * (d1 - d0)) * 10) / 10;
  }
  return 6;
}

export function dbToPos(db: number): number {
  if (!Number.isFinite(db) || db <= -90) return 0;
  if (db < -60) return Math.round(((db + 90) / 30) * TAPER[0]![0] * FADER_MAX);
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, d1] = TAPER[i]!;
    const [p0, d0] = TAPER[i - 1]!;
    if (db <= d1) return Math.round((p0 + ((db - d0) / (d1 - d0)) * (p1 - p0)) * FADER_MAX);
  }
  return FADER_MAX;
}

export const faderLabel = (db: number): string =>
  !Number.isFinite(db) ? "muted" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;

/**
 * Turns a range input into a console fader: 0..1000 positions, tooltip with the dB value,
 * and double-click or Alt/Option-click resets to `resetDb` (0 dB), like in Logic.
 * `onDb` is called with the new dB value (-Infinity at the bottom).
 */
export function setupFader(input: HTMLInputElement, initialDb: number, onDb: (db: number) => void, resetDb = 0): void {
  input.min = "0";
  input.max = String(FADER_MAX);
  input.step = "1";
  input.value = String(dbToPos(initialDb));
  const show = (): void => {
    input.title = faderLabel(posToDb(Number(input.value))) + " – double-click or Alt-click for 0 dB";
  };
  show();
  input.addEventListener("input", () => {
    show();
    onDb(posToDb(Number(input.value)));
  });
  const reset = (): void => {
    input.value = String(dbToPos(resetDb));
    show();
    onDb(resetDb);
  };
  input.addEventListener("dblclick", reset);
  input.addEventListener("pointerdown", (e) => {
    if (e.altKey) {
      e.preventDefault();
      reset();
    }
  });
}

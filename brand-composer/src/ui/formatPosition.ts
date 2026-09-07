/** Turns Tone.Transport's "bars:beats:sixteenths" position into a human-friendly, 1-indexed "Bar:Beat". */
export function formatBarsBeats(position: string): string {
  const [bars, beats] = position.split(":");
  const bar = Number(bars) + 1;
  const beat = Number(beats) + 1;
  return `${bar}:${beat}`;
}

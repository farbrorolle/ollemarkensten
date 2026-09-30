#!/usr/bin/env python3
"""
Analyses a long-bounce project's stems and writes the results into its config:

- tails:        for every track, how many seconds it rings on after the end of each
                source bar (until its next new attack, or until it goes silent, max 4 s).
                Used for the ring-out when a section is left.
- swellEvents:  for tracks marked "role": "swell", every swell as a clip
                {start, end, anchorBar}: the source seconds it spans and the bar whose
                downbeat it leads into.

Usage: python3 scripts/analyze-stems.py public/config/broadcom.json
Needs ffmpeg and numpy. Paths in the config are relative to public/.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
FRAME = 0.01  # 10 ms analysis frames
MAX_TAIL = 4.0


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def frame_db(x: np.ndarray) -> np.ndarray:
    n = int(SR * FRAME)
    frames = len(x) // n
    rms = np.sqrt(np.mean(x[: frames * n].reshape(frames, n) ** 2, axis=1))
    return 20 * np.log10(rms + 1e-9)


def tail_after(db: np.ndarray, boundary_frame: int) -> float:
    """Seconds the sound rings on after `boundary_frame` before a new attack or silence."""
    if boundary_frame <= 5 or boundary_frame >= len(db):
        return 0.0
    before = np.median(db[max(0, boundary_frame - 10) : boundary_frame])
    if before < -60:
        return 0.0  # nothing sounding at the boundary
    limit = min(len(db), boundary_frame + int(MAX_TAIL / FRAME))
    quiet_run = 0
    for i in range(boundary_frame, limit):
        recent_min = db[max(boundary_frame - 3, i - 5) : i].min() if i > boundary_frame - 3 else db[i]
        if db[i] > -45 and db[i] > recent_min + 6:
            # A new attack: stop just before it.
            return max(0.0, (i - boundary_frame - 2) * FRAME)
        quiet_run = quiet_run + 1 if db[i] < -60 else 0
        if quiet_run >= 10:
            return (i - boundary_frame) * FRAME
    return (limit - boundary_frame) * FRAME


def swell_events(db: np.ndarray, file_offset: float, bar: float, total_bars: int) -> list:
    active = db > -55
    events = []
    i = 0
    n = len(db)
    while i < n:
        if not active[i]:
            i += 1
            continue
        start = i
        gap = 0
        j = i
        while j < n and gap < int(0.3 / FRAME):
            gap = 0 if active[j] else gap + 1
            j += 1
        end = j - gap
        if (end - start) * FRAME >= 0.15:
            seg = db[start:end]
            peak = start + int(np.argmax(seg))
            src_peak = file_offset + peak * FRAME
            anchor = int(round(src_peak / bar)) + 1  # bar whose downbeat is nearest the peak
            if 2 <= anchor <= total_bars:
                events.append(
                    {
                        "start": round(file_offset + start * FRAME, 3),
                        "end": round(file_offset + min(n, end + 5) * FRAME, 3),
                        "anchorBar": anchor,
                    }
                )
        i = j
    return events


def main() -> None:
    config_path = Path(sys.argv[1])
    public = config_path.parent.parent
    config = json.loads(config_path.read_text())
    bar = 60 / config["bpm"] * (config.get("timeSignature") or [4, 4])[0]
    total_bars = max(r[1] for r in config["sourceRegions"].values()) + 8
    for track in config["tracks"]:
        if track.get("role") == "logo" or not track.get("file"):
            continue
        x = decode(public / track["file"].lstrip("/"))
        db = frame_db(x)
        file_start_bar = track.get("fileStartBar", 1)
        file_offset = (file_start_bar - 1) * bar
        tails = []
        for n in range(1, total_bars + 1):
            boundary = n * bar - file_offset  # end of source bar n, in file seconds
            tails.append(round(tail_after(db, int(round(boundary / FRAME))), 2) if boundary > 0 else 0.0)
        track["tails"] = tails
        # Ring-out after every beat (for the logo's hit, which lands mid-bar).
        beat = bar / (config.get("timeSignature") or [4, 4])[0]
        beat_tails = []
        for k in range(1, total_bars * 4 + 1):
            boundary = k * beat - file_offset
            beat_tails.append(round(tail_after(db, int(round(boundary / FRAME))), 2) if boundary > 0 else 0.0)
        track["beatTails"] = beat_tails
        # Pickups (upbeats): sound in the bar(s) just before a section start that belongs to that
        # section -- the track was silent before it within the previous section.
        active = []
        for n in range(1, total_bars + 1):
            a = int(round(((n - 1) * bar - file_offset) / FRAME))
            b = int(round((n * bar - file_offset) / FRAME))
            seg = db[max(0, a) : max(0, min(len(db), b))] if b > 0 else db[0:0]
            active.append(bool(len(seg)) and float(seg.max()) > -50)
        pickups = {}
        for start in sorted(r[0] for r in config["sourceRegions"].values()):
            if start <= 2:
                continue
            p = 0
            while p < 2 and start - 1 - p >= 1 and active[start - 2 - p]:
                p += 1
            silent_before = start - 2 - p >= 0 and not active[start - 2 - p]
            if 1 <= p <= 2 and silent_before and active[start - 1] if start - 1 < len(active) else False:
                pickups[str(start)] = p
        if pickups:
            track["pickups"] = pickups
        if track.get("role") == "swell":
            track["swellEvents"] = swell_events(db, file_offset, bar, total_bars)
            print(track["id"], track["name"], "swells:", [(e["anchorBar"], e["start"], e["end"]) for e in track["swellEvents"]])
        nonzero = [(i + 1, t) for i, t in enumerate(tails) if t >= 0.3]
        print(track["id"], track["name"], "long tails:", nonzero[:12])
    config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Onset extractor for FIZX Visualizer
Writes beats.json next to this script, 
consumed by compile.py which injects 
beats.json into fizx.html — no copy-paste needed.

Usage:
    python3 ex_beats.py <audio_file>

Output:
    beats.json  →  { "beats": [...], "bpm": 129, "source": "filename.mp3" }

Design notes:
    sr=None     : preserves native sample rate (fixes timestamp drift on 48kHz files
                  caused by librosa's default resampling to 22050Hz)
    backtrack   : snaps onset frames back to the nearest preceding local minimum,
                  aligning timestamps to the actual attack transient, not the peak
    aggregate   : np.median smooths noise better than mean for dense rap transients
    delta       : 0.07 is a safe starting point; raise if you get too many false
                  positives, lower if strong hits are being missed
    wait        : 8 frames at 48kHz ≈ 85ms — prevents double-triggers on one hit
    MIN_GAP     : secondary 120ms de-dupe pass on final time values after all
                  librosa processing, catches edge cases the wait param misses
"""

import librosa
import numpy as np
import json
import sys
from pathlib import Path


def extract_onsets(audio_path: str) -> tuple[list[float], int]:
    y, sr = librosa.load(audio_path, sr=None)

    print(f"Loaded : {audio_path}")
    print(f"SR     : {sr} Hz  |  Duration: {len(y)/sr:.2f}s")

    # Use a combined spectral flux onset envelope.
    # aggregate=np.median smooths out noise better than np.mean for rap
    # which has dense percussive transients that can cause false positives.
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, aggregate=np.median)

    # detect_onset with backtrack=True snaps each detected onset back to
    # the nearest preceding local minimum in the envelope — this aligns
    # the timestamp to the actual attack transient rather than the peak.
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        backtrack=True,
        # delta controls sensitivity. 0.07 is a reasonable starting point
        # for rap mixes; increase if you get too many false positives,
        # decrease if strong hits are being missed.
        delta=0.07,
        # wait: minimum gap between onsets in frames (~512 samples each).
        # 8 frames at 48kHz ≈ 85ms — prevents double-triggers on a single hit.
        wait=8
    )

    onset_times = librosa.frames_to_time(onset_frames, sr=sr)

    # Secondary de-dupe: drop any onset closer than 120ms to the previous one.
    # The librosa wait parameter operates in frames before NMS; this operates
    # on the final time values after all processing, catching edge cases.
    MIN_GAP = 0.12
    filtered = []
    for t in onset_times:
        if not filtered or (t - filtered[-1]) >= MIN_GAP:
            filtered.append(round(float(t), 3))

    # Also pull BPM for reference (not used by the scheduler but useful
    # for manually checking if the extraction looks reasonable).
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo))

    print(f"Onsets raw      : {len(onset_times)}")
    print(f"After 120ms gap : {len(filtered)}")
    print(f"Estimated BPM   : {bpm}")

    return filtered, bpm


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 ex_beats.py <audio_file>")
        sys.exit(1)

    audio_path = sys.argv[1]
    beats, bpm = extract_onsets(audio_path)

    # Write beats.json next to this script so index.html can fetch it directly
    out_path = Path(__file__).parent / "beats.json"
    payload  = {
        "beats":  beats,
        "bpm":    bpm,
        "source": Path(audio_path).name
    }

    with open(out_path, "w") as f:
        json.dump(payload, f)

    print(f"\n✅ Written → {out_path}")
    print(f"   {len(beats)} onsets | {bpm} BPM")
    print(f"   run compile.py to inject onsets into the visualizer")

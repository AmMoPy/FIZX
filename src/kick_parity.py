#!/usr/bin/env python3
"""
How to read the result:
-----------------------
- Time grid: the script compares on a time grid rather than by index. 
The browser decodes at the AudioContext rate (often 48000Hz), while librosa 
reads the file's native rate. The two step_ms values differ whenever the source 
isn't at the context rate, so index-for-index comparison would be wrong.

- Expected match: corr should be at least 0.98 on beats, and close to 1 for vocal_env 
and treble_env. Both paths use the same Hann window, band edges, centered frames and normalization.

- Residual drift: the remaining differences should come from resampling at decode time and float32 versus float64.

- A real bug: a much lower beats correlation with normal vocal and treble results points at the kick filters or the 
percentile alignment above. A vocal or treble mismatch points at frame centering, which must be identical in both paths.

usage: python kick_parity.py python_beats.json studio_beats.json
"""
import sys, json, numpy as np
from pathlib import Path

py = json.loads(Path(sys.argv[1]).read_text())
js = json.loads(Path(sys.argv[2]).read_text())

def grid(step_ms, arr, dt=10.0):                # both paths onto a shared 10ms time grid
    t = np.arange(0, len(arr) * step_ms, dt)
    return np.interp(t, np.arange(len(arr)) * step_ms, arr)

for key in ('beats', 'vocal_env', 'treble_env'):
    a, b = grid(py['step_ms'], py[key]), grid(js['step_ms'], js[key]); n = min(len(a), len(b)); a, b = a[:n], b[:n]
    print(f"{key:11s} corr={np.corrcoef(a, b)[0,1]:.4f}  mean|d|={np.abs(a-b).mean():.4f}  max|d|={np.abs(a-b).max():.3f}")

po, jo = np.array(py['onsets']), np.array(js['onsets'])
hit = sum(bool(len(jo)) and np.min(np.abs(jo - p)) <= .04 for p in po)

print(f"onsets py={len(po)} js={len(jo)}  py onsets with a js onset within ±40ms: {hit}/{len(po)}")
print(f"step_ms py={py['step_ms']} js={js['step_ms']}   bpm py={py['bpm']} js={js['bpm']}")
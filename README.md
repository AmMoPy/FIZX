<div align="center">

<img width="50%" src="https://raw.githubusercontent.com/AmMoPy/FIZX/main/assets/fizx.svg">

<details>
<summary><h3>DEMO</h3></summary>

https://github.com/user-attachments/assets/8e62d32e-957e-40eb-a873-f56fd58b9ac5

</details>

# FREE LYRICS VISUALIZER THAT ACTUALLY SYNX

</div>

> **CapCut? Never heard of!**
>
> *"Portable. Personal. Offline. Forever."*

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)
[![Made with Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=fff)](#)
[![Pure HTML/JS](https://img.shields.io/badge/Frontend-Vanilla%20JS-important)](#)
[![Cloud Required](https://img.shields.io/badge/Cloud-No%20Thanks-yellowgreen)](#)
[![Watermarks](https://img.shields.io/badge/Watermarks-Never-critical)](#)
[![Vibe Coded](https://img.shields.io/badge/Methodology-Vibe%20Coding-black)](#)

---

## DAFUQ !

Bring your lyrics to life from any browser, with a tiny file that fits in a text message.

**In English:** FIZX is a self-contained sync tool that nobody asked for, you give it an audio file and some lyrics. It gives you a single `.html` file that plays both in sync, with animated visual presets. Drop your audio. Paste your text. Export. Record. Post and pretend you have a production budget. Built the hard way, for legacy hardware, by someone who clearly had options. No reason for it to exist except that it does and it's faster than explaining why!

**In Technical:** rAF-scheduled, pointer-driven and drift-free beat-sync engine. Dual-path architecture, Python onset extractor with native sample rate preservation and DTW/ONNX lyrics forced alignment; Browser-based audio analysis pipeline with FFT worker, multi-engine onset detection, manual/automated lyrics alignment and editing. Modular themed preset system and animations, CSS-powered visual effects, and enough canvas optimizations to make a game dev nod approvingly. Dual aspect ratio (9:16 / 16:9) support. 

**In Therapy Speak:** The gap on my resume? Filled with ~100KB of HTML.

**Perfect for:** Doomscrolling.

**Developed on 4GB RAM and 2 cores. If my fans are happy, your fans are happy. This is my QA process for archival-grade engineering.**

---

## Why This Exists

> *"The Gap™"*

I spent a decade auditing systems. I saw inefficiencies everywhere. Exceeded expectations. Then I had time. Too much time. I thought "Fine..I'll do what I do best; Audit the hell out of AI slop".

Here I am, making a video bragging about my broken [RAG](https://github.com/AmMoPy/DOX) system (don't ask). Every free animation tool failed me. Watermarks, time limits, low export quality....

**So I built my own.**

```
┌─────────────────────────────────────────────────────────────┐
│                    THE FIZX UNIVERSE                        │
│                                                             │
│   TECHNICAL PATH              NON-TECHNICAL PATH            │
│   (You have Python)           (You have a browser)          │
│                                                             │
│   compile.py                  studio.html                   │
│       │                           │                         │
│       ├── --beats    (librosa)     ├── Drop audio           │
│       ├── --lyrics   (ONNX/aeneas) ├── Paste lyrics         │
│       ├── --both     (one pass)    ├── Tap spacebar         │
│       └── --out fizx.html          ├── Auto-populate        │
│                │                   └── Edit in preview      │
│                └──────────────────────────┘                 │
│                              │                              │
│                        fizx.html                            │
│                    120KB. Works offline.                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

> *"No subscriptions. No watermarks. No cloud. No bullshit.'"*

- Portable: One file, works offline, anywhere.
- Extensible: Add your own presets/visualizers.
- Efficient: Behaves around screen recorders.
- Simple: Paste. Drop. Tap. Export. Or just compile.
- Free: Just you and ~100KB of HTML.

---

## Getting Started

> *"One tool. Two workflows. Genuinely Simple This Time."*

### Prerequisites

- A computer that turns on
- Python 3.11+ (**optional**)
- An audio file (MP3 or WAV)
- Lyrics
- Screen Recorder
- Low expectations

### Usage

#### Peasants (Non-Developers)

Open studio.html > paste lyrics > drop audio > select mode > start session > tap spacebar > preview > export > screen record > post > go viral.

#### Elites (Developers)

- Edit LYRICS_RAW in `lyrics.js` > run compile OR just use the studio, I won't judge.

```bash
# Minimalist, defaults only (rap + ethereal presets, all visualizers)
python compile.py path_to_audio --out fizx.html 

# Single preset, single visualizer (smallest output)
python compile.py path_to_audio --p void --v ring

# Multiple presets, all visualizers
python compile.py path_to_audio --p rap,ethereal,void

# Everything (maximum bloat, maximum flexibility)
python compile.py path_to_audio --all

# Extract beats only (librosa)
python compile.py path_to_audio --e --b

# Align lyrics only (aeneas on full mix, the accurate one)
python compile.py path_to_audio --e --l # --onnx for ONNX forced alignment: Spleeter and wav2vec2 CTC

# Force re-extraction even if data is fresh
python compile.py track.mp3 --e --b --f

# All CLI commands defaults to rebuilding the studio unless --out is explicitly stated
# Extracted beats and lyrics are written to beats.js and lyrics.js in src directory
```

---

## What's Inside (For Nerds)

> *"The most sophisticated solution to a problem that didn't exist."*

`compile.py` is the only required step for technical users. It:

1. Checks if `beats.json` is stale and calls `ex_beats.py` if so
2. Reads `presets.js`, `visualizers.js`, `lyrics.js`, `template.html`
3. Tree-shakes presets and visualizers based on `--preset` / `--visualizer` flags
4. Injects everything into the templates via `/* @@MARKER@@ */` comment blocks
5. Writes a single self-contained `.html`

`ex_beats.py` wraps librosa and lyrics aligners with a set of choices that took longer to get right than the entire rest of the project:

**Beat Extraction**:
- `librosa.load(sr=None)` — native sample rate. Forced resampling to 22050Hz causes timestamp drift on 48kHz files. This is the kind of thing you only find out when someone complains that the lyrics are off by 200ms on "every 48kHz file." `sr=None` costs nothing and fixes it permanently.
- `aggregate=np.median` — spectral flux with median aggregation. Mean gets pulled by loud spikes. Median doesn't care about your outliers.
- `backtrack=True` — timestamps land on the attack transient, not the peak. 50ms difference. Perceptually significant.
- BPM via `librosa.beat.beat_track` autocorrelation, NOT inter-onset interval median. Interval median returns 2× BPM on rap because hi-hats fire on every 8th note. This took an embarrassingly long time to figure out.

**Lyric Alignment** — two paths, pick one:

| Path | Accuracy | Setup Pain | Runtime |
|------|----------|------------|---------|
| **aeneas** (full mix) | ★★★★☆ | High (espeak, ffmpeg) | ~30s |
| **ONNX CTC** (vocal stem) | ★★★★☆ | Medium (model downloads) | ~2 min |

*aeneas* uses DTW on MFCC features. It aligns your lyrics to the audio without transcribing — it knows the text, it just needs to find where. Works on the full mix directly. No vocal separation needed. Fastest path offering best accuracy.

*ONNX CTC* uses Sherpa-ONNX (Spleeter INT8) -> vocal stem -> wav2vec2 CTC forced aligner. More infrastructure, comparable accuracy, works offline after first model download.

Both beat the Whisper+Spleeter approach because we simply dont need transcription, or i just configured it wrong!

`studio.html` runs the same pipeline in a Web Worker using a hand-rolled radix-2 Cooley-Tukey FFT, it also acts as a browser-native lyric tapping tool. Drop an audio file, paste lyrics, tap spacebar in time. Export a working FIZX visualizer file without touching code.

**The Quine Strategy** — The studio carries a copy of the compiled FIZX template as a JS string (`FIZX_TEMPLATE`). When you hit "Generate FIZX.HTML", it performs string substitution of `[[LYRICS_DATA]]`, `[[BEATS_DATA]]`, `[[BPM_DATA]]` and triggers a download. No server, no POST, no file system access. The studio is self-replicating in the sense that it contains and can emit its own payload.

**Full-mix analysis** (beat sync for visualizer):
- Spectral Flux: FFT-based, detects timbral changes. Best for rap, dense production.
- Energy RMS: Amplitude-based. Best for loud attacks, kicks, spoken word.

**Vocal onset detection** (optional for lyric snapping, falls back to full-mix):
- DSP path: 500–8kHz bandpass + 3kHz peaking EQ → spectral flux on filtered signal.
- Mono downmix, no L-R subtraction (L-R cancels vocals on widened tracks).
- Auto-tune: 150-combination grid search finds optimal delta/wait/minGap for your lyric count. Runs in ~150ms on pre-computed envelope.
- Beat masking was tried and removed. Some of the tested vocals landed ON the beat intentionally. Masking removed correct detections.

**The Lyrics Preview Panel** (My Pride and Joy):
The preview is a **canvas renderer**, not an iframe. This matters because:
- The iframe's AudioContext is sandboxed — no communication with the parent
- Sliders in an iframe cannot seek an iframe's internal player (learned this the hard way)
- Canvas reads `state.results` and `state.beats` on every rAF tick
- Slider drag → updates state → canvas updates on next frame
- Canvas drag on lyric lines → updates state → slider updates
- Everything is the same mutation point. Divergence is structurally impossible.

`fizx.html` The thing that makes your lyrics look cool.

**Beat sync**: Single rAF loop. Zero timers. No drift. Just a pointer that moves forward.

**Presets**: CSS variable swaps + effect configs, Tree-shaken — unused presets don't ship.

---

## Honest Limitations

> *"It works on my machine is my shipping strategy."*

**Browser DSP ceiling**: The studio's vocal onset detection is good for clean vocal recordings on sparse arrangements. On tracks with stutter edits, deliberate double-timing, or buried vocals, it will detect roughly 65–80% of lines correctly. The waveform editor exists for the remaining 20–35%. This is a feature, not a failure, It's called "user correction" and it's how professionals work.

**aeneas setup**: Requires `ffmpeg` and `espeak` on PATH. Ubuntu: `apt install ffmpeg espeak`. macOS: `brew install ffmpeg espeak`. Windows: good luck, genuinely. Consider using the studio instead.

**ONNX CTC timing**: First run downloads ~400MB of models. Subsequent runs are instant (cached locally). On a legacy 2-core CPU, alignment takes ~2–4 minutes. This is the price of being broke!

**BPM on sparse tracks**: Autocorrelation BPM works well on music with a clear pulse. On freeform spoken word or heavily rubato material, it will return a number with false confidence. The number will be in the 40–240 range. That's all I can promise, the visualizer doesn't actually need BPM for anything except display, so it's fine.

---

## Contributing 

> *"What else was I supposed to do?"*

Not recommended

---

## License

MIT — Sync, remix, redistribute. Just don't put a watermark on it.

---

<div align="center">

<sub>© 2026 — @AmMoPy No rights reserved. Do whatever. The timestamps are yours.</sub>

</div>

<div align="center">

<img width="50%" src="https://raw.githubusercontent.com/AmMoPy/FIZX/main/assets/fizx.svg">

<details>
<summary><h3>DEMO</h3></summary>

https://github.com/user-attachments/assets/f845dc27-33e8-4abb-a70a-69a9bf96acfb

</details>

# FREE SPECTRUM VISUALIZER THAT ACTUALLY SYNX

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

Bring your audio to life from any browser, with a tiny file that fits in a text message.

**In English:** FIZX is a self-contained sync tool that nobody asked for, you give it an audio file and some lyrics. It gives you a single `.html` file that plays both in sync, with animated visual presets. Drop your audio. Paste your text. Export. Record. Post and pretend you have a production budget. Built the hard way, for legacy hardware, by someone who clearly had options. No reason for it to exist except that it does and it's faster than explaining why!

**In Technical:** Drift-free beat-sync engine. Dual-path architecture, Python extractor and DTW/ONNX lyrics forced alignment; Browser-based DSP pipeline with FFT worker, multi-engine detectors, manual/automated lyrics alignment and editing. Modular themed preset system and animations, CSS-powered visual effects, and enough canvas optimizations to make a game dev nod approvingly. Dual aspect ratio (9:16 / 16:9) support. 

**In Therapy Speak:** Huh...?.

**Perfect for:** Doomscrolling.

**Developed on 4GB RAM and 2 cores. If my CPU fans are happy, your CPU fans are happy. This is my QA process for archival-grade engineering.**

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
│       │                            │                        │
│       ├── --beats    (librosa)     ├── Drop audio           │
│       ├── --lyrics   (ONNX/aeneas) ├── Design animations    │
│       ├── --both     (one pass)    ├── Paste lyrics         │
│       └── --out fizx.html          ├── Tap spacebar         │
│                │                   ├── Auto-populate        │
│                │                   └── Edit in preview      │
│                └──────────────────────────┘                 │
│                              │                              │
│                        fizx.html                            │
│                      Works offline                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

> *"No subscriptions. No watermarks. No cloud. No bullshit.'"*

- Portable: One file, works offline, anywhere.
- Extensible: Add your own presets/visualizers.
- Efficient: Behaves around screen recorders.
- Simple: Paste. Drop. Tap. Export. Or just compile.
- Free: Buy me a coffee?

---

## Getting Started

> *"One tool. Two workflows. Genuinely Simple This Time."*

### Prerequisites

- A computer that turns on
- Python 3.11+ (**optional**)
- An audio file (MP3 or WAV)
- Lyrics
- Screen Recorder
- High expectations

### Usage

#### Peasants (Non-Developers)

Open studio.html > paste lyrics > drop audio > select mode > start session > tap spacebar > preview > export > screen record > post > go viral.

#### Elites (Developers)

- Edit LYRICS_RAW in `lyrics.js` > run compile OR just use the studio, I won't judge.

```bash
# Minimalist, defaults only
python compile.py path_to_audio --out fizx.html 

# Single preset, single visualizer (smallest output)
python compile.py path_to_audio -p void -v ring

# Multiple presets, all visualizers
python compile.py path_to_audio -p rap,ethereal,void

# Everything (maximum bloat, maximum flexibility)
python compile.py path_to_audio --all

# Extract beats only (librosa)
python compile.py path_to_audio -e -b

# Align lyrics only (aeneas on full mix, the accurate one)
python compile.py path_to_audio -e -l # --onnx for ONNX forced alignment: Spleeter and wav2vec2 CTC

# Force re-extraction even if data is fresh
python compile.py track.mp3 -e -b -f

# Beat Onsets instead of LUT (bass only)
python compile.py path_to_audio -bm kick

# All CLI commands defaults to rebuilding the studio
# Extracted beats and lyrics are written to beats.js and lyrics.js in src directory
```

---

## What's Inside (For Nerds)

> *"The most sophisticated solution to a problem that didn't exist."*

- **Extensible Design** add your own processing engines and visualization presets, the registry system is designed for exactly that.
- **Design Animations** with live preview, param controls, and the ability to bake the design into the export.
- **Build Pipeline (compile.py)** that produces a self-contained HTML with baked data, embedded fonts, and inlined JS.
- **Worker-based DSP Pipeline** that runs the same analysis in-browser that numpy/scipy does in Python, with parity that's close enough to share a preset format.
- **Studio - Quine Strategy** that lets a non-technical user go from audio file -> tapped lyrics -> exported visualizer without touching any of the internals.
- **Registry-driven UI** where adding a preset or engine is a data change, not a code change.
- **Rendering Core** (AnimCore, stylekit.js, rendercore.js) that's shared between the studio's preview and the exported template, so what you see is what you get.

---

## Honest Limitations

> *"It works on my machine is my shipping strategy."*

**Browser DSP ceiling**: The studio's audio analysis is slower than python path (for now!), auto lyrics assignment is not accurate and manual tapping/editing is the way to go.

**aeneas setup**: Requires `ffmpeg` and `espeak` on PATH. Ubuntu: `apt install ffmpeg espeak`. macOS: `brew install ffmpeg espeak`. Windows: good luck, genuinely. Consider using the studio instead.

**ONNX CTC timing**: First run downloads models. Subsequent runs are instant (cached locally). On a legacy 2-core CPU, alignment takes ~2–4 minutes. This is the price of being broke!

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

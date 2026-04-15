<div align="center">

<img width="50%" src="https://raw.githubusercontent.com/AmMoPy/FIZX/main/assets/fizx.svg">

# FREE LYRICS VISUALIZER THAT ACTUALLY SYNCS

</div>

> **Built Because Watermarks Are a Personal Offense**
>
> *"Free tier? More like free tears."*

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)
[![Made with Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=fff)](#)
[![Pure HTML/JS](https://img.shields.io/badge/Frontend-Vanilla%20JS-red)](#)
[![Cloud Required](https://img.shields.io/badge/Cloud-No%20Thanks-yellowgreen)](#)
[![Watermarks](https://img.shields.io/badge/Watermarks-Never-inactive)](#)
[![Vibe Coded](https://img.shields.io/badge/Methodology-Vibe%20Coding-black)](#)
[![Beat Sync](https://img.shields.io/badge/Precision-AudioContext-important)](#)
[![Beat Detection](https://img.shields.io/badge/Beat%20Detection-Pre--Analyzed-critical)](#)
[![Genres Supported](https://img.shields.io/badge/Genres-MULTI-informational)](#)

---

## DAFUQ !

A browser-based lyric visualizer with pre-analyzed, zero lag beat-synchronized animations, Built because every "free" AI animation tool gave me:

- 5-second clips (useless)
- Watermarks the size of my ego
- Faces that melted into nightmares
- "Subscribe for $29.99 to remove the dancing rat"

**In English:** Drop your audio file, see your lyrics animate in sync with the beat. No accounts, no watermarks, no subscriptions, no cloud, no npm install, no webpack, no opinions — just a portable html file you open in any browser.

**In Technical:** Beat-sync engine using high-resolution clock with scheduled callbacks. Python onset extractor with native sample rate preservation. Zero-copy-paste automation handshake. Modular preset system for genre-aware themes and animations. Dual aspect ratio support for vertical/horizontal export.

**Perfect for:** Promoting your AI slop when you can't afford rent.

**This project is ~50KB of HTML/CSS/JS; don't expect to go viral, your lyrics sux anyways! ¯\\(ツ)/¯**

---

## Why This Exists

I wanted to make a rap video bragging about my  broken [RAG](https://github.com/AmMoPy/DOX) system (don't ask). Every free animation tool failed me. So I did what any unemployed auditor would do. **I built my own.**

If this saved you from watermarks, give it a ⭐. It feeds the ego that started this whole thing.

---

## Getting Started

> *"Genuinely Simple This Time."*

### Prerequisites

- A computer that turns on
- Python 3.11+ (**only needed for auto mode**)
- An audio file (MP3 or WAV)
- Lyrics with timestamps (**manual extraction, for now...**)
- Screen Recorder
- Low expectations

### Installation

```bash
git clone https://github.com/AmMoPy/FIZX
cd FIZX
```

### Usage

**Auto mode: modify `lyrics.js`  with timestamps then run**

```bash
python compile.py <audio_file_path> [--preset rap|ethereal] [--out output.html]
```

**Manual mode: modify "INJECTED DATA" section in `fizx.html` as follows:** 

**Step 1: Extract Beats (one time per audio file)**

```bash
python ex_beats.py <audio_file_path>
```

`beats.json` now lives next to `ex_beats.py`; in auto mode it gets injected into `fizx.html` by `compile.py` — no copy-paste needed.

**Step 2: Add Your Lyrics Timestamps**

Edit `lyrics.js`:

```javascript
export const LYRICS = [
    { text: "Your first line", start: 1.2, end: 2.8 },
    { text: "Your second line", start: 3.0, end: 4.5 },
    // ...
];
```

Timestamps in seconds. Get them from Audacity label tracks, CapCut captions export, or by listening and pausing like an animal.

**Step 3: Add more presets if you must**

Edit `presets.js`:

```javascript
export const PRESETS = {
    rap: {
        label: 'RAP',
        cssVars: {...}
    // ...
];
```

**Open `src/fizx.html` (manual mode) or `root/<audio_stem>.html` (auto mode) in any browser. Click PLAY, select your audio file, start screen recording**

---

## Features

> *"No subscriptions. No watermarks. No cloud. No bullshit.'"*

### Core

- **Beat-Sync Engine** — `AudioContext` clock-anchored `setTimeout` callbacks. Not polling. Not `requestAnimationFrame` jitter. Actual precision scheduling. Absorbs browser audio latency automatically by capturing `t0` at `play()` resolution.

- **Lyric Display** — Timestamp-driven lyric rendering with current/next line preview. `rAF` loop handles display only — animation triggers are fully decoupled.

- **Dual Sync Modes**
  - **Mode A** — Beat timestamps from `ex_beats.py` onset detection
  - **Mode B** — Lyric start timestamps (one trigger per line)
  - Switchable mid-playback, reschedules automatically

### Presets

- **RAP** — Sharp, punchy animations: shake, glitch, chromatic split, flicker, zoom. 

- **ETHEREAL** — Slow ambient animations: drift, breathe, aurora glow, dissolve, float.

- **Add Your Own** — Drop a new entry in `presets.js`. It auto-appears in the toggle cycle. See the existing presets for the schema.

### Controls

| Button | Behavior |
|--------|----------|
| ▶ PLAY | Load file + play/pause. |
| ⟳ RESET | Full wipe. Re-triggers file picker. |
| ⇄ MODE | Toggle A/B sync mode. Mid-playback safe. |
| 🎨 PRESET | Cycle presets. Mid-playback safe. |
| ⊞ AR | Toggle 9:16 ↔ 16:9 aspect ratio. |
| ◎ CIRCLE | Toggle beat circle on/off. |

## Project Structure

> *"Modular enough to feel professional, simple enough to actually understand"*

```
.
├── src/
│   ├── ex_beats.py     # Python onset extractor → writes beats.json
│   ├── fizx.html       # Core structure, scheduler, playback logic
│   ├── lyrics.js       # Your lyrics
│   └── presets.js      # Theme CSS vars, animation pools, configs
└── compile.py          # Entry point → writes <audio_stem>.html`
```

---

## License

MIT — Sync, remix, redistribute. Just don't put a watermark on it.

---

<div align="center">

<sub>© 2026 — No rights reserved. Do whatever. The timestamps are yours.</sub>

</div>

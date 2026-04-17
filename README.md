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

**This project is ~50 - 70KB of HTML/CSS/JS; don't expect to go viral, your lyrics SUX anyways! ¯\\(ツ)/¯**

---

## Why This Exists

I wanted to make a rap video bragging about my  broken [RAG](https://github.com/AmMoPy/DOX) system (don't ask). Every free animation tool failed me. So I did what any unemployed auditor would do. **I built my own.**

If this saved you from watermarks, give it a ⭐. It feeds the ego that started this whole thing.

---

## Getting Started

> *"One tool. Two workflows. Genuinely Simple This Time."*

### Prerequisites

- A computer that turns on
- Python 3.11+ (**only needed for auto mode**)
- An audio file (MP3 or WAV)
- Lyrics with timestamps (**manual extraction, for now...**)
- Screen Recorder
- Low expectations

### Usage

#### Peasants (Non-Developers)

- Right click `fizx.html` > open with > Notepad > search for `LYRICS` and `BEAT_DATA`, They look like this:

```javascript
/* @@LYRICS@@ */
const LYRICS = [
    { text: "Yeah...", start: 1.0, end: 1.48 },
    { text: "They said I couldn't build it.", start: 1.48, end: 3.0 },
];
/* @@END_LYRICS@@ */

/* @@BEATS@@ */
const BEAT_DATA = {
    beats: [ 1.022, 1.486, 1.718, ...],
     bpm:   129,
};
/* @@END_BEATS@@ */

```

- Replace the example lyrics with your own. Timestamps in seconds.

- (Optional) Replace BEAT_DATA if you extracted beats. Or don't. Mode B (lyric triggers) works fine.
 
- Save and close.

- Note: you only get default 2 themes, if you are feeling fancy modify the values in `PRESETS`

#### Elites (Developers)

- Edit `lyrics.js` → paste your timestamped lyrics

```bash
# Minimalist — defaults only (rap + ethereal presets, all visualizers)
python compile.py song.mp3 --out fizx.html 

# Single preset, single visualizer (smallest output)
python compile.py song.mp3 --preset void --visualizer ring

# Multiple presets, all visualizers
python compile.py song.mp3 --preset rap,ethereal,void

# Everything (maximum bloat, maximum flexibility)
python compile.py song.mp3 --all

# Custom output name
python compile.py song.mp3 --out tiktok_ready.html

```

#### Finally open `fizx.html` in any browser. Click PLAY, select your audio file, start screen recording

---

## Features

> *"No subscriptions. No watermarks. No cloud. No bullshit.'"*

- **Beat-Sync Engine** — `AudioContext` clock-anchored `setTimeout` callbacks. Not polling. Not `requestAnimationFrame` jitter. Actual precision scheduling. Absorbs browser audio latency automatically by capturing `t0` at `play()` resolution.

- **Lyric Display** — Timestamp-driven lyric rendering with current/next line preview. `rAF` loop handles display only — animation triggers are fully decoupled.

- **Dual Sync Modes**
  - **Mode A** — Beat timestamps from `ex_beats.py` onset detection
  - **Mode B** — Lyric start timestamps (one trigger per line)
  - Switchable mid-playback, reschedules automatically

- **Presets/visualizers** — several themes to match different genres, dont like any? Just add your own!

### Controls

| Button | Behavior |
|--------|----------|
| ▶ PLAY | Load file + play/pause. |
| ⟳ RESET | Full wipe. Re-triggers file picker. |
| ⇄ MODE | Toggle A/B sync mode. Mid-playback safe. |
| 🎨 PRESET | Cycle presets. Mid-playback safe. |
| ⊞ AR | Toggle 9:16 ↔ 16:9 aspect ratio. |
| ◎ | Toggle visualizers on/off. |

## Project Structure

> *"Modular enough to feel professional, simple enough to actually understand"*

```
.
├── src/
│   ├── ex_beats.py         # Python beat extractor
│   ├── template.html       # Layout only
│   ├── lyrics.js           # User lyrics with timestamps
│   ├── visualizers.js      # BaseVisualizer + classes
│   ├── presets.js          # Preset styles, cssVars, effects
│   └── compile.py          # Injects presets/visualizers/lyrics/beats into template
├── fizx.html               # Compiled output (default)
└── README.md
```

---

## License

MIT — Sync, remix, redistribute. Just don't put a watermark on it.

---

<div align="center">

<sub>© 2026 — No rights reserved. Do whatever. The timestamps are yours.</sub>

</div>

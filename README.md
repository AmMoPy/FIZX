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

Bring your text to life from any browser, with a tiny file that fits in a text message.

**In English:** Drop your audio. Paste your text. Tap spacebar. Export. Record. Post and pretend you have a production budget.

**In Technical:** Beat-sync engine using high-resolution clock with scheduled callbacks. Python onset extractor with native sample rate preservation. Zero-copy-paste automation handshake. Modular preset system for genre-aware themes and animations. Dual aspect ratio support for vertical/horizontal export and an Over-engineered UI

**Perfect for:** Making content when you can't afford rent.

---

## Why This Exists

I wanted to make a video bragging about my  broken [RAG](https://github.com/AmMoPy/DOX) system (don't ask). Every free animation tool failed me. Watermarks, time limits, low export quality....

**So I built my own.**

If this saved you from watermarks, give it a ⭐. It feeds the ego that started this whole thing.

---

## Getting Started

> *"One tool. Two workflows. Genuinely Simple This Time."*

### Prerequisites

- A computer that turns on
- Python 3.11+ (**only needed if you are a pro**)
- An audio file (MP3 or WAV)
- Lyrics with timestamps (**Or just use the studio**)
- Screen Recorder
- Low expectations

### Usage

#### Peasants (Non-Developers)

Open studio > drop audio > select mode > start session > tap spacebar > preview > export > screen record > post > go viral.

Note: you only get default 2 themes.

#### Elites (Developers)

- Edit `lyrics.js` > run compile OR just use the studio, I won't judge.

```bash
# Minimalist, defaults only (rap + ethereal presets, all visualizers)
python compile.py path_to_audio --o fizx.html 

# Single preset, single visualizer (smallest output)
python compile.py path_to_audio --p void --v ring

# Multiple presets, all visualizers
python compile.py path_to_audio --p rap,ethereal,void

# Everything (maximum bloat, maximum flexibility)
python compile.py path_to_audio --all

# Rebuild studio
python compile.py path_to_audio --s

```
---

## Features

> *"No subscriptions. No watermarks. No cloud. No bullshit.'"*

- Portable: One file, double-click, works offline.
- Extensible: Add your own presets/visualizers.
- Efficient: Behaves around screen recorders.
- Simple: Paste. Drop. Tap. Export.
- Free: Just you and ~80KB of HTML.

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
│   ├── ex_beats.py        # Python beat extractor
│   ├── template.html      # Core visualizer layout
│   ├── template_studio.html # Studio layout
│   ├── lyrics.js          # Your lyrics (editable)
│   ├── presets.js         # Theme CSS vars, animation pools
│   └── visualizers.js     # Canvas beat visualizers
├── studio.html            # Centralized workflow UI
├── compile.py             # Main compiler → builds final HTML
└── README.md
```

---

## License

MIT — Sync, remix, redistribute. Just don't put a watermark on it.

---

<div align="center">

<sub>© 2026 — No rights reserved. Do whatever. The timestamps are yours.</sub>

</div>

#!/usr/bin/env python3
"""
compile.py — FIZX Visualizer build script.
Produces a single self-contained HTML with zero external dependencies.

Usage:
    python compile.py <audio_file> [--preset rap|ethereal] [--out output.html]

    <audio_file>  Path to your audio file (MP3/WAV/OGG).
                  If beats.json is missing or older than the audio file,
                  ex_beats.py is called automatically.

    --preset      Starting preset baked into the compiled HTML.
                  Default: rap

    --out         Output filename. Default: <audio_stem>.html

What it does:
    1. Checks for beats.json; runs ex_beats.py if absent or stale.
    2. Reads beats.json, presets.js, lyrics.js.
    3. Inlines everything into fizx.html by replacing placeholder blocks:
         @@PRESETS@@   ... @@END_PRESETS@@
         @@LYRICS@@    ... @@END_LYRICS@@
         @@BEATS@@     ... @@END_BEATS@@
    4. Writes a single portable HTML — open it on any device, no server needed.

The compiled file has no fetch() calls, no ES module imports, no external scripts.
All data is embedded as plain JS object literals.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).parent
HERE = ROOT / "src"


def run_beat_extractor(audio_path: Path) -> Path:
    """Run ex_beats.py and return path to beats.json."""
    extractor = HERE / "ex_beats.py"
    if not extractor.exists():
        print(f"❌ ex_beats.py not found at {extractor}")
        sys.exit(1)
    print(f"⚙️  Running ex_beats.py on {audio_path.name}…")
    result = subprocess.run(
        [sys.executable, str(extractor), str(audio_path)],
        capture_output=False
    )
    if result.returncode != 0:
        print("❌ ex_beats.py failed.")
        sys.exit(1)
    return HERE / "beats.json"


def needs_extraction(audio_path: Path, beats_json: Path) -> bool:
    """True if beats.json is missing or older than the audio file."""
    if not beats_json.exists():
        return True
    return beats_json.stat().st_mtime < audio_path.stat().st_mtime # TODO: usless


def load_presets_js() -> str:
    """Read presets.js and strip ES module export syntax for inline use."""
    src = (HERE / "presets.js").read_text()
    # Remove export keywords — the compiled HTML uses plain var declarations
    src = re.sub(r'\bexport\s+const\s+', 'const ', src)
    # Strip JS comments that are only useful in the source file context
    src = re.sub(r'//\s*═+.*\n', '', src)
    return src.strip()


def load_lyrics_js() -> str:
    """Read lyrics.js and extract just the LYRICS array literal."""
    src = (HERE / "lyrics.js").read_text()
    src = re.sub(r'\bexport\s+const\s+', 'const ', src)
    src = re.sub(r'//.*\n', '\n', src)  # strip single-line comments
    return src.strip()


def load_beats_json(beats_json: Path) -> dict:
    return json.loads(beats_json.read_text())


def inline_block(html: str, tag: str, replacement: str) -> str:
    """Replace @@TAG@@ ... @@END_TAG@@ block in html with replacement string."""
    pattern = rf'/\*\s*@@{tag}@@\s*\*/(.*?)/\*\s*@@END_{tag}@@\s*\*/'
    repl    = f'/* @@{tag}@@ */\n{replacement}\n/* @@END_{tag}@@ */'
    result  = re.sub(pattern, repl, html, flags=re.DOTALL)
    if result == html:
        print(f"⚠️  Warning: placeholder @@{tag}@@ not found in fizx.html")
    return result


def set_initial_preset(html: str, preset_key: str) -> str:
    """Swap the first entry in PRESET_ORDER so the chosen preset loads first."""
    # Replace the PRESET_ORDER array to put the chosen preset first
    def reorder(m):
        order_str = m.group(1)
        keys      = re.findall(r"'(\w+)'", order_str)
        if preset_key in keys:
            keys.remove(preset_key)
            keys.insert(0, preset_key)
        new_order = ', '.join(f"'{k}'" for k in keys)
        return f"const PRESET_ORDER = [{new_order}];"
    return re.sub(r'const PRESET_ORDER\s*=\s*\[([^\]]+)\];', reorder, html)


def main():
    parser = argparse.ArgumentParser(description="FIZX Visualizer compile script")
    parser.add_argument("audio",           help="Path to audio file")
    parser.add_argument("--preset", "-p",  default="rap", help="Starting preset (default: rap)")
    parser.add_argument("--out",    "-o",  default=None,  help="Output filename")
    args = parser.parse_args()

    audio_path = Path(args.audio).resolve()
    if not audio_path.exists():
        print(f"❌ Audio file not found: {audio_path}")
        sys.exit(1)

    beats_json = HERE / "beats.json"
    if needs_extraction(audio_path, beats_json):
        beats_json = run_beat_extractor(audio_path)
    else:
        print(f"✅ beats.json up to date, skipping extraction")

    # Read source files
    index_html = (HERE / "fizx.html").read_text()
    beats_data = load_beats_json(beats_json)

    # Verify chosen preset exists in presets.js
    presets_src = load_presets_js()
    if f"'{args.preset}'" not in presets_src and f'"{args.preset}"' not in presets_src:
        print(f"⚠️  Preset '{args.preset}' not found in presets.js — defaulting to first preset")

    # Build inline JS blocks
    beats_block   = (
        f"const BEAT_DATA = {{\n"
        f"    beats: {json.dumps(beats_data['beats'])},\n"
        f"    bpm:   {beats_data['bpm']},\n"
        f"}};"
    )

    presets_block = presets_src
    lyrics_block  = load_lyrics_js()

    # Inline into HTML
    out_html = index_html
    out_html = inline_block(out_html, 'PRESETS', presets_block)
    out_html = inline_block(out_html, 'LYRICS',  lyrics_block)
    out_html = inline_block(out_html, 'BEATS',   beats_block)

    # Set starting preset
    out_html = set_initial_preset(out_html, args.preset)

    # Update title to reflect the source audio
    out_html = out_html.replace(
        '<title>FIZX VISUALIZER</title>',
        f'<title>FIZX · {audio_path.stem}</title>'
    )

    # Remove the <script type="module"> — compiled file uses plain <script>
    # (already plain script in fizx.html; this is a safety strip)
    out_html = re.sub(r'<script type="module">', '<script>', out_html)

    # Write output
    out_name = args.out or f"{audio_path.stem}.html"
    out_path = ROOT / out_name
    out_path.write_text(out_html)

    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ Compiled → {out_path}")
    print(f"   Preset  : {args.preset}")
    print(f"   Beats   : {len(beats_data['beats'])} onsets · {beats_data['bpm']} BPM")
    print(f"   Source  : {beats_data.get('source', audio_path.name)}")
    print(f"   Size    : {size_kb:.1f} KB")
    print(f"\n   Open {out_name} on any device — no server, no dependencies.")


if __name__ == "__main__":
    main()

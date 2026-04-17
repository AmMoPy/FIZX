#!/usr/bin/env python3
"""
compile.py — FIZX Visualizer build script.
Produces a single self-contained HTML with zero external dependencies.

USAGE:
    python compile.py <audio_file> [options]

    <audio_file>       Path to audio file (MP3/WAV/OGG).
                       If beats.json is missing or older than the audio,
                       ex_beats.py is called automatically.

OPTIONS:
    --preset [name]    Include only this preset.
                       Can be specified multiple times.
                       No flag → defaults only (rap + ethereal).
                       --all → include every preset defined in presets.js.

    --visualizer [name]  Include only this visualizer class.
                         Can be specified multiple times.
                         No flag → include all visualizer classes (default).
                         Rationale: visualizers are small; including all costs ~5KB.
                         The --visualizer flag exists for extreme size optimization.

    --out [filename]   Output filename. Default: <audio_stem>.html

    -p / --preset shorthand supported.

WHAT IT DOES:
    1. Checks beats.json; runs ex_beats.py automatically if absent/stale.
    2. Reads src/presets.js → extracts cssVars, effects, visualizer per preset.
       Extracts the `styles` string per preset for CSS injection.
    3. Reads src/visualizers.js → extracts requested class source code.
    4. Reads src/template.html → replaces injection blocks:
         @@STYLES@@      → concatenated preset CSS (keyframes + fx classes)
         @@VISUALIZERS@@ → BaseVisualizer + utility functions + requested classes
                           + VISUALIZERS map + VISUALIZER_ORDER
         @@PRESETS@@     → PRESETS object + PRESET_ORDER
         @@LYRICS@@      → LYRICS array
         @@BEATS@@       → BEAT_DATA object
    5. Writes a single portable HTML. Open on any device — no server needed.

FLAG LOGIC SUMMARY:
    No --preset flag  → include rap + ethereal (DEFAULT_PRESETS)
    --preset void     → include only void preset
    --preset void --preset dream → include void + dream
    --all             → include all presets in PRESET_ORDER

    No --visualizer flag → include all visualizer classes
    --visualizer ring    → include only ring class (+ BaseVisualizer + utils)
    --visualizer ring --visualizer bloom → ring + bloom only

    TODO: --preset comma/pipe support, input validation default fallback
"""

import argparse
import ast
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC  = ROOT / "src"


# ═══════════════════════════════════════════════════════════════════
# BEAT EXTRACTION
# ═══════════════════════════════════════════════════════════════════

def run_beat_extractor(audio_path: Path) -> Path:
    extractor = SRC / "ex_beats.py"
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
    return SRC / "beats.json"

def needs_extraction(audio_path: Path, beats_json: Path) -> bool:
    """True if beats.json is missing or older than the audio file."""
    if not beats_json.exists():
        return True
    return beats_json.stat().st_mtime < audio_path.stat().st_mtime # TODO: usless


# ═══════════════════════════════════════════════════════════════════
# PRESETS EXTRACTION
# Parses presets.js to extract:
#   - The list of all preset keys (from PRESET_ORDER)
#   - The list of default preset keys (from DEFAULT_PRESETS)
#   - The `styles` string for each preset
#   - A clean JS object literal for each preset (cssVars, effects, visualizer)
#     with the `styles` key removed (it belongs in <style>, not in JS)
# ═══════════════════════════════════════════════════════════════════

def _strip_export(src: str) -> str:
    """Remove ES module export keywords for inline use."""
    return re.sub(r'\bexport\s+const\s+', 'const ', src)

def _strip_line_comments(src: str) -> str:
    """Remove // single-line comments. Preserves block comments and strings."""
    return re.sub(r'(?m)//.*$', '', src)

def extract_preset_keys(src: str, var_name: str) -> list[str]:
    """Extract string array values from a const declaration like:
       const PRESET_ORDER = ['rap', 'ethereal', ...];
    """
    m = re.search(rf"const\s+{var_name}\s*=\s*\[([^\]]+)\]", src)
    if not m:
        return []
    return re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))

def _flatten_keys(matches):
    return [a or b for a, b in matches]

def extract_styles_for_preset(src: str, key: str) -> str:
    """Extract the value of the `styles` backtick string for a given preset key.
    
    We look for:
        <key>: {
            ...
            styles: `...`,
            ...
        }
    
    Strategy: find the styles property within the preset block using a
    balanced-brace walk rather than regex, since the styles string contains
    CSS with braces that would break a naive regex.
    """
    # Find the start of the preset block: "key: {"
    key_pattern = re.compile(rf'\b{re.escape(key)}\s*:\s*\{{')
    m = key_pattern.search(src)
    if not m:
        return ''

    # Walk forward to find the matching closing brace of the preset block
    depth = 0
    block_start = m.start()
    block_end   = m.end()
    i = m.end() - 1  # start just before the opening {
    while i < len(src):
        ch = src[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                block_end = i + 1
                break
        i += 1

    block = src[block_start:block_end]

    # Extract the backtick string value of `styles`
    m2 = re.search(r'\bstyles\s*:\s*`(.*?)`', block, re.DOTALL)
    if not m2:
        return ''
    return m2.group(1).strip()

def build_presets_block(src: str, preset_keys: list[str]) -> str:
    """Build PRESETS JS object containing ONLY the requested preset keys.
    Also builds PRESET_ORDER array from those keys.
    """
    clean = _strip_line_comments(_strip_export(src))
    
    # Extract the raw text of each requested preset's object literal
    preset_definitions = {}
    for key in preset_keys:
        # Find the start of the preset block: "key: {"
        pattern = re.compile(rf'\b{re.escape(key)}\s*:\s*\{{')
        m = pattern.search(clean)
        if not m:
            print(f"⚠️  Preset '{key}' definition not found in presets.js")
            continue
        
        # Walk braces to capture the full preset object
        depth = 0
        start = m.start()
        i = m.end() - 1  # position before the opening '{'
        while i < len(clean):
            if clean[i] == '{':
                depth += 1
            elif clean[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
            i += 1
        else:
            print(f"⚠️  Could not find closing brace for preset '{key}'")
            continue
        
        preset_raw = clean[start:end]
        # Remove the `styles: ` line (including its backtick string)
        preset_raw = re.sub(r'\bstyles\s*:\s*`.*?`\s*,?', '', preset_raw, flags=re.DOTALL)
        # Clean up double commas or trailing commas before '}'
        preset_raw = re.sub(r',\s*,', ',', preset_raw)
        preset_raw = re.sub(r',\s*\}', '}', preset_raw)
        preset_definitions[key] = preset_raw
    
    # Build the final PRESETS object
    if not preset_definitions:
        print("⚠️  No valid preset definitions found. Using empty object.")
        presets_obj = "const PRESETS = {};"
    else:
        inner = ',\n'.join(preset_definitions.values())
        presets_obj = f"const PRESETS = {{\n{inner}\n}};"
    
    # Build PRESET_ORDER array
    order_str = f"const PRESET_ORDER = {json.dumps(preset_keys)};"
    
    return presets_obj + "\n" + order_str


# ═══════════════════════════════════════════════════════════════════
# STYLES EXTRACTION
# Collects the `styles` strings from all requested presets and
# concatenates them into a single CSS block for injection into <style>.
# ═══════════════════════════════════════════════════════════════════

def build_styles_block(src: str, preset_keys: list[str]) -> str:
    parts = []
    for key in preset_keys:
        css = extract_styles_for_preset(src, key)
        if css:
            parts.append(f"/* ── {key.upper()} ── */\n{css}")
    return '\n\n'.join(parts)


# ═══════════════════════════════════════════════════════════════════
# VISUALIZERS EXTRACTION
# Extracts:
#   - All text before the first class declaration (CANVAS_SCALE, utils,
#     easeOutSine, makeCanvas etc.) — always included
#   - BaseVisualizer class — always included
#   - Each requested concrete class
#   - VISUALIZERS map filtered to requested classes
#   - VISUALIZER_ORDER array
#
# Strategy: extract class source using a balanced-brace walk from each
# "class XxxVisualizer" declaration. This is reliable across all
# formatting styles without requiring an AST parser.
# ═══════════════════════════════════════════════════════════════════

def extract_class_source(src: str, class_name: str) -> str:
    """Extract full source of a class by name using balanced-brace walk."""
    pattern = re.compile(rf'\bclass\s+{re.escape(class_name)}\b')
    m = pattern.search(src)
    if not m:
        return ''
    # Find opening brace
    brace_pos = src.find('{', m.end())
    if brace_pos == -1:
        return ''
    depth = 0
    i = brace_pos
    while i < len(src):
        if src[i] == '{': depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
        i += 1
    return ''

def build_visualizers_block(src: str, viz_keys: list[str]) -> str:
    """Build the full visualizers JS block for injection.
    
    Always includes:
      - Module-level constants (CANVAS_SCALE) and utility functions
      - BaseVisualizer class
    
    Then includes only the requested concrete classes and filters
    VISUALIZERS map and VISUALIZER_ORDER accordingly.
    """
    clean = _strip_line_comments(_strip_export(src))

    parts = []

    # 1. Preamble: everything up to the first "class" declaration
    first_class = re.search(r'\bclass\s+\w+', clean)
    if first_class:
        preamble = clean[:first_class.start()].strip()
        if preamble:
            parts.append(preamble)

    # 2. BaseVisualizer — always required
    base_src = extract_class_source(clean, 'BaseVisualizer')
    if base_src:
        parts.append(base_src)
    else:
        print("⚠️  BaseVisualizer not found in visualizers.js")

    # 3. Map from key to class name (convention: key → Titlecase + Visualizer)
    key_to_class = {
        'ring':      'RingVisualizer',
        'bloom':     'BloomVisualizer',
        'heartbeat': 'HeartbeatVisualizer',
        'ripple':    'RippleVisualizer',
        'waveform':  'WaveformVisualizer',
        'particles': 'ParticlesVisualizer',
        'dna':       'DNAVisualizer',
    }

    # 4. Concrete classes for requested keys
    for key in viz_keys:
        if key == 'off':
            continue
        cls_name = key_to_class.get(key)
        if not cls_name:
            # Attempt auto-derive: key → Key + Visualizer
            cls_name = key.capitalize() + 'Visualizer'
        cls_src = extract_class_source(clean, cls_name)
        if cls_src:
            parts.append(cls_src)
        else:
            print(f"⚠️  Class {cls_name} not found in visualizers.js (key: {key})")

    # 5. VISUALIZERS map — filtered to requested keys
    entries = []
    for key in viz_keys:
        if key == 'off':
            continue
        cls_name = key_to_class.get(key, key.capitalize() + 'Visualizer')
        entries.append(f"    {key}: {cls_name},")
    viz_map = "const VISUALIZERS = {\n" + "\n".join(entries) + "\n};"
    parts.append(viz_map)

    # 6. VISUALIZER_ORDER — all requested keys + 'off' sentinel
    # 'off' is always appended so the user can always disable the visualizer.
    order = [k for k in viz_keys if k != 'off'] + ['off']
    parts.append(f"const VISUALIZER_ORDER = {json.dumps(order)};")
    print(f"{json.dumps(order)}")

    # # 7. DEFAULT_VISUALIZERS — intersection of requested + defaults from source
    # m_def = re.search(r'const\s+DEFAULT_VISUALIZERS\s*=\s*\[([^\]]+)\]', clean)
    # if m_def:
    #     parts.append(f"const DEFAULT_VISUALIZERS = {json.dumps(order[:2])};")

    return '\n\n'.join(parts)


# ═══════════════════════════════════════════════════════════════════
# LYRICS
# ═══════════════════════════════════════════════════════════════════

def load_lyrics_js() -> str:
    src = (SRC / "lyrics.js").read_text()
    src = _strip_export(src)
    src = _strip_line_comments(src)
    return src.strip()


# ═══════════════════════════════════════════════════════════════════
# BLOCK INJECTION
# Replaces /* @@TAG@@ */ ... /* @@END_TAG@@ */ in HTML.
# Robust against whitespace variations around markers.
# ═══════════════════════════════════════════════════════════════════

def inline_block(html: str, tag: str, replacement: str) -> str:
    start_marker = f'/* @@{tag}@@ */'
    end_marker   = f'/* @@END_{tag}@@ */'
    
    if start_marker not in html or end_marker not in html:
        print(f"⚠️  Markers for @@{tag}@@ not found in template.html")
        return html
    
    # Split into three parts: before start, between markers, after end
    before, rest = html.split(start_marker, 1)
    middle, after = rest.split(end_marker, 1)
    
    # Reassemble with replacement in the middle
    return before + start_marker + '\n' + replacement + '\n' + end_marker + after

def set_initial_preset(html: str, preset_key: str) -> str:
    """Reorder PRESET_ORDER so the chosen preset is first (loads on boot)."""
    def reorder(m):
        keys = re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))
        flat = [a or b for a, b in keys]
        if preset_key in flat:
            flat.remove(preset_key)
            flat.insert(0, preset_key)
        return f"const PRESET_ORDER = [{', '.join(repr(k) for k in flat)}];"
    return re.sub(r'const PRESET_ORDER\s*=\s*\[([^\]]+)\];', reorder, html)


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="FIZX Visualizer build script")
    parser.add_argument("audio",                   help="Path to audio file")
    parser.add_argument("--preset",   "-p",        action="append", default=[], metavar="NAME",
                        help="Include preset (repeatable). No flag = defaults only.")
    parser.add_argument("--all",                   action="store_true",
                        help="Include all presets")
    parser.add_argument("--visualizer", "-v",      action="append", default=[], metavar="NAME",
                        help="Include visualizer (repeatable). No flag = all.")
    parser.add_argument("--out",      "-o",        default=None,
                        help="Output filename (default: <stem>.html)")
    args = parser.parse_args()

    audio_path = Path(args.audio).resolve()
    if not audio_path.exists():
        print(f"❌ Audio file not found: {audio_path}")
        sys.exit(1)

    # ── Beat extraction ───────────────────────────────────────────
    beats_json = SRC / "beats.json"
    if needs_extraction(audio_path, beats_json):
        beats_json = run_beat_extractor(audio_path)
    else:
        print(f"✅ beats.json up to date")
    beats_data = json.loads(beats_json.read_text())

    # ── Read source files ─────────────────────────────────────────
    presets_src  = (SRC / "presets.js").read_text()
    viz_src      = (SRC / "visualizers.js").read_text()
    template     = (SRC / "template.html").read_text()

    # ── Resolve preset keys ───────────────────────────────────────
    all_preset_keys    = _flatten_keys(extract_preset_keys(presets_src, 'PRESET_ORDER'))
    default_preset_keys = _flatten_keys(extract_preset_keys(presets_src, 'DEFAULT_PRESETS')) or ['rap', 'ethereal'] # fallback

    if args.all:
        preset_keys = all_preset_keys
        print(f"📦 Including all presets: {preset_keys}")
    elif args.preset:
        # only add user-specified presets
        preset_keys = list(dict.fromkeys(args.preset))
        # Validate
        for key in args.preset:
            if key not in all_preset_keys:
                print(f"⚠️  Preset '{key}' not found in presets.js (available: {all_preset_keys})")
        print(f"📦 Presets: {preset_keys}")
    else:
        preset_keys = default_preset_keys
        print(f"📦 Default presets only: {preset_keys}")

    # ── Resolve visualizer keys ───────────────────────────────────
    all_viz_keys = _flatten_keys(extract_preset_keys(viz_src, 'VISUALIZER_ORDER'))
    # Remove 'off' sentinel — it is not a real class
    all_viz_keys = [k for k in all_viz_keys if k != 'off']

    if args.visualizer:
        viz_keys = list(dict.fromkeys(args.visualizer))
        for key in viz_keys:
            if key not in all_viz_keys:
                print(f"⚠️  Visualizer '{key}' not found (available: {all_viz_keys})")
        print(f"🎨 Visualizers: {viz_keys}")
    else:
        viz_keys = all_viz_keys
        print(f"🎨 All visualizers included")

    # ── Build injection blocks ────────────────────────────────────
    styles_block    = build_styles_block(presets_src, preset_keys)
    presets_block   = build_presets_block(presets_src, preset_keys)
    viz_block       = build_visualizers_block(viz_src, viz_keys)
    lyrics_block    = load_lyrics_js()
    beats_block     = (
        f"const BEAT_DATA = {{\n"
        f"    beats: {json.dumps(beats_data['beats'])},\n"
        f"    bpm:   {beats_data['bpm']},\n"
        f"}};"
    )

    # ── Inject into template ──────────────────────────────────────
    out = template
    out = inline_block(out, 'STYLES',      styles_block)
    out = inline_block(out, 'VISUALIZERS', viz_block)
    out = inline_block(out, 'PRESETS',     presets_block)
    out = inline_block(out, 'LYRICS',      lyrics_block)
    out = inline_block(out, 'BEATS',       beats_block)

    # Set the boot preset to the first in the requested list
    out = set_initial_preset(out, preset_keys[0])

    # Update title
    out = out.replace('<title>FIZX VISUALIZER</title>',
                      f'<title>FIZX · {audio_path.stem}</title>')

    # Safety: strip type="module" if present (compiled file is plain JS)
    out = re.sub(r'<script\s+type=["\']module["\']>', '<script>', out)

    # ── Write output ──────────────────────────────────────────────
    out_name = args.out or f"{audio_path.stem}.html"
    out_path = ROOT / out_name
    out_path.write_text(out)

    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ Compiled → {out_path}")
    print(f"   Presets     : {preset_keys}")
    print(f"   Visualizers : {viz_keys}")
    print(f"   Beats       : {len(beats_data['beats'])} onsets · {beats_data['bpm']} BPM")
    print(f"   Size        : {size_kb:.1f} KB")
    print(f"\n   Open {out_name} — no server, no dependencies.")


if __name__ == "__main__":
    main()

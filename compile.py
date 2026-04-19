#!/usr/bin/env python3
"""
compile.py — FIZX Visualizer build script.
Produces a single self-contained HTML with zero external dependencies.

USAGE:
    python compile.py <audio_file> [options]

    <audio_file>        Path to audio file (MP3/WAV/OGG).
                        If beats.json is missing or stale,
                        ex_beats.py is called automatically.

OPTIONS:
    --preset [name[,name,...]]
                        Include specific preset(s). Comma or pipe separated,
                        or repeat the flag: --preset void --preset dream
                        No flag: defaults only (rap + ethereal).
                        --preset all: include every preset (alias for --all)

    --all               Include all presets defined in presets.js.

    --visualizer [name[,name,...]]  
                        Include specific visualizer(s). Comma or pipe separated.
                        No flag → include all.
                        Rationale: visualizers are small; including all costs ~5KB.
                        The --visualizer flag exists for extreme size optimization.

    --extract           Re-extract beats even if beats.json exists and valid

    --out [filename]    Output filename. Default: <audio_stem>.html

INJECTION BLOCKS (in template.html):
    /* @@STYLES@@     */ ... /* @@END_STYLES@@     */
    /* @@VISUALIZERS@@*/ ... /* @@END_VISUALIZERS@@*/
    /* @@PRESETS@@    */ ... /* @@END_PRESETS@@    */
    /* @@LYRICS@@     */ ... /* @@END_LYRICS@@     */
    /* @@BEATS@@      */ ... /* @@END_BEATS@@      */
"""

import argparse
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
    """True if beats.json is missing or has different file name"""
    if not beats_json.exists():
        return True
    data = json.loads(beats_json.read_text())
    return data.get('source') != audio_path.name


# ─────────────────────────────────────────────────────────────────
# SOURCE HELPERS
# ─────────────────────────────────────────────────────────────────

def _strip_export(src: str) -> str:
    """Remove ES module export keywords for inline use."""
    return re.sub(r'\bexport\s+const\s+', 'const ', src)

def _strip_line_comments(src: str) -> str:
    """Remove // single-line comments. Preserves block comments and strings."""
    return re.sub(r'(?m)//.*$', '', src)

def extract_array_values(src: str, var_name: str) -> list[str]:
    """Extract string values from: const VAR = ['a', 'b', ...];"""
    m = re.search(rf'const\s+{re.escape(var_name)}\s*=\s*\[([^\]]+)\]', src)
    if not m:
        return []
    return [a or b for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))]

def brace_walk(src: str, start_pos: int) -> int:
    """
    Walk from start_pos (which must be at or before the opening '{') to
    the matching '}'. Returns the index after the closing '}'.
    """
    i = src.find('{', start_pos)
    if i == -1:
        return -1
    depth = 0
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


# ═══════════════════════════════════════════════════════════════════
# PRESETS EXTRACTION
# Parses presets.js to extract:
#   - The list of all preset keys (from PRESET_ORDER)
#   - The list of default preset keys (from DEFAULT_PRESETS)
#   - The `styles` string for each preset
#   - A clean JS object literal for each preset (cssVars, effects, ...)
#     with the `styles` key removed (it belongs in <style>, not in JS)
# ═══════════════════════════════════════════════════════════════════

def build_presets_block(src: str, preset_keys: list[str]) -> str:
    """
    Build PRESETS JS object containing ONLY the requested preset keys.
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
        start = m.start()
        end = brace_walk(clean, start)
        if end == -1:
            print(f"⚠️  Could not find closing brace for preset '{key}'")
            continue
        
        preset_raw = clean[start:end]
        # Remove the `styles: ` backtick string — belongs in <style>, not JS
        preset_raw = re.sub(r'\bstyles\s*:\s*`.*?`\s*,?', '', preset_raw, flags=re.DOTALL)
        # Clean up double commas or trailing commas before '}'
        preset_raw = re.sub(r',\s*,', ',', preset_raw)
        preset_raw = re.sub(r',\s*\}', '}', preset_raw)
        preset_definitions[key] = preset_raw
    
    # Build the final PRESETS object
    if not preset_definitions:
        print("⚠️  No valid preset definitions found.")
        return "const PRESETS = {};\nconst PRESET_ORDER = [];"
    
    # Build PRESET_ORDER array
    inner = ',\n'.join(preset_definitions.values())
    presets_obj = f"const PRESETS = {{\n{inner}\n}};"
    order_str = f"const PRESET_ORDER = {json.dumps(preset_keys)};"
    
    return presets_obj + "\n" + order_str


# ═══════════════════════════════════════════════════════════════════
# STYLES EXTRACTION
# ═══════════════════════════════════════════════════════════════════

def extract_styles_for_preset(src: str, key: str) -> str:
    """
    Extract the backtick `styles` string from a named preset block.
    Uses brace walking to find the preset block boundary first,
    then regex inside that block for the backtick string.

    We look for:
        <key>: {
            ...
            styles: `...`,
            ...
        }
    """
    # Find the start of the preset block: "key: {"
    key_pattern = re.compile(rf'\b{re.escape(key)}\s*:\s*\{{')
    m = key_pattern.search(src)
    if not m:
        return ''

    # Walk forward to find the matching closing brace of the preset block
    start = m.start()
    end = brace_walk(src, start)
    if end == -1:
        return ''

    block = src[start:end]

    # Extract the backtick string value of `styles`
    m2 = re.search(r'\bstyles\s*:\s*`(.*?)`', block, re.DOTALL)
    if not m2:
        return ''
    return m2.group(1).strip()

def build_styles_block(src: str, preset_keys: list[str]) -> str:
    """
    Collects the `styles` strings from all requested presets and 
    concatenates them into a single CSS block for injection into <style>.
    """
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
    end = brace_walk(src, m.end())
    return src[m.start():end] if end != -1 else ''

def build_visualizers_block(src: str, viz_keys: list[str], fltr: bool) -> str:
    """
    Build the full visualizers JS block for injection.
    """
    clean = _strip_line_comments(_strip_export(src))
    
    # default path - all included
    if not fltr:
        return clean

    # filtered path - only requested keys
    parts = []

    # Preamble: everything up to the first "class" declaration
    first_class = re.search(r'\bclass\s+\w+', clean)
    if first_class:
        preamble = clean[:first_class.start()].strip()
        if preamble:
            parts.append(preamble)

    # BaseVisualizer — always required
    base_src = extract_class_source(clean, 'BaseVisualizer')
    if base_src:
        parts.append(base_src)
    else:
        print("⚠️  BaseVisualizer not found in visualizers.js")

    # Parse VISUALIZERS map from source
    viz_map_match = re.search(r'const\s+VISUALIZERS\s*=\s*\{([^}]+)\}', clean, re.DOTALL)
    key_to_class = {}
    if viz_map_match:
        for entry in re.finditer(r'(\w+)\s*:\s*(\w+)', viz_map_match.group(1)):
            key_to_class[entry.group(1)] = entry.group(2)

    # Concrete classes, filtered map, and order
    entries = []
    for key in viz_keys:
        if key == 'off':
            continue
        # Attempt auto-derive: key → Key + Visualizer
        cls_name = key_to_class.get(key, key.capitalize() + 'Visualizer')
        cls_src = extract_class_source(clean, cls_name)
        if cls_src:
            parts.append(cls_src)
        else:
            print(f"⚠️  Class {cls_name} not found in visualizers.js (key: {key})")
        entries.append(f"    {key}: {cls_name},")

    viz_map = "const VISUALIZERS = {\n" + "\n".join(entries) + "\n};"
    parts.append(viz_map)

    # VISUALIZER_ORDER — all requested keys + 'off' sentinel
    # 'off' is always appended so the user can always disable the visualizer.
    order = [k for k in viz_keys if k != 'off'] + ['off']
    parts.append(f"const VISUALIZER_ORDER = {json.dumps(order)};")

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
# BLOCK INJECTION AND REWRITE
# ═══════════════════════════════════════════════════════════════════

def inline_block(html: str, tag: str, replacement: str) -> str:
    """
    Replaces /* @@TAG@@ */ ... /* @@END_TAG@@ */ in HTML.
    Robust against whitespace variations around markers.
    """
    start_marker = f'/* @@{tag}@@ */'
    end_marker   = f'/* @@END_{tag}@@ */'
    
    if start_marker not in html or end_marker not in html:
        print(f"⚠️  Markers for @@{tag}@@ not found in template.html")
        return html
    
    # Split into three parts: before start, between markers, after end
    before, rest = html.split(start_marker, 1)
    middle, after = rest.split(end_marker, 1)
    
    # Reassemble with replacement in the middle
    return before + start_marker + '\n' + replacement.strip() + '\n' + end_marker + after

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


# ─────────────────────────────────────────────────────────────────
# ARGUMENT PARSING HELPERS
# --preset all is now handled explicitly, not as a literal name.
# comma/pipe support so --preset void,dream works.
# ─────────────────────────────────────────────────────────────────

def parse_list_arg(values: list[str]) -> list[str]:
    """
    Flatten comma/pipe-separated values from repeated --flag arguments.
    e.g. ['void,dream', 'ember'] → ['void', 'dream', 'ember']
    """
    result = []
    for v in values:
        for part in re.split(r'[,|]', v):
            part = part.strip()
            if part:
                result.append(part)
    return list(dict.fromkeys(result))  # deduplicate, preserve order


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="FIZX Visualizer build script")
    parser.add_argument("audio",                   help="Path to audio file")
    parser.add_argument("--preset",   "-p",        action="append", default=[], metavar="NAME[,NAME]",
                        help="Preset(s) to include. Comma-separated or repeat flag. "
                             "'all' = include everything. No flag = defaults only.")
    parser.add_argument("--all",                   action="store_true",
                        help="Include all presets (shorthand for --preset all)")
    parser.add_argument("--visualizer", "-v",      action="append", default=[], metavar="NAME[,NAME]",
                        help="Visualizer(s) to include. No flag = all.")
    parser.add_argument("--extract",  "-e",        action="store_true",
                        help="Re-extract beats even if beats.json exists and valid")    
    parser.add_argument("--out",      "-o",        default=None,
                        help="Output filename (default: <stem>.html)")
    args = parser.parse_args()

    audio_path = Path(args.audio).resolve()
    if not audio_path.exists():
        print(f"❌ Audio file not found: {audio_path}")
        sys.exit(1)

    # ── Beat extraction ───────────────────────────────────────────
    beats_json = SRC / "beats.json"
    if args.extract or needs_extraction(audio_path, beats_json):
        beats_json = run_beat_extractor(audio_path)
    else:
        print(f"✅ beats.json up to date")
    beats_data = json.loads(beats_json.read_text())

    # ── Read sources ─────────────────────────────────────────
    presets_src  = (SRC / "presets.js").read_text()
    viz_src      = (SRC / "visualizers.js").read_text()
    template     = (SRC / "template.html").read_text()

    all_preset_keys     = extract_array_values(presets_src, 'PRESET_ORDER')
    default_preset_keys = extract_array_values(presets_src, 'DEFAULT_PRESETS')
    # Remove 'off' sentinel — it is not a real class
    all_viz_keys        = [k for k in extract_array_values(viz_src, 'VISUALIZER_ORDER') if k != 'off']

    # ── Resolve preset keys ───────────────────────────────────────
    # treat literal 'all' in --preset values same as --all flag
    raw_presets = parse_list_arg(args.preset)
    include_all = args.all or 'all' in raw_presets
    raw_presets = [k for k in raw_presets if k != 'all']

    if include_all:
        preset_keys = all_preset_keys
        print(f"📦 Including all presets: {preset_keys}")
    elif raw_presets:
        # only add user-specified presets
        preset_keys = []
        for key in raw_presets:
            if key in all_preset_keys:
                preset_keys.append(key)
            else:
                print(f"⚠️  Preset '{key}' not found skipping")

        if not preset_keys:
            print(f"⚠️  No valid presets — falling back to defaults")
            preset_keys = default_preset_keys
        print(f"📦 Presets: {preset_keys}")
    else:
        preset_keys = default_preset_keys
        print(f"📦 Default presets only: {preset_keys}")

    # ── Resolve visualizer keys ───────────────────────────────────
    raw_viz = parse_list_arg(args.visualizer)

    if raw_viz:
        viz_keys = []
        fltr = True
        for key in raw_viz:
            if key in all_viz_keys:
                viz_keys.append(key)
            else:
                print(f"⚠️  Visualizer '{key}' not found skipping")
        
        if not viz_keys:
            print(f"⚠️  No valid Visualizer — falling back to defaults")
            viz_keys = all_viz_keys
            fltr = False
        print(f"🎨 Visualizers: {viz_keys}")
    else:
        viz_keys = all_viz_keys # default all keys
        fltr = False
        print(f"🎨 All visualizers included")

    # ── Build injection blocks ────────────────────────────────────
    styles_block    = build_styles_block(presets_src, preset_keys)
    presets_block   = build_presets_block(presets_src, preset_keys)
    viz_block       = build_visualizers_block(viz_src, viz_keys, fltr)
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
    print(f"\n✅ Success {out_path.name}  ({size_kb:.1f} KB)")
    print(f"   Presets     : {preset_keys}")
    print(f"   Visualizers : {viz_keys}")
    print(f"   Beats       : {len(beats_data['beats'])} onsets · {beats_data['bpm']} BPM")
    print(f"\n   Open {out_name} — no server, no dependencies.")


if __name__ == "__main__":
    main()
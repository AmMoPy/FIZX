#!/usr/bin/env python3
"""
compile.py — FIZX Visualizer build script.
Produces a single self-contained HTML with zero external dependencies.

USAGE:
    python compile.py <audio_file> [options]

    <audio_file>        Path to audio file (MP3/WAV/OGG).

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

    --extract           Triggers lyrics/beats extraction

    --out [filename]    Output filename. Default: omit to build studio only.

INJECTION BLOCKS (in template.html):
    /* @@FONTS@@      */ ... /* @@END_FONTS@@      */
    /* @@STYLES@@     */ ... /* @@END_STYLES@@     */
    /* @@VISUALIZERS@@*/ ... /* @@END_VISUALIZERS@@*/
    /* @@PRESETS@@    */ ... /* @@END_PRESETS@@    */
    /* @@LYRICS@@     */ ... /* @@END_LYRICS@@     */
    /* @@BEATS@@      */ ... /* @@END_BEATS@@      */

INJECTION BLOCKS (in studio.html):
    /* @@FIZX_TEMPLATE@@ */   — replaced with the full compiled FIZX template,
                                so studio can re-generate modified template.
    /* @@FONTS@@ */           — replaced with pre-generated base64 subset covering 
                                only the characters actually used to keep the size 
                                reasonable (~20KB per variant).
"""

import re
import sys
import json
import logging
import argparse
import urllib.parse
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════
# CONFIG & PATHS
# ═══════════════════════════════════════════════════════════════════

# Logging
log_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(
    level=getattr(logging, "INFO"),
    format=log_format
)

logger = logging.getLogger("[FIZX]")

# Paths
ROOT = Path(__file__).parent
SRC  = ROOT / "src"
FD   = ROOT / 'assets' / 'fonts' # fonts directory, base64 subsets

# @font-face configs
FONT_MAP = {
    'merri': {'p': FD / 'Merriweather.b64', 'w': 'normal', 's': 'normal'}, # path, weight, style
    'deja': {'p': FD / 'DejaVuSans.b64', 'w': 'normal', 's': 'normal'}, # arabic support
}


# ─────────────────────────────────────────────────────────────────
# SOURCE HELPERS
# ─────────────────────────────────────────────────────────────────

def _strip(src: str) -> str:
    """Remove // comments, ES module exports, and empty lines."""
    text = re.sub(r"//.*", "", src)
    text = re.sub(r"\bexport\s+const\s+", "const ", text)
    # Generator expression inside join to avoid intermediate list
    # Filter(None, ...) is highly optimized in Python
    # rstrip removes trailing spaces/newlines, preserving indentation
    return "\n".join(filter(None, (line.rstrip() for line in text.splitlines())))

def _replace_tag(match:str, data_map:dict, is_studio_prep:bool):
    """Handle tag replacement to avoid double-tagging"""
    tag = match.group(1)

    if tag not in data_map:
        # Leave unknown blocks untouched
        return match.group(0)
    
    if is_studio_prep and tag in ['BEATS', 'LYRICS']:
        return f"[[{tag}_DATA]]"
        
    content = str(data_map.get(tag, match.group(0))).strip()
    return f"/* @@{tag}@@ */\n{content}\n/* @@END_{tag}@@ */"

def _format_beats_json(data: dict) -> str:
    """Keep beats array on one line for readability."""
    beats_line = json.dumps(data.get('beats', []))
    return (
        f"const BEAT_DATA = {{\n"
        f"  \"beats\": {beats_line},\n"
        f"  \"bpm\": {data.get('bpm', 0)}\n"
        f"}};"
    )

def _format_lyrics_json(data: dict) -> str:
    """One object per line for readability without vertical bloat"""
    formatted = data.get('LYRICS', [])
    if formatted:
        # Serialize everything once
        lyrics = json.dumps(formatted)
        # Transform: [{"a":1}, {"a":2}] -> [\n  {"a":1},\n  {"a":2}\n]
        # replaces the separator '}, {' with '},\n  {'
        formatted = lyrics.replace("}, {", "},\n  {")
        # Fix the start and end of the string
        formatted = formatted.replace("[{", "[\n  {").replace("}]", "}\n]")
    return f"const LYRICS = {formatted};"

def extract_array_values(src: str, var_name: str) -> list[str]:
    """Extract string values from: const VAR = ['a', 'b', ...];"""
    m = re.search(rf'const\s+{re.escape(var_name)}\s*=\s*\[([^\]]+)\]', src)
    if not m:
        return []
    return [a or b for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))]

def brace_walk(src: str, start_pos: int) -> int:
    """
    Walk from start_pos (which must be at or before the opening '{') to
    the matching '}'. Returns the index after the closing '}', or -1 if unmatched.
    """
    i = src.find('{', start_pos)
    if i == -1:
        return -1
    depth, length = 0, len(src)
    while i < length:
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
#   - All preset keys (PRESET_ORDER) and defaults (DEFAULT_PRESETS)
#   - CSS `styles` string per preset
# ═══════════════════════════════════════════════════════════════════

def extract_preset_data(src: str, preset_keys: list[str]) -> tuple[str, str]:
    """
    Build PRESETS JS object containing ONLY the requested preset keys and
    Extract the backtick `styles` string from a named preset block.
    Returns (styles_block, presets_block) for the given keys.
    """
    # Strip comments and export keywords once
    clean = _strip(src)

    styles_parts = []
    preset_defs = {}

    for key in preset_keys:
        # Find the start of the preset block: "key: {"
        pattern = re.compile(rf'\b{re.escape(key)}\s*:\s*\{{')
        m = pattern.search(clean)
        if not m:
            logger.warning(f"Preset '{key}' definition not found in presets.js")
            continue
        # Walk braces to capture the full preset object
        start = m.start()
        end = brace_walk(clean, start)
        if end == -1:
            logger.warning(f"Could not find closing brace for preset '{key}'")
            continue
        block = clean[start:end]

        # Extract the backtick string value of `styles`
        style_match = re.search(r'\bstyles\s*:\s*`(.*?)`', block, re.DOTALL)
        if style_match:
            css = style_match.group(1).strip()
            styles_parts.append(f"/* ── {key.upper()} ── */\n{css}")

        # Strip the styles key to build the JS object
        js_block = re.sub(r'\bstyles\s*:\s*`.*?`\s*,?', '', block, flags=re.DOTALL)
        # Clean up double commas or trailing commas before '}'
        js_block = re.sub(r',\s*,', ',', js_block)
        js_block = re.sub(r',\s*}', '}', js_block)
        preset_defs[key] = js_block

    # Build the final object
    if not styles_parts:
        logger.warning("No valid styles definitions found.")
        styles_block = styles_parts
    else:
        styles_block = '\n\n'.join(styles_parts)

    if not preset_defs:
        logger.warning("No valid preset definitions found.")
        presets_obj =  "const PRESETS = {};\nconst PRESET_ORDER = [];"
    else:
        inner = ',\n'.join(preset_defs.values())
        presets_obj = f"const PRESETS = {{\n{inner}\n}};"
        order_str = f"const PRESET_ORDER = {json.dumps(preset_keys)};"

    return styles_block, presets_obj + "\n" + order_str


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
    clean = _strip(src)
    
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
        logger.warning("BaseVisualizer not found in visualizers.js")

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
            logger.warning(f"Class {cls_name} not found in visualizers.js (key: {key})")
        entries.append(f"    {key}: {cls_name},")

    viz_map = "const VISUALIZERS = {\n" + "\n".join(entries) + "\n};"
    parts.append(viz_map)

    # VISUALIZER_ORDER — all requested keys + 'off' sentinel
    # 'off' is always appended so the user can always disable the visualizer.
    order = ['off'] + [k for k in viz_keys if k != 'off']
    parts.append(f"const VISUALIZER_ORDER = {json.dumps(order)};")

    return '\n\n'.join(parts)

# ═══════════════════════════════════════════════════════════════════
# BLOCK INJECTION AND REWRITE
# ═══════════════════════════════════════════════════════════════════

def inline_blocks(template: str, data_map: dict[str, str], is_studio_prep: bool = False) -> str:
    """
    Replace all /* @@TAG@@ */ ... /* @@END_TAG@@ */ blocks in one pass.
    Ensures no whitespace bloat by stripping content before injection.
    """
    # Build a pattern that captures TAG and the inner content (non-greedy)
    pattern = r'/\* @@(\w+)@@ \*/(.*?)/\* @@END_\1@@ \*/'

    return re.sub(
        pattern, 
        lambda m: _replace_tag(m, data_map, is_studio_prep), 
        template, 
        flags=re.DOTALL
    )

def build_fonts(font_names: list[str]):
    """Build @font-face blocks from base64-encoded .b64 files."""
    replacement = ""
    for name in font_names:
        cfg = FONT_MAP.get(name)
        if not cfg:
            continue
        path = cfg.get('p')
        if not path or not path.exists():
            logger.warning(f'Font file missing: {name} — skipping')
            continue
        # read encoding from path
        b64 = path.read_text().strip()
        # build font style
        data_uri = f"url('data:font/woff2;base64,{b64}') format('woff2')"
        # font-display: block prevents Flash of Unstyled Text (FOUT) for consistent layout
        replacement += f"""
        @font-face {{
            font-family: '{name}';
            font-weight: {cfg['w']};
            font-style: {cfg['s']};
            font-display: block;
            src: {data_uri};
        }}
        """
        logger.info(f'Font injected: {path.name} ({len(b64)//1024}KB encoded)')
    if not replacement:
        logger.warning(f'No Fonts detected, ensure font file exists and are correctly mapped in FONT_MAP')
        replacement = "/* Inline fonts not available — using system fallback */"
    
    return replacement


# ═══════════════════════════════════════════════════════════════════
# STUDIO BUILD
# ═══════════════════════════════════════════════════════════════════

def build_studio(
    fizx_template: str,
    fonts_block: str,
    template_marker: str = '/* @@FIZX_TEMPLATE@@ */',
    fonts_marker: str = '/* @@FONTS@@ */'
    ) -> str:
    """
    Produce studio.html by injecting into template_studio.html:
      - Compiled FIZX template (URL-encoded) at @@FIZX_TEMPLATE@@
      - Base64 fonts at @@FONTS@@

    URL encoding chosen over backtick escaping because the FIZX template
    contains backticks, backslashes, and ${ sequences that are difficult
    to escape reliably across all content variations.
    The studio uses decodeURIComponent() to restore the original string.
    """
    studio_path = SRC / "template_studio.html"
    if not studio_path.exists():
        logger.error(f"template_studio.html not found at {studio_path}")
        sys.exit(1)

    studio = studio_path.read_text()

    # ── Inject FIZX template ───────────────────────────────────
    if template_marker not in studio:
        logger.warning(f"{template_marker} not found in template_studio.html — skipping template injection")
    else:
        # URL safe component encoding for the studio quine
        s_encoded = urllib.parse.quote(fizx_template)
        studio = studio.replace(template_marker, s_encoded)
        logger.info(f"FIZX template injected ({len(fizx_template)//1024} KB)")
    
    # ── Inject Fonts ───────────────────────────────────
    if fonts_marker not in studio:
        logger.warning(f"{fonts_marker} not found in template_studio.html — skipping fonts injection")
    else:
        studio = studio.replace(fonts_marker, fonts_block)

    return studio


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
    parser.add_argument("audio",                   
                        help="Path to audio file")
    parser.add_argument("--preset",     "-p",      action="append", default=[], metavar="NAME[,NAME]",
                        help="Preset(s) to include. Comma-separated or repeat flag. "
                             "'all' = include everything. No flag = defaults only.")
    parser.add_argument("--all",                   action="store_true",
                        help="Include all presets (shorthand for --preset all)")
    parser.add_argument("--visualizer", "-v",      action="append", default=[], metavar="NAME[,NAME]",
                        help="Visualizer(s) to include. No flag = all.")
    parser.add_argument("--extract",    "-e",      action="store_true",
                        help="Triggers lyrics/beats extraction")
    parser.add_argument("--out",                   default=None,
                        help="Output filename (default: <stem>.html)")
    
    # parse_known_args grabs the above args and keep the 
    # rest in 'extra_argv' as a list of strings ['--beats', '--force']
    # to be passed to the beats/lyrics extractor
    args, extra_argv = parser.parse_known_args()

    audio_path = Path(args.audio).resolve()
    if not audio_path.exists():
        logger.error(f"Audio file not found: {audio_path}")
        sys.exit(1)

    # ── Beat/Lyrics extraction ───────────────────────────────────────────
    beats_json  = SRC / "beats.json"
    lyrics_json = SRC / "lyrics.json"   

    if args.extract:
        from src import ex_beats
        # 'audio' is a positional arg, it was already 
        # consumed by the caller, add back for the extractor
        extra_argv.append(args.audio)
        # The caller doesn't parse extractor flags; it just passes the whole argv
        # This effectively "hands off" control to the extractor's main()
        beats_data, lyrics_data = ex_beats.main(
            extra_argv,
            logger=logger,
            beats_json=beats_json,
            lyrics_json=lyrics_json
        )
    else:
        # Fast fallback just return empty structures if no data available
        logger.warning(f"Skipping extraction, loading existing data if available...")
        beats_data  = json.loads(beats_json.read_text()) if beats_json.exists() else {"beats": [], "bpm": 0}
        lyrics_data = json.loads(lyrics_json.read_text()) if lyrics_json.exists() else []


    # ── Read JS sources ─────────────────────────────────────────
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
    elif raw_presets:
        # only add user-specified presets
        preset_keys = []
        for key in raw_presets:
            if key in all_preset_keys:
                preset_keys.append(key)
            else:
                logger.warning(f"Preset '{key}' not found skipping")

        if not preset_keys:
            logger.warning(f"No valid presets — falling back to defaults")
            preset_keys = default_preset_keys
    else:
        preset_keys = default_preset_keys

    # ── Resolve visualizer keys ───────────────────────────────────
    raw_viz = parse_list_arg(args.visualizer)

    if raw_viz:
        viz_keys = []
        fltr = True
        for key in raw_viz:
            if key in all_viz_keys:
                viz_keys.append(key)
            else:
                logger.warning(f"Visualizer '{key}' not found skipping")
        
        if not viz_keys:
            logger.warning(f"No valid Visualizer — falling back to defaults")
            viz_keys = all_viz_keys
            fltr = False
    else:
        viz_keys = all_viz_keys # default all keys
        fltr = False

    # ── Build injection blocks ────────────────────────────────────
    styles_block, presets_block = extract_preset_data(presets_src, preset_keys)
    viz_block     = build_visualizers_block(viz_src, viz_keys, fltr)
    fonts_block   = build_fonts(['merri', 'deja'])
    beats_block   = _format_beats_json(beats_data)
    lyrics_block  = _format_lyrics_json(lyrics_data)

    # ── Compile FIZIX template ──────────────────────────────────────
    out = template
    # Assembl
    inj_blocks = {
        'FONTS': fonts_block,
        'STYLES': styles_block,
        'VISUALIZERS': viz_block,
        'PRESETS': presets_block,
        'BEATS': beats_block, 
        'LYRICS': lyrics_block
    }
    out = inline_blocks(out, inj_blocks)
    # Update title
    out = out.replace('<title>FIZX VISUALIZER</title>',
                      f'<title>FIZX · {audio_path.stem}</title>')
    # Safety: strip type="module" if present (compiled file is plain JS)
    out = re.sub(r'<script\s+type=["\']module["\']>', '<script>', out)

    # ── Write FIZX output (optional) ────────────────────────────────
    if args.out:
        out_path = ROOT / args.out
        out_path.write_text(out)
        size_kb = out_path.stat().st_size / 1024
        logger.info(
            f"VISUALIZER GENERATED\n"
            f"{'*'*20}\n- {out_path.name}  ({size_kb:.1f} KB)\n"
            f"- Presets: {preset_keys}\n"
            f"- Visualizers: {viz_keys}\n{'*'*20}"
        )

    # ── Compile studio template ─────────────────────────────────────
    # The template injected into the studio is the bare template.html
    # with all blocks populated but WITHOUT audio-specific data (beats/lyrics)
    # so the Quine strategy works correctly.Studio will substitute 
    # [[LYRICS_DATA]], [[BEATS_DATA]] and [[BPM_DATA]] at export time
    # using its own session results.
    logger.info(f"\n{'*'*20}Building studio{'*'*20}")
    studio_template = out
    # Assembl
    placeholders = {
        'BEATS':  'const BEAT_DATA = { beats: [[BEATS_DATA]], bpm: [[BPM_DATA]] };',
        'LYRICS': 'const LYRICS = [[LYRICS_DATA]];'
    }
    studio_template = inline_blocks(studio_template, placeholders)
    studio_html = build_studio(studio_template, fonts_block)

    # ── Write Studio output ────────────────────────────────────────
    studio_out  = ROOT / "studio.html"
    studio_out.write_text(studio_html)
    studio_kb = studio_out.stat().st_size / 1024
    logger.info(
        f"STUDIO COMPILED\n"
        f"{'*'*20}\n- studio.html  ({studio_kb:.1f} KB)\n"
        f"- Contains generic FIZX template\n"
        f"- Open studio to edit the template\n{'*'*20}"
    )

if __name__ == "__main__":
    main()
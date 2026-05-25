// ═══════════════════════════════════════════════════════════════════
// presets.js — Single source of truth for all visual themes.
//
// STRUCTURE PER PRESET:
//   label       : shown in status bar
//   cssVars     : CSS custom properties injected into :root at runtime
//   styles      : raw CSS string — ALL @keyframes and .fx-* classes this
//                 preset needs. compile.py extracts and injects into <style>.
//                 Template.html contains ZERO preset-specific CSS.
//   dustColor   : rgba string for floating particles
//   flashColor  : rgba for screen flash
//   flashCycle  : (optional) true → rotate through flashCycleColors per trigger
//   flashCycleColors : (optional) array of rgba strings for spectral cycling
//   effects     : array of { className, duration, useFlash, useScan }
//                 className  → applied to .current-line; removed after duration ms
//                 duration   → ms before class is removed
//                 useFlash   → fires screen-flash keyed to current flashColor
//                 useScan    → fires scanline wipe (only on CRT presets)  
//
// WHAT A PRESET DOES NOT OWN:
//   circle / visualizer config — visualizers are fully independent.
//   Each visualizer reads --viz-color, --viz-glow, --viz-secondary
//   from the active preset's CSS vars at runtime. Switching preset
//   recolors the running visualizer automatically with zero rebuild.
//
// VISUALIZER COLOR VARS (must be present in every preset's cssVars):
//   --viz-color      : primary stroke/fill color
//   --viz-glow       : shadow/glow color (rgba with alpha)
//   --viz-secondary  : secondary color for two-tone visualizers (DNA strands, ripple)
//
// DENSE BEAT DESIGN NOTE:
//   Ambient/ethereal beats arrive 5-6× per second (~120-500ms apart).
//   Two strategies keep animations legible at that density:
//
//   SHORT  (duration ≤ 130ms)
//     Completes before the next beat. Safe with transforms.
//     Reads as rapid staccato pulse on dense tracks.
//
//   LAYER  (any duration, opacity/filter/text-shadow ONLY — no transform)
//     Overlapping instances accumulate as luminance swell, not spatial conflict.
//     Safe to stack indefinitely.
//
//   Never combine transform-based animations with duration > 200ms on
//   dense beats — they will visually collide mid-animation.
//
//   Animation logic (all presets):
//   to address latency problems where the animation spent
//   its first 200-400ms building up to peak, causing visual 
//   confirmation of the beat arrived late:
//     1. INSTANT-PEAK keyframes: the visible effect (glow, opacity change,
//        position shift) is at maximum at 0% of the animation, not 50%.
//        Example: bad kDrift goes 0→-4px→-2px→0 (peak at 40%).
//                 good kDrift goes -4px→-1px→0 (peak at 0%).
//     2. Shorter durations on LAYER effects: 500-800ms → 200-350ms.
//        At 60fps this gives 12-21 frames of visible effect, enough for
//        the user to register it, but short enough to clear before
//        the next beat at most tempos.
//     3. useFlash: true added to more effects — screen flash has zero
//        ramp-up time (CSS animation starts at max box-shadow) so it's
//        the most reliable beat-sync indicator. More flash = more sync feel.
//
// TO ADD A NEW PRESET (zero template changes required):
//   1. Copy any existing entry; give it a unique key.
//   2. Write all required @keyframes and .fx-* classes into the styles string.
//   3. Add --viz-color, --viz-glow, --viz-secondary to cssVars.
//   4. Add the key to PRESET_ORDER.
//   5. Run compile.py — done.
// ═══════════════════════════════════════════════════════════════════

export const PRESETS = {

    // ── RAP ──────────────────────────────────────────────────────────
    // Green CRT terminal. Punchy snap animations for sparse beats
    // (60-130 BPM). Each effect completes cleanly between hits.
    rap: {
        label: 'RAP',

        cssVars: {
            '--bg-body':       '#030603',
            '--bg-container':  'linear-gradient(145deg,#141a14,#0a0f0a)',
            '--bg-screen':     '#0a0e0a',
            '--border-screen': '#2a4a2a',
            '--color-primary': '#1eff00',
            '--color-dim':     '#3c9e3c',
            '--color-faint':   '#2a8a2a',
            '--color-muted':   '#3a7a3a',
            '--shadow-screen': 'inset 0 0 25px rgba(0,255,0,0.06)',
            '--shadow-outer':  '0 0 0 2px #1a3a1a,0 20px 40px rgba(0,0,0,0.5)',
            '--bg-stats':      '#0a0c0a',
            '--bg-btn':        '#1a2a1a',
            '--border-btn':    '#3c9e3c',
            '--color-btn':     '#aaffaa',
            '--crt-on':        '1',
            // Visualizer color palette — read by visualizers at runtime
            '--viz-color':     '#1eff00',
            '--viz-glow':      'rgba(30,255,0,0.55)',
            '--viz-secondary': 'rgba(30,255,0,0.25)',
            '--crt-color':     'rgba(0,255,0,0.04)',
            '--scan-color':    'rgba(0,255,0,0.18)',
            '--scan-anim':     'kScanWipe 0.25s linear'
        },

        // All CSS this preset needs. compile.py injects this verbatim into <style>.
        // Keeping keyframes here means adding a preset = editing this file only.
        styles: `
            @keyframes kShake {
                0%  { transform:translate(0,0);      text-shadow:0 0 3px #0f0; }
                25% { transform:translate(-2px,1px); text-shadow:2px 0 #ff00aa; }
                50% { transform:translate(2px,-1px); text-shadow:-2px 0 #0effff; }
                75% { transform:translate(-1px,1px); }
                100%{ transform:translate(0,0);      text-shadow:0 0 5px #1eff00; }
            }
            @keyframes kGlitch {
                0%  { text-shadow:-1px 0 #ff00aa,1px 0 #00ffff; opacity:1; }
                50% { text-shadow:2px 0 #ff00aa,-2px 0 #00ffff; opacity:0.9; }
                100%{ text-shadow:0 0 5px #1eff00; opacity:1; }
            }
            @keyframes kChroma {
                0%  { filter:none; text-shadow:0 0 0 transparent; }
                30% { text-shadow:-4px 0 #ff0044,4px 0 #00ffcc; filter:brightness(1.4); }
                60% { text-shadow:3px 0 #ff0044,-3px 0 #00ffcc; }
                100%{ filter:none; text-shadow:0 0 5px #1eff00; }
            }
            @keyframes kFlicker {
                0%  { opacity:1; }  15%{ opacity:0.2; } 30%{ opacity:1; }
                50% { opacity:0.5;} 65%{ opacity:1;  } 80%{ opacity:0.3; } 100%{ opacity:1; }
            }
            @keyframes kZoom {
                0%  { transform:scale(1); }
                40% { transform:scale(1.08); }
                100%{ transform:scale(1); }
            }
            @keyframes kScanWipe {
                0%  { background-position:0 -100%; }
                100%{ background-position:0 200%; }
            }
            .fx-shake   { animation:kShake   0.08s ease-in-out; }
            .fx-glitch  { animation:kGlitch  0.12s 2; }
            .fx-chroma  { animation:kChroma  0.18s ease-out; }
            .fx-flicker { animation:kFlicker 0.20s linear; }
            .fx-zoom    { animation:kZoom    0.15s ease-out; }
        `,

        dustColor:  'rgba(30,255,0,0.25)',
        flashColor: 'rgba(0,255,0,0.4)',

        effects: [
            // SHORT transforms — safe at sparse rap BPM
            { className:'fx-shake',   duration:100, useFlash:true,  useScan:false },
            { className:'fx-glitch',  duration:260, useFlash:false, useScan:false },
            { className:'fx-chroma',  duration:200, useFlash:false, useScan:true  },
            { className:'fx-flicker', duration:220, useFlash:false, useScan:false },
            { className:'fx-zoom',    duration:160, useFlash:true,  useScan:false },
        ],
    },


    // ── ETHEREAL ─────────────────────────────────────────────────────
    // Dark violet/purple. Slow ambient animations.
    // LAYER strategy: opacity + blur only — stacks gracefully on dense beats.
    ethereal: {
        label: 'ETHEREAL',

        cssVars: {
            '--bg-body':       '#06030f',
            '--bg-container':  'linear-gradient(145deg,#0e0819,#070410)',
            '--bg-screen':     '#0b0718',
            '--border-screen': '#2e1650',
            '--color-primary': '#b388ff',
            '--color-dim':     '#7c4daa',
            '--color-faint':   '#4a2870',
            '--color-muted':   '#2e1650',
            '--shadow-screen': 'inset 0 0 35px rgba(140,70,220,0.06)',
            '--shadow-outer':  '0 0 0 2px #1e0a38,0 20px 60px rgba(60,0,100,0.55)',
            '--bg-stats':      '#080514',
            '--bg-btn':        '#140a28',
            '--border-btn':    '#5c3080',
            '--color-btn':     '#c4a0f0',
            '--crt-on':        '0',
            '--viz-color':     '#c084fc',
            '--viz-glow':      'rgba(160,80,255,0.5)',
            '--viz-secondary': 'rgba(120,60,200,0.25)',
        },

        styles: `
            @keyframes kDrift {
                0%  { transform:translateY(-5px); opacity:0.7; }
                100%{ transform:translateY(0);    opacity:1; }
            }
            @keyframes kEtherealCycle {
                0%  { filter:hue-rotate(0deg)   brightness(1.6) saturate(1.8); }
                40% { filter:hue-rotate(60deg)  brightness(1.3) saturate(1.4); }
                75% { filter:hue-rotate(120deg) brightness(1.1); }
                100%{ filter:none; }
            }
            @keyframes kEtherealDepth {
                0%  { transform:perspective(280px) rotateX(22deg) scale(0.96); opacity:0.65; }
                55% { transform:perspective(280px) rotateX(4deg)  scale(0.99); opacity:0.9; }
                100%{ transform:perspective(280px) rotateX(0deg)  scale(1);    opacity:1; }
            }
            @keyframes kDissolve {
                0%  { opacity:0.45; filter:blur(2.5px); }
                50% { opacity:0.8;  filter:blur(0.5px); }
                100%{ opacity:1;    filter:none; }
            }
            @keyframes kFloat {
                0%  { transform:scale(1.05) translateY(-4px); }
                100%{ transform:scale(1)    translateY(0); }
            }
            .fx-drift    { animation:kDrift          0.25s ease-out; }
            .fx-breathe  { animation:kEtherealCycle  0.30s ease-out; }
            .fx-aurora   { animation:kEtherealDepth  0.32s ease-out; }
            .fx-dissolve { animation:kDissolve       0.28s ease-out; }
            .fx-float    { animation:kFloat          0.22s ease-out; }
        `,

        dustColor:  'rgba(160,100,255,0.15)',
        flashColor: 'rgba(140,70,255,0.20)',

        effects: [
            // LAYER — all opacity/filter/text-shadow, safe to stack
            { className:'fx-drift',    duration:250, useFlash:true,  useScan:false },
            { className:'fx-breathe',  duration:300, useFlash:false, useScan:false },
            { className:'fx-aurora',   duration:350, useFlash:true,  useScan:false },
            { className:'fx-dissolve', duration:280, useFlash:true,  useScan:false },
            { className:'fx-float',    duration:220, useFlash:false, useScan:false },
        ],
    },

    // ── ETHEREAL II ───────────────────────────────────────────────
    // Same purple palette as ETHEREAL. Entirely different mechanics.
    // ETHEREAL = luminance (glow, blur, opacity).
    // ETHEREAL II = geometric + chromatic + compositional.
    // Five effects across five different CSS axes — zero overlap
    // with each other or with ETHEREAL's effect set.
    ethereal_ii: {
        label: 'ETHEREAL II',
 
        cssVars: {
            '--bg-body':       '#06030f',
            '--bg-container':  'linear-gradient(145deg,#0e0819,#070410)',
            '--bg-screen':     '#0b0718',
            '--border-screen': '#2e1650',
            '--color-primary': '#b388ff',
            '--color-dim':     '#7c4daa',
            '--color-faint':   '#4a2870',
            '--color-muted':   '#2e1650',
            '--shadow-screen': 'inset 0 0 35px rgba(140,70,220,0.06)',
            '--shadow-outer':  '0 0 0 2px #1e0a38,0 20px 60px rgba(60,0,100,0.55)',
            '--bg-stats':      '#080514',
            '--bg-btn':        '#140a28',
            '--border-btn':    '#5c3080',
            '--color-btn':     '#c4a0f0',
            '--crt-on':        '0',
            '--viz-color':     '#c084fc',
            '--viz-glow':      'rgba(160,80,255,0.5)',
            '--viz-secondary': 'rgba(120,60,200,0.25)',
        },
 
        styles: `
            /* ETHEREAL II — five axes, none luminance-only */
 
            /* 1. GEOMETRIC: perspective depth tilt.
               The line tips toward the viewer then settles.
               transform-origin: center bottom so it pivots from
               the baseline rather than the centre — reads as
               the text standing up. */
            @keyframes kE2Depth {
                0%  { transform:perspective(260px) rotateX(26deg) translateY(4px);
                      opacity:0.6; }
                55% { transform:perspective(260px) rotateX(4deg)  translateY(1px);
                      opacity:0.9; }
                100%{ transform:perspective(260px) rotateX(0)     translateY(0);
                      opacity:1; }
            }
 
            /* 2. CHROMATIC: hue cycle through the purple family.
               purple → indigo → teal → back.
               At 0.32s the shift is subliminal — you feel it more
               than you see it. At 0.5s+ you'd see distinct colors. */
            @keyframes kE2Cycle {
                0%  { filter:hue-rotate(0deg) brightness(1.7) saturate(2); }
                35% { filter:hue-rotate(70deg) brightness(1.3) saturate(1.5); }
                70% { filter:hue-rotate(130deg) brightness(1.1); }
                100%{ filter:none; }
            }
 
            /* 3. COMPOSITIONAL: screen blend bloom.
               Text adds luminance to background instead of replacing it.
               On the near-black purple bg the bloom stays within the
               violet family — no color clash. */
            @keyframes kE2Bloom {
                0%  { mix-blend-mode:screen;
                      filter:brightness(2.8) saturate(1.8);
                      opacity:0.7; }
                40% { mix-blend-mode:screen;
                      filter:brightness(1.6) saturate(1.2);
                      opacity:0.88; }
                100%{ mix-blend-mode:normal;
                      filter:none;
                      opacity:1; }
            }
 
            /* 4. SPATIAL: counter-orbit shadow halo.
               Two shadows at opposite offsets swap positions.
               The halo appears to rotate around the glyphs. */
            @keyframes kE2Orbit {
                0%  { text-shadow: 5px -5px 20px #e040fb,
                                  -5px  5px 20px #7c4dff,
                                   0 0 40px #b388ff; }
                50% { text-shadow:-5px  5px 14px #e040fb,
                                   5px -5px 14px #7c4dff,
                                   0 0 20px #b388ff; }
                100%{ text-shadow:0 0 5px #b388ff; }
            }
 
            /* 5. STRUCTURAL: outline pulse from text boundary.
               Grows outward and fades. Zero fill-rate cost.
               The purple outline against near-black reads as
               a force field contracting inward. */
            @keyframes kE2Outline {
                0%  { outline:2px solid rgba(179,136,255,0.8);
                      outline-offset:10px; opacity:0.8; }
                60% { outline-color:rgba(179,136,255,0.25);
                      outline-offset:3px; }
                100%{ outline:2px solid rgba(179,136,255,0);
                      outline-offset:0px; opacity:1; }
            }
 
            .fx-e2-depth   { animation:kE2Depth   0.30s ease-out; }
            .fx-e2-cycle   { animation:kE2Cycle   0.32s ease-out; }
            .fx-e2-bloom   { animation:kE2Bloom   0.26s ease-out; }
            .fx-e2-orbit   { animation:kE2Orbit   0.32s ease-out; }
            .fx-e2-outline { animation:kE2Outline 0.38s ease-out; }
        `,
 
        dustColor:  'rgba(160,100,255,0.15)',
        flashColor: 'rgba(140,70,255,0.20)',
 
        effects: [
            { className:'fx-e2-depth',   duration:300, useFlash:false, useScan:false },
            { className:'fx-e2-cycle',   duration:320, useFlash:true,  useScan:false },
            { className:'fx-e2-bloom',   duration:260, useFlash:true,  useScan:false },
            { className:'fx-e2-orbit',   duration:320, useFlash:false, useScan:false },
            { className:'fx-e2-outline', duration:380, useFlash:true,  useScan:false },
        ],
    },

    // ── VOID ─────────────────────────────────────────────────────────
    // Cold deep-space silver/white. ALL SHORT (≤ 120ms).
    // At dense beat rates: rapid staccato flicker = cold data stream.
    void: {
        label: 'VOID',

        cssVars: {
            '--bg-body':       '#020202',
            '--bg-container':  'linear-gradient(145deg,#0a0a0c,#050507)',
            '--bg-screen':     '#080809',
            '--border-screen': '#1a1a2a',
            '--color-primary': '#d0d8e8',
            '--color-dim':     '#6070a0',
            '--color-faint':   '#2a3050',
            '--color-muted':   '#181828',
            '--shadow-screen': 'inset 0 0 30px rgba(80,100,180,0.04)',
            '--shadow-outer':  '0 0 0 1px #0e0e1e,0 20px 50px rgba(0,0,0,0.85)',
            '--bg-stats':      '#06060a',
            '--bg-btn':        '#0e0e18',
            '--border-btn':    '#2a3060',
            '--color-btn':     '#8090c0',
            '--crt-on':        '0',
            '--viz-color':     '#6080d0',
            '--viz-glow':      'rgba(80,120,220,0.35)',
            '--viz-secondary': 'rgba(60,80,160,0.2)',
        },

        styles: `
            @keyframes kVoidBlink {
                0%{ opacity:0.05; } 15%{ opacity:1; } 100%{ opacity:1; }
            }
            @keyframes kVoidSlice {
                0%  { clip-path:inset(0 0 60% 0); }
                40% { clip-path:inset(40% 0 0 0); }
                100%{ clip-path:inset(0 0 0 0); }
            }
            @keyframes kVoidDiff {
                0%  { mix-blend-mode:difference; filter:brightness(2.8) contrast(1.4); opacity:0.85; }
                30% { mix-blend-mode:difference; filter:brightness(1.4); }
                100%{ mix-blend-mode:normal; filter:none; opacity:1; }
            }
            @keyframes kVoidShift {
                0%  { letter-spacing:0.9px; opacity:0.6; }
                100%{ letter-spacing:normal; opacity:1; }
            }
            @keyframes kVoidStatic {
                0%  { text-shadow:4px 0 #fff,-4px 0 #6070a0; }
                40% { text-shadow:-3px 0 #fff,3px 0 #6070a0; }
                100%{ text-shadow:0 0 2px #d0d8e8; }
            }
            .fx-void-blink  { animation:kVoidBlink  0.12s ease-out; }
            .fx-void-slice  { animation:kVoidSlice  0.14s ease-out; }
            .fx-void-dim    { animation:kVoidDiff   0.18s ease-out; }
            .fx-void-shift  { animation:kVoidShift  0.16s ease-out; }
            .fx-void-static { animation:kVoidStatic 0.15s ease-out; }
        `,

        dustColor:  'rgba(160,180,255,0.07)',
        flashColor: 'rgba(200,220,255,0.14)',

        effects: [
            // ALL SHORT — each completes before next dense beat arrives
            { className:'fx-void-blink',  duration:120, useFlash:true,  useScan:false },
            { className:'fx-void-slice',  duration:140, useFlash:false, useScan:false },
            { className:'fx-void-dim',    duration:180, useFlash:true,  useScan:false },
            { className:'fx-void-shift',  duration:160, useFlash:false, useScan:false },
            { className:'fx-void-static', duration:150, useFlash:true,  useScan:false },
        ],
    },


    // ── VOID II ───────────────────────────────────────────────────
    // VOID is already the best-constructed existing preset.
    // VOID II keeps the cold silver palette and the SHORT duration
    // constraint but adds the one missing axis: compositional.
    // mix-blend-mode:difference on light text vs near-black bg
    // produces the only effect in this entire codebase where the
    // text reads as ink rather than light.
    // All effects ≤ 180ms — safe at dense beat rates.
    void_ii: {
        label: 'VOID II',
 
        cssVars: {
            '--bg-body':       '#020202',
            '--bg-container':  'linear-gradient(145deg,#0a0a0c,#050507)',
            '--bg-screen':     '#080809',
            '--border-screen': '#1a1a2a',
            '--color-primary': '#d0d8e8',
            '--color-dim':     '#6070a0',
            '--color-faint':   '#2a3050',
            '--color-muted':   '#181828',
            '--shadow-screen': 'inset 0 0 30px rgba(80,100,180,0.04)',
            '--shadow-outer':  '0 0 0 1px #0e0e1e,0 20px 50px rgba(0,0,0,0.85)',
            '--bg-stats':      '#06060a',
            '--bg-btn':        '#0e0e18',
            '--border-btn':    '#2a3060',
            '--color-btn':     '#8090c0',
            '--crt-on':        '0',
            '--viz-color':     '#6080d0',
            '--viz-glow':      'rgba(80,120,220,0.35)',
            '--viz-secondary': 'rgba(60,80,160,0.2)',
        },
 
        styles: `
            /* VOID II — SHORT (≤180ms), compositional axis added */
 
            /* 1. COMPOSITIONAL: difference blend.
               Light text (#d0d8e8) against near-black (#080809):
               difference = #c8d0df — near-identical to the original.
               BUT with brightness(3): the text value approaches #fff,
               difference of #fff and #080809 = #f7f7f6 — the text
               briefly becomes a bright cutout on an inverted slice.
               Reads as the text momentarily going negative. */
            @keyframes kV2Diff {
                0%  { mix-blend-mode:difference;
                      filter:brightness(3.2) contrast(1.5);
                      opacity:0.88; }
                25% { mix-blend-mode:difference;
                      filter:brightness(1.8); }
                100%{ mix-blend-mode:normal;
                      filter:none;
                      opacity:1; }
            }
 
            /* 2. GEOMETRIC: perspective tilt SHORT.
               Same mechanic as ETHEREAL II but compressed to 160ms.
               At this duration the tilt reads as a snap rather than
               a drift — appropriate for the VOID's cold machine feel. */
            @keyframes kV2Tilt {
                0%  { transform:perspective(240px) rotateX(20deg); opacity:0.7; }
                50% { transform:perspective(240px) rotateX(3deg);  opacity:0.92; }
                100%{ transform:perspective(240px) rotateX(0); opacity:1; }
            }
 
            /* 3. STRUCTURAL: outline contract.
               Outline starts large and collapses inward to zero.
               On the silver/white palette the outline is barely
               visible against the dark bg — reads as a proximity
               field shutting down. */
            @keyframes kV2Outline {
                0%  { outline:1px solid rgba(208,216,232,0.6);
                      outline-offset:12px; opacity:0.8; }
                55% { outline-color:rgba(208,216,232,0.15);
                      outline-offset:2px; }
                100%{ outline:1px solid rgba(208,216,232,0);
                      outline-offset:0; opacity:1; }
            }
 
            /* 4. SPATIAL: pinch — scaleX compress + translateY rise.
               The text squeezes horizontally as it rises.
               Reads as data being compressed before transmission. */
            @keyframes kV2Pinch {
                0%  { transform:translateY(-5px) scaleX(0.82);
                      filter:brightness(1.6); opacity:0.7; }
                55% { transform:translateY(1px)  scaleX(0.98);
                      filter:brightness(1.1); }
                100%{ transform:none; filter:none; opacity:1; }
            }
 
            /* 5. CHROMATIC: invert + hue-rotate SHORT.
               At 160ms the invert reads as a frame dropout.
               The silver text inverts to near-black momentarily —
               the text disappears and reappears. Pure data loss. */
            @keyframes kV2Dropout {
                0%  { filter:invert(0.92) hue-rotate(180deg) brightness(1.4);
                      opacity:0.82; }
                18% { filter:invert(0.5) hue-rotate(60deg); }
                100%{ filter:none; opacity:1; }
            }
 
            .fx-v2-diff    { animation:kV2Diff    0.18s ease-out; }
            .fx-v2-tilt    { animation:kV2Tilt    0.16s ease-out; }
            .fx-v2-outline { animation:kV2Outline 0.17s ease-out; }
            .fx-v2-pinch   { animation:kV2Pinch   0.15s ease-out; }
            .fx-v2-dropout { animation:kV2Dropout 0.16s ease-out; }
        `,
 
        dustColor:  'rgba(160,180,255,0.07)',
        flashColor: 'rgba(200,220,255,0.14)',
 
        effects: [
            { className:'fx-v2-diff',    duration:180, useFlash:true,  useScan:false },
            { className:'fx-v2-tilt',    duration:160, useFlash:false, useScan:false },
            { className:'fx-v2-outline', duration:170, useFlash:true,  useScan:false },
            { className:'fx-v2-pinch',   duration:150, useFlash:false, useScan:false },
            { className:'fx-v2-dropout', duration:160, useFlash:true,  useScan:false },
        ],
    },


    // ── DREAM ────────────────────────────────────────────────────────
    // Soft pastel teal/cyan. LAYER strategy throughout.
    // Overlapping fades accumulate as gentle luminance swell.
    dream: {
        label: 'DREAM',

        cssVars: {
            '--bg-body':       '#030a0e',
            '--bg-container':  'linear-gradient(145deg,#071418,#03080c)',
            '--bg-screen':     '#060e14',
            '--border-screen': '#0d3040',
            '--color-primary': '#7ee8e8',
            '--color-dim':     '#3a8a8a',
            '--color-faint':   '#1a4a4a',
            '--color-muted':   '#0d2828',
            '--shadow-screen': 'inset 0 0 40px rgba(60,180,200,0.05)',
            '--shadow-outer':  '0 0 0 2px #061820,0 20px 50px rgba(0,40,60,0.7)',
            '--bg-stats':      '#040c10',
            '--bg-btn':        '#071418',
            '--border-btn':    '#1a6060',
            '--color-btn':     '#7ecece',
            '--crt-on':        '0',
            '--viz-color':     '#7ee8e8',
            '--viz-glow':      'rgba(100,220,220,0.35)',
            '--viz-secondary': 'rgba(60,160,160,0.2)',
        },

        styles: `
            @keyframes kDreamBloom {
                0%  { mix-blend-mode:screen; filter:brightness(2.4) saturate(1.6); opacity:0.75; }
                45% { mix-blend-mode:screen; filter:brightness(1.5); opacity:0.9; }
                100%{ mix-blend-mode:normal; filter:none; opacity:1; }
            }
            @keyframes kDreamPull {
                0%  { word-spacing:14px; opacity:0.6; }
                55% { word-spacing:4px; }
                100%{ word-spacing:normal; opacity:1; }
            }
            @keyframes kDreamLean {
                0%  { transform:rotateZ(-1.8deg) translateX(-4px); opacity:0.7; }
                60% { transform:rotateZ(0.4deg)  translateX(1px); opacity:0.92; }
                100%{ transform:rotateZ(0)       translateX(0);   opacity:1; }
            }
            @keyframes kDreamGlow {
                0%  { text-shadow:0 0 22px #7ee8e8,0 0 45px #3ab0b0; }
                100%{ text-shadow:0 0 4px #7ee8e8; }
            }
            @keyframes kDreamRipple {
                0%  { letter-spacing:1px; opacity:0.6; }
                100%{ letter-spacing:normal; opacity:1;   }
            }
            .fx-dream-fade   { animation:kDreamBloom  0.24s ease-out; }
            .fx-dream-fog    { animation:kDreamPull   0.28s ease-out; }
            .fx-dream-pulse  { animation:kDreamLean   0.22s ease-out; }
            .fx-dream-glow   { animation:kDreamGlow   0.30s ease-out; }
            .fx-dream-ripple { animation:kDreamRipple 0.20s ease-out; }
        `,

        dustColor:  'rgba(100,220,220,0.10)',
        flashColor: 'rgba(60,200,200,0.13)',

        effects: [
            // LAYER-safe: opacity + blur only, stacks on dense beats
            { className:'fx-dream-fade',   duration:220, useFlash:true,  useScan:false },
            { className:'fx-dream-fog',    duration:250, useFlash:false, useScan:false },
            { className:'fx-dream-pulse',  duration:180, useFlash:true,  useScan:false },
            { className:'fx-dream-glow',   duration:300, useFlash:false, useScan:false },
            { className:'fx-dream-ripple', duration:200, useFlash:true,  useScan:false },
        ],
    },


    // ── DREAM II ───────────────────────────────────────────────────
    // Same teal/cyan palette as DREAM. Mechanical overhaul.
    // DREAM = five luminance effects that feel identical.
    // DREAM II = geometric, compositional, chromatic, structural.
    // word-spacing in px throughout.
    dream_ii: {
        label: 'DREAM II',
 
        cssVars: {
            '--bg-body':       '#030a0e',
            '--bg-container':  'linear-gradient(145deg,#071418,#03080c)',
            '--bg-screen':     '#060e14',
            '--border-screen': '#0d3040',
            '--color-primary': '#7ee8e8',
            '--color-dim':     '#3a8a8a',
            '--color-faint':   '#1a4a4a',
            '--color-muted':   '#0d2828',
            '--shadow-screen': 'inset 0 0 40px rgba(60,180,200,0.05)',
            '--shadow-outer':  '0 0 0 2px #061820,0 20px 50px rgba(0,40,60,0.7)',
            '--bg-stats':      '#040c10',
            '--bg-btn':        '#071418',
            '--border-btn':    '#1a6060',
            '--color-btn':     '#7ecece',
            '--crt-on':        '0',
            '--viz-color':     '#7ee8e8',
            '--viz-glow':      'rgba(100,220,220,0.35)',
            '--viz-secondary': 'rgba(60,160,160,0.2)',
        },
 
        styles: `
            /* DREAM II — teal palette, no luminance-only effects */
 
            /* 1. COMPOSITIONAL: screen blend bloom.
               Teal on near-black via screen blend = aqua luminance
               added to the bg without replacing it. Reads as the
               text briefly becoming part of the background light. */
            @keyframes kD2Bloom {
                0%  { mix-blend-mode:screen;
                      filter:brightness(2.6) saturate(1.5);
                      opacity:0.72; }
                45% { mix-blend-mode:screen;
                      filter:brightness(1.5);
                      opacity:0.9; }
                100%{ mix-blend-mode:normal;
                      filter:none;
                      opacity:1; }
            }
 
            /* 2. SPATIAL: word-spacing pull in px.
               16px = roughly one character width at the clamped
               font size. Spaces breathe open then close.
               Characters never move — only the gaps do. */
            @keyframes kD2Pull {
                0%  { word-spacing:16px; opacity:0.65; }
                55% { word-spacing:5px; }
                100%{ word-spacing:normal; opacity:1; }
            }
 
            /* 3. GEOMETRIC: rotateZ lean with translateX.
               The line arrives leaning left, straightens.
               Reads as a thought that arrived sideways. */
            @keyframes kD2Lean {
                0%  { transform:rotateZ(-2deg) translateX(-5px); opacity:0.68; }
                58% { transform:rotateZ(0.4deg) translateX(1px); opacity:0.92; }
                100%{ transform:none; opacity:1; }
            }
 
            /* 4. GEOMETRIC: downward settle.
               The line drops in from above and lands.
               Weight. Arrival. The opposite of float. */
            @keyframes kD2Settle {
                0%  { transform:translateY(-9px) scaleX(0.96); opacity:0.55; }
                58% { transform:translateY(2px)  scaleX(0.99); opacity:0.9; }
                100%{ transform:none; opacity:1; }
            }
 
            /* 5. CHROMATIC: contrast drain + restore.
               High contrast collapses midtones — text looks briefly
               etched into the background rather than lit.
               Then restores to full teal. */
            @keyframes kD2Drain {
                0%  { filter:contrast(3.5) saturate(0.3) brightness(1.2); opacity:0.75; }
                48% { filter:contrast(1.6) saturate(0.7); }
                100%{ filter:none; opacity:1; }
            }
 
            .fx-d2-bloom  { animation:kD2Bloom  0.26s ease-out; }
            .fx-d2-pull   { animation:kD2Pull   0.30s ease-out; }
            .fx-d2-lean   { animation:kD2Lean   0.24s ease-out; }
            .fx-d2-settle { animation:kD2Settle 0.28s ease-out; }
            .fx-d2-drain  { animation:kD2Drain  0.26s ease-out; }
        `,
 
        dustColor:  'rgba(100,220,220,0.10)',
        flashColor: 'rgba(60,200,200,0.13)',
 
        effects: [
            { className:'fx-d2-bloom',  duration:260, useFlash:true,  useScan:false },
            { className:'fx-d2-pull',   duration:300, useFlash:false, useScan:false },
            { className:'fx-d2-lean',   duration:240, useFlash:false, useScan:false },
            { className:'fx-d2-settle', duration:280, useFlash:true,  useScan:false },
            { className:'fx-d2-drain',  duration:260, useFlash:true,  useScan:false },
        ],
    },


    // ── AURORA ───────────────────────────────────────────────────────
    // Northern lights. Indigo/magenta/teal spectrum.
    // MIXED: SHORT color shifts + LAYER glow swells.
    // flashCycle rotates through flashCycleColors for spectral variety.
    aurora: {
        label: 'AURORA',

        cssVars: {
            '--bg-body':       '#04020c',
            '--bg-container':  'linear-gradient(145deg,#0a0618,#06030e)',
            '--bg-screen':     '#080412',
            '--border-screen': '#2a1548',
            '--color-primary': '#a8d8ff',
            '--color-dim':     '#5070a8',
            '--color-faint':   '#281850',
            '--color-muted':   '#140c30',
            '--shadow-screen': 'inset 0 0 40px rgba(80,40,180,0.06)',
            '--shadow-outer':  '0 0 0 2px #140830,0 20px 60px rgba(20,0,60,0.75)',
            '--bg-stats':      '#060310',
            '--bg-btn':        '#0e0820',
            '--border-btn':    '#3a2070',
            '--color-btn':     '#a0b8e8',
            '--crt-on':        '0',
            '--viz-color':     '#a0b8ff',
            '--viz-glow':      'rgba(120,80,255,0.45)',
            '--viz-secondary': 'rgba(80,40,200,0.2)',
        },

        styles: `
            @keyframes kAuroraShift {
                0%  { text-shadow:0 0 20px #e080ff,0 0 10px #80ffcc; }
                100%{ text-shadow:0 0 4px #a8d8ff; }
            }
            @keyframes kAuroraSweep {
                0%  { opacity:0.55; filter:hue-rotate(60deg) brightness(1.3); }
                100%{ opacity:1;    filter:none; }
            }
            @keyframes kAuroraInvert {
                0%  { filter:invert(0.9) hue-rotate(200deg) brightness(1.6); opacity:0.75; }
                20% { filter:invert(0.4) hue-rotate(80deg); }
                100%{ filter:none; opacity:1; }
            }
            @keyframes kAuroraOrbit {
                0%  { text-shadow: 5px -5px 16px #e080ff, -5px 5px 16px #80ffcc,
                                   0 0 32px #a8d8ff; }
                50% { text-shadow:-5px 5px 10px #e080ff,  5px -5px 10px #80ffcc,
                                   0 0 18px #a8d8ff; }
                100%{ text-shadow:0 0 4px #a8d8ff; }
            }
            @keyframes kAuroraHaze {
                0%  { filter:blur(0.8px) hue-rotate(50deg) brightness(1.25); }
                100%{ filter:none; }
            }
            .fx-aurora-shift   { animation:kAuroraShift   0.22s ease-out; }
            .fx-aurora-sweep   { animation:kAuroraSweep   0.20s ease-out; }
            .fx-aurora-swell   { animation:kAuroraInvert  0.28s ease-out; }
            .fx-aurora-shimmer { animation:kAuroraOrbit   0.26s ease-out; }
            .fx-aurora-haze    { animation:kAuroraHaze    0.28s ease-out; }
        `,

        dustColor:  'rgba(120,100,255,0.10)',
        flashColor: 'rgba(100,80,220,0.18)',
        flashCycle: true,
        flashCycleColors: [
            'rgba(180,80,255,0.20)',
            'rgba(80,200,255,0.16)',
            'rgba(255,80,160,0.16)',
            'rgba(80,255,180,0.13)',
        ],

        effects: [
            // SHORT color-only — safe for dense beats
            { className:'fx-aurora-shift',   duration:220, useFlash:true,  useScan:false },
            { className:'fx-aurora-sweep',   duration:200, useFlash:true,  useScan:false },
            { className:'fx-aurora-shimmer', duration:180, useFlash:true,  useScan:false },
            // LAYER text-shadow — safe to stack
            { className:'fx-aurora-swell',   duration:350, useFlash:false, useScan:false },
            { className:'fx-aurora-haze',    duration:280, useFlash:false, useScan:false },
        ],
    },


    // ── EMBER ────────────────────────────────────────────────────────
    // Warm dark ambient. Deep red/amber smoldering coal.
    // SHORT + LAYER mixed. Rapid red flicker reads as heat shimmer.
    ember: {
        label: 'EMBER',

        cssVars: {
            '--bg-body':       '#080200',
            '--bg-container':  'linear-gradient(145deg,#140800,#0a0400)',
            '--bg-screen':     '#0e0500',
            '--border-screen': '#3a1400',
            '--color-primary': '#ff9040',
            '--color-dim':     '#a04010',
            '--color-faint':   '#501800',
            '--color-muted':   '#2a0c00',
            '--shadow-screen': 'inset 0 0 35px rgba(200,60,0,0.06)',
            '--shadow-outer':  '0 0 0 2px #200800,0 20px 50px rgba(80,10,0,0.7)',
            '--bg-stats':      '#0a0300',
            '--bg-btn':        '#160600',
            '--border-btn':    '#6a2000',
            '--color-btn':     '#e08040',
            '--crt-on':        '0',
            '--viz-color':     '#ff6020',
            '--viz-glow':      'rgba(255,100,20,0.45)',
            '--viz-secondary': 'rgba(180,50,0,0.2)',
        },

        styles: `
            @keyframes kEmberFlare {
                0%  { text-shadow:0 0 28px #ff4000,0 0 50px #ff2000; filter:brightness(1.7); }
                100%{ text-shadow:0 0 4px #ff9040; filter:none; }
            }
            @keyframes kEmberTilt {
                0%  { transform:rotateZ(2.5deg) translateX(3px) scaleY(0.94); filter:brightness(1.5); }
                55% { transform:rotateZ(-0.5deg) translateX(-1px) scaleY(1.01); }
                100%{ transform:none; filter:none; }
            }
            @keyframes kEmberSmolder {
                0%  { letter-spacing:0.5px; text-shadow:0 0 18px #ff6020; }
                100%{ letter-spacing:normal; text-shadow:none; }
            }
            @keyframes kEmberHeat {
                0%  { filter:brightness(1.4) saturate(1.5) blur(0.5px); }
                100%{ filter:none; }
            }
            @keyframes kEmberPulse {
                0%  { opacity:0.5; }
                100%{ opacity:1;   }
            }
            .fx-ember-flare   { animation:kEmberFlare   0.18s ease-out; }
            .fx-ember-char    { animation:kEmberTilt    0.18s ease-out; }
            .fx-ember-smolder { animation:kEmberSmolder 0.22s ease-out; }
            .fx-ember-heat    { animation:kEmberHeat    0.25s ease-out; }
            .fx-ember-pulse   { animation:kEmberPulse   0.16s ease-out; }
        `,

        dustColor:  'rgba(255,120,20,0.16)',
        flashColor: 'rgba(220,80,10,0.22)',

        effects: [
            // SHORT — rapid heat shimmer on dense beats
            { className:'fx-ember-flare',   duration:180, useFlash:true,  useScan:false },
            { className:'fx-ember-char',    duration:200, useFlash:false, useScan:false },
            { className:'fx-ember-smolder', duration:220, useFlash:true,  useScan:false },
            { className:'fx-ember-pulse',   duration:160, useFlash:true,  useScan:false },
            // LAYER — warm filter swell
            { className:'fx-ember-heat',    duration:250, useFlash:false, useScan:false },
        ],
    },


    // ── NEON ────────────────────────────────────────────────────────
    // Cyberpunk. Hot pink / cyan. Aggressive SHORT effects only.
    // Everything at duration ≤ 160ms — reads as hard machine snap.
    // High flash frequency for maximum sync feel at any BPM.
    neon: {
        label: 'NEON',
        cssVars: {
            '--bg-body':       '#050008',
            '--bg-container':  'linear-gradient(145deg,#0c0014,#060008)',
            '--bg-screen':     '#080010',
            '--border-screen': '#5a0060',
            '--color-primary': '#ff2d78',
            '--color-dim':     '#a01050',
            '--color-faint':   '#500030',
            '--color-muted':   '#280018',
            '--shadow-screen': 'inset 0 0 30px rgba(255,0,100,0.06)',
            '--shadow-outer':  '0 0 0 2px #300020,0 20px 50px rgba(120,0,60,0.6)',
            '--bg-stats':      '#060008',
            '--bg-btn':        '#120010',
            '--border-btn':    '#8a0060',
            '--color-btn':     '#ff80b0',
            '--crt-on':        '0',
            '--viz-color':     '#ff2d78',
            '--viz-glow':      'rgba(255,40,120,0.55)',
            '--viz-secondary': 'rgba(0,255,220,0.4)',
            '--crt-color':     'rgba(255,0,100,0.05)',
            '--scan-color':    'rgba(255,0,100,0.15)',
            '--scan-anim':     'kScanWipeNeon 0.2s linear'
        },
        styles: `
            /* All effects have peak at 0% — maximum snap */
            @keyframes kNeonStrike {
                0%  { transform:scaleX(1.12); text-shadow:-5px 0 #00ffdc,5px 0 #ff2d78; filter:brightness(2); }
                60% { transform:scaleX(1.02); }
                100%{ transform:scaleX(1);    text-shadow:0 0 8px #ff2d78; filter:none; }
            }
            @keyframes kNeonSplit {
                0%  { text-shadow:-6px 0 #00ffdc,6px 0 #ff2d78; letter-spacing:0.5px; }
                50% { letter-spacing:0.3px; }
                100%{ text-shadow:0 0 6px #ff2d78; letter-spacing:normal; }
            }
            @keyframes kNeonBuzz {
                0%  { opacity:0.1; } 8%{ opacity:1; } 16%{ opacity:0.15; }
                24% { opacity:1;   } 32%{ opacity:0.2; } 100%{ opacity:1; }
            }
            @keyframes kNeonFlat {
                0%  { transform:scaleY(0.05); filter:brightness(3); }
                25% { transform:scaleY(1.08); }
                100%{ transform:scaleY(1);    filter:none; }
            }
            @keyframes kNeonGhost {
                0%  { text-shadow:0 -4px 0 #00ffdc,0 4px 0 #ff2d78; opacity:0.6; }
                100%{ text-shadow:0 0 6px #ff2d78; opacity:1; }
            }
            @keyframes kScanWipeNeon {
                0%{ background-position:0 -100%; } 100%{ background-position:0 200%; }
            }
            .fx-neon-strike { animation:kNeonStrike 0.14s ease-out; }
            .fx-neon-split  { animation:kNeonSplit  0.16s ease-out; }
            .fx-neon-buzz   { animation:kNeonBuzz   0.12s linear; }
            .fx-neon-flat   { animation:kNeonFlat   0.13s ease-out; }
            .fx-neon-ghost  { animation:kNeonGhost  0.15s ease-out; }
        `,
        dustColor:  'rgba(255,40,120,0.20)',
        flashColor: 'rgba(255,20,100,0.35)',
        effects: [
            { className:'fx-neon-strike', duration:140, useFlash:true,  useScan:false },
            { className:'fx-neon-split',  duration:160, useFlash:false, useScan:false },
            { className:'fx-neon-buzz',   duration:120, useFlash:true,  useScan:false },
            { className:'fx-neon-flat',   duration:130, useFlash:true,  useScan:false },
            { className:'fx-neon-ghost',  duration:150, useFlash:false, useScan:false },
        ],
    },


    // ── MIDNIGHT ───────────────────────────────────────────────────
    // Deep blue jazz club. Warm shadow, slow swing.
    // Effects: medium-speed (180-280ms) — suited to 70-100 BPM swing.
    // Uses instant-peak glow bursts + subtle position shifts.
    midnight: {
        label: 'MIDNIGHT',
        cssVars: {
            '--bg-body':       '#01030a',
            '--bg-container':  'linear-gradient(145deg,#050d1a,#020810)',
            '--bg-screen':     '#040c18',
            '--border-screen': '#0d2040',
            '--color-primary': '#60a8e8',
            '--color-dim':     '#2a5070',
            '--color-faint':   '#102030',
            '--color-muted':   '#081018',
            '--shadow-screen': 'inset 0 0 40px rgba(30,80,160,0.06)',
            '--shadow-outer':  '0 0 0 2px #050f20,0 20px 60px rgba(0,10,30,0.8)',
            '--bg-stats':      '#030a14',
            '--bg-btn':        '#060e1c',
            '--border-btn':    '#1a4060',
            '--color-btn':     '#6090c0',
            '--crt-on':        '0',
            '--viz-color':     '#4888d0',
            '--viz-glow':      'rgba(60,120,220,0.4)',
            '--viz-secondary': 'rgba(40,80,160,0.2)',
        },
        styles: `
            /* Warm blue glow — instant peak, slow decay to dark */
            @keyframes kMidnightGlow {
                0%  { text-shadow:0 0 24px #80c8ff,0 0 50px #4080c0; }
                100%{ text-shadow:0 0 4px #60a8e8; }
            }
            @keyframes kMidnightDip {
                0%  { transform:translateY(3px); opacity:0.55; filter:brightness(0.6); }
                100%{ transform:translateY(0);   opacity:1;   filter:none; }
            }
            @keyframes kMidnightBlue {
                0%  { filter:saturate(2.5) brightness(1.5); }
                100%{ filter:none; }
            }
            @keyframes kMidnightWaver {
                0%  { letter-spacing:0.5px; opacity:0.65; }
                50% { letter-spacing:0.3px; }
                100%{ letter-spacing:normal; opacity:1; }
            }
            @keyframes kMidnightCool {
                0%  { text-shadow:0 0 30px #a0d0ff; opacity:0.7; }
                60% { text-shadow:0 0 10px #60a8e8; }
                100%{ text-shadow:0 0 3px #4080c0; opacity:1; }
            }
            .fx-midnight-glow  { animation:kMidnightGlow  0.28s ease-out; }
            .fx-midnight-dip   { animation:kMidnightDip   0.22s ease-out; }
            .fx-midnight-blue  { animation:kMidnightBlue  0.20s ease-out; }
            .fx-midnight-waver { animation:kMidnightWaver 0.26s ease-out; }
            .fx-midnight-cool  { animation:kMidnightCool  0.32s ease-out; }
        `,
        dustColor:  'rgba(60,120,220,0.10)',
        flashColor: 'rgba(40,100,200,0.18)',
        effects: [
            { className:'fx-midnight-glow',  duration:280, useFlash:true,  useScan:false },
            { className:'fx-midnight-dip',   duration:220, useFlash:false, useScan:false },
            { className:'fx-midnight-blue',  duration:200, useFlash:true,  useScan:false },
            { className:'fx-midnight-waver', duration:260, useFlash:false, useScan:false },
            { className:'fx-midnight-cool',  duration:320, useFlash:true,  useScan:false },
        ],
    },


    // ── ACID ───────────────────────────────────────────────────────
    // Toxic yellow-green. Distortion-heavy. Aggressive and unstable.
    // Short/medium effects — works at high BPM and dense beats.
    // Inspired by 90s rave visuals and acid house aesthetics.
    acid: {
        label: 'ACID',
        cssVars: {
            '--bg-body':       '#020800',
            '--bg-container':  'linear-gradient(145deg,#060e00,#030800)',
            '--bg-screen':     '#060c00',
            '--border-screen': '#2a4a00',
            '--color-primary': '#ccff00',
            '--color-dim':     '#6a8800',
            '--color-faint':   '#304000',
            '--color-muted':   '#182000',
            '--shadow-screen': 'inset 0 0 30px rgba(160,220,0,0.05)',
            '--shadow-outer':  '0 0 0 2px #182200,0 20px 50px rgba(40,60,0,0.7)',
            '--bg-stats':      '#040a00',
            '--bg-btn':        '#081000',
            '--border-btn':    '#486000',
            '--color-btn':     '#aadd00',
            '--crt-on':        '1',
            '--viz-color':     '#aaff00',
            '--viz-glow':      'rgba(160,255,0,0.5)',
            '--viz-secondary': 'rgba(100,200,0,0.25)',
            '--crt-color':     'rgba(160,220,0,0.06)',
            '--scan-color':    'rgba(160,220,0,0.2)',
            '--scan-anim':     'kScanWipeAcid 0.2s linear'
        },
        styles: `
            /* Acid: everything distorted at 0%, resolves to normal */
            @keyframes kAcidMelt {
                0%  { transform:skewX(-8deg) scaleY(0.88); filter:hue-rotate(80deg) brightness(1.8); }
                50% { transform:skewX(3deg)  scaleY(1.03); filter:hue-rotate(20deg); }
                100%{ transform:none; filter:none; }
            }
            @keyframes kAcidSplat {
                0%  { transform:scale(1.15,0.75); text-shadow:0 0 30px #ccff00,0 0 60px #88ff00; }
                60% { transform:scale(0.98,1.02); }
                100%{ transform:none; text-shadow:0 0 5px #ccff00; }
            }
            @keyframes kAcidStrobe {
                0%  { opacity:0; } 6%{ opacity:1; } 12%{ opacity:0.1; }
                18% { opacity:1; } 24%{ opacity:0.05; } 100%{ opacity:1; }
            }
            @keyframes kAcidTwitch {
                0%  { transform:translate(4px,-2px); filter:brightness(2.5); }
                25% { transform:translate(-3px,1px); }
                50% { transform:translate(2px,-1px); filter:brightness(1.2); }
                75% { transform:translate(-1px,2px); }
                100%{ transform:none; filter:none; }
            }
            @keyframes kAcidBurn {
                0%  { filter:sepia(1) hue-rotate(60deg) brightness(2); opacity:0.6; }
                100%{ filter:none; opacity:1; }
            }
            @keyframes kScanWipeAcid {
                0%{ background-position:0 -100%; } 100%{ background-position:0 200%; }
            }
            .fx-acid-melt   { animation:kAcidMelt   0.22s ease-out; }
            .fx-acid-splat  { animation:kAcidSplat  0.18s ease-out; }
            .fx-acid-strobe { animation:kAcidStrobe 0.15s linear; }
            .fx-acid-twitch { animation:kAcidTwitch 0.16s ease-out; }
            .fx-acid-burn   { animation:kAcidBurn   0.20s ease-out; }
        `,
        dustColor:  'rgba(160,255,0,0.18)',
        flashColor: 'rgba(140,220,0,0.30)',
        effects: [
            { className:'fx-acid-melt',   duration:220, useFlash:true,  useScan:true  },
            { className:'fx-acid-splat',  duration:180, useFlash:true,  useScan:false },
            { className:'fx-acid-strobe', duration:150, useFlash:true,  useScan:false },
            { className:'fx-acid-twitch', duration:160, useFlash:false, useScan:true  },
            { className:'fx-acid-burn',   duration:200, useFlash:false, useScan:false },
        ],
    },


    // ── CHROME ─────────────────────────────────────────────────────
    // Metallic silver. Clean, geometric, precise.
    // Minimal effects — works for lo-fi, hip-hop instrumentals,
    // anything where cleanliness matters more than chaos.
    chrome: {
        label: 'CHROME',
        cssVars: {
            '--bg-body':       '#060608',
            '--bg-container':  'linear-gradient(145deg,#0e0e12,#080810)',
            '--bg-screen':     '#0c0c10',
            '--border-screen': '#303040',
            '--color-primary': '#d8dce8',
            '--color-dim':     '#7880a0',
            '--color-faint':   '#303848',
            '--color-muted':   '#181c28',
            '--shadow-screen': 'inset 0 0 30px rgba(160,170,220,0.04)',
            '--shadow-outer':  '0 0 0 1px #202030,0 20px 50px rgba(0,0,10,0.8)',
            '--bg-stats':      '#08080e',
            '--bg-btn':        '#0e0e18',
            '--border-btn':    '#404060',
            '--color-btn':     '#a0a8c8',
            '--crt-on':        '0',
            '--viz-color':     '#b0b8d8',
            '--viz-glow':      'rgba(160,170,220,0.35)',
            '--viz-secondary': 'rgba(100,110,160,0.2)',
        },
        styles: `
            /* Chrome: clean, precise. Instant brightness at 0%. */
            @keyframes kChromeShine {
                0%  { filter:brightness(2.2) contrast(1.3); text-shadow:0 0 20px #ffffff; }
                100%{ filter:none; text-shadow:0 0 3px #d8dce8; }
            }
            @keyframes kChromeEdge {
                0%  { text-shadow:2px 0 #fff,-2px 0 #a0a8c8; letter-spacing:0.5px; }
                100%{ text-shadow:0 0 3px #d8dce8; letter-spacing:normal; }
            }
            @keyframes kChromeCut {
                0%  { clip-path:inset(0 50% 0 0); filter:brightness(1.8); }
                40% { clip-path:inset(0 0% 0 0);  filter:brightness(1.2); }
                100%{ filter:none; }
            }
            @keyframes kChromePulse {
                0%  { opacity:0.3; transform:scale(1.04); }
                100%{ opacity:1;   transform:scale(1); }
            }
            @keyframes kChromeFlat {
                0%  { transform:scaleY(0.08); filter:brightness(3) contrast(2); }
                30% { transform:scaleY(1.04); filter:brightness(1.2); }
                100%{ transform:scaleY(1);    filter:none; }
            }
            .fx-chrome-shine { animation:kChromeShine 0.20s ease-out; }
            .fx-chrome-edge  { animation:kChromeEdge  0.22s ease-out; }
            .fx-chrome-cut   { animation:kChromeCut   0.18s ease-out; }
            .fx-chrome-pulse { animation:kChromePulse 0.16s ease-out; }
            .fx-chrome-flat  { animation:kChromeFlat  0.14s ease-out; }
        `,
        dustColor:  'rgba(160,170,220,0.07)',
        flashColor: 'rgba(200,210,240,0.18)',
        effects: [
            { className:'fx-chrome-shine', duration:200, useFlash:true,  useScan:false },
            { className:'fx-chrome-edge',  duration:220, useFlash:false, useScan:false },
            { className:'fx-chrome-cut',   duration:180, useFlash:true,  useScan:false },
            { className:'fx-chrome-pulse', duration:160, useFlash:false, useScan:false },
            { className:'fx-chrome-flat',  duration:140, useFlash:true,  useScan:false },
        ],
    },


    // ── TERMINAL ─────────────────────────────────────────────────────
    // Amber/green hacker terminal. Vintage phosphor monitor feel.
    //   - Dense beat zones: SHORT transforms (≤140ms) — clean snap per hit
    //   - Spoken word zones: LAYER text-shadow only — glow swell on sparse beats
    //
    // The amber color reads as "late night, one terminal open, nobody else awake."
    terminal: {
        label: 'TERMINAL',

        cssVars: {
            '--bg-body':       '#030200',
            '--bg-container':  'linear-gradient(145deg,#0a0800,#060500)',
            '--bg-screen':     '#090700',
            '--border-screen': '#3a2800',
            '--color-primary': '#ffb020',
            '--color-dim':     '#886010',
            '--color-faint':   '#402800',
            '--color-muted':   '#201400',
            '--shadow-screen': 'inset 0 0 30px rgba(200,130,0,0.06)',
            '--shadow-outer':  '0 0 0 2px #201000,0 20px 50px rgba(60,30,0,0.7)',
            '--bg-stats':      '#070500',
            '--bg-btn':        '#100800',
            '--border-btn':    '#604000',
            '--color-btn':     '#e09030',
            '--crt-on':        '1',
            '--viz-color':     '#ffb020',
            '--viz-glow':      'rgba(255,160,20,0.45)',
            '--viz-secondary': 'rgba(180,100,0,0.22)',
            '--crt-color':     'rgba(255,160,20,0.05)',
            '--scan-color':    'rgba(255,160,20,0.16)',
            '--scan-anim':     'kTermScan 0.22s linear'
        },

        styles: `
            /* TERMINAL effects — instant peak at 0% on all keyframes */

            /* SHORT: hard snap for dense beats */
            @keyframes kTermSnap {
                0%  { transform:translate(0,0) scaleX(1.06);
                      text-shadow:-3px 0 #ff6000,3px 0 #ffee00;
                      filter:brightness(1.8); }
                40% { transform:translate(0,0) scaleX(1); }
                100%{ text-shadow:0 0 4px #ffb020; filter:none; }
            }
            @keyframes kTermBlink {
                0%  { opacity:0.05; } 10%{ opacity:1; } 20%{ opacity:0.1; }
                35% { opacity:1; }   55%{ opacity:0.4; } 100%{ opacity:1; }
            }
            /* LAYER: breathing glow for sparse/spoken sections — safe to stack */
            @keyframes kTermGlow {
                0%  { text-shadow:0 0 20px #ffb020,0 0 40px #ff6000; }
                100%{ text-shadow:0 0 4px #ffb020; }
            }
            @keyframes kTermFade {
                0%  { opacity:0.3; filter:brightness(0.5) sepia(0.6); }
                100%{ opacity:1;   filter:none; }
            }
            /* SHORT: scan pulse — crt-on only */
            @keyframes kTermPulse {
                0%  { letter-spacing:0.8px; filter:brightness(1.6); opacity:0.7; }
                100%{ letter-spacing:normal; filter:none; opacity:1; }
            }
            @keyframes kTermScan {
                0%{ background-position:0 -100%; } 100%{ background-position:0 200%; }
            }
            .fx-term-snap   { animation:kTermSnap   0.13s ease-out; }
            .fx-term-blink  { animation:kTermBlink  0.14s linear; }
            .fx-term-glow   { animation:kTermGlow   0.32s ease-out; }
            .fx-term-fade   { animation:kTermFade   0.28s ease-out; }
            .fx-term-pulse  { animation:kTermPulse  0.22s ease-out; }
        `,

        dustColor:  'rgba(255,160,20,0.14)',
        flashColor: 'rgba(220,120,0,0.28)',

        effects: [
            // SHORT: dense beat zones
            { className:'fx-term-snap',  duration:130, useFlash:true,  useScan:false  },
            { className:'fx-term-blink', duration:140, useFlash:true,  useScan:false },
            // LAYER: spoken word zones — these stack gracefully on sparse beats
            // { className:'fx-term-glow',  duration:320, useFlash:false, useScan:false },
            { className:'fx-term-fade',  duration:280, useFlash:true,  useScan:false },
            { className:'fx-term-pulse', duration:220, useFlash:false, useScan:false  },
        ],
    },


    // ── STATIC ─────────────────────────────────────────────────────
    // Washed-out white noise. Monochrome. Broken TV energy.
    // Dense zones: aggressive strobe/slice — SHORT, reads as overload.
    // Spoken zones: slow dim + recover — LAYER, reads as signal fading.
    //
    // Very low flash alpha — the screen stays mostly dark.
    // The effect is restraint punctuated by hard cuts.
    static: {
        label: 'STATIC',

        cssVars: {
            '--bg-body':       '#020202',
            '--bg-container':  'linear-gradient(145deg,#080808,#050505)',
            '--bg-screen':     '#060606',
            '--border-screen': '#202020',
            '--color-primary': '#e8e8e0',
            '--color-dim':     '#707068',
            '--color-faint':   '#282820',
            '--color-muted':   '#141410',
            '--shadow-screen': 'inset 0 0 30px rgba(200,200,180,0.03)',
            '--shadow-outer':  '0 0 0 1px #181818,0 20px 50px rgba(0,0,0,0.9)',
            '--bg-stats':      '#040404',
            '--bg-btn':        '#0c0c0c',
            '--border-btn':    '#303030',
            '--color-btn':     '#909080',
            '--crt-on':        '0',
            '--viz-color':     '#c0c0b8',
            '--viz-glow':      'rgba(200,200,180,0.25)',
            '--viz-secondary': 'rgba(140,140,120,0.15)',
        },

        styles: `
            /* STATIC effects — monochrome, broken signal aesthetic */

            /* SHORT: hard cut / signal dropout */
            @keyframes kStaticCut {
                0%  { clip-path:inset(0 0 65% 0); filter:brightness(3) contrast(2); }
                25% { clip-path:inset(55% 0 0 0); filter:brightness(1.5); }
                60% { clip-path:inset(0 0 0 0);   filter:brightness(1.1); }
                100%{ filter:none; }
            }
            @keyframes kStaticNoise {
                0%  { text-shadow:3px 0 #fff,-3px 0 #404040,0 -2px #fff; opacity:0.8; }
                30% { text-shadow:-2px 0 #fff,2px 0 #404040; opacity:0.9; }
                100%{ text-shadow:0 0 2px #e8e8e0; opacity:1; }
            }
            /* LAYER: slow dim — signals the spoken sections */
            @keyframes kStaticDim {
                0%  { opacity:0.2; filter:brightness(0.25); }
                60% { opacity:0.7; }
                100%{ opacity:1;   filter:none; }
            }
            @keyframes kStaticGhost {
                0%  { opacity:0.6; filter:blur(1.2px) contrast(0.6); }
                100%{ opacity:1;   filter:none; }
            }
            /* SHORT: scan-line glitch */
            @keyframes kStaticFlat {
                0%  { transform:scaleY(0.06); filter:brightness(4) invert(0.3); }
                30% { transform:scaleY(1.05); filter:brightness(1.2); }
                100%{ transform:scaleY(1); filter:none; }
            }
            .fx-static-cut   { animation:kStaticCut   0.15s ease-out; }
            .fx-static-noise { animation:kStaticNoise  0.14s ease-out; }
            .fx-static-dim   { animation:kStaticDim    0.30s ease-out; }
            .fx-static-ghost { animation:kStaticGhost  0.26s ease-out; }
            .fx-static-flat  { animation:kStaticFlat   0.12s ease-out; }
        `,

        dustColor:  'rgba(200,200,180,0.05)',
        flashColor: 'rgba(220,220,200,0.10)',

        effects: [
            // SHORT: signal failure
            { className:'fx-static-cut',   duration:150, useFlash:true,  useScan:false },
            { className:'fx-static-noise', duration:140, useFlash:false, useScan:false },
            { className:'fx-static-flat',  duration:120, useFlash:true,  useScan:false },
            // LAYER: signal fade — spoken sections
            { className:'fx-static-dim',   duration:300, useFlash:false, useScan:false },
            { className:'fx-static-ghost', duration:260, useFlash:true,  useScan:false },
        ],
    },

 
    // ── DUSK ─────────────────────────────────────────────────────
    // Warm rose-gold at the boundary between amber and violet.
    // The color of a screen at 3am when you've been coding too long.
    //
    // Use this if the song feels more like a confession than a flex.
    dusk: {
        label: 'DUSK',

        cssVars: {
            '--bg-body':       '#060204',
            '--bg-container':  'linear-gradient(145deg,#100608,#080304)',
            '--bg-screen':     '#0c0406',
            '--border-screen': '#3a1020',
            '--color-primary': '#e88060',
            '--color-dim':     '#804030',
            '--color-faint':   '#401820',
            '--color-muted':   '#201010',
            '--shadow-screen': 'inset 0 0 40px rgba(200,80,60,0.05)',
            '--shadow-outer':  '0 0 0 2px #200810,0 20px 60px rgba(60,10,20,0.75)',
            '--bg-stats':      '#080204',
            '--bg-btn':        '#100408',
            '--border-btn':    '#601828',
            '--color-btn':     '#c07060',
            '--crt-on':        '0',
            '--viz-color':     '#d06040',
            '--viz-glow':      'rgba(220,90,50,0.40)',
            '--viz-secondary': 'rgba(150,50,30,0.20)',
        },

        styles: `
            /* DUSK — all LAYER effects. No transforms.
               Designed for the long spoken-word sections.
               Stacks gracefully regardless of beat density. */

            @keyframes kDuskWarm {
                0%  { text-shadow:0 0 22px #ff8060,0 0 44px #e04020; }
                100%{ text-shadow:0 0 5px #e88060; }
            }
            @keyframes kDuskFade {
                0%  { opacity:0.3; filter:brightness(0.45) saturate(1.8); }
                100%{ opacity:1;   filter:none; }
            }
            @keyframes kDuskBlush {
                0%  { filter:saturate(2.2) brightness(1.5) hue-rotate(-15deg); }
                100%{ filter:none; }
            }
            @keyframes kDuskPulse {
                0%  { opacity:0.5; text-shadow:0 0 30px #ff6040; }
                60% { opacity:0.85; text-shadow:0 0 12px #e88060; }
                100%{ opacity:1;    text-shadow:0 0 4px #e88060; }
            }
            @keyframes kDuskBreath {
                0%  { opacity:0.6; letter-spacing:0.6px; filter:blur(0.6px); }
                100%{ opacity:1;   letter-spacing:normal; filter:none; }
            }
            .fx-dusk-warm   { animation:kDuskWarm   0.35s ease-out; }
            .fx-dusk-fade   { animation:kDuskFade   0.30s ease-out; }
            .fx-dusk-blush  { animation:kDuskBlush  0.24s ease-out; }
            .fx-dusk-pulse  { animation:kDuskPulse  0.32s ease-out; }
            .fx-dusk-breath { animation:kDuskBreath 0.28s ease-out; }
        `,

        dustColor:  'rgba(220,90,60,0.12)',
        flashColor: 'rgba(200,70,40,0.18)',

        effects: [
            // All LAYER — stacks on dense beats, breathes on sparse ones
            // { className:'fx-dusk-warm',   duration:350, useFlash:true,  useScan:false },
            { className:'fx-dusk-fade',   duration:300, useFlash:false, useScan:false },
            { className:'fx-dusk-blush',  duration:240, useFlash:true,  useScan:false },
            { className:'fx-dusk-pulse',  duration:320, useFlash:true,  useScan:false },
            { className:'fx-dusk-breath', duration:280, useFlash:false, useScan:false },
        ],
    },


    // ── DUSK II ───────────────────────────────────────────────────────────
    // Direct evolution of DUSK. Same palette (rose-gold/warm red),
    // fx-dusk-warm removed per direction. MY FAVORITE
    //
    // New mechanics introduced here that exist nowhere else in the codebase:
    //   - word-spacing expand (different from letter-spacing — spaces pull
    //     apart while characters stay tight)
    //   - filter: drop-shadow() vs text-shadow — follows glyph contours
    //   - perspective() rotateX() — 3D tilt on the text plane
    //   - outline pulse — grows outward from text boundary, zero fill-rate cost
    //
    // All LAYER — no transforms that would collide on dense beats.
    dusk_ii: {
        label: 'DUSK II',

        cssVars: {
            '--bg-body':       '#060204',
            '--bg-container':  'linear-gradient(145deg,#100608,#080304)',
            '--bg-screen':     '#0c0406',
            '--border-screen': '#3a1020',
            '--color-primary': '#e88060',
            '--color-dim':     '#804030',
            '--color-faint':   '#401820',
            '--color-muted':   '#201010',
            '--shadow-screen': 'inset 0 0 40px rgba(200,80,60,0.05)',
            '--shadow-outer':  '0 0 0 2px #200810,0 20px 60px rgba(60,10,20,0.75)',
            '--bg-stats':      '#080204',
            '--bg-btn':        '#100408',
            '--border-btn':    '#601828',
            '--color-btn':     '#c07060',
            '--crt-on':        '0',
            '--viz-color':     '#d06040',
            '--viz-glow':      'rgba(220,90,50,0.40)',
            '--viz-secondary': 'rgba(150,50,30,0.20)',
        },

        styles: `
            /* word-spacing expand: spaces between words pull apart,
               characters stay tight. Different spatial reading from letter-spacing.
               Reads as the sentence inhaling before it speaks. */
            @keyframes kDuskWordPull {
                0%  { word-spacing:18px; opacity:0.65; }
                60% { word-spacing:5px; }
                100%{ word-spacing:normal; opacity:1; }
            }

            /* filter: drop-shadow() — follows actual glyph contours including
               descenders and ascenders. Visually different from text-shadow
               which approximates a rectangle. More organic glow shape. */
            @keyframes kDuskDrop {
                0%  { filter:drop-shadow(0 0 18px #ff6040) drop-shadow(0 0 36px #e03010) brightness(1.4); }
                100%{ filter:none; }
            }

            /* perspective() rotateX() — 3D tilt on the text plane.
               Reads as the line tipping forward toward the viewer then
               settling. Zero fill-rate cost — GPU transform only.
               perspective() value controls depth intensity. */
            @keyframes kDuskTilt {
                0%  { transform:perspective(300px) rotateX(18deg); opacity:0.7; }
                60% { transform:perspective(300px) rotateX(3deg);  opacity:0.9; }
                100%{ transform:perspective(300px) rotateX(0deg);  opacity:1; }
            }

            /* outline pulse — outline grows outward from the text boundary
               and fades. outline is not a fill — the GPU draws it on the
               stacking context without affecting layout or triggering reflow.
               Has no equivalent in any other preset. */
            @keyframes kDuskOutline {
                0%  { outline: 2px solid rgba(232,128,96,0.7);
                      outline-offset: 8px;
                      opacity:0.75; }
                60% { outline-offset: 3px;
                      outline-color: rgba(232,128,96,0.3); }
                100%{ outline: 2px solid rgba(232,128,96,0);
                      outline-offset: 0px;
                      opacity:1; }
            }

            /* opacity with steps() timing — binary frame-skipping.
               Not a smooth fade. The text flickers between fully visible
               states with no in-between, reads as a frame-rate drop or
               signal stutter. Entirely different feel from kDuskFade. */
            @keyframes kDuskStep {
                0%  { opacity:1; }
                10% { opacity:0; }
                20% { opacity:1; }
                35% { opacity:0; }
                50% { opacity:1; }
                70% { opacity:0.6; }
                100%{ opacity:1; }
            }

            .fx-dusk-word-pull { animation:kDuskWordPull 0.32s ease-out; }
            .fx-dusk-drop      { animation:kDuskDrop     0.30s ease-out; }
            .fx-dusk-tilt      { animation:kDuskTilt     0.28s ease-out; }
            .fx-dusk-outline   { animation:kDuskOutline  0.36s ease-out; }
            .fx-dusk-step      { animation:kDuskStep     0.24s steps(1,end); }
        `,

        dustColor:  'rgba(220,90,60,0.12)',
        flashColor: 'rgba(200,70,40,0.18)',

        effects: [
            { className:'fx-dusk-word-pull', duration:320, useFlash:false, useScan:false },
            { className:'fx-dusk-drop',      duration:300, useFlash:true,  useScan:false },
            { className:'fx-dusk-tilt',      duration:280, useFlash:false, useScan:false },
            { className:'fx-dusk-outline',   duration:360, useFlash:true,  useScan:false },
            { className:'fx-dusk-step',      duration:240, useFlash:false, useScan:false },
        ],
    },


    // ── DUSK III ───────────────────────────────────────────────────────
    // Dusk palette shifted cooler — rose-gold pulls toward dusty mauve.
    // The difference: DUSK/II feel like heat. DUSK_III feels like the
    // moment after the heat, when the room has gone quiet.
    //
    // New mechanics:
    //   - background-clip: text color wash — animates a gradient across
    //     the glyphs. Only possible because the template uses a dark bg.
    //     The text color transitions through a spectrum mid-animation.
    //   - mix-blend-mode shift — changes compositor blend mode briefly.
    //     'screen' on a dark bg makes the text add light to the bg instead
    //     of replacing it. Creates a blooming effect with no extra draws.
    //   - multi-axis: translateY + scaleX simultaneously (different from
    //     kFloat which is scaleX+Y uniform, or kDrift which is Y only).
    //     Horizontal compression while rising = pinched float.
    dusk_iii: {
        label: 'DUSK III',

        cssVars: {
            '--bg-body':       '#050205',
            '--bg-container':  'linear-gradient(145deg,#0c0610,#070308)',
            '--bg-screen':     '#0a0410',
            '--border-screen': '#2e1035',
            '--color-primary': '#c87898',
            '--color-dim':     '#6a3850',
            '--color-faint':   '#341828',
            '--color-muted':   '#1a0c14',
            '--shadow-screen': 'inset 0 0 40px rgba(180,60,100,0.05)',
            '--shadow-outer':  '0 0 0 2px #180810,0 20px 60px rgba(50,5,25,0.78)',
            '--bg-stats':      '#080210',
            '--bg-btn':        '#0e0418',
            '--border-btn':    '#501828',
            '--color-btn':     '#b06878',
            '--crt-on':        '0',
            '--viz-color':     '#b05870',
            '--viz-glow':      'rgba(190,80,110,0.38)',
            '--viz-secondary': 'rgba(120,40,65,0.20)',
        },

        styles: `
            /* DUSK III — cooler mauve palette, novel compositor mechanics */

            /* background-clip: text color wash.
               Animates a gradient painted behind the text, visible only
               through the transparent glyph shapes. The text acts as a mask.
               Has zero equivalents in any other preset in this file. */
            @keyframes kDuskWash {
                0%  { background: linear-gradient(90deg, #ff8080 0%, #c878a8 50%, #8060d0 100%);
                      -webkit-background-clip: text;
                      background-clip: text;
                      color: transparent;
                      opacity:0.85; }
                70% { background: linear-gradient(90deg, #e09090 0%, #c878a8 100%);
                      -webkit-background-clip: text;
                      background-clip: text;
                      color: transparent; }
                100%{ background: none;
                      -webkit-background-clip: unset;
                      background-clip: unset;
                      color: var(--color-primary);
                      opacity:1; }
            }

            /* mix-blend-mode: screen — text adds to background luminance
               instead of replacing it. On a near-black bg the effect is
               a bloom: the text glows without a separate shadow draw.
               Costs nothing — compositor operation only. */
            @keyframes kDuskBloom {
                0%  { mix-blend-mode:screen; filter:brightness(2.2); opacity:0.8; }
                50% { mix-blend-mode:screen; filter:brightness(1.4); opacity:0.9; }
                100%{ mix-blend-mode:normal; filter:none; opacity:1; }
            }

            /* pinched float: translateY up + scaleX compress simultaneously.
               The line squeezes horizontally as it rises — different spatial
               reading from kFloat (uniform scale) or kDrift (Y only).
               Reads as a word that's trying to fit into a smaller space mid-flight. */
            @keyframes kDuskPinch {
                0%  { transform:translateY(-6px) scaleX(0.88); opacity:0.7; }
                60% { transform:translateY(-1px) scaleX(0.98); opacity:0.9; }
                100%{ transform:translateY(0)   scaleX(1);    opacity:1; }
            }

            /* filter: contrast() spike — high contrast collapses midtones,
               makes the text look briefly like it's printed on the bg rather
               than lit from behind. Different from brightness which just adds light. */
            @keyframes kDuskContrast {
                0%  { filter:contrast(3) saturate(0.4); opacity:0.7; }
                50% { filter:contrast(1.5) saturate(0.8); }
                100%{ filter:none; opacity:1; }
            }

            /* slow opacity hold then drop — the line exists at full brightness,
               then dips briefly before recovering. Reads as a second thought.
               Intentionally unsettling timing. */
            @keyframes kDuskDoubt {
                0%  { opacity:1; }
                40% { opacity:1; }
                60% { opacity:0.25; filter:blur(0.5px); }
                100%{ opacity:1; filter:none; }
            }

            .fx-dusk-wash     { animation:kDuskWash     0.38s ease-out; }
            .fx-dusk-bloom    { animation:kDuskBloom    0.30s ease-out; }
            .fx-dusk-pinch    { animation:kDuskPinch    0.26s ease-out; }
            .fx-dusk-contrast { animation:kDuskContrast 0.28s ease-out; }
            .fx-dusk-doubt    { animation:kDuskDoubt    0.42s ease-in-out; }
        `,

        dustColor:  'rgba(180,80,110,0.10)',
        flashColor: 'rgba(160,60,90,0.16)',

        effects: [
            { className:'fx-dusk-wash',     duration:380, useFlash:false, useScan:false },
            { className:'fx-dusk-bloom',    duration:300, useFlash:true,  useScan:false },
            { className:'fx-dusk-pinch',    duration:260, useFlash:false, useScan:false },
            { className:'fx-dusk-contrast', duration:280, useFlash:true,  useScan:false },
            { className:'fx-dusk-doubt',    duration:420, useFlash:false, useScan:false },
        ],
    },


    // ── DUSK IV ───────────────────────────────────────────────────────
    // Dusk palette shifted warmer — amber-gold instead of rose-gold.
    // Closer to TERMINAL without the CRT. No scanlines, no phosphor.
    // Just warm light in a dark room.
    //
    // New mechanics:
    //   - text-shadow multi-color counter-rotation — two shadows orbit
    //     in opposite directions around the text. One clockwise offset,
    //     one counter-clockwise. Creates a halo that breathes.
    //   - filter: invert() partial — briefly inverts the text against
    //     the dark bg, making it look like a negative for one frame.
    //   - translateX + rotateZ simultaneously — horizontal slide with
    //     a slight lean, like a word that arrived off-balance.
    //   - opacity in steps() with uneven intervals — not binary like
    //     kDuskStep, but an unsteady rhythm that feels like breathing
    //     through interference.
    dusk_iv: {
        label: 'DUSK IV',

        cssVars: {
            '--bg-body':       '#040300',
            '--bg-container':  'linear-gradient(145deg,#0a0700,#060400)',
            '--bg-screen':     '#080500',
            '--border-screen': '#382000',
            '--color-primary': '#e8a040',
            '--color-dim':     '#805010',
            '--color-faint':   '#402000',
            '--color-muted':   '#201000',
            '--shadow-screen': 'inset 0 0 40px rgba(210,130,0,0.05)',
            '--shadow-outer':  '0 0 0 2px #1e1000,0 20px 60px rgba(55,25,0,0.75)',
            '--bg-stats':      '#060300',
            '--bg-btn':        '#0e0600',
            '--border-btn':    '#5a2800',
            '--color-btn':     '#c08030',
            '--crt-on':        '0',
            '--viz-color':     '#c07820',
            '--viz-glow':      'rgba(210,130,20,0.42)',
            '--viz-secondary': 'rgba(140,75,0,0.20)',
        },

        styles: `
            /* DUSK IV — amber-gold, novel shadow + transform mechanics */

            /* Counter-rotating text-shadow halo.
               Two shadows: one offset up-right, one offset down-left.
               They swap positions over the animation duration, creating
               a halo that appears to rotate around the glyphs. */
            @keyframes kDuskOrbit {
                0%  { text-shadow: 4px -4px 18px #ff9040, -4px 4px 18px #ffe060,
                                   0 0 40px #e8a040; }
                50% { text-shadow: -4px 4px 12px #ff9040, 4px -4px 12px #ffe060,
                                   0 0 20px #e8a040; }
                100%{ text-shadow: 0 0 5px #e8a040; }
            }

            /* filter: invert() + hue-rotate — briefly renders the text
               as a negative image (light text becomes dark cutout on a
               briefly inverted bg-colored glow), then snaps back.
               Visually: the text goes "hollow" for a frame. */
            @keyframes kDuskInvert {
                0%  { filter:invert(0.85) hue-rotate(30deg) brightness(1.5); opacity:0.8; }
                15% { filter:invert(0.4)  hue-rotate(10deg); }
                100%{ filter:none; opacity:1; }
            }

            /* horizontal slide + rotateZ lean simultaneously.
               The line enters from slightly left, leaning clockwise,
               then straightens as it settles. Different from kDrift (Y)
               or kPinch (Y + scaleX). This one has attitude. */
            @keyframes kDuskSlide {
                0%  { transform:translateX(-8px) rotateZ(-1.5deg); opacity:0.65; }
                60% { transform:translateX(1px)  rotateZ(0.3deg);  opacity:0.9; }
                100%{ transform:translateX(0)    rotateZ(0);        opacity:1; }
            }

            /* Unsteady opacity — not steps(), not smooth. Four distinct
               levels with abrupt jumps between them. Feels like a signal
               that can't make up its mind whether it's present or not. */
            @keyframes kDuskUnsteady {
                0%  { opacity:0.9; }
                15% { opacity:0.2; }
                30% { opacity:0.8; }
                50% { opacity:0.35; }
                70% { opacity:0.95; }
                85% { opacity:0.6; }
                100%{ opacity:1; }
            }

            /* word-spacing + color shift together — words spread while the
               color warms from white-hot back to amber. The spreading and
               the cooling happen at the same rate. */
            @keyframes kDuskSpread {
                0%  { word-spacing:16px; color:#ffe0a0; filter:brightness(1.8); }
                60% { word-spacing:4px; color:#f0b060; }
                100%{ word-spacing:normal; color:var(--color-primary); filter:none; }
            }

            .fx-dusk-orbit    { animation:kDuskOrbit    0.34s ease-out; }
            .fx-dusk-invert   { animation:kDuskInvert   0.22s ease-out; }
            .fx-dusk-slide    { animation:kDuskSlide    0.28s ease-out; }
            .fx-dusk-unsteady { animation:kDuskUnsteady 0.32s linear; }
            .fx-dusk-spread   { animation:kDuskSpread   0.30s ease-out; }
        `,

        dustColor:  'rgba(210,130,20,0.13)',
        flashColor: 'rgba(190,110,10,0.20)',

        effects: [
            { className:'fx-dusk-orbit',    duration:340, useFlash:false, useScan:false },
            { className:'fx-dusk-invert',   duration:220, useFlash:true,  useScan:false },
            { className:'fx-dusk-slide',    duration:280, useFlash:false, useScan:false },
            { className:'fx-dusk-unsteady', duration:320, useFlash:true,  useScan:false },
            { className:'fx-dusk-spread',   duration:300, useFlash:false, useScan:false },
        ],
    },


    // ── DUSK V ───────────────────────────────────────────────────────
    // Dusk palette at its darkest — near-black with barely-visible
    // crimson. Designed for the long spoken sections specifically.
    // Very low flash alpha. Very long animation durations (320–480ms).
    // On the dense beat zones earlier in the track this will feel
    // slow — that's intentional. The preset is tuned for 118–185s.
    //
    // New mechanics:
    //   - text-shadow single long-distance offset — shadow cast far
    //     from the text, creating a "ghost standing behind the words."
    //   - filter: opacity() inside filter chain — different from
    //     globalAlpha; applies to the element including its shadow.
    //   - translateY down (not up) — the line settles INTO the frame
    //     from above, gravity-weighted. All other Y animations rise.
    //   - filter: grayscale() partial — drains color from the text
    //     then restores it. The words go briefly colorless.
    //   - CSS variable animation via @property — not available without
    //     registering properties. Skip. Use direct color instead.
    //   - letter-spacing + translateX simultaneously — the characters
    //     spread outward from centre while the whole line drifts left.
    //     Creates the illusion of the text breaking apart spatially.
    dusk_v: {
        label: 'DUSK V',

        cssVars: {
            '--bg-body':       '#040101',
            '--bg-container':  'linear-gradient(145deg,#0a0303,#060202)',
            '--bg-screen':     '#080202',
            '--border-screen': '#2a0808',
            '--color-primary': '#c05040',
            '--color-dim':     '#602020',
            '--color-faint':   '#300e0e',
            '--color-muted':   '#180808',
            '--shadow-screen': 'inset 0 0 50px rgba(160,40,30,0.04)',
            '--shadow-outer':  '0 0 0 2px #160606,0 20px 60px rgba(40,5,5,0.85)',
            '--bg-stats':      '#060101',
            '--bg-btn':        '#0e0404',
            '--border-btn':    '#481010',
            '--color-btn':     '#a04030',
            '--crt-on':        '0',
            '--viz-color':     '#a03828',
            '--viz-glow':      'rgba(180,55,40,0.35)',
            '--viz-secondary': 'rgba(100,25,18,0.18)',
        },

        styles: `
            /* DUSK V — darkest variant, tuned for spoken sections */

            /* Long-distance offset shadow — the shadow is cast 12px from
               the text rather than directly behind it. Reads as a second
               version of the words standing slightly behind the first.
               A ghost of the sentence. */
            @keyframes kDuskShadowCast {
                0%  { text-shadow:12px 8px 0 rgba(192,80,64,0.5),
                                  0 0 30px rgba(192,80,64,0.6); opacity:0.8; }
                60% { text-shadow:4px 3px 0 rgba(192,80,64,0.2),
                                  0 0 10px rgba(192,80,64,0.3); }
                100%{ text-shadow:0 0 4px #c05040; opacity:1; }
            }

            /* translateY down — the line drops INTO the frame from above,
               settles with gravity. Every other Y animation in this codebase
               rises (translateY negative). This is the only one that falls.
               Reads as weight, as arrival, as landing. */
            @keyframes kDuskSettle {
                0%  { transform:translateY(-10px); opacity:0.5; }
                55% { transform:translateY(2px);   opacity:0.9; }
                100%{ transform:translateY(0);     opacity:1; }
            }

            /* filter: grayscale() — color drains from the text, then fills
               back in. The words go briefly colorless — like a memory that
               loses its saturation before it sharpens again. */
            @keyframes kDuskDrain {
                0%  { filter:grayscale(1) brightness(1.3); opacity:0.7; }
                50% { filter:grayscale(0.4); }
                100%{ filter:none; opacity:1; }
            }

            /* letter-spacing expand + translateX drift simultaneously.
               Characters spread from their centres while the whole line
               drifts slightly left. The text appears to come apart and
               pull back together. */
            @keyframes kDuskBreaking {
                0%  { letter-spacing:12px; transform:translateX(-6px); opacity:0.6; }
                55% { letter-spacing:3px;  transform:translateX(1px); }
                100%{ letter-spacing:normal; transform:translateX(0); opacity:1; }
            }

            /* Very slow single-axis filter: brightness hold.
               The text brightens to near-white, holds for 40% of the
               animation, then slowly dims back. Long hold makes it feel
               deliberate rather than reactive. For the lines that mean
               something. */
            @keyframes kDuskHold {
                0%  { filter:brightness(2.2) saturate(0.3); }
                15% { filter:brightness(2.0) saturate(0.4); }
                55% { filter:brightness(1.5); }
                100%{ filter:none; }
            }

            .fx-dusk-shadow-cast { animation:kDuskShadowCast 0.40s ease-out; }
            .fx-dusk-settle      { animation:kDuskSettle     0.34s ease-out; }
            .fx-dusk-drain       { animation:kDuskDrain      0.36s ease-out; }
            .fx-dusk-breaking    { animation:kDuskBreaking   0.38s ease-out; }
            .fx-dusk-hold        { animation:kDuskHold       0.48s ease-in-out; }
        `,

        dustColor:  'rgba(160,50,35,0.10)',
        flashColor: 'rgba(140,40,28,0.13)',

        effects: [
            { className:'fx-dusk-shadow-cast', duration:400, useFlash:false, useScan:false },
            { className:'fx-dusk-settle',      duration:340, useFlash:true,  useScan:false },
            { className:'fx-dusk-drain',       duration:360, useFlash:false, useScan:false },
            // { className:'fx-dusk-breaking',    duration:380, useFlash:true,  useScan:false },
            { className:'fx-dusk-hold',        duration:480, useFlash:false, useScan:false },
        ],
    },


    // ── GHOST ───────────────────────────────────────────────────────────
    // Ice blue on near-black. Barely there. Minimal presence.
    // For the lines that don't need emphasis — they speak for themselves.
    //
    // This is the quietest preset. Effects are slow (280–400ms) and subtle.
    // Flash alpha is very low — the screen barely reacts.
    // On dense beat zones the overlapping glow swells feel like interference
    // patterns rather than separate events. That's intentional.
    //
    // Pairs well with the outro where the lyric pace slows
    // and each line needs to land alone.
    ghost: {
        label: 'GHOST',

        cssVars: {
            '--bg-body':       '#010206',
            '--bg-container':  'linear-gradient(145deg,#03060e,#020408)',
            '--bg-screen':     '#02040c',
            '--border-screen': '#0a1428',
            '--color-primary': '#88aacc',
            '--color-dim':     '#304060',
            '--color-faint':   '#101828',
            '--color-muted':   '#080e18',
            '--shadow-screen': 'inset 0 0 50px rgba(60,100,180,0.04)',
            '--shadow-outer':  '0 0 0 2px #080e1c,0 20px 60px rgba(0,5,20,0.85)',
            '--bg-stats':      '#020408',
            '--bg-btn':        '#060c18',
            '--border-btn':    '#18304a',
            '--color-btn':     '#607090',
            '--crt-on':        '0',
            '--viz-color':     '#6090b8',
            '--viz-glow':      'rgba(80,130,200,0.30)',
            '--viz-secondary': 'rgba(50,80,140,0.16)',
        },

        styles: `
            /* GHOST — all LAYER, all slow, all opacity/filter/text-shadow.
               Optimized for sparse beats and long spoken sections.
               At dense beat rates the overlapping swells merge into
               continuous shimmer rather than distinct pulses. */

            @keyframes kGhostRise {
                0%  { opacity:0.25; filter:blur(2px); text-shadow:0 0 30px #88aacc; }
                60% { opacity:0.75; filter:blur(0.5px); }
                100%{ opacity:1;    filter:none; text-shadow:0 0 4px #88aacc; }
            }
            @keyframes kGhostSwell {
                0%  { text-shadow:0 0 24px #a0c8f0,0 0 50px #5080b0; }
                100%{ text-shadow:0 0 4px #88aacc; }
            }
            @keyframes kGhostDrift {
                0%  { opacity:0.4; filter:brightness(0.5) blur(1px); }
                100%{ opacity:1;   filter:none; }
            }
            @keyframes kGhostShiver {
                /* Slightly unsteady — presence that can't quite hold itself solid */
                0%  { filter:brightness(1.8) saturate(0.5); opacity:0.6; }
                40% { filter:brightness(1.2); opacity:0.85; }
                100%{ filter:none; opacity:1; }
            }
            @keyframes kGhostLinger {
                /* Long hold — for the lines that deserve silence after them */
                0%  { text-shadow:0 0 40px #88aacc,0 0 80px #304060; opacity:0.7; }
                70% { text-shadow:0 0 14px #88aacc; opacity:0.9; }
                100%{ text-shadow:0 0 4px #88aacc;  opacity:1; }
            }
            .fx-ghost-rise   { animation:kGhostRise   0.38s ease-out; }
            .fx-ghost-swell  { animation:kGhostSwell  0.40s ease-out; }
            .fx-ghost-drift  { animation:kGhostDrift  0.32s ease-out; }
            .fx-ghost-shiver { animation:kGhostShiver 0.28s ease-out; }
            .fx-ghost-linger { animation:kGhostLinger 0.45s ease-out; }
        `,

        dustColor:  'rgba(80,120,200,0.06)',
        flashColor: 'rgba(60,100,180,0.10)',

        effects: [
            // All LAYER — glow/opacity/filter only
            // { className:'fx-ghost-rise',   duration:380, useFlash:false, useScan:false },
            { className:'fx-ghost-swell',  duration:400, useFlash:true,  useScan:false },
            { className:'fx-ghost-drift',  duration:320, useFlash:false, useScan:false },
            { className:'fx-ghost-shiver', duration:280, useFlash:true,  useScan:false },
            { className:'fx-ghost-linger', duration:450, useFlash:false, useScan:false },
        ],
    },
};

// ─────────────────────────────────────────────────────────────────
// PRESET_ORDER — controls the in-app toggle cycle sequence.
// order must include all available presets, compile.py --preset
// flag selects which are included in output.
// ─────────────────────────────────────────────────────────────────
export const PRESET_ORDER = [
                             "dusk", "dusk_ii", "dusk_iii", "dusk_iv", "dusk_v",
                             "terminal", "static", "ghost", "void", 'void_ii', 
                             "ember", "neon", "chrome", "rap", "ethereal", 'ethereal_ii', 
                             "dream", 'dream_ii', "aurora", "midnight", "acid"
                            ];

// ─────────────────────────────────────────────────────────────────
// DEFAULT_PRESETS — when --preset flag is not passed.
// ─────────────────────────────────────────────────────────────────
export const DEFAULT_PRESETS = ['rap', 'ethereal'];
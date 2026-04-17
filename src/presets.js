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
//   visualizer  : config consumed by the active visualizer class
//                 style field must match a key in VISUALIZERS (visualizers.js)
//                 TODO: this creates tight coupling, incoming refactor    
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
// TO ADD A NEW PRESET (zero HTML changes required):
//   1. Copy any existing entry; give it a unique key.
//   2. Write all required @keyframes and .fx-* classes into the styles string.
//   3. Add the key to PRESET_ORDER.
//   4. Run compile.py — done.
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
            .screen.crt-on.scan-active::before {
                background:
                    repeating-linear-gradient(0deg,
                        rgba(0,255,0,0.04) 0px,rgba(0,255,0,0.04) 2px,
                        transparent 2px,transparent 5px),
                    linear-gradient(to bottom,transparent 0%,rgba(0,255,0,0.18) 50%,transparent 100%);
                background-size:100% 100%,100% 30%;
                animation:kScanWipe 0.25s linear;
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

        visualizer: {
            style:         'ring', // this is just a label, not a selector
            baseSize:      60,
            pulseScale:    1.6,
            pulseDuration: 180,
            ringWidth:     3,
            color:         '#1eff00',
            glowColor:     'rgba(30,255,0,0.5)',
        },
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
        },

        styles: `
            @keyframes kDrift {
                0%  { transform:translateY(0);    opacity:1; }
                40% { transform:translateY(-4px); opacity:0.75; }
                70% { transform:translateY(-2px); opacity:0.9; }
                100%{ transform:translateY(0);    opacity:1; }
            }
            @keyframes kBreathe {
                0%  { letter-spacing:normal; opacity:1; filter:blur(0); }
                50% { letter-spacing:0.06em; opacity:0.8; filter:blur(0.5px); }
                100%{ letter-spacing:normal; opacity:1; filter:none; }
            }
            @keyframes kEtherealAurora {
                0%  { text-shadow:0 0 8px #a855f7,0 0 20px #7c3aed; }
                33% { text-shadow:0 0 12px #c084fc,0 0 28px #a855f7; }
                66% { text-shadow:0 0 10px #818cf8,0 0 22px #6366f1; }
                100%{ text-shadow:0 0 8px #a855f7,0 0 20px #7c3aed; }
            }
            @keyframes kDissolve {
                0%  { opacity:1;    filter:blur(0); }
                30% { opacity:0.5;  filter:blur(2px); }
                60% { opacity:0.85; filter:blur(0.5px); }
                100%{ opacity:1;    filter:blur(0); }
            }
            @keyframes kFloat {
                0%  { transform:scale(1)    translateY(0); }
                50% { transform:scale(1.03) translateY(-3px); }
                100%{ transform:scale(1)    translateY(0); }
            }
            .fx-drift    { animation:kDrift         0.60s ease-in-out; }
            .fx-breathe  { animation:kBreathe        0.80s ease-in-out; }
            .fx-aurora   { animation:kEtherealAurora 0.70s ease-in-out; }
            .fx-dissolve { animation:kDissolve       0.50s ease-in-out; }
            .fx-float    { animation:kFloat          0.65s ease-in-out; }
        `,

        dustColor:  'rgba(160,100,255,0.15)',
        flashColor: 'rgba(140,70,255,0.16)',

        effects: [
            // LAYER — all opacity/filter/text-shadow, safe to stack
            { className:'fx-drift',    duration:600, useFlash:false, useScan:false },
            { className:'fx-breathe',  duration:800, useFlash:false, useScan:false },
            { className:'fx-aurora',   duration:700, useFlash:true,  useScan:false },
            { className:'fx-dissolve', duration:500, useFlash:true,  useScan:false },
            { className:'fx-float',    duration:650, useFlash:false, useScan:false },
        ],

        visualizer: {
            style:         'bloom',
            baseSize:      70,
            pulseScale:    1.9,
            pulseDuration: 700,
            ringWidth:     0,
            color:         'rgba(180,100,255,0.3)',
            glowColor:     'rgba(150,80,255,0.5)',
        },
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
        },

        styles: `
            @keyframes kVoidBlink {
                0%{ opacity:1; } 50%{ opacity:0.05; } 100%{ opacity:1; }
            }
            @keyframes kVoidSlice {
                0%  { clip-path:inset(0 0 0 0); }
                40% { clip-path:inset(0 0 60% 0); }
                70% { clip-path:inset(40% 0 0 0); }
                100%{ clip-path:inset(0 0 0 0); }
            }
            @keyframes kVoidDim {
                0%  { opacity:1;   filter:none; }
                50% { opacity:0.3; filter:brightness(0.4); }
                100%{ opacity:1;   filter:none; }
            }
            @keyframes kVoidShift {
                0%  { letter-spacing:normal; }
                40% { letter-spacing:0.12em; opacity:0.7; }
                100%{ letter-spacing:normal; opacity:1; }
            }
            @keyframes kVoidStatic {
                0%,100%{ text-shadow:0 0 2px #d0d8e8; }
                25%    { text-shadow:3px 0 #fff,-3px 0 #6070a0; }
                75%    { text-shadow:-2px 0 #fff,2px 0 #6070a0; }
            }
            .fx-void-blink  { animation:kVoidBlink  0.08s linear; }
            .fx-void-slice  { animation:kVoidSlice  0.12s ease-out; }
            .fx-void-dim    { animation:kVoidDim    0.10s linear; }
            .fx-void-shift  { animation:kVoidShift  0.11s ease-in-out; }
            .fx-void-static { animation:kVoidStatic 0.09s linear; }
        `,

        dustColor:  'rgba(160,180,255,0.07)',
        flashColor: 'rgba(200,220,255,0.11)',

        effects: [
            // ALL SHORT — each completes before next dense beat arrives
            { className:'fx-void-blink',  duration:80,  useFlash:true,  useScan:false },
            { className:'fx-void-slice',  duration:120, useFlash:false, useScan:false },
            { className:'fx-void-dim',    duration:100, useFlash:false, useScan:false },
            { className:'fx-void-shift',  duration:110, useFlash:true,  useScan:false },
            { className:'fx-void-static', duration:90,  useFlash:false, useScan:false },
        ],

        visualizer: {
            style:         'heartbeat',
            baseSize:      60,
            pulseScale:    1.0,
            pulseDuration: 300,
            color:         '#4060c0',
            glowColor:     'rgba(80,120,220,0.3)',
            lineWidth:     1.5,
        },
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
        },

        styles: `
            @keyframes kDreamFade {
                0%  { opacity:1; }
                50% { opacity:0.4; filter:blur(1px); }
                100%{ opacity:1;  filter:none; }
            }
            @keyframes kDreamFog {
                0%  { filter:none; }
                50% { filter:blur(1.5px) brightness(1.2); }
                100%{ filter:none; }
            }
            @keyframes kDreamPulse {
                0%  { opacity:1;   }
                40% { opacity:0.6; }
                100%{ opacity:1;   }
            }
            @keyframes kDreamGlow {
                0%  { text-shadow:0 0 5px #7ee8e8; }
                50% { text-shadow:0 0 18px #7ee8e8,0 0 35px #3ab0b0; }
                100%{ text-shadow:0 0 5px #7ee8e8; }
            }
            @keyframes kDreamRipple {
                0%  { letter-spacing:normal; opacity:1;   }
                50% { letter-spacing:0.04em; opacity:0.7; }
                100%{ letter-spacing:normal; opacity:1;   }
            }
            .fx-dream-fade   { animation:kDreamFade   0.14s ease-in-out; }
            .fx-dream-fog    { animation:kDreamFog    0.18s ease-in-out; }
            .fx-dream-pulse  { animation:kDreamPulse  0.12s linear; }
            .fx-dream-glow   { animation:kDreamGlow   0.16s ease-in-out; }
            .fx-dream-ripple { animation:kDreamRipple 0.13s ease-in-out; }
        `,

        dustColor:  'rgba(100,220,220,0.10)',
        flashColor: 'rgba(60,200,200,0.09)',

        effects: [
            // LAYER-safe: opacity + blur only, stacks on dense beats
            { className:'fx-dream-fade',   duration:140, useFlash:false, useScan:false },
            { className:'fx-dream-fog',    duration:180, useFlash:true,  useScan:false },
            { className:'fx-dream-pulse',  duration:120, useFlash:false, useScan:false },
            { className:'fx-dream-glow',   duration:160, useFlash:false, useScan:false },
            { className:'fx-dream-ripple', duration:130, useFlash:true,  useScan:false },
        ],

        visualizer: {
            style:         'ripple',
            baseSize:      50,
            pulseScale:    1.0,
            pulseDuration: 900,
            color:         '#7ee8e8',
            glowColor:     'rgba(100,220,220,0.3)',
            ringWidth:     1.5,
            maxRings:      4,
        },
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
        },

        styles: `
            @keyframes kAuroraShift {
                0%  { text-shadow:0 0 6px #a8d8ff; }
                50% { text-shadow:0 0 14px #e080ff,0 0 6px #80ffcc; }
                100%{ text-shadow:0 0 6px #a8d8ff; }
            }
            @keyframes kAuroraSweep {
                0%  { opacity:1; }
                30% { opacity:0.6; filter:hue-rotate(40deg); }
                100%{ opacity:1;  filter:none; }
            }
            @keyframes kAuroraSwell {
                0%  { text-shadow:0 0 4px #a8d8ff; }
                50% { text-shadow:0 0 24px #c080ff,0 0 48px #8040ff; }
                100%{ text-shadow:0 0 4px #a8d8ff; }
            }
            @keyframes kAuroraShimmer {
                0%,100%{ opacity:1; }
                33%    { opacity:0.7; filter:brightness(1.4); }
                66%    { opacity:0.9; }
            }
            @keyframes kAuroraHaze {
                0%  { filter:none; }
                40% { filter:blur(0.5px) hue-rotate(30deg) brightness(1.15); }
                100%{ filter:none; }
            }
            .fx-aurora-shift   { animation:kAuroraShift   0.12s ease-in-out; }
            .fx-aurora-sweep   { animation:kAuroraSweep   0.13s ease-out; }
            .fx-aurora-swell   { animation:kAuroraSwell   0.60s ease-in-out; }
            .fx-aurora-shimmer { animation:kAuroraShimmer 0.11s linear; }
            .fx-aurora-haze    { animation:kAuroraHaze    0.58s ease-in-out; }
        `,

        dustColor:  'rgba(120,100,255,0.10)',
        flashColor: 'rgba(100,80,220,0.13)',
        flashCycle: true,
        flashCycleColors: [
            'rgba(180,80,255,0.14)',
            'rgba(80,200,255,0.11)',
            'rgba(255,80,160,0.11)',
            'rgba(80,255,180,0.09)',
        ],

        effects: [
            // SHORT color-only — safe for dense beats
            { className:'fx-aurora-shift',   duration:120, useFlash:true,  useScan:false },
            { className:'fx-aurora-sweep',   duration:130, useFlash:false, useScan:false },
            { className:'fx-aurora-shimmer', duration:110, useFlash:true,  useScan:false },
            // LAYER text-shadow — safe to stack
            { className:'fx-aurora-swell',   duration:600, useFlash:false, useScan:false },
            { className:'fx-aurora-haze',    duration:580, useFlash:false, useScan:false },
        ],

        visualizer: {
            style:         'bloom',
            baseSize:      65,
            pulseScale:    1.8,
            pulseDuration: 500,
            ringWidth:     0,
            color:         'rgba(140,100,255,0.0)',
            glowColor:     'rgba(120,80,255,0.4)',
            colorCycle: [
                'rgba(180,80,255,0.5)',
                'rgba(80,200,255,0.45)',
                'rgba(255,80,160,0.4)',
                'rgba(80,255,180,0.38)',
            ],
        },
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
        },

        styles: `
            @keyframes kEmberFlare {
                0%  { text-shadow:0 0 4px #ff9040; }
                50% { text-shadow:0 0 20px #ff4000,0 0 40px #ff2000; filter:brightness(1.5); }
                100%{ text-shadow:0 0 4px #ff9040; filter:none; }
            }
            @keyframes kEmberChar {
                0%  { opacity:1; }
                30% { opacity:0.5; filter:sepia(1) brightness(0.6); }
                100%{ opacity:1;   filter:none; }
            }
            @keyframes kEmberSmolder {
                0%  { letter-spacing:normal; }
                50% { letter-spacing:0.03em; text-shadow:0 0 12px #ff6020; }
                100%{ letter-spacing:normal; }
            }
            @keyframes kEmberHeat {
                0%  { filter:none; }
                50% { filter:brightness(1.2) saturate(1.3) blur(0.3px); }
                100%{ filter:none; }
            }
            @keyframes kEmberPulse {
                0%,100%{ opacity:1;   }
                50%    { opacity:0.65; }
            }
            .fx-ember-flare   { animation:kEmberFlare   0.10s ease-out; }
            .fx-ember-char    { animation:kEmberChar    0.12s ease-in-out; }
            .fx-ember-smolder { animation:kEmberSmolder 0.13s ease-in-out; }
            .fx-ember-heat    { animation:kEmberHeat    0.55s ease-in-out; }
            .fx-ember-pulse   { animation:kEmberPulse   0.11s linear; }
        `,

        dustColor:  'rgba(255,120,20,0.16)',
        flashColor: 'rgba(220,80,10,0.19)',

        effects: [
            // SHORT — rapid heat shimmer on dense beats
            { className:'fx-ember-flare',   duration:100, useFlash:true,  useScan:false },
            { className:'fx-ember-char',    duration:120, useFlash:false, useScan:false },
            { className:'fx-ember-smolder', duration:130, useFlash:true,  useScan:false },
            { className:'fx-ember-pulse',   duration:110, useFlash:false, useScan:false },
            // LAYER — warm filter swell
            { className:'fx-ember-heat',    duration:550, useFlash:false, useScan:false },
        ],

        visualizer: {
            style:         'waveform',
            baseSize:      60,
            pulseScale:    1.0,
            pulseDuration: 250,
            color:         '#ff6020',
            glowColor:     'rgba(255,100,20,0.4)',
            lineWidth:     2,
            waveAmplitude: 14,
            waveFrequency: 3,
        },
    },
};

// ─────────────────────────────────────────────────────────────────
// PRESET_ORDER — controls the in-app toggle cycle sequence.
// compile.py --preset flag selects which are included in output.
// ─────────────────────────────────────────────────────────────────
export const PRESET_ORDER = ['rap', 'ethereal', 'void', 'dream', 'aurora', 'ember'];

// ─────────────────────────────────────────────────────────────────
// DEFAULT_PRESETS — when --preset flag is not passed.
// ─────────────────────────────────────────────────────────────────
export const DEFAULT_PRESETS = ['rap', 'ethereal'];

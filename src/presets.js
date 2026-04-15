// ═══════════════════════════════════════════════════════════════════
// presets.js — Theme definitions and animation effect pools
//
// Each preset defines:
//   - cssVars      : CSS custom properties injected into :root at runtime
//   - dustColor    : rgba string for floating dust particles
//   - flashColor   : rgba string for screen flash (both presets use flash,
//                    just with different colors and intensities)
//   - effects      : animation pool randomly sampled per beat/lyric trigger
//   - circle       : beat circle visual behavior
//   - label        : display name shown in status bar
//
// To add a new preset: copy an existing entry, give it a unique key,
// add the key to PRESET_ORDER. Nothing else to change.
// ═══════════════════════════════════════════════════════════════════

export const PRESETS = {

    rap: {
        label: 'RAP',

        cssVars: {
            '--bg-body':       '#030603',
            '--bg-container':  'linear-gradient(145deg, #141a14, #0a0f0a)',
            '--bg-screen':     '#0a0e0a',
            '--border-screen': '#2a4a2a',
            '--color-primary': '#1eff00',
            '--color-dim':     '#3c9e3c',
            '--color-faint':   '#2a8a2a',
            '--color-muted':   '#3a7a3a',
            '--shadow-screen': 'inset 0 0 25px rgba(0,255,0,0.06)',
            '--shadow-outer':  '0 0 0 2px #1a3a1a, 0 20px 40px rgba(0,0,0,0.5)',
            '--bg-stats':      '#0a0c0a',
            '--bg-btn':        '#1a2a1a',
            '--border-btn':    '#3c9e3c',
            '--color-btn':     '#aaffaa',
            '--crt-on':        '1',
        },

        dustColor:  'rgba(30,255,0,0.25)',
        flashColor: 'rgba(0,255,0,0.4)',

        // Each effect: className on .current-line, duration (ms) before class removal,
        // useFlash triggers screen flash, useScan triggers scanline wipe overlay.
        effects: [
            { className: 'fx-shake',   duration: 100, useFlash: true,  useScan: false },
            { className: 'fx-glitch',  duration: 260, useFlash: false, useScan: false },
            { className: 'fx-chroma',  duration: 200, useFlash: false, useScan: true  },
            { className: 'fx-flicker', duration: 220, useFlash: false, useScan: false },
            { className: 'fx-zoom',    duration: 160, useFlash: true,  useScan: false },
        ],

        circle: {
            style:         'ring',
            baseSize:      60,
            pulseScale:    1.6,
            pulseDuration: 180,
            ringWidth:     3,
            color:         '#1eff00',
            glowColor:     'rgba(30,255,0,0.5)',
        },
    },

    ethereal: {
        label: 'ETHEREAL',

        // Colors chosen for dark-skin eye comfort:
        // #b388ff is muted lavender — readable without eye-strain saturation.
        // Avoid pure white or full-saturation violet (#8000ff) which cause
        // contrast fatigue on prolonged dark-background viewing.
        cssVars: {
            '--bg-body':       '#06030f',
            '--bg-container':  'linear-gradient(145deg, #0e0819, #070410)',
            '--bg-screen':     '#0b0718',
            '--border-screen': '#2e1650',
            '--color-primary': '#b388ff',
            '--color-dim':     '#7c4daa',
            '--color-faint':   '#4a2870',
            '--color-muted':   '#2e1650',
            '--shadow-screen': 'inset 0 0 35px rgba(140,70,220,0.06)',
            '--shadow-outer':  '0 0 0 2px #1e0a38, 0 20px 60px rgba(60,0,100,0.55)',
            '--bg-stats':      '#080514',
            '--bg-btn':        '#140a28',
            '--border-btn':    '#5c3080',
            '--color-btn':     '#c4a0f0',
            '--crt-on':        '0',
        },

        // Soft violet-tinted dust — same mechanic as RAP, different color
        dustColor: 'rgba(160,100,255,0.15)',

        // Flash is much dimmer than RAP — a gentle violet pulse, not a strobe.
        // Keeps the effect present without fighting the chill vibe.
        flashColor: 'rgba(140,70,255,0.16)',

        effects: [
            { className: 'fx-drift',    duration: 600, useFlash: false, useScan: false },
            { className: 'fx-breathe',  duration: 800, useFlash: false, useScan: false },
            { className: 'fx-aurora',   duration: 700, useFlash: true,  useScan: false },
            { className: 'fx-dissolve', duration: 500, useFlash: true,  useScan: false },
            { className: 'fx-float',    duration: 650, useFlash: false, useScan: false },
        ],

        circle: {
            style:         'bloom',
            baseSize:      70,
            pulseScale:    1.9,
            pulseDuration: 700,
            ringWidth:     0,
            color:         'rgba(180,100,255,0.0)',
            glowColor:     'rgba(150,80,255,0.5)',
        },
    },
};

export const PRESET_ORDER = ['rap', 'ethereal'];

// ═══════════════════════════════════════════════════════════════════
// visualizers.js — All canvas-based beat visualizers.
//
// ARCHITECTURE:
//   BaseVisualizer — abstract base class enforcing the interface:
//     constructor(wrap)   — mount canvas into wrap, start loops
//     pulse()             — called on every beat trigger
//     destroy()           — final, handles all GPU + memory cleanup
//   All concrete classes extend BaseVisualizer and implement:
//     _init()             — create canvas, start loop
//     _cleanup()          — class-specific teardown (called by base destroy())
//
//   Visualizers read color from CSS custom properties at runtime:
//     --viz-color      → primary stroke/fill
//     --viz-glow       → shadow/glow (rgba with alpha)
//     --viz-secondary  → secondary tint for two-tone visuals
//
//   This means switching presets recolors the running visualizer
//   instantly with zero rebuild — applyPreset() injects new CSS vars,
//   and the next canvas draw picks them up automatically.
//
//   Visualizers own their own size/timing defaults. No preset config
//   is needed to construct a visualizer — just pass (wrap).
//
// READING CSS VARS:
//   _readVars() is called at the start of every _draw()/_loop() call,
//   not at construction time. This is the key to zero-coupling:
//   the visualizer never caches colors from construction, so a preset
//   switch takes effect on the very next frame.
//   Cost: one getComputedStyle call per frame per active visualizer.
//   getComputedStyle is O(1) for custom properties — negligible vs
//   the canvas draw operations that follow.
//
// GPU MEMORY RELEASE:
//   BaseVisualizer.destroy() handles the common GPU memory release:
//     1. Cancel any pending rAF via this._rafId
//     2. clearRect the full canvas
//     3. Set canvas.width = canvas.height = 0  → forces GPU buffer release
//     4. Remove canvas from DOM
//     5. Null all references → GC eligible
//
//   This is the only reliable cross-browser mechanism to immediately
//   release the GPU framebuffer. DOM removal alone is insufficient —
//   the browser holds the buffer until GC, which is non-deterministic.
//
// CYCLING:
//   VISUALIZER_ORDER defines the button cycle sequence.
//   The engine calls destroys the current instance before constructing
//   the next, so GPU memory is always released before allocation.
//
// DENSE BEAT HANDLING:
//   pulse() on a decaying visualizer resets state to MAX immediately.
//   No lock flags needed (except HeartbeatVisualizer where waveform
//   shape integrity requires completion).
//
// BEAT RESPONSIVENESS MODEL:
//
//   The brain perceives a beat at the moment of the audio transient.
//   The scheduler fires the callback at that exact moment. But if the
//   visual spends the first 50-100ms "ramping up" to peak (sin curve),
//   the user sees nothing for one full display frame after the beat —
//   perceived as lag even though the timer was precise.
//
//   Correct model:
//     pulse() → INSTANTLY set state to maximum
//     _loop() → decay from maximum toward rest over time
//
//   Wrong model:
//     pulse() → start a ramp-up animation from 0 → peak → 0
//     Peak arrives at 50% of duration = perceivable latency
//
//   LATENCY PRE-COMPENSATION:
//   The display pipeline (canvas compositing + vsync) adds ~1 frame
//   (~16ms) of visual latency after the JS callback fires. We absorb
//   this by making the visual state MAX at t=0 of pulse() — the user's
//   first frame after the beat shows the peak, not the ramp.
//
//   DECAY SHAPE:
//   Exponential decay (state *= factor) is used everywhere because:
//     - It reaches perceivable zero faster than linear for the same
//       total duration, leaving the canvas "clean" before the next beat
//     - It never fully reaches zero (no hard cutoff artifact)
//     - It's a single multiply per frame — cheaper than sin/ease math
//
// TO ADD A NEW VISUALIZER (zero HTML or compile.py changes required):
//   1. Extend BaseVisualizer, implement _init() and pulse().
//   2. Use _readVars() in every draw to get current colors.
//   3. Add to VISUALIZERS map and VISUALIZER_ORDER.
//   4. No preset or HTML changes needed.
//   5. Run compile.py — done.
// ═══════════════════════════════════════════════════════════════════

// Canvas is larger than the visual content to give glow/expansion room.
const CANVAS_SCALE = 2.6;

// Cached reference to :root for CSS var reads — avoids repeated DOM lookup.
const ROOT_STYLE = document.documentElement;


// ── SHARED UTILITIES ──────────────────────────────────────────────

// Read the three visualizer color vars from the active preset's CSS vars.
// Called per-frame so preset switches take effect immediately.
// Returns plain strings ready for ctx.strokeStyle / ctx.shadowColor.
function readVizVars() {
    const s = getComputedStyle(ROOT_STYLE);
    return {
        color:     s.getPropertyValue('--viz-color').trim()     || '#ffffff',
        glow:      s.getPropertyValue('--viz-glow').trim()      || 'rgba(255,255,255,0.4)',
        secondary: s.getPropertyValue('--viz-secondary').trim() || 'rgba(255,255,255,0.2)',
    };
}

// easeOutExpo: extremely fast start, long soft tail.
// Used for DECAY animations — gives instant visual confirmation then
// gracefully fades so the canvas is clear for the next beat.
function easeOutExpo(t) {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

// easeOutSine: fast start, soft landing. Good for pulse attacks.
// still used for ripple ring expansion (spatial, not temporal)
function easeOutSine(t) { return Math.sin((t * Math.PI) / 2); }


// ═══════════════════════════════════════════════════════════════════
// BASE VISUALIZER
// Abstract class. Subclasses must implement _init() and pulse().
// destroy() is final — do not override; implement _cleanup() instead.
// ═══════════════════════════════════════════════════════════════════
class BaseVisualizer {
    constructor(wrap) {
        this.wrap   = wrap;
        this.canvas = null;
        this.ctx    = null;
        this._rafId = null;
        this._init();
    }

    // Subclasses implement this to create canvas and start loops.
    _init() { throw new Error('BaseVisualizer._init() must be implemented'); }

    // Called on every beat. Subclasses implement this.
    pulse() { throw new Error('BaseVisualizer.pulse() must be implemented'); }

    // Subclasses implement for visualizer-specific cleanup (stop loops etc.)
    // Called by destroy() before common teardown.
    _cleanup() {}

    // ── FINAL: do not override ────────────────────────────────────
    // GPU memory release sequence:
    //   cancelAnimationFrame → clearRect → zero dimensions (releases GPU buffer)
    //   → remove from DOM → null refs → GC eligible
    //
    // Setting canvas.width/height to 0 is the only reliable cross-browser
    // way to immediately release the underlying GPU framebuffer. Simply
    // removing from DOM or nulling the reference is insufficient — the
    // browser may hold the buffer until GC, which is non-deterministic.
    destroy() {
        this._cleanup();

        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        if (this.canvas) {
            if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            // Zero dimensions → immediate GPU buffer release
            this.canvas.width  = 0;
            this.canvas.height = 0;
            if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
            this.canvas = null;
            this.ctx    = null;
        }

        this.wrap = null;
    }

    // Shared canvas factory. Clears wrap before mounting so switching
    // visualizers never leaves orphaned canvases in the DOM.
    _makeCanvas(w, h) {
        // Clear previous content (previous visualizer's canvas)
        this.wrap.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        // CSS size matches pixel size — no scaling blur
        canvas.style.cssText = `width:${w}px;height:${h}px;display:block;`;
        // GPU hint: canvas compositing is always transform/opacity-based
        canvas.style.willChange = 'transform, opacity';
        this.wrap.appendChild(canvas);
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        return canvas;
    }
}


// ═══════════════════════════════════════════════════════════════════
// RING - hollow expanding ring, hard edge, sharp snap
// Default timing: 180ms pulse, 1.6× scale peak.
// Dense beats: cancels previous rAF and restarts from current scale.
// The newest trigger always wins — the user should see
// the most recent beat, not a stale one completing.
// ═══════════════════════════════════════════════════════════════════
class RingVisualizer extends BaseVisualizer {
    _init() {
        this.scale   = 1;
        this.BASE    = 60;
        this.MAX     = 1.65;
        this.DECAY   = 0.88; // multiply per frame — reaches ~1 in ~200ms at 60fps
        this.RING_W  = 3;
        const sz     = this.BASE * CANVAS_SCALE;
        this._makeCanvas(sz, sz);
        this._loop();
    }

    pulse() {
        // Instant peak — zero ramp-up, first frame shows maximum
        this.scale = this.MAX;
    }

    _loop() {
        if (!this.canvas) return;
        this.scale = 1 + (this.scale - 1) * this.DECAY;
        this._draw();
        this._rafId = requestAnimationFrame(() => this._loop());
    }

    _draw() {
        const { canvas, ctx, scale, BASE, RING_W } = this;
        const { color, glow } = readVizVars();
        const cx = canvas.width / 2, cy = canvas.height / 2;
        const r  = (BASE / 2) * scale;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth   = RING_W;
        ctx.shadowColor = glow;
        ctx.shadowBlur  = 6 + (scale - 1) * 30;
        ctx.globalAlpha = Math.min(1, 0.5 + (scale - 1) * 1.5);
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
}


// ═══════════════════════════════════════════════════════════════════
// BLOOM — soft radial gradient glow, no hard edge
// colorCycle: rotates through aurora-palette glow colors per pulse.
// Uses secondary glow cycle derived from --viz-glow variants.
// Default timing: 700ms pulse (slow bloom suits ambient/ethereal).
// ═══════════════════════════════════════════════════════════════════
class BloomVisualizer extends BaseVisualizer {
    _init() {
        this.BASE      = 65;
        this.intensity = 0;   // 0 = dark, 1 = full bloom
        this.DECAY     = 0.92; // slower decay than ring — bloom lingers longer
        this._cycleIdx = 0;
        const sz       = this.BASE * CANVAS_SCALE;
        this._makeCanvas(sz, sz);
        this._loop();
    }

    pulse() {
        this.intensity = 1.0; // instant full bloom
        this._cycleIdx = (this._cycleIdx + 1) % 4;
    }

    _loop() {
        if (!this.canvas) return;
        this.intensity *= this.DECAY;
        this._draw();
        this._rafId = requestAnimationFrame(() => this._loop());
    }

    _draw() {
        if (!this.canvas) return;
        const { canvas, ctx, BASE, intensity } = this;
        if (intensity < 0.005) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
        const { glow } = readVizVars();
        const cx = canvas.width / 2, cy = canvas.height / 2;
        // Scale grows slightly with intensity for a "breath" feel
        const r  = (BASE / 2) * (1 + intensity * 0.5);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Cyclic alpha offset — subtle spectral variety without hard-coded colors
        const aMod = 0.85 + this._cycleIdx * 0.05;

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.4);
        g.addColorStop(0,    this._a(glow, intensity * 0.85 * aMod));
        g.addColorStop(0.4,  this._a(glow, intensity * 0.55 * aMod));
        g.addColorStop(0.75, this._a(glow, intensity * 0.2));
        g.addColorStop(1,    'rgba(0,0,0,0)');

        ctx.fillStyle   = g;
        ctx.shadowColor = glow;
        ctx.shadowBlur  = 20 + intensity * 30;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    // Replace alpha component of an rgba() string.
    // Trade-off: regex on every draw frame is ~0.01ms — acceptable vs
    // the complexity of storing pre-parsed color components (canvas operations).
    _a(rgba, a) { 
        return rgba.replace(/[\d.]+\)$/, `${Math.min(a,1).toFixed(3)})`); 
    }
}


// ═══════════════════════════════════════════════════════════════════
// HEARTBEAT
// Flat ECG baseline that spikes into a cardiac waveform on beat.
// Lock flag prevents overlapping spikes — each spike completes fully
// before the next fires. At high density: misses beats rather than
// producing overlapping visual chaos. Correct trade-off for a
// biometric waveform that must read as a single coherent shape.
// ═══════════════════════════════════════════════════════════════════
class HeartbeatVisualizer extends BaseVisualizer {
    _init() {
        this._lock    = false;
        this.BASE     = 60;
        this.DURATION = 280; // slightly shorter — spike reads sharper
        const w = this.BASE * 3, h = this.BASE * 1.2;
        this.w = w; this.h = h;
        this._makeCanvas(w, h);
        this._draw(0);
    }

    pulse() {
        // Lock: don't interrupt mid-spike. Correct for a waveform that
        // must be readable as a single shape — overlap destroys legibility.
        if (this._lock) return;
        this._lock = true;
        const start = performance.now();
        const go = now => {
            if (!this.canvas) return;
            const p = Math.min((now - start) / this.DURATION, 1);
            // easeOutExpo: spike is near-full at p=0.1 (first frame after beat)
            // This is the key fix — old sin(p*π) peaked at p=0.5
            const env = p < 0.5
                ? easeOutExpo(p * 2)           // fast attack: 0→1 in first half
                : 1 - easeOutExpo((p - 0.5)*2); // slow decay: 1→0 in second half
            this._draw(env);
            if (p < 1) this._rafId = requestAnimationFrame(go);
            else { this._draw(0); this._lock = false; }
        };
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(go);
    }
    _draw(env) {
        if (!this.canvas) return;
        const { ctx, w, h } = this;
        const { color, glow } = readVizVars();
        ctx.clearRect(0, 0, w, h);
        const cy  = h / 2;
        const amp = (h * 0.38) * env;

        // Cardiac profile: P-wave → QRS complex → S-wave → T-wave
        const profile = x => {
            if (x < 0.25) return 0;
            if (x < 0.32) return -(x - 0.25) / 0.07 * 0.15;
            if (x < 0.38) return  (x - 0.32) / 0.06;
            if (x < 0.42) return 1 - (x - 0.38) / 0.04 * 1.6;
            if (x < 0.46) return -0.6 + (x - 0.42) / 0.04 * 0.6;
            if (x < 0.55) return 0;
            if (x < 0.65) return Math.sin((x - 0.55) / 0.10 * Math.PI) * 0.18;
            return 0;
        };

        ctx.beginPath();
        for (let px = 0; px < w; px++) {
            const y = cy - profile(px / w) * amp;
            px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.5;
        ctx.shadowColor = glow;
        ctx.shadowBlur  = 4 + amp * 0.4;
        ctx.globalAlpha = 0.4 + env * 0.6;
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }

    _cleanup() { this._lock = false; }
}


// ═══════════════════════════════════════════════════════════════════
// RIPPLE
// Each pulse spawns an expanding ring that fades as it grows.
// Multiple rings coexist, bounded by maxRings (FIFO evicted).
// Uses a single continuous rAF loop shared across all rings —
// one loop is more efficient than per-ring timeouts.
// ═══════════════════════════════════════════════════════════════════
class RippleVisualizer extends BaseVisualizer {
    _init() {
        this._rings   = [];
        this.BASE     = 50;
        this.MAX_RINGS= 4;
        this.DURATION = 600; // was 900 — shorter keeps canvas cleaner between beats
        const sz      = this.BASE * CANVAS_SCALE;
        this.sz       = sz;
        this._makeCanvas(sz, sz);
        this._loop();
    }

    pulse() {
        if (this._rings.length >= this.MAX_RINGS) this._rings.shift();
        // Start at p=0.08 so first frame shows a non-zero radius
        this._rings.push({ t0: performance.now() - this.DURATION * 0.08, dur: this.DURATION });
    }

    _loop() {
        if (!this.canvas) return;
        const { ctx, sz, BASE } = this;
        const { color, glow } = readVizVars();
        const cx = sz / 2, cy = sz / 2;
        const maxR = (BASE / 2) * 2.2;
        ctx.clearRect(0, 0, sz, sz);
        const now = performance.now();
        this._rings = this._rings.filter(ring => {
            const p = (now - ring.t0) / ring.dur;
            if (p >= 1) return false;
            const r = maxR * easeOutSine(p);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = color;
            ctx.lineWidth   = 1.8 * (1 - p * 0.6);
            ctx.shadowColor = glow;
            ctx.shadowBlur  = 14 * (1 - p);
            ctx.globalAlpha = (1 - p) * 0.8;
            ctx.stroke();
            ctx.shadowBlur = 0; ctx.globalAlpha = 1;
            return true;
        });
        this._rafId = requestAnimationFrame(() => this._loop());
    }

    _cleanup() { this._rings = []; }
}


// ═══════════════════════════════════════════════════════════════════
// WAVEFORM
// Scrolling sine wave. Flat at rest, distorts to full amplitude on
// beat then decays. Decay is frame-rate proportional (not wall-clock)
// which means it looks consistent at 30fps and 60fps alike.
// Trade-off: decay speed is approximate — acceptable for a visual.
// ═══════════════════════════════════════════════════════════════════
class WaveformVisualizer extends BaseVisualizer {
    _init() {
        this._amp   = 0;
        this._phase = 0;
        this.MAX_AMP  = 16;
        this.FREQ     = 3;
        this.DECAY    = 0.91; // exponential — faster clearance than old linear
        const w = 60*3, h = 60*1.4;
        this.w = w; this.h = h;
        this._makeCanvas(w, h);
        this._loop();
    }

    pulse() {
        this._amp = this.MAX_AMP; // instant peak
    }

    _loop() {
        if (!this.canvas) return;
        const { ctx, w, h } = this;
        const { color, glow } = readVizVars();
        const cy = h / 2;

        this._amp   *= this.DECAY;
        this._phase += 0.05; // slightly faster scroll than before

        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        for (let px = 0; px <= w; px++) {
            const x   = px / w;
            const env = Math.sin(x * Math.PI); // edge taper 0→1→0
            const y   = cy - Math.sin(x * Math.PI * 2 * this.FREQ + this._phase) * this._amp * env;
            px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        const intensity = this._amp / this.MAX_AMP;
        ctx.strokeStyle = color;
        ctx.lineWidth   = 2;
        ctx.shadowColor = glow;
        ctx.shadowBlur  = 4 + intensity * 16;
        ctx.globalAlpha = 0.35 + intensity * 0.65;
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;

        this._rafId = requestAnimationFrame(() => this._loop());
    }
}


// ═══════════════════════════════════════════════════════════════════
// PARTICLES
// Burst of dots exploding from center. Dense beats spawn overlapping
// bursts — at high density this creates a sustained particle field.
// Particle count bounded by maxParticles to prevent unbounded growth.
// Particles are plain objects (not class instances) — avoids GC churn
// from allocating/deallocating class instances per frame.
// ═══════════════════════════════════════════════════════════════════
class ParticlesVisualizer extends BaseVisualizer {
    _init() {
        this._particles = [];
        this.MAX_P    = 72;
        this.PER_BURST= 14; // slightly more per burst for denser feel
        this.BASE     = 60;
        const sz = this.BASE * CANVAS_SCALE;
        this.sz  = sz;
        this._makeCanvas(sz, sz);
        this._loop();
    }

    pulse() {
        const { sz, MAX_P, PER_BURST, BASE } = this;
        const cx = sz / 2, cy = sz / 2;
        // Evict oldest before spawning — preserves a hard particle cap
        if (this._particles.length + PER_BURST > MAX_P) {
            this._particles.splice(0, PER_BURST); // evict oldest burst
        }
        for (let i = 0; i < PER_BURST; i++) {
            const angle = (Math.PI * 2 / PER_BURST) * i + (Math.random() - 0.5) * 0.5;
            const spd   = BASE * 0.016 + Math.random() * BASE * 0.018;
            this._particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd,
                r: 1.5 + Math.random() * 2.5,
                life: 1.0,
                decay: 0.022 + Math.random()*0.014, // faster fade
            });
        }
    }

    _loop() {
        if (!this.canvas) return;
        const { ctx, sz } = this;
        const { color, glow } = readVizVars();
        ctx.clearRect(0, 0, sz, sz);
        this._particles = this._particles.filter(p => {
            p.x += p.vx; p.y += p.vy;
            p.vx *= 0.94; p.vy *= 0.94;
            p.life -= p.decay;
            if (p.life <= 0) return false;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r*p.life, 0, Math.PI*2);
            ctx.fillStyle   = color;
            ctx.shadowColor = glow;
            ctx.shadowBlur  = 5;
            ctx.globalAlpha = p.life * 0.9;
            ctx.fill();
            ctx.shadowBlur = 0; ctx.globalAlpha = 1;
            return true;
        });
        this._rafId = requestAnimationFrame(() => this._loop());
    }

    _cleanup() { this._particles = []; }
}


// ═══════════════════════════════════════════════════════════════════
// DNA
// Double helix: two sine waves offset by 180° with ladder rungs.
// Amplitude pulses on beat and decays exponentially to a resting
// state. Exponential decay (multiply by factor) is cheaper than
// linear and gives a more organic "spring back" feel.
// ═══════════════════════════════════════════════════════════════════
class DNAVisualizer extends BaseVisualizer {
    _init() {
        this.BASE     = 60;
        this._restAmp = this.BASE * 0.10;
        this._maxAmp  = this.BASE * 0.44;
        this._amp     = this._restAmp;
        this.DECAY    = 0.93;
        this._phase   = 0;
        const w = this.BASE*3, h = this.BASE*1.4;
        this.w = w; this.h = h;
        this._makeCanvas(w, h);
        this._loop();
    }

    pulse() { this._amp = this._maxAmp; }

    _loop() {
        if (!this.canvas) return;
        const { ctx, w, h } = this;
        const { color, glow, secondary } = readVizVars();
        const cy    = h / 2;
        const freq  = 2.5;
        const rungs = 8;

        // Exponential decay toward resting amplitude
        this._amp   = this._restAmp + (this._amp - this._restAmp) * this.DECAY;
        this._phase += 0.03;

        ctx.clearRect(0, 0, w, h);

        const norm  = (this._amp - this._restAmp) / (this._maxAmp - this._restAmp);
        const gBlur = norm * 16;
        const alpha = 0.4 + norm * 0.5;

        // Strand 1 — primary color
        this._strand(ctx, w, cy, freq, 0,       color,     gBlur,       alpha,       glow);
        // Strand 2 — secondary color, slightly dimmer
        this._strand(ctx, w, cy, freq, Math.PI, secondary, gBlur * 0.6, alpha * 0.65, glow);

        // Rungs
        ctx.strokeStyle = color;
        ctx.lineWidth   = 0.9;
        ctx.globalAlpha = alpha * 0.3;
        ctx.shadowColor = glow;
        ctx.shadowBlur  = gBlur * 0.4;
        for (let i = 0; i <= rungs; i++) {
            const xN = i / rungs;
            const y1 = cy - Math.sin(xN * Math.PI * 2 * freq + this._phase) * this._amp;
            const y2 = cy - Math.sin(xN * Math.PI * 2 * freq + this._phase + Math.PI) * this._amp;
            ctx.beginPath(); ctx.moveTo(xN * w, y1); ctx.lineTo(xN * w, y2); ctx.stroke();
        }
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
        this._rafId = requestAnimationFrame(() => this._loop());
    }

    _strand(ctx, w, cy, freq, offset, strokeColor, glowBlur, alpha, shadowColor) {
        ctx.beginPath();
        for (let px = 0; px <= w; px++) {
            const y = cy - Math.sin((px / w) * Math.PI * 2 * freq + this._phase + offset) * this._amp;
            px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth   = 1.5;
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur  = glowBlur;
        ctx.globalAlpha = alpha;
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
}


// ═══════════════════════════════════════════════════════════════════
// VISUALIZERS MAP
// Keys must match values used in VISUALIZER_ORDER.
// compile.py reads this map to know which classes to inline.
// ═══════════════════════════════════════════════════════════════════
export const VISUALIZERS = {
    ring:      RingVisualizer,
    bloom:     BloomVisualizer,
    heartbeat: HeartbeatVisualizer,
    ripple:    RippleVisualizer,
    waveform:  WaveformVisualizer,
    particles: ParticlesVisualizer,
    dna:       DNAVisualizer,
};

// ─────────────────────────────────────────────────────────────────
// VISUALIZER_ORDER — button cycle sequence.
// OFF is a sentinel that the engine maps to null (no visualizer).
// order must include all available visualizers, 
// filtering happens inside compile.py if required.
// ─────────────────────────────────────────────────────────────────
export const VISUALIZER_ORDER = ['off', 'particles', 'waveform', 'dna', 'heartbeat', 'ripple', 'ring', 'bloom'];
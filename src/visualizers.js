// ═══════════════════════════════════════════════════════════════════
// visualizers.js — All canvas-based beat visualizers.
//
// ARCHITECTURE:
//   BaseVisualizer — abstract base class enforcing the interface.
//   All concrete classes extend BaseVisualizer and implement:
//     _init()    — create canvas, mount into wrap, start any continuous loop
//     pulse()    — called on every beat trigger
//     _cleanup() — visualizer-specific teardown (called by base destroy())
//
//   BaseVisualizer.destroy() handles the common GPU memory release:
//     1. Cancel any pending rAF via this._rafId
//     2. clearRect the full canvas
//     3. Set canvas.width = canvas.height = 0  → forces GPU buffer release
//     4. Remove canvas from DOM
//     5. Null all references → GC eligible
//
// CYCLING:
//   VISUALIZER_ORDER defines the button cycle sequence.
//   The engine calls destroys the current instance before constructing
//   the next, so GPU memory is always released before allocation.
//
// DENSE BEAT HANDLING per visualizer:
//   ring/bloom   — cancel previous rAF, restart from current scale
//   heartbeat    — lock flag: ignores pulse() while spike in flight
//   ripple       — spawns new ring per pulse, bounded by maxRings
//   waveform     — kicks amplitude to max, decay loop handles the rest
//   particles    — spawns burst per pulse, bounded by maxParticles
//   dna          — kicks amplitude to max, decay loop handles the rest
//
// TO ADD A NEW VISUALIZER (zero HTML or compile.py changes required):
//   1. Write a class extending BaseVisualizer.
//   2. Add it to VISUALIZERS map.
//   3. Add its key to VISUALIZER_ORDER.
//   4. Reference it in a preset's visualizer.style field.
//   5. Run compile.py — done.
// ═══════════════════════════════════════════════════════════════════

const CANVAS_SCALE = 2.6; // glow/expansion headroom beyond baseSize


// ── SHARED UTILITIES ──────────────────────────────────────────────

// easeOutSine: fast start, soft landing. Good for pulse attacks.
function easeOutSine(t) { return Math.sin((t * Math.PI) / 2); }


// ═══════════════════════════════════════════════════════════════════
// BASE VISUALIZER
// Abstract class. Subclasses must implement _init() and pulse().
// destroy() is final — do not override; implement _cleanup() instead.
// ═══════════════════════════════════════════════════════════════════
class BaseVisualizer {
    constructor(wrap, cfg) {
        this.wrap   = wrap;
        this.cfg    = cfg;
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
        this.cfg  = null;
    }

    // Shared canvas factory. Clears wrap before mounting.
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
// RING
// Hollow expanding ring that snaps outward then contracts.
// RAP default. Hard edge, high contrast. Fast attack (180ms).
// Dense beats: cancels previous rAF mid-flight and restarts.
// This means overlapping pulses snap to the newest trigger — correct
// behavior since the user sees the most recent beat, not a stale one.
// ═══════════════════════════════════════════════════════════════════
class RingVisualizer extends BaseVisualizer {
    _init() {
        this.scale = 1;
        const sz   = this.cfg.baseSize * CANVAS_SCALE;
        this._makeCanvas(sz, sz);
        this._draw();
    }

    pulse() {
        const { pulseDuration, pulseScale } = this.cfg;
        const start = performance.now();
        const go = now => {
            const p    = Math.min((now - start) / pulseDuration, 1);
            this.scale = 1 + (pulseScale - 1) * Math.sin(p * Math.PI);
            this._draw();
            if (p < 1) this._rafId = requestAnimationFrame(go);
            else { this.scale = 1; this._draw(); }
        };
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(go);
    }

    _draw() {
        if (!this.canvas) return;
        const { ctx, cfg, scale } = this;
        const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
        const r  = (cfg.baseSize / 2) * scale;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth   = cfg.ringWidth;
        ctx.shadowColor = cfg.glowColor;
        ctx.shadowBlur  = 10 + (scale - 1) * 20;
        ctx.globalAlpha = 0.7 + (scale - 1) * 0.3;
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
}


// ═══════════════════════════════════════════════════════════════════
// BLOOM
// Soft radial gradient glow with no hard edge. Ethereal default.
// colorCycle: optional array sampled round-robin per pulse for
// spectral variety (used by aurora preset).
// ═══════════════════════════════════════════════════════════════════
class BloomVisualizer extends BaseVisualizer {
    _init() {
        this.scale     = 1;
        this._colorIdx = 0;
        this._curColor = (this.cfg.colorCycle && this.cfg.colorCycle.length)
                          ? this.cfg.colorCycle[0]
                          : this.cfg.glowColor;
        const sz       = this.cfg.baseSize * CANVAS_SCALE;
        this._makeCanvas(sz, sz);
        this._draw();
    }

    pulse() {
        if (this.cfg.colorCycle && this.cfg.colorCycle.length) {
            this._colorIdx = (this._colorIdx + 1) % this.cfg.colorCycle.length;
            this._curColor = this.cfg.colorCycle[this._colorIdx];
        }
        const { pulseDuration, pulseScale } = this.cfg;
        const start = performance.now();
        const go = now => {
            const p    = Math.min((now - start) / pulseDuration, 1);
            this.scale = 1 + (pulseScale - 1) * Math.sin(p * Math.PI);
            this._draw();
            if (p < 1) this._rafId = requestAnimationFrame(go);
            else { this.scale = 1; this._draw(); }
        };
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(go);
    }

    _draw() {
        if (!this.canvas) return;
        const { ctx, cfg, scale } = this;
        const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
        const r  = (cfg.baseSize / 2) * scale;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.4);
        const a = 0.12 + (scale - 1) * 0.5;
        g.addColorStop(0,    this._alpha(this._curColor, a * 1.5));
        g.addColorStop(0.4,  this._alpha(this._curColor, a));
        g.addColorStop(0.75, this._alpha(this._curColor, a * 0.35));
        g.addColorStop(1,    'rgba(0,0,0,0)');
        ctx.fillStyle   = g;
        ctx.shadowColor = this._curColor;
        ctx.shadowBlur  = 28 + (scale - 1) * 40;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    // Replace alpha component of an rgba() string.
    // Trade-off: regex on every draw frame is ~0.01ms — acceptable vs
    // the complexity of storing pre-parsed color components.
    _alpha(rgba, a) {
        return rgba.replace(/[\d.]+\)$/, `${Math.min(a, 1).toFixed(2)})`);
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
        this._lock = false;
        const w    = this.cfg.baseSize * 3;
        const h    = this.cfg.baseSize * 1.2;
        this.w     = w;
        this.h     = h;
        this._makeCanvas(w, h);
        this._draw(0);
    }

    pulse() {
        // Lock: don't interrupt mid-spike. Correct for a waveform that
        // must be readable as a single shape — overlap destroys legibility.
        if (this._lock) return;
        this._lock  = true;
        const dur   = this.cfg.pulseDuration;
        const start = performance.now();
        const go = now => {
            if (!this.canvas) return; // destroyed mid-animation
            const p = Math.min((now - start) / dur, 1);
            this._draw(p);
            if (p < 1) this._rafId = requestAnimationFrame(go);
            else { this._draw(0); this._lock = false; }
        };
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(go);
    }

    _draw(p) {
        if (!this.canvas) return;
        const { ctx, w, h, cfg } = this;
        ctx.clearRect(0, 0, w, h);
        const cy  = h / 2;
        const amp = (h * 0.38) * Math.sin(p * Math.PI); // envelope

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
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth   = cfg.lineWidth || 1.5;
        ctx.shadowColor = cfg.glowColor;
        ctx.shadowBlur  = 8 + amp * 0.3;
        ctx.globalAlpha = 0.5 + p * 0.5;
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }

    _cleanup() { this._lock = false; }
}


// ═══════════════════════════════════════════════════════════════════
// RIPPLE
// Each pulse spawns an expanding ring that fades as it grows.
// Multiple rings coexist, bounded by maxRings (oldest evicted).
// Uses a single continuous rAF loop shared across all rings —
// one loop is more efficient than per-ring timeouts.
// ═══════════════════════════════════════════════════════════════════
class RippleVisualizer extends BaseVisualizer {
    _init() {
        this._rings = []; // { startTime, duration }
        const sz    = this.cfg.baseSize * CANVAS_SCALE;
        this.sz     = sz;
        this._makeCanvas(sz, sz);
        this._loop();
    }

    pulse() {
        const max = this.cfg.maxRings || 4;
        if (this._rings.length >= max) this._rings.shift(); // FIFO eviction
        this._rings.push({ startTime: performance.now(), duration: this.cfg.pulseDuration });
    }

    _loop() {
        if (!this.canvas) return;
        const { ctx, sz, cfg } = this;
        const cx = sz / 2, cy = sz / 2;
        const maxR = (cfg.baseSize / 2) * 2.2;
        ctx.clearRect(0, 0, sz, sz);
        const now = performance.now();
        this._rings = this._rings.filter(ring => {
            const p = (now - ring.startTime) / ring.duration;
            if (p >= 1) return false;
            const r = maxR * easeOutSine(p);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth   = (cfg.ringWidth || 1.5) * (1 - p * 0.5);
            ctx.shadowColor = cfg.glowColor;
            ctx.shadowBlur  = 12 * (1 - p);
            ctx.globalAlpha = (1 - p) * 0.7;
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
        this._amplitude = 0;
        this._phase     = 0;
        const w = this.cfg.baseSize * 3;
        const h = this.cfg.baseSize * 1.4;
        this.w  = w;
        this.h  = h;
        this._makeCanvas(w, h);
        this._loop();
    }

    pulse() {
        this._amplitude = this.cfg.waveAmplitude || 14;
    }

    _loop() {
        if (!this.canvas) return;
        const { ctx, w, h, cfg } = this;
        const freq     = cfg.waveFrequency || 3;
        const maxAmp   = cfg.waveAmplitude || 14;
        const decayRate = this._amplitude > 0.05
            ? (this._amplitude / (cfg.pulseDuration / 16.67)) * 1.2
            : 0;
        this._amplitude = Math.max(0, this._amplitude - decayRate);
        this._phase    += 0.04;

        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        const cy = h / 2;
        for (let px = 0; px <= w; px++) {
            const x   = px / w;
            const env = Math.sin(x * Math.PI); // edge taper 0→1→0
            const y   = cy - Math.sin(x * Math.PI * 2 * freq + this._phase) * this._amplitude * env;
            px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        const intensity = this._amplitude / maxAmp;
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth   = cfg.lineWidth || 2;
        ctx.shadowColor = cfg.glowColor;
        ctx.shadowBlur  = 4 + intensity * 12;
        ctx.globalAlpha = 0.45 + intensity * 0.55;
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
        const sz = this.cfg.baseSize * CANVAS_SCALE;
        this.sz  = sz;
        this._makeCanvas(sz, sz);
        this._loop();
    }

    pulse() {
        const { cfg, sz } = this;
        const max   = cfg.maxParticles || 60;
        const count = cfg.particlesPerBurst || 12;
        const cx = sz / 2, cy = sz / 2;
        // Evict oldest before spawning — preserves a hard particle cap
        if (this._particles.length + count > max) {
            this._particles.splice(0, count);
        }
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.4;
            const speed = cfg.baseSize * 0.012 + Math.random() * cfg.baseSize * 0.014;
            this._particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                r: 1.5 + Math.random() * 2,
                life: 1.0,
                decay: 0.018 + Math.random() * 0.012,
            });
        }
    }

    _loop() {
        if (!this.canvas) return;
        const { ctx, sz, cfg } = this;
        ctx.clearRect(0, 0, sz, sz);
        this._particles = this._particles.filter(p => {
            p.x   += p.vx;
            p.y   += p.vy;
            p.vx  *= 0.96; // drag
            p.vy  *= 0.96;
            p.life -= p.decay;
            if (p.life <= 0) return false;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
            ctx.fillStyle   = cfg.color;
            ctx.shadowColor = cfg.glowColor;
            ctx.shadowBlur  = 4;
            ctx.globalAlpha = p.life * 0.85;
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
        this._restAmp = this.cfg.baseSize * 0.12;
        this._maxAmp  = this.cfg.baseSize * 0.42;
        this._amp     = this._restAmp;
        this._phase   = 0;
        const w = this.cfg.baseSize * 3;
        const h = this.cfg.baseSize * 1.4;
        this.w  = w;
        this.h  = h;
        this._makeCanvas(w, h);
        this._loop();
    }

    pulse() { this._amp = this._maxAmp; }

    _loop() {
        if (!this.canvas) return;
        const { ctx, w, h, cfg } = this;
        // Exponential decay toward rest — more organic than linear
        this._amp  = this._restAmp + (this._amp - this._restAmp) * 0.945;
        this._phase += 0.03;
        ctx.clearRect(0, 0, w, h);
        const cy      = h / 2;
        const freq    = 2.5;
        const rungs   = 8;
        const glow    = ((this._amp - this._restAmp) / (this._maxAmp - this._restAmp)) * 14;
        const alpha   = 0.45 + ((this._amp - this._restAmp) / (this._maxAmp - this._restAmp)) * 0.4;
        this._strand(ctx, w, cy, this._amp, freq, 0,         cfg, glow, alpha);
        this._strand(ctx, w, cy, this._amp, freq, Math.PI,   cfg, glow, alpha * 0.7);
        // Rungs
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth   = (cfg.lineWidth || 1.5) * 0.6;
        ctx.globalAlpha = alpha * 0.35;
        ctx.shadowColor = cfg.glowColor;
        ctx.shadowBlur  = glow * 0.5;
        for (let i = 0; i <= rungs; i++) {
            const xN = i / rungs;
            const y1 = cy - Math.sin(xN * Math.PI * 2 * freq + this._phase) * this._amp;
            const y2 = cy - Math.sin(xN * Math.PI * 2 * freq + this._phase + Math.PI) * this._amp;
            ctx.beginPath(); ctx.moveTo(xN * w, y1); ctx.lineTo(xN * w, y2); ctx.stroke();
        }
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
        this._rafId = requestAnimationFrame(() => this._loop());
    }

    _strand(ctx, w, cy, amp, freq, offset, cfg, glow, alpha) {
        ctx.beginPath();
        for (let px = 0; px <= w; px++) {
            const y = cy - Math.sin((px / w) * Math.PI * 2 * freq + this._phase + offset) * amp;
            px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth   = cfg.lineWidth || 1.5;
        ctx.shadowColor = cfg.glowColor;
        ctx.shadowBlur  = glow;
        ctx.globalAlpha = alpha;
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
}


// ═══════════════════════════════════════════════════════════════════
// VISUALIZERS MAP
// Keys must match preset.visualizer.style values in presets.js.
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
// compile.py reads this to determine what to include.
// ─────────────────────────────────────────────────────────────────
export const VISUALIZER_ORDER = ['particles', 'waveform', 'dna', 'heartbeat', 'ripple', 'ring', 'bloom', 'off'];

// // ─────────────────────────────────────────────────────────────────
// // DEFAULT_VISUALIZERS — always included regardless of --visualizer flag.
// // ─────────────────────────────────────────────────────────────────
// export const DEFAULT_VISUALIZERS = ['particles', 'waveform'];
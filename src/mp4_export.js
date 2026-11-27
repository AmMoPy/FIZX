// ═══════════════════════════════════════════════════════════════════════════════════
// export the RUNNING TEMPLATE to an MP4, frame by frame, as a screen recording would show it.
//
// How it works (nothing is re-implemented):
//   1. A virtual clock replaces performance.now / requestAnimationFrame / Element.animate. The template's own displayLoop,
//      the legacy visualizers' loops, AnimCore and its Web Animations then run on frame time, not wall time.
//   2. Each frame the real DOM ends up in exactly the state a viewer would see (preset LUT scrub on #currentLine, flash on
//      .screen, AnimCore's text wrappers, the canvases).
//   3. The "photographer" reads that state back (getComputedStyle + element boxes) and paints the stage onto one canvas:
//      container gradient, screen frame and shadows, masterCanvas, circle canvas, CRT layers, lyric layers.
//   4. The canvas goes to a WebCodecs encoder with an explicit timestamp; audio is encoded alongside; mp4-muxer writes the file.
//
// Needs: the template's globals (stageEl, screenEl, masterCanvas, core, vizs, displayLoop, audioBuffer ...), the mp4-muxer UMD (Mp4Muxer).
// Not painted: the control row under the screen (seek bar, stats, buttons).
//
// Limitation: Export time on a machine without hardware H.264 encoding is dominated by the software encoder, which is slow!
// ═══════════════════════════════════════════════════════════════════════════════════
const FizxExport = (() => {
    'use strict';
    const FAR = 20000;                                         // canvas shadows: draw the caster far off-canvas, let only its shadow land here

    // ───────────────────────── CSS value helpers ─────────────────────────
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    function splitTop(text) {
        const parts = []; let depth = 0, current = '';
        for (const ch of text) {
            if (ch === '(') depth++; else if (ch === ')') depth--;
            if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += ch;
        }
        if (current.trim()) parts.push(current.trim());
        return parts;
    }
    const COLOR_RE = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|hsla?\([^)]*\)/i;
    function parseShadows(value) {                             // computed box-shadow / text-shadow list
        if (!value || value === 'none') return [];
        return splitTop(value).map((part) => {
            const colorMatch = part.match(COLOR_RE);
            const color = colorMatch ? colorMatch[0] : 'rgba(0,0,0,1)';
            const rest = part.replace(color, ' ');
            const inset = /\binset\b/.test(rest);
            const numbers = rest.replace('inset', ' ').trim().split(/\s+/).map(parseFloat).filter((n) => !isNaN(n));
            return { color, inset, x: numbers[0] || 0, y: numbers[1] || 0, blur: numbers[2] || 0, spread: numbers[3] || 0 };
        });
    }
    function parseLinearGradient(value) {                      // "linear-gradient(145deg, c1 0%, c2 100%)"
        const match = value && value.match(/^linear-gradient\((.*)\)$/s);
        if (!match) return null;
        const parts = splitTop(match[1]);
        let angle = 180;
        if (/^-?[\d.]+deg$/.test(parts[0])) angle = parseFloat(parts.shift());
        else if (/^to /.test(parts[0])) { const d = parts.shift(); angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }[d.trim()] ?? 180; }
        const stops = parts.map((part) => {
            const color = (part.match(COLOR_RE) || ['#000'])[0];
            const pos = part.replace(color, '').trim();
            return { color, pos: pos.endsWith('%') ? parseFloat(pos) / 100 : null };
        });
        stops.forEach((stop, i) => { if (stop.pos === null) stop.pos = stops.length > 1 ? i / (stops.length - 1) : 0; });
        return { angle, stops };
    }
    function makeCssGradient(ctx, gradient, x, y, w, h) {      // CSS gradient line for an angle in a box
        const rad = gradient.angle * Math.PI / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
        const length = Math.abs(w * dx) + Math.abs(h * dy), cx = x + w / 2, cy = y + h / 2;
        const g = ctx.createLinearGradient(cx - dx * length / 2, cy - dy * length / 2, cx + dx * length / 2, cy + dy * length / 2);
        gradient.stops.forEach((stop) => g.addColorStop(clamp(stop.pos, 0, 1), stop.color));
        return g;
    }
    function addRoundRect(path, x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        path.moveTo(x + r, y); path.lineTo(x + w - r, y); path.arcTo(x + w, y, x + w, y + r, r);
        path.lineTo(x + w, y + h - r); path.arcTo(x + w, y + h, x + w - r, y + h, r);
        path.lineTo(x + r, y + h); path.arcTo(x, y + h, x, y + h - r, r);
        path.lineTo(x, y + r); path.arcTo(x, y, x + r, y, r); path.closePath();
    }

    // Border-box of `el` in the coordinates of `root`'s border box, IGNORING transforms (offset* is layout, not painted position)
    function layoutBox(el, root) {
        let x = 0, y = 0, node = el;
        while (node && node !== root) {
            x += node.offsetLeft; y += node.offsetTop;
            const parent = node.offsetParent;
            if (!parent) break;
            x += parent.clientLeft; y += parent.clientTop;
            if (parent === root) break;
            node = parent;
        }
        return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    }
    function parseMatrix(transform) { return transform && transform !== 'none' ? new DOMMatrix(transform) : null; }

    // ───────────────────────── yield helpers ───────────────────────────────────────────────────────
    const yieldToEventLoop = (() => {
        const ch = new MessageChannel(); let waiting = [];
        ch.port1.onmessage = () => { const w = waiting; waiting = []; w.forEach((f) => f()); };
        return () => new Promise((res) => { waiting.push(res); ch.port2.postMessage(0); });
    })();

    // ───────────────────────── scratch canvases (never allocate per frame) ─────────────────────────
    const scratchPool = [];
    function scratch(w, h) {
        w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
        let c = scratchPool.pop();
        if (!c) c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } else c.getContext('2d').clearRect(0, 0, w, h);
        c.getContext('2d').setTransform(1, 0, 0, 1, 0, 0);
        return c;
    }
    const release = (c) => scratchPool.push(c);

    // ───────────────────────── virtual clock ─────────────────────────
    // While installed, the page believes it is running at exactly the frame rate we step it: one runFrame() = one rAF tick.
    const clock = { active: false, now: 0, nextId: 0, queue: [], animations: [], saved: null, realNow: null };
    function installClock(startMs) {
        if (clock.active) return;
        clock.realNow = performance.now.bind(performance);                 // the real clock, still available while the virtual one is installed
        clock.saved = {
            now: performance.now, raf: window.requestAnimationFrame, caf: window.cancelAnimationFrame,     // the original function objects, restored by identity
            animate: Element.prototype.animate, dpr: Object.getOwnPropertyDescriptor(window, 'devicePixelRatio'),
        };
        clock.now = startMs; clock.queue = []; clock.animations = []; clock.active = true;
        performance.now = () => clock.now;
        window.requestAnimationFrame = (callback) => { const id = ++clock.nextId; clock.queue.push([id, callback]); return id; };
        window.cancelAnimationFrame = (id) => { clock.queue = clock.queue.filter((entry) => entry[0] !== id); };
        Element.prototype.animate = function () {              // Web Animations (AnimCore's text transitions): created paused, sought by us
            const animation = clock.saved.animate.apply(this, arguments);
            animation.pause(); animation.__vStart = clock.now; clock.animations.push(animation);
            if (clock.animations.length > 24) clock.animations.splice(0, clock.animations.length - 24);
            return animation;
        };
    }
    function removeClock() {
        if (!clock.active) return;
        performance.now = clock.saved.now; window.requestAnimationFrame = clock.saved.raf; window.cancelAnimationFrame = clock.saved.caf;
        Element.prototype.animate = clock.saved.animate;
        if (clock.saved.dpr) Object.defineProperty(window, 'devicePixelRatio', clock.saved.dpr); else delete window.devicePixelRatio;
        clock.active = false; clock.queue = []; clock.animations = [];
    }
    function syncAnimations() {
        for (const animation of clock.animations) {
            if (animation.playState === 'idle') continue;
            animation.currentTime = Math.max(0, clock.now - animation.__vStart);
        }
    }
    // One displayed frame: advance the clock, let every queued rAF callback run once, then pin every Web Animation to frame time
    function runFrame(nowMs) {
        clock.now = nowMs;
        syncAnimations();
        const queue = clock.queue; clock.queue = [];
        for (const entry of queue) entry[1](nowMs);
        syncAnimations();                                      // animations created by the callbacks start at 0, like a fresh play()
    }

    // ───────────────────────── the photographer ─────────────────────────
    const ids = (name) => document.getElementById(name);
    function opacityChain(el, stop) { let o = 1; for (let n = el; n && n !== stop; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; }
    function isHidden(el, stop) { for (let n = el; n && n !== stop; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return true; } return false; }

    // exact full-resolution shadows (used for hard-edged ones)
    function paintOuterShadow(ctx, box, radius, shadow, s) {
        ctx.save();
        const clip = new Path2D(); clip.rect(-FAR, -FAR, FAR * 2, FAR * 2); addRoundRect(clip, box.x, box.y, box.w, box.h, radius);
        ctx.clip(clip, 'evenodd');                             // CSS never paints a drop shadow under its own box
        ctx.shadowColor = shadow.color; ctx.shadowBlur = shadow.blur * s; ctx.shadowOffsetX = (shadow.x + FAR) * s; ctx.shadowOffsetY = shadow.y * s;
        const grow = shadow.spread; const caster = new Path2D();
        addRoundRect(caster, box.x - grow - FAR, box.y - grow, box.w + 2 * grow, box.h + 2 * grow, Math.max(0, radius + grow));
        ctx.fillStyle = '#000'; ctx.fill(caster);
        ctx.restore();
    }
    function paintInsetShadow(ctx, box, radius, shadow, s) {
        ctx.save();
        const inside = new Path2D(); addRoundRect(inside, box.x, box.y, box.w, box.h, radius); ctx.clip(inside);
        const frame = new Path2D(); frame.rect(box.x - FAR - 2000, box.y - 2000, box.w + 4000, box.h + 4000);
        const hole = Math.max(0, shadow.spread);
        addRoundRect(frame, box.x + hole - FAR, box.y + hole, box.w - 2 * hole, box.h - 2 * hole, Math.max(0, radius - hole));
        ctx.shadowColor = shadow.color; ctx.shadowBlur = shadow.blur * s; ctx.shadowOffsetX = (shadow.x + FAR) * s; ctx.shadowOffsetY = shadow.y * s;
        ctx.fillStyle = '#000'; ctx.fill(frame, 'evenodd');
        ctx.restore();
    }
    // Soft shadows are smooth by definition: build the shadow mask at a fraction of the resolution, blur it there (cheap on a small
    // canvas), and let smoothing scale it up. Hard-edged shadows (blur under ~3 device px) fall back to the exact full-resolution painters.
    function paintShadowLayer(ctx, box, radius, shadow, s, inset) {
        const device = shadow.blur * s;
        if (device < 6) { (inset ? paintInsetShadow : paintOuterShadow)(ctx, box, radius, shadow, s); return; }
        const r = clamp(10 / device, 0.1, 0.5);
        const reach = shadow.blur * 1.5 + Math.abs(shadow.x) + Math.abs(shadow.y) + Math.max(0, shadow.spread) + 2;
        const region = { x: box.x - reach, y: box.y - reach, w: box.w + reach * 2, h: box.h + reach * 2 };
        const k = s * r, wl = Math.ceil(region.w * k), hl = Math.ceil(region.h * k);
        const mask = scratch(wl, hl), m = mask.getContext('2d');
        m.setTransform(k, 0, 0, k, -region.x * k, -region.y * k);
        m.fillStyle = shadow.color;
        const spread = shadow.spread;
        if (!inset) {                                                       // the caster: the box grown by the spread, moved by the offset
            const caster = new Path2D(); addRoundRect(caster, box.x + shadow.x - spread, box.y + shadow.y - spread, box.w + 2 * spread, box.h + 2 * spread, Math.max(0, radius + spread));
            m.fill(caster);
        } else {                                                            // everything outside the box shrunk by the spread
            m.fillRect(region.x, region.y, region.w, region.h);
            const hole = new Path2D(); addRoundRect(hole, box.x + shadow.x + spread, box.y + shadow.y + spread, box.w - 2 * spread, box.h - 2 * spread, Math.max(0, radius - spread));
            m.globalCompositeOperation = 'destination-out'; m.fillStyle = '#000'; m.fill(hole); m.globalCompositeOperation = 'source-over';
        }
        const soft = scratch(wl, hl), q = soft.getContext('2d');
        q.filter = `blur(${shadow.blur / 2 * k}px)`; q.drawImage(mask, 0, 0); q.filter = 'none';
        const boxPath = new Path2D(); q.setTransform(k, 0, 0, k, -region.x * k, -region.y * k); addRoundRect(boxPath, box.x, box.y, box.w, box.h, radius);
        q.globalCompositeOperation = inset ? 'destination-in' : 'destination-out'; q.fillStyle = '#000'; q.fill(boxPath); q.globalCompositeOperation = 'source-over';
        ctx.save(); ctx.imageSmoothingEnabled = true;
        if (!inset) { const outside = new Path2D(); outside.rect(region.x, region.y, region.w, region.h); addRoundRect(outside, box.x, box.y, box.w, box.h, radius); ctx.clip(outside, 'evenodd'); }   // only the ring that shows is worth scaling up
        ctx.drawImage(soft, 0, 0, wl, hl, region.x, region.y, region.w, region.h);
        ctx.restore(); release(mask); release(soft);
    }

    // applies one ancestor's CSS transform (about its own transform-origin) to the context
    function applyBoxTransform(ctx, el, rootEl) {
        const cs = getComputedStyle(el), matrix = parseMatrix(cs.transform);
        if (!matrix) return;
        const box = layoutBox(el, rootEl), origin = cs.transformOrigin.split(' ').map(parseFloat);
        const ox = box.x + (origin[0] || 0), oy = box.y + (origin[1] || 0);
        ctx.translate(ox, oy); ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f); ctx.translate(-ox, -oy);
    }

    function wrapLines(measureCtx, text, maxWidth, whiteSpace) {   // CSS white-space: newlines kept only for pre-line / pre-wrap / pre; spaces collapsed; greedy wrap
        const out = [], keepNewlines = /^pre/.test(whiteSpace), noWrap = whiteSpace === 'nowrap' || whiteSpace === 'pre';
        text = keepNewlines ? String(text) : String(text).replace(/\s*\n\s*/g, ' ');
        for (const paragraph of text.split('\n')) {
            let line = '';
            for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
                const trial = line ? line + ' ' + word : word;
                if (!noWrap && line && measureCtx.measureText(trial).width > maxWidth) { out.push(line); line = word; } else line = trial;
            }
            out.push(line);
        }
        return out;
    }
    const measureCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');

    // Paints one text element exactly as its computed style says: opacity, filter, clip-path, transform, text-shadow, outline.
    // (The preset's LUT effect and AnimCore's glow are both just CSS on these elements, so this one routine covers both.)
    // Fast path: no filter / clip-path / outline means the text can be drawn straight into the frame (canvas shadows do text-shadow).
    function paintTextElement(ctx, el, stageRoot, s, textOverride) {
        const cs = getComputedStyle(el);
        const text = textOverride !== undefined ? textOverride : el.textContent;
        const opacity = parseFloat(cs.opacity);
        if (cs.display === 'none' || cs.visibility === 'hidden' || opacity <= 0.001) return;
        const box = layoutBox(el, stageRoot);
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        measureCtx.font = font;
        const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0, padT = parseFloat(cs.paddingTop) || 0;
        const borderL = parseFloat(cs.borderLeftWidth) || 0, borderT = parseFloat(cs.borderTopWidth) || 0;
        const contentW = box.w - borderL - (parseFloat(cs.borderRightWidth) || 0) - padL - padR;
        const lines = text ? wrapLines(measureCtx, text, contentW, cs.whiteSpace) : [];
        const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        const m = measureCtx.measureText('Hg'), ascent = m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.95, descent = m.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.25;
        const textX = box.x + borderL + padL + contentW / 2, top = box.y + borderT + padT;
        const shadows = parseShadows(cs.textShadow);
        const filter = cs.filter, clip = cs.clipPath, matrix = parseMatrix(cs.transform);
        const outlineW = parseFloat(cs.outlineWidth) || 0, hasOutline = outlineW > 0 && cs.outlineStyle !== 'none';
        const borderTopW = parseFloat(cs.borderTopWidth) || 0, hasBorderTop = borderTopW > 0 && cs.borderTopStyle !== 'none';
        const needsLayer = (filter && filter !== 'none') || (clip && clip !== 'none') || hasOutline;
        const origin = cs.transformOrigin.split(' ').map(parseFloat), ox = box.x + (origin[0] || 0), oy = box.y + (origin[1] || 0);
        const baseline = (i) => top + i * lineH + (lineH - (ascent + descent)) / 2 + ascent;
        const drawBorderTop = (c) => {
            c.save(); c.strokeStyle = cs.borderTopColor; c.lineWidth = borderTopW;
            if (cs.borderTopStyle === 'dashed') c.setLineDash([borderTopW * 3, borderTopW * 3]);
            c.beginPath(); c.moveTo(box.x, box.y + borderTopW / 2); c.lineTo(box.x + box.w, box.y + borderTopW / 2); c.stroke(); c.restore();
        };

        // ── fast path: straight into the frame ──
        const t = ctx.getTransform();
        if (!needsLayer && Math.abs(t.b) + Math.abs(t.c) < 1e-6 && Math.abs(t.a - t.d) < 1e-6) {
            ctx.save();
            if (matrix) { ctx.translate(ox, oy); ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f); ctx.translate(-ox, -oy); }
            ctx.globalAlpha *= opacity;
            ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            if (cs.letterSpacing !== 'normal' && 'letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing;
            const k = ctx.getTransform().a;                                  // device px per CSS px at this point
            lines.forEach((line, i) => {
                const y = baseline(i);
                for (let n = shadows.length - 1; n >= 0; n--) {              // text-shadow: draw each shadow alone, far off-canvas, offset back
                    const sh = shadows[n]; ctx.save();
                    ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur * k; ctx.shadowOffsetX = (sh.x + FAR) * k; ctx.shadowOffsetY = sh.y * k;
                    ctx.fillStyle = '#000'; ctx.fillText(line, textX - FAR, y); ctx.restore();
                }
                ctx.fillStyle = cs.color; ctx.fillText(line, textX, y);
            });
            if (hasBorderTop) drawBorderTop(ctx);
            ctx.restore();
            return;
        }

        // ── layered path: filter / clip-path / outline need the element rendered on its own first ──
        const textW = lines.reduce((a, line) => Math.max(a, measureCtx.measureText(line).width), 0);
        const blurPx = (filter.match(/(?:blur|drop-shadow)\([^)]*\)/g) || []).reduce((a, f) => Math.max(a, ...(f.match(/-?[\d.]+px/g) || []).map(parseFloat)), 0);
        const reach = shadows.reduce((a, sh) => Math.max(a, sh.blur + Math.abs(sh.x) + Math.abs(sh.y)), 0);
        const outlineReach = outlineW + (parseFloat(cs.outlineOffset) || 0);
        const margin = Math.ceil(6 + 2 * Math.max(reach, blurPx * 1.5) + outlineReach);
        const wide = hasOutline || hasBorderTop || (clip && clip !== 'none');   // these are tied to the whole box, not the glyphs
        const bx = (wide ? box.x : textX - textW / 2) - margin, bw = (wide ? box.w : textW) + margin * 2;
        const by = (wide ? box.y : top) - margin, bh = (wide ? box.h : lines.length * lineH) + margin * 2;
        const onlyBlur = /^blur\(([\d.]+)px\)$/.exec(filter);                  // a glow layer: soft by definition, so build it small
        const q = onlyBlur ? clamp(8 / (parseFloat(onlyBlur[1]) * s), 0.2, 1) : 1, sq = s * q;
        const drawShadows = onlyBlur ? [{ x: 0, y: 0, blur: 2 * parseFloat(onlyBlur[1]), color: cs.color }] : shadows;
        const A = scratch(bw * sq, bh * sq), a = A.getContext('2d');
        a.setTransform(sq, 0, 0, sq, -bx * sq, -by * sq);
        a.font = font; a.textAlign = 'center'; a.textBaseline = 'alphabetic';
        if (cs.letterSpacing !== 'normal' && 'letterSpacing' in a) a.letterSpacing = cs.letterSpacing;
        lines.forEach((line, i) => {
            const y = baseline(i);
            for (let n = drawShadows.length - 1; n >= 0; n--) {
                const sh = drawShadows[n]; a.save();
                a.shadowColor = sh.color; a.shadowBlur = sh.blur * sq; a.shadowOffsetX = (sh.x + FAR) * sq; a.shadowOffsetY = sh.y * sq;
                a.fillStyle = '#000'; a.fillText(line, textX - FAR, y); a.restore();
            }
            if (!onlyBlur) { a.fillStyle = cs.color; a.fillText(line, textX, y); }   // blur-only layer = shadow only
        });
        if (hasBorderTop) drawBorderTop(a);
        if (hasOutline) { const g = (parseFloat(cs.outlineOffset) || 0) + outlineW / 2; a.save(); a.strokeStyle = cs.outlineColor; a.lineWidth = outlineW; a.strokeRect(box.x - g, box.y - g, box.w + 2 * g, box.h + 2 * g); a.restore(); }
        let layer = A;
        if (filter && filter !== 'none' && !onlyBlur) {                  // filter, then clip-path, then opacity, then transform: CSS order
            const B = scratch(bw * sq, bh * sq), b = B.getContext('2d');
            b.filter = filter.replace(/(-?[\d.]+)px/g, (_, n) => (parseFloat(n) * sq) + 'px');
            b.drawImage(A, 0, 0); b.filter = 'none'; release(A); layer = B;
        }
        if (clip && clip.startsWith('inset(')) {
            const lc = layer.getContext('2d');
            const p = clip.slice(6, -1).split(/\s+/), L = (tok, ref) => tok.endsWith('%') ? parseFloat(tok) / 100 * ref : parseFloat(tok);
            const top2 = L(p[0], box.h), right = L(p[1] ?? p[0], box.w), bottom = L(p[2] ?? p[0], box.h), left = L(p[3] ?? p[1] ?? p[0], box.w);
            lc.globalCompositeOperation = 'destination-in'; lc.fillStyle = '#000';
            lc.fillRect((box.x - bx + left) * sq, (box.y - by + top2) * sq, (box.w - left - right) * sq, (box.h - top2 - bottom) * sq);
            lc.globalCompositeOperation = 'source-over';
        }
        ctx.save();
        if (matrix) { ctx.translate(ox, oy); ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f); ctx.translate(-ox, -oy); }
        ctx.globalAlpha *= opacity; ctx.imageSmoothingEnabled = true;
        ctx.drawImage(layer, 0, 0, layer.width, layer.height, bx, by, bw, bh);
        ctx.restore();
        release(layer);
    }

    // CRT scan sweep
    const _rgbCache = new Map();

    function cssToRGB(css) {
        let v = _rgbCache.get(css);
        if (!v) {
            const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
            const x = c.getContext('2d', { willReadFrequently: true });
            x.fillStyle = css; x.fillRect(0, 0, 1, 1);
            const d = x.getImageData(0, 0, 1, 1).data;
            v = { rgb: `${d[0]},${d[1]},${d[2]}`, a: d[3] / 255 };
            _rgbCache.set(css, v);
        }
        return v;
    }

    function paintScanBand(ctx, pad) {
        const scanColor = getComputedStyle(screenEl).getPropertyValue('--scan-color').trim();
        if (!scanColor) return;
        const anim = screenEl.getAnimations({ subtree: true }).find((a) => a.effect && a.effect.pseudoElement === '::before');
        if (anim) { anim.pause(); anim.currentTime = Math.max(0, clock.now - _scanStart); }   // pin the CSS animation to frame time
        const raw = getComputedStyle(screenEl, '::before').backgroundPosition.split(',');
        const yTok = ((raw[1] || raw[0]).trim().split(/\s+/)[1]) || '0%';                       // layer 2 = the band
        const bandH = pad.h * 0.3;                                                              // background-size: 100% 30%
        const off = yTok.endsWith('%') ? (pad.h - bandH) * parseFloat(yTok) / 100 : parseFloat(yTok);
        const { rgb, a } = cssToRGB(scanColor);
        const first = pad.y + (((off % bandH) + bandH) % bandH) - bandH;                        // background-repeat: repeat
        for (let y = first; y < pad.y + pad.h; y += bandH) {
            const g = ctx.createLinearGradient(0, y, 0, y + bandH);
            g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(0.5, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
            ctx.fillStyle = g; ctx.fillRect(pad.x, y, pad.w, bandH);
        }
    }

    // Paints the whole stage for the CURRENT DOM state onto ctx's canvas. `scale` = output px per CSS px. `probe(name)` is an optional profiling hook.
    function photograph(ctx, scale, probe) {
        const mark = probe || (() => {});
        const stageRect = stageEl.getBoundingClientRect(), W = stageRect.width, H = stageRect.height, s = scale;
        const rel = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - stageRect.left, y: r.top - stageRect.top, w: r.width, h: r.height }; };
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowColor = 'transparent';
        const attrs = ctx.getContextAttributes ? ctx.getContextAttributes() : { alpha: true };
        if (attrs.alpha !== false) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);    // an opaque canvas is fully repainted below, so skip the clear
        ctx.setTransform(s, 0, 0, s, 0, 0);

        // 1. container: the stage's gradient background (rendered once, then only the parts the screen does not hide are copied)
        const container = document.querySelector('.container'), cbox = rel(container), ccs = getComputedStyle(container);
        const gradient = parseLinearGradient(ccs.backgroundImage);
        const cacheKey = [ccs.backgroundImage, ccs.backgroundColor, cbox.w, cbox.h, s].join('|');
        if (!photograph.containerCache || photograph.containerCache.key !== cacheKey) {
            const bmp = document.createElement('canvas'); bmp.width = Math.ceil(cbox.w * s); bmp.height = Math.ceil(cbox.h * s);
            const b = bmp.getContext('2d'); b.setTransform(s, 0, 0, s, 0, 0);
            b.fillStyle = gradient ? makeCssGradient(b, gradient, 0, 0, cbox.w, cbox.h) : ccs.backgroundColor; b.fillRect(0, 0, cbox.w, cbox.h);
            photograph.containerCache = { key: cacheKey, bmp };
        }
        const cacheBmp = photograph.containerCache.bmp, kx = cacheBmp.width / cbox.w, ky = cacheBmp.height / cbox.h;
        const piece = (x, y, w, h) => { if (w > 0 && h > 0) ctx.drawImage(cacheBmp, (x - cbox.x) * kx, (y - cbox.y) * ky, w * kx, h * ky, x, y, w, h); };
        const sr = rel(screenEl), rad = parseFloat(getComputedStyle(screenEl).borderTopLeftRadius) || 0;       // the screen hides the middle: paint only what shows
        piece(cbox.x, cbox.y, cbox.w, sr.y - cbox.y);                                                         // above
        piece(cbox.x, sr.y + sr.h, cbox.w, cbox.y + cbox.h - sr.y - sr.h);                                    // below
        piece(cbox.x, sr.y, sr.x - cbox.x, sr.h); piece(sr.x + sr.w, sr.y, cbox.x + cbox.w - sr.x - sr.w, sr.h); // left, right
        for (const [cx, cy] of [[sr.x, sr.y], [sr.x + sr.w - rad, sr.y], [sr.x, sr.y + sr.h - rad], [sr.x + sr.w - rad, sr.y + sr.h - rad]]) piece(cx, cy, rad, rad);   // behind the rounded corners
        mark('container');

        // 2. screen frame: outer shadows, background, inset shadows, then the clipped content, then the border
        const sbox = sr, scs = getComputedStyle(screenEl);
        const radius = parseFloat(scs.borderTopLeftRadius) || 0, bw = parseFloat(scs.borderTopWidth) || 0;
        const faint = (sh) => { const n = sh.color.match(/[\d.]+/g) || [0, 0, 0, 1]; return Math.max(n[0], n[1], n[2]) * (n.length > 3 ? parseFloat(n[3]) : 1) < 1.2; };   // would shift a pixel by at most one level
        const shadows = parseShadows(scs.boxShadow).filter((sh) => !faint(sh));
        for (let i = shadows.length - 1; i >= 0; i--) if (!shadows[i].inset) paintShadowLayer(ctx, sbox, radius, shadows[i], s, false);
        mark('outer shadows');
        const outer = new Path2D(); addRoundRect(outer, sbox.x, sbox.y, sbox.w, sbox.h, radius);
        ctx.fillStyle = scs.backgroundColor; ctx.fill(outer);
        mark('screen bg');
        const pad = { x: sbox.x + bw, y: sbox.y + bw, w: sbox.w - 2 * bw, h: sbox.h - 2 * bw }, padRadius = Math.max(0, radius - bw);
        for (let i = shadows.length - 1; i >= 0; i--) if (shadows[i].inset) paintShadowLayer(ctx, pad, padRadius, shadows[i], s, true);
        mark('screen shadows+bg');

        ctx.save();
        const inner = new Path2D(); addRoundRect(inner, pad.x, pad.y, pad.w, pad.h, padRadius); ctx.clip(inner);   // overflow: hidden

        // 2a. masterCanvas (background fill, dust, legacy visualizer)
        const mbox = rel(masterCanvas); ctx.drawImage(masterCanvas, mbox.x, mbox.y, mbox.w, mbox.h);
        mark('masterCanvas');

        // 2b. the AnimCore circle (draggable box above the master canvas, below CRT and lyrics)
        const circleCanvas = core && core.circleCanvasEl;
        if (circleCanvas && !isHidden(circleCanvas, screenEl)) {
            const cb = rel(circleCanvas); ctx.save(); ctx.globalAlpha = opacityChain(circleCanvas, screenEl);
            ctx.drawImage(circleCanvas, cb.x, cb.y, cb.w, cb.h); ctx.restore();
        }
        mark('circle');

        // 2c. CRT scanlines + vignette (CSS pseudo-elements in the template)
        if (screenEl.classList.contains('crt-on')) {
            const color = getComputedStyle(screenEl).getPropertyValue('--crt-color').trim();
            if (color) { ctx.fillStyle = color; for (let y = pad.y + pad.h - 5; y > pad.y - 5; y -= 5) ctx.fillRect(pad.x, y + 3, pad.w, 2); }   // 0deg: lit 0-2px from the bottom, dark 2-5px
            if (screenEl.classList.contains('scan-active')) paintScanBand(ctx, pad);
            const cx = pad.x + pad.w * 0.5, cy = pad.y + pad.h * 0.4, far = Math.hypot(Math.max(cx - pad.x, pad.x + pad.w - cx), Math.max(cy - pad.y, pad.y + pad.h - cy));
            const vignette = ctx.createRadialGradient(cx, cy, 0, cx, cy, far);
            vignette.addColorStop(0.5, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
            ctx.fillStyle = vignette; ctx.fillRect(pad.x, pad.y, pad.w, pad.h);
        }
        mark('crt');

        // 2d. lyric layers: AnimCore's wrappers (breathe, in/out) around the blurred glow and the preset-styled current line
        const lyricArea = document.querySelector('.lyric-area');
        if (lyricArea && !isHidden(lyricArea, stageEl)) {
            const breathe = ids('lyricBreathe'), io = ids('lineIO'), glow = ids('lineGlow'), current = ids('currentLine'), next = ids('nextLine');
            const lb = rel(lyricArea), gx = Math.max(0, lb.x - 40), gy = Math.max(0, lb.y - 40), gw = Math.min(W - gx, lb.w + 80), gh = Math.min(H - gy, lb.h + 80);   // the lyric area plus room for glow
            const group = scratch(gw * s, gh * s), g = group.getContext('2d');
            g.setTransform(s, 0, 0, s, -gx * s, -gy * s);
            applyBoxTransform(g, breathe, stageEl); applyBoxTransform(g, io, stageEl);
            if (glow) paintTextElement(g, glow, stageEl, s);
            paintTextElement(g, current, stageEl, s);
            ctx.save(); ctx.globalAlpha = parseFloat(getComputedStyle(breathe).opacity) * parseFloat(getComputedStyle(io).opacity);
            ctx.drawImage(group, 0, 0, group.width, group.height, gx, gy, gw, gh); ctx.restore(); release(group);
            if (next) paintTextElement(ctx, next, stageEl, s);
        }
        mark('lyrics');
        ctx.restore();

        // 3. screen border, over the content's edge
        if (bw > 0) {
            const ring = new Path2D(); addRoundRect(ring, sbox.x, sbox.y, sbox.w, sbox.h, radius); addRoundRect(ring, pad.x, pad.y, pad.w, pad.h, padRadius);
            ctx.fillStyle = scs.borderTopColor; ctx.fill(ring, 'evenodd');
        }
        return ctx.canvas;
    }

    // ───────────────────────── run control ─────────────────────────
    let run = null;
    let _pinnedStage = null;
    // Freeze the live template and put it on frame time. Everything touched here is restored by end().
    async function begin({ scale = 1, fps = 30, durationSec }) {
        // The pin uses the stage's current rectangle, which is the same one exportMp4 already measured. 
        // A window resize or a mobile URL-bar change mid-export can no longer change the frames.
        _pinnedStage = { style: stageEl.getAttribute('style'), rect: stageEl.getBoundingClientRect() };
        _pinnedShown = false;                                     // ensure entry animation play at the start of the video
        stageEl.style.transition = 'none';                        // the stage animates max-width/aspect-ratio; no animation while pinned
        stageEl.style.width = _pinnedStage.rect.width + 'px';
        stageEl.style.height = _pinnedStage.rect.height + 'px';
        stageEl.style.maxWidth = 'none';
        stageEl.style.aspectRatio = 'auto';
        _scanEndAt = 0; _scanUntil = 0; screenEl.classList.remove('scan-active');
        if (run) throw new Error('an export is already running');
        if (isPlaying) await togglePlay();                        // pause real playback
        await document.fonts.ready;
        const saved = { isPlaying, audioContext, startedAt, startOffset, audioDuration, lastFiredBeatIdx, currentLyricIdx, flashCycleIdx, exited: _exited };
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        if (vizs && vizs._rafId) cancelAnimationFrame(vizs._rafId);        // the legacy visualizers' own loop: re-seeded on the virtual clock below
        const baseNow = 1e6;
        installClock(baseNow);
        Object.defineProperty(window, 'devicePixelRatio', { get: () => scale, configurable: true });
        // _masterCanvasCap = Math.max(_masterCanvasCap, 4096);            // lift the cap for export
        resizeMasterCanvas();                                              // master canvas now follows the export scale (the template caps it at 1920)
        if (core && typeof core.setRenderScale === 'function') core.setRenderScale(scale);
        if (vizs && typeof vizs._loop === 'function') window.requestAnimationFrame(() => vizs._loop());
        window.requestAnimationFrame(displayLoop);
        lastFiredBeatIdx = 0; currentLyricIdx = -1; flashCycleIdx = 0; _exited = false;
        audioDuration = durationSec; startedAt = 0; startOffset = 0; isPlaying = true; isSeeking = false;
        audioContext = { currentTime: 0 };
        _lastFrame = baseNow - 1000 / fps;
        run = { saved, baseNow, fps, scale };
    }
    function stepTo(tSec) {                                                // advance the page to time tSec (frames must be stepped in order)
        audioContext.currentTime = tSec;
        runFrame(run.baseNow + tSec * 1000);
    }
    function end() {
        if (_pinnedStage) {
            if (_pinnedStage.style === null) stageEl.removeAttribute('style'); else stageEl.setAttribute('style', _pinnedStage.style);
            _pinnedStage = null;
        }        
        _scanEndAt = 0; _scanUntil = 0; screenEl.classList.remove('scan-active');
        if (!run) return;
        const { saved } = run;
        removeClock();                                                     // restores performance.now, rAF, animate and devicePixelRatio
        // _masterCanvasCap = 1920;
        // Reset _lastFrame to the REAL clock (performance.now is real again after removeClock).
        // Otherwise the next real displayLoop frame computes dt = realNow - virtualLastFrame,
        // a huge negative number, which makes exponentialApproach return NaN and the
        // circle style's createRadialGradient throw.
        _lastFrame = performance.now();
        resizeMasterCanvas();
        if (core && typeof core.setRenderScale === 'function') core.setRenderScale(1);
        ({ isPlaying, audioContext, startedAt, startOffset, audioDuration, lastFiredBeatIdx, currentLyricIdx, flashCycleIdx } = saved);
        _exited = saved.exited;
        isPlaying = false;
        // Repaint the UI to reflect the restored paused position. displayLoop's
        // UI block is gated by isPlaying, so it won't do this while paused.
        timeDisplay.textContent = startOffset.toFixed(3);
        _updateSeekBarVisual(startOffset);
        updateLyrics(startOffset);
        if (vizs && typeof vizs._loop === 'function') vizs._rafId = requestAnimationFrame(() => vizs._loop());
        animFrameId = requestAnimationFrame(displayLoop);
        run = null;
    }

    // ───────────────────────── encoding ─────────────────────────
    function mulberry32(seed) {                                            // seeded Math.random: dust, visualizers and styles repeat exactly
        let state = seed >>> 0;
        return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function avcCodecCandidates(width, height, fps) {                      // H.264 level from frame size and rate (macroblock limits)
        const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16), rate = macroblocks * fps;
        const levels = [[0x1f, 3600, 108000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3e, 139264, 8355840]];
        const hex = (levels.find(([, maxFrame, maxRate]) => macroblocks <= maxFrame && rate <= maxRate) || levels[levels.length - 1])[0].toString(16).padStart(2, '0');
        return [`avc1.6400${hex}`, `avc1.4D00${hex}`, `avc1.4200${hex}`];
    }
    async function pickCodecs({ width, height, fps, bitrate, audio }) {   // H.264 + AAC first (plays everywhere), then VP9 / Opus in MP4
        let video = null;
        for (const codec of avcCodecCandidates(width, height, fps)) {
            const config = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
            if ((await VideoEncoder.isConfigSupported(config)).supported) { video = { muxer: 'avc', config }; break; }
        }
        if (!video) { const config = { codec: 'vp09.00.40.08', width, height, bitrate, framerate: fps }; if ((await VideoEncoder.isConfigSupported(config)).supported) video = { muxer: 'vp9', config }; }
        if (!video) throw new Error('This browser cannot encode H.264 or VP9 video (WebCodecs).');
        let audioPick = null;
        if (audio) for (const [muxer, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus']]) {
            const config = { codec, sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate: 192000 };
            if (typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported(config)).supported) { audioPick = { muxer, config }; break; }
        }
        return { video, audio: audioPick };
    }
    async function prepareAudio(buffer) {                                  // 48 kHz, at most stereo: what AAC and Opus encoders are happiest with
        const channels = Math.min(2, buffer.numberOfChannels), sampleRate = 48000;
        if (buffer.sampleRate === sampleRate && buffer.numberOfChannels <= 2) return { buffer, sampleRate, channels };
        const offline = new OfflineAudioContext(channels, Math.ceil(buffer.duration * sampleRate), sampleRate);
        const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
        return { buffer: await offline.startRendering(), sampleRate, channels };
    }

    const EXPORT_PRESETS = { '720p': 720, '1080p': 1080, '1440p': 1440, '4K': 2160 };   // SHORT side in px; the long side follows the stage's aspect ratio

    /**
     * Export the running template as an MP4.
     * @param o { shortSide: 1080 | '1080p' ...,  fps: 30,  durationSec (default: the loaded song),  audio (default: the loaded song),
     *            seed: 1,  bitsPerPixel: 0.14,  onProgress({frame,frames,fps,etaSec}),  signal: AbortSignal,  target: Mp4Muxer target }
     * @returns Blob (video/mp4), or null when a custom target (e.g. a file stream) is given
     */
    async function exportMp4(o = {}) {
        const fps = o.fps || 30;
        const shortSide = typeof o.shortSide === 'string' ? EXPORT_PRESETS[o.shortSide] : (o.shortSide || 1080);
        const rect = stageEl.getBoundingClientRect();
        const portrait = rect.height >= rect.width;
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        const width = even(portrait ? shortSide : shortSide * rect.width / rect.height);
        const height = even(portrait ? shortSide * rect.height / rect.width : shortSide);
        const scale = width / rect.width;
        const song = o.audio !== undefined ? o.audio : (typeof audioBuffer !== 'undefined' ? audioBuffer : null);
        const durationSec = o.durationSec || (song ? song.duration : BEAT_DATA.beats.length * BEAT_DATA.step_ms / 1000);
        const totalFrames = Math.ceil(durationSec * fps);
        const bitrate = Math.round(width * height * fps * (o.bitsPerPixel || 0.14));
        const audio = song ? await prepareAudio(song) : null;
        const picked = await pickCodecs({ width, height, fps, bitrate, audio });

        const target = o.target || new Mp4Muxer.ArrayBufferTarget();
        const muxer = new Mp4Muxer.Muxer({
            target, video: { codec: picked.video.muxer, width, height, frameRate: fps },
            audio: picked.audio ? { codec: picked.audio.muxer, numberOfChannels: audio.channels, sampleRate: audio.sampleRate } : undefined,
            fastStart: o.target ? 'fragmented' : 'in-memory', firstTimestampBehavior: 'offset',
        });
        let encoderError = null;
        const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encoderError = e; } });
        videoEncoder.configure(picked.video.config);
        let audioEncoder = null;
        if (picked.audio) { audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encoderError = e; } }); audioEncoder.configure(picked.audio.config); }

        let audioOffset = 0;
        const pushAudioUpTo = (seconds) => {                              // audio goes in step with the video, one second at a time
            if (!audioEncoder) return;
            const endSample = Math.min(audio.buffer.length, Math.floor(seconds * audio.sampleRate));
            while (audioOffset < endSample) {
                const frames = Math.min(48000, endSample - audioOffset), planar = new Float32Array(frames * audio.channels);
                for (let c = 0; c < audio.channels; c++) planar.set(audio.buffer.getChannelData(Math.min(c, audio.buffer.numberOfChannels - 1)).subarray(audioOffset, audioOffset + frames), c * frames);
                const data = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: frames, numberOfChannels: audio.channels, timestamp: Math.round(audioOffset / audio.sampleRate * 1e6), data: planar });
                audioEncoder.encode(data); data.close(); audioOffset += frames;
            }
        };

        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d', { alpha: false });            // opaque: cheaper to composite and encode
        const originalRandom = Math.random;
        Math.random = mulberry32(o.seed || 1);                             // seeded BEFORE begin(): resizing the master canvas re-seeds the dust field
        let beganRun = false;
        try {
            document.body.classList.add('mp4-exporting');
            const statusEl = document.getElementById('mp4-export-status');
            const detailEl = document.getElementById('mp4-export-detail');
            await begin({ scale, fps, durationSec });
            beganRun = true;
            const realNow = clock.realNow;
            const wall0 = realNow();
            
            // profiling
            const T = { step: 0, paint: 0, encode: 0, wait: 0, yield: 0 }, sec = {};
            let tMark = 0;
            const probe = (name) => { const t = realNow(); sec[name] = (sec[name] || 0) + (t - tMark); tMark = t; };
            const per = (v, f) => +(v / (f + 1)).toFixed(1);

            for (let frame = 0; frame < totalFrames; frame++) {
                if (o.signal && o.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
                if (encoderError) throw encoderError;
                const timeSec = frame / fps;
                let t0 = realNow();
                stepTo(timeSec);
                let t1 = realNow(); T.step += t1 - t0; tMark = t1;
                photograph(ctx, scale, probe);
                let t2 = realNow(); T.paint += t2 - t1;
                const videoFrame = new VideoFrame(canvas, { timestamp: Math.round(frame * 1e6 / fps), duration: Math.round(1e6 / fps) });
                videoEncoder.encode(videoFrame, { keyFrame: frame % (fps * 2) === 0 }); videoFrame.close();
                if (frame % fps === 0) pushAudioUpTo(timeSec + 1);
                let t3 = realNow(); T.encode += t3 - t2;
                while (videoEncoder.encodeQueueSize > 8) {
                    await Promise.race([
                        new Promise((r) => videoEncoder.addEventListener('dequeue', r, { once: true })),
                        new Promise((r) => setTimeout(r, 100)),            // safety net only, so a dead encoder cannot hang the loop
                    ]);
                    if (encoderError) throw encoderError;
                }     // backpressure
                T.wait += realNow() - t3;
                if (frame % 15 === 0) {
                    const elapsed = (realNow() - wall0) / 1000;
                    if (o.onProgress) o.onProgress({
                        frame, 
                        frames: totalFrames, 
                        fps: frame / Math.max(elapsed, 1e-3), 
                        etaSec: elapsed / Math.max(frame, 1) * (totalFrames - frame),
                        timing: { step: per(T.step, frame), paint: per(T.paint, frame), encode: per(T.encode, frame), wait: per(T.wait, frame), yield: per(T.yield, frame),
                                  sections: Object.fromEntries(Object.entries(sec).map(([k, v]) => [k, per(v, frame)])) },
                    });
                    if (statusEl) statusEl.textContent = `EXPORTING MP4…${Math.round(100 * frame / totalFrames)}%`;
                    if (detailEl) detailEl.textContent = `ETA ${Math.round(elapsed / Math.max(frame, 1) * (totalFrames - frame))}s`;                   
                    const ty = realNow(); await yieldToEventLoop(); T.yield += realNow() - ty;
                }
            }
            pushAudioUpTo(durationSec + 1);
            await videoEncoder.flush(); if (audioEncoder) await audioEncoder.flush();
            muxer.finalize();
            return o.target ? null : new Blob([target.buffer], { type: 'video/mp4' });
        } finally {
            document.body.classList.remove('mp4-exporting');
            if (beganRun) end();
            Math.random = originalRandom;
            try { videoEncoder.close(); } catch (e) { /* already closed */ }
            try { if (audioEncoder) audioEncoder.close(); } catch (e) { /* already closed */ }
        }
    }

    return { exportMp4, EXPORT_PRESETS, begin, stepTo, end, photograph, _clock: clock };
})();

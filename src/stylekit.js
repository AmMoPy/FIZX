// ═══════════════════════════════════════════════════════════════════
// stylekit.js — shared by template.html and the Studio. Pure data + draw
// functions. Nothing here knows about audio extraction or the DOM outside
// the canvas/element it's handed.
//
// To add a new style or effect later: copy an existing entry, change the 
// id and the body. Nothing outside this file needs to know it exists 
// AnimCore reads CIRCLE_STYLES/EFFECTS/TEXT_TRANSITIONS by id, and the 
// Studio's control panel is generated from each entry's params list.
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════
// ─── rewrite the alpha channel of an rgba(...) string ───
// Brightens or dims an rgba() color string by replacing the number with 
// a clamped, fixed-precision alpha value. Any CSS colour -> rgba() with the alpha you want. 
// Understands #rgb, #rrggbb, rgb() and rgba(); anything else is returned untouched.
// Used wherever a style needs the same base color at a different opacity
// (e.g. a glow that fades in with the vocal level).
function withAlpha(color, alpha) {
    if (typeof color !== 'string') return color;
    const clampedAlpha = Math.min(Math.max(alpha, 0), 1).toFixed(3); // keeps the output strings stable
    if (color[0] === '#') {
        let hex = color.slice(1);
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        if (hex.length >= 6) {
            return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${clampedAlpha})`;
        }
    }
    const match = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return match ? `rgba(${match[1]},${match[2]},${match[3]},${clampedAlpha})` : color;
}

// ═══════════════════════════════════════════════════════════════════
// SHARED MOTION HELPERS
// ═══════════════════════════════════════════════════════════════════
// A damped spring: `value` chases a target, `velocity` carries momentum so hits can be injected as impulses.
function createSpring(initialValue = 0) {
    return { value: initialValue, velocity: 0 };
}

// Advances a spring toward `target`.
//   frequencyHz  — how quickly it responds.
//   dampingRatio — 1 settles without overshoot, below 1 bounces.
// Sub-stepped so a long frame gap (paused redraw, tab switch) cannot make it unstable.
function stepSpring(spring, target, frequencyHz, dampingRatio, deltaSeconds) {
    const omega = 2 * Math.PI * frequencyHz;
    const stiffness = omega * omega;
    const damping = 2 * dampingRatio * omega;
    const stepCount = Math.max(1, Math.ceil(deltaSeconds / 0.008));
    const stepSeconds = deltaSeconds / stepCount;
    for (let step = 0; step < stepCount; step++) {
        spring.velocity += (stiffness * (target - spring.value) - damping * spring.velocity) * stepSeconds;
        spring.value += spring.velocity * stepSeconds;
    }
}

function frameSeconds(drawContext) {
    return Math.min(0.05, (drawContext.deltaTimeMs || 16.7) / 1000);
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function smoothstep(x) {
    const t = clamp(x, 0, 1);
    return t * t * (3 - 2 * t);
}

// Expanding rings that a hit sends out. Fixed-size pool, reused, never allocates after creation.
function createRipples(count) {
    return Array.from({ length: count }, () => ({ age: 1, strength: 0 }));
}

function spawnRipple(ripples, strength) {
    let oldest = ripples[0];
    for (const ripple of ripples) if (ripple.age > oldest.age) oldest = ripple;
    oldest.age = 0;
    oldest.strength = strength;
}

function advanceRipples(ripples, deltaSeconds, lifetimeSeconds) {
    for (const ripple of ripples) ripple.age = Math.min(1, ripple.age + deltaSeconds / lifetimeSeconds);
}

// The bars recipe, shared. verticalness: 0 = bottom (bass), 0.5 = the sides (vocal), 1 = the top (treble).
function bandEnergy(verticalness, bass, vocal, treble) {
    return bass * Math.max(0, 1 - verticalness * 2.2)
         + vocal * Math.max(0, 1 - Math.abs(verticalness - 0.5) * 3)
         + treble * Math.max(0, (verticalness - 0.55) * 2.2);
}

// verticalness for a screen angle in canvas convention (0 = right, +π/2 = down). Same linear mapping bars uses.
function verticalnessAtAngle(angle) {
    let distance = Math.abs(angle - Math.PI / 2) % (Math.PI * 2);
    if (distance > Math.PI) distance = Math.PI * 2 - distance;
    return distance / Math.PI;
}

// Delay line for a 0..1 signal: push one sample every TRAIL_STEP seconds, read it back `delaySeconds` ago.
// Lets one band travel along a shape (a vocal pulse running down a tentacle) instead of hitting it all at once.
const TRAIL_STEP = 0.025;
function createTrail(length = 48) { return { samples: new Float32Array(length), head: 0, clock: 0 }; }
function pushTrail(trail, value, deltaSeconds) {
    trail.clock += deltaSeconds;
    while (trail.clock >= TRAIL_STEP) {
        trail.clock -= TRAIL_STEP;
        trail.head = (trail.head + 1) % trail.samples.length;
        trail.samples[trail.head] = value;
    }
}

function readTrail(trail, delaySeconds) {
    const length = trail.samples.length;
    const position = Math.min(length - 2, Math.max(0, delaySeconds / TRAIL_STEP));
    const whole = Math.floor(position), fraction = position - whole;
    const newer = trail.samples[(trail.head - whole + length) % length];
    const older = trail.samples[(trail.head - whole - 1 + length) % length];
    return newer + (older - newer) * fraction;
}

// Beat-locked dance clock + move scheduler. Reused by any style that wants "a pool of moves".
//   phase    — beats elapsed (continuous). Eases toward each detected hit instead of snapping, so the figure never pops.
//   current / previous / blend — the move now playing, the one fading out, and 0..1 crossfade progress.
function createChoreographer(moveCount) {
    return { phase: 0, pending: 0, lastBeat: 0, beatsLeft: 4, current: Math.floor(Math.random() * moveCount), previous: 0, blend: 1 };
}

// `accept(index)` (optional) lets the caller veto a move for the current moment (e.g. too energetic for a quiet passage).
function stepChoreographer(choreo, frameValues, deltaSeconds, moveCount, beatsPerMove, accept) {
    choreo.phase += deltaSeconds / ((frameValues.beatPeriodMs || 500) / 1000);
    if (frameValues.hitDetected) choreo.pending = Math.round(choreo.phase) - choreo.phase; // signed distance to the nearest beat
    const pull = choreo.pending * (1 - Math.exp(-deltaSeconds / 0.12));
    choreo.phase += pull;
    choreo.pending -= pull;

    const beat = Math.floor(choreo.phase);
    if (frameValues.hitDetected) choreo.beatsLeft--;
    choreo.moveSeconds = (choreo.moveSeconds || 0) + deltaSeconds;
    if (choreo.moveSeconds > 12) choreo.beatsLeft = 0; // time cap keeps quiet passages moving.

    choreo.blend = Math.min(1, choreo.blend + deltaSeconds / 0.35);
    if (choreo.beatsLeft <= 0 && moveCount > 1) {
        let next = choreo.current;
        for (let attempt = 0; attempt < 12 && (next === choreo.current || (accept && !accept(next))); attempt++) {
            next = Math.floor(Math.random() * moveCount);
        }
        if (next !== choreo.current) { 
            choreo.previous = choreo.current; 
            choreo.current = next; 
            choreo.blend = 0;
            choreo.moveSeconds = 0; 
        }
        choreo.beatsLeft = beatsPerMove + 2 * Math.floor(Math.random() * 2);       // beatsPerMove or +2 so it never feels metronomic
    }
}

// One-pole smoothing: moves `current` toward `target`, frame-rate independent. tauSeconds = how long it takes to cover ~63% of the gap.
function easeToward(current, target, deltaSeconds, tauSeconds) {
    return current + (target - current) * (1 - Math.exp(-deltaSeconds / tauSeconds));
}

// Smooth closed / open curves through the midpoints of a point list (no corners). Point lists live in Float32Arrays;
// `offset` lets several curves share one buffer. They only add to the current path: call beginPath() / stroke() yourself.
function traceSmoothLoop(ctx, xs, ys, offset, count) {
    ctx.moveTo((xs[offset + count - 1] + xs[offset]) / 2, (ys[offset + count - 1] + ys[offset]) / 2);
    for (let i = 0; i < count; i++) {
        const next = i + 1 === count ? 0 : i + 1;
        ctx.quadraticCurveTo(xs[offset + i], ys[offset + i], (xs[offset + i] + xs[offset + next]) / 2, (ys[offset + i] + ys[offset + next]) / 2);
    }
    ctx.closePath();
}

function traceSmoothCurve(ctx, xs, ys, offset, count) {
    ctx.moveTo(xs[offset], ys[offset]);
    for (let i = 1; i < count - 1; i++) {
        ctx.quadraticCurveTo(xs[offset + i], ys[offset + i], (xs[offset + i] + xs[offset + i + 1]) / 2, (ys[offset + i] + ys[offset + i + 1]) / 2);
    }
    ctx.lineTo(xs[offset + count - 1], ys[offset + count - 1]);
}

// Appends a closed, slightly wobbling circle to the current path (hand-drawn look). wobble = fraction of the radius.
function traceWobblyCircle(ctx, cx, cy, radius, wobble, phase, segments = 96) {
    for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const r = radius * (1 + wobble * (0.6 * Math.sin(3 * a + phase) + 0.4 * Math.sin(7 * a - phase * 1.3)));
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

// ═══ STAGE WALKER (shared by every roaming character) ═══════════════════════
// A character's place on the canvas. x is in character units (same units as the figure), 0 = centre of the canvas.
//   vel   units/second           facing  +1 / -1, the way it is heading      turn  eased facing (-1..1), squashes through 0 on a turn
//   pace  0..1.2 how fast it is moving (drives stride, lean, bob)             gait  walk-cycle phase in cycles, advances with distance
// Two ways to move it: planStage (beat-planned trips that arrive on a beat) and pursueStage (chase a moving target).
// Both end in settleStage, so every character gets the same turn/pace/gait outputs.
function createStageWalker() {
    return { x: 0, vel: 0, facing: 1, turn: 1, pace: 0, gait: 0, moving: false, from: 0, to: 0, startPhase: 0, beats: 1 };
}

function settleStage(walker, deltaSeconds) {
    if (Math.abs(walker.vel) > 0.25) walker.facing = walker.vel > 0 ? 1 : -1;
    walker.turn += (walker.facing - walker.turn) * (1 - Math.exp(-deltaSeconds / 0.12));
    const speed = Math.abs(walker.vel);
    walker.pace += (Math.min(1.2, speed / 2.2) - walker.pace) * (1 - Math.exp(-deltaSeconds / 0.1));
    walker.gait = (walker.gait + speed * deltaSeconds / 1.1) % 1000;     // one cycle (two steps) per 1.1 units travelled
}

// Beat-planned travel. While `wantTravel` it walks to random spots, each trip lasting a whole number of beats (never longer
// than `beatsAvailable`), so it arrives on the beat. When not wanted it finishes the trip it is on and then stands.
function planStage(walker, phase, deltaSeconds, wantTravel, beatsAvailable, halfRange, speedPerBeat) {
    const previousX = walker.x;
    walker.x = clamp(walker.x, -halfRange, halfRange);                     // room can shrink (resize, size slider)
    if (walker.moving) {
        const progress = (phase - walker.startPhase) / walker.beats;
        if (progress >= 1) { walker.moving = false; walker.x = walker.to; }
        else walker.x = walker.from + (walker.to - walker.from) * smoothstep(progress);
    }
    if (!walker.moving && wantTravel && halfRange > 0.4 && beatsAvailable >= 2) {
        let target = walker.x;
        for (let attempt = 0; attempt < 6 && Math.abs(target - walker.x) < halfRange * 0.7; attempt++) target = (Math.random() * 2 - 1) * halfRange;
        if (Math.abs(target - walker.x) < halfRange * 0.7) target = walker.x > 0 ? -halfRange : halfRange;
        const direction = target >= walker.x ? 1 : -1;
        const beats = Math.max(2, Math.min(Math.floor(beatsAvailable), Math.ceil(Math.abs(target - walker.x) / speedPerBeat)));
        const reachable = beats * speedPerBeat;                       // trip too long for the beats left: stop short instead of sprinting
        if (Math.abs(target - walker.x) > reachable) target = clamp(walker.x + direction * reachable, -halfRange, halfRange);
        const endPhase = Math.ceil(phase + beats - 1e-6);   // arrive exactly ON a beat, however far into this beat the trip starts
        walker.from = walker.x; walker.to = target; walker.startPhase = phase; walker.beats = endPhase - phase; walker.moving = true;
    }
    walker.vel = deltaSeconds > 0 ? (walker.x - previousX) / deltaSeconds : 0;
    settleStage(walker, deltaSeconds);
}

// Chase a target (a ball, another character): eases toward it, capped at maxSpeed units/second.
function pursueStage(walker, targetX, deltaSeconds, maxSpeed, halfRange) {
    const error = clamp(targetX, -halfRange, halfRange) - walker.x;
    walker.vel += (clamp(error * 4, -maxSpeed, maxSpeed) - walker.vel) * (1 - Math.exp(-deltaSeconds / 0.12));
    walker.x = clamp(walker.x + walker.vel * deltaSeconds, -halfRange, halfRange);
    walker.moving = false;
    settleStage(walker, deltaSeconds);
}

// ═══ BLOOM CORE ══════════════════════════════════════════════
// The in-loop "wow" came from additive ('lighter') halos stacking up to ~N passes on the early bars.
// A single stroke caps at globalAlpha 1, so stacking is now explicit and bounded. Weight is in
// "pass-equivalents": floor(weight) full-alpha strokes + one fractional stroke.
const BLOOM = {
    mode: 'ramp',      // 'ramp' = option 1 (index ramp, O(n·passes)) | 'uniform' = option 2 (flat, constant cost). Read by bars.
    gain: 6,           // pass-equivalents per unit of glowAlpha in every strokeWithGlow call. 1 = legacy single faint pass.
    maxPasses: 5,      // per-element cap; beyond this the colour is already clipped and extra strokes are wasted
    haloScale: 2.8,    // halo width = lineWidth * haloScale
    levelsPerPass: 4,  // ramp only: fractional resolution (4 = quarter-pass steps, ~0.1 pass max error)
};

// Reusable typed arrays so per-frame helpers never allocate. Safe to share: draw() is synchronous.
const bloomScratch = {};
function scratchBuffer(name, size) {
    let buffer = bloomScratch[name];
    if (!buffer || buffer.length < size) buffer = bloomScratch[name] = new Float32Array(size);
    return buffer;
}

// The conic halo gradient bars already used (primary → secondary → glowAccent → secondary → primary), now shared.
function createBloomGradient(ctx, x, y, colors, startAngle = -Math.PI / 2) {
    if (!ctx.createConicGradient) return colors.glowAccent || colors.glow;
    const gradient = ctx.createConicGradient(startAngle, x, y);
    gradient.addColorStop(0,    colors.primary);
    gradient.addColorStop(0.25, colors.secondary);
    gradient.addColorStop(0.5,  colors.glowAccent || colors.glow);
    gradient.addColorStop(0.75, colors.secondary);
    gradient.addColorStop(1,    colors.primary);
    return gradient;
}

// Strokes the CURRENT path `weight` pass-equivalents deep, additively. Cost = ceil(weight) strokes, independent of element count.
function stackHalo(ctx, haloStyle, haloWidth, weight) {
    let remaining = Math.min(weight, BLOOM.maxPasses);
    if (remaining <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = haloWidth;
    ctx.strokeStyle = haloStyle;
    while (remaining > 0.01) {
        ctx.globalAlpha = remaining > 1 ? 1 : remaining;
        ctx.stroke();
        remaining -= 1;
    }
    ctx.restore();
}

// OPTION 1 engine: per-element halo weights for any element count.
//   weights[i]    — halo depth of element i in pass-equivalents (OVERWRITTEN: used as scratch).
//   addElement(i) — adds element i's geometry only (moveTo/lineTo/arc). No beginPath, no stroke.
// Tier p strokes every element whose weight >= p, so cost is ~(maxPasses + levelsPerPass) strokes, not one per element.
// Clobbers the current path.
function strokeBloomTiers(ctx, count, weights, addElement, haloStyle, haloWidth) {
    const levels = BLOOM.levelsPerPass;
    const unitCap = BLOOM.maxPasses * levels;
    let maxUnits = 0;
    for (let i = 0; i < count; i++) {
        const units = Math.min(unitCap, Math.round(weights[i] * levels));
        weights[i] = units;
        if (units > maxUnits) maxUnits = units;
    }
    if (maxUnits < 1) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = haloWidth;
    ctx.strokeStyle = haloStyle;

    ctx.globalAlpha = 1;
    for (let tier = levels; tier <= maxUnits; tier += levels) {           // whole passes
        ctx.beginPath();
        for (let i = 0; i < count; i++) if (weights[i] >= tier) addElement(i);
        ctx.stroke();
    }
    ctx.globalAlpha = 1 / levels;
    for (let step = 1; step < levels; step++) {                           // fractional remainder, quarter-pass steps
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < count; i++) if (weights[i] % levels >= step) { addElement(i); any = true; }
        if (any) ctx.stroke();
    }
    ctx.restore();
}

// OPTION 2 / default for every style: halo + crisp stroke of the current path.
// Signature unchanged; `options` is new and optional:
//   weight    — halo depth in pass-equivalents (bypasses glowAlpha * gain)
//   gain      — per-call gain override
//   haloWidth — halo width in px; REQUIRED when lineWidth is 0
//   alpha     — crisp-stroke alpha (default 1)
// lineWidth <= 0 means "halo only, no crisp stroke".
function strokeWithGlow(ctx, color, lineWidth, glowAlpha, glowColor, options) {
    const haloStyle = glowColor ?? color;
    const haloWidth = options?.haloWidth ?? lineWidth * BLOOM.haloScale;
    if (glowAlpha > 0.01 && haloWidth > 0) {
        stackHalo(ctx, haloStyle, haloWidth, options?.weight ?? glowAlpha * (options?.gain ?? BLOOM.gain));
    }
    ctx.globalAlpha = options?.alpha ?? 1;
    if (lineWidth > 0) {
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = color;
        ctx.stroke();
    }
}

// Two-bone limb (shoulder-elbow-hand, hip-knee-foot). Writes the middle joint into `jointOut`, plus the end
// point actually reached (clamped if the target is out of reach). `bendSide` (-1 or +1) picks the bend direction.
function solveTwoBoneJoint(rootX, rootY, endX, endY, boneLength, bendSide, jointOut) {
    let deltaX = endX - rootX, deltaY = endY - rootY;
    let distance = Math.hypot(deltaX, deltaY);
    const maximumReach = boneLength * 2 - 0.001;
    if (distance > maximumReach) {
        deltaX *= maximumReach / distance;
        deltaY *= maximumReach / distance;
        distance = maximumReach;
    }
    distance = Math.max(distance, 0.001);
    const halfChord = distance / 2;
    const bendHeight = Math.sqrt(Math.max(0, boneLength * boneLength - halfChord * halfChord));
    let perpendicularX = -deltaY / distance, perpendicularY = deltaX / distance;
    if (perpendicularX * bendSide < 0) { perpendicularX = -perpendicularX; perpendicularY = -perpendicularY; }
    jointOut.x = rootX + deltaX / 2 + perpendicularX * bendHeight;
    jointOut.y = rootY + deltaY / 2 + perpendicularY * bendHeight;
    jointOut.endX = rootX + deltaX;
    jointOut.endY = rootY + deltaY;
}

// ───────────────────────────────────────────────────────────────────
// DANCE MOVES — each writes target pose values for a beat phase `p` (in beats) at intensity `k` (~0.5..1.5).
// Pose fields (neutral values in DANCE_NEUTRAL): squat, hipX, lean, width (1 = facing, <1 = turning), stance (foot spread),
// liftL/liftR (foot lift), hop (whole-body lift), handLx/handLy + handRx/handRy (hand target relative to its shoulder:
// x = outward distance, y = downward distance), headTilt. A move only sets what it changes.
// To add a move: copy an entry, change the body. The dancer picks from this list at random.
// ───────────────────────────────────────────────────────────────────
const DANCE_TAU = Math.PI * 2;
const DANCE_NEUTRAL = { squat: 0, hipX: 0, lean: 0, width: 1, stance: 1, liftL: 0, liftR: 0, hop: 0,
                        handLx: 0.5, handLy: 1.3, handRx: 0.5, handRy: 1.3, headTilt: 0 };
const DANCE_KEYS = Object.keys(DANCE_NEUTRAL);
const DANCE_MOVES = [
    { name: 'sway', minEnergy: 0, fn(p, k, out) {
        const s = Math.sin(DANCE_TAU * p);
        out.hipX = 0.55 * k * s; out.lean = -0.18 * k * s;
        out.squat = 0.10 + 0.14 * k * (0.5 - 0.5 * Math.cos(2 * DANCE_TAU * p));
        out.liftL = Math.max(0, s) * 0.5 * k; out.liftR = Math.max(0, -s) * 0.5 * k;
        out.handLx = out.handRx = 0.75; out.handLy = 1.0 + 0.35 * k * s; out.handRy = 1.0 - 0.35 * k * s;
    } },
    { name: 'bounce', minEnergy: 0, fn(p, k, out) {
        const c = Math.cos(DANCE_TAU * p);                       // +1 on the beat
        out.squat = 0.55 * k * (0.5 + 0.5 * c);
        out.handLx = out.handRx = 0.65;
        out.handLy = out.handRy = 1.1 - 0.9 * k * (0.5 - 0.5 * c);
        out.headTilt = 0.3 * Math.sin(DANCE_TAU * p);
    } },
    { name: 'shimmy', minEnergy: 0.35, fn(p, k, out) {
        const fast = Math.sin(DANCE_TAU * 4 * p);
        out.hipX = 0.22 * k * fast; out.lean = -0.10 * k * fast;
        out.squat = 0.8; out.stance = 1.45;
        out.handLx = out.handRx = 0.95; out.handLy = out.handRy = 0.75 + 0.1 * Math.cos(DANCE_TAU * p);
        out.headTilt = 0.15 * Math.sin(DANCE_TAU * p);
    } },
    { name: 'wave', minEnergy: 0, fn(p, k, out) {
        const s = 0.5 + 0.5 * Math.sin(DANCE_TAU * p);
        out.handLy = 1.3 - 2.5 * k * s; out.handRy = 1.3 - 2.5 * k * (1 - s);
        out.handLx = 0.55 + 0.4 * s; out.handRx = 0.55 + 0.4 * (1 - s);
        out.hipX = 0.2 * Math.sin(DANCE_TAU * p); out.lean = 0.08 * Math.sin(DANCE_TAU * p); out.squat = 0.1;
    } },
    { name: 'point', minEnergy: 0.2, fn(p, k, out) {
        const sign = Math.max(-1, Math.min(1, 3 * Math.sin(Math.PI * p)));       // flips every 2 beats, smoothly
        const right = 0.5 + 0.5 * sign, left = 1 - right;
        out.handRx = 0.62 + 0.63 * right; out.handRy = 0.55 - 1.65 * right;      // pointing arm: out and up; other: hand on hip
        out.handLx = 0.62 + 0.63 * left;  out.handLy = 0.55 - 1.65 * left;
        out.hipX = 0.3 * k * sign * Math.cos(DANCE_TAU * p);
        out.squat = 0.12 + 0.12 * (0.5 + 0.5 * Math.cos(2 * DANCE_TAU * p));
        out.liftR = right * 0.35; out.liftL = left * 0.35;
    } },
    { name: 'turn', minEnergy: 0.2, fn(p, k, out) {
        out.width = Math.max(0.2, Math.abs(Math.cos(DANCE_TAU * p / 4)));        // narrows to an edge-on silhouette twice per 4 beats
        out.handLx = out.handRx = 1.0; out.handLy = out.handRy = 0.45 + 0.15 * Math.sin(DANCE_TAU * p);
        out.squat = 0.12 + 0.1 * (0.5 - 0.5 * Math.cos(2 * DANCE_TAU * p));
        out.headTilt = 0.2 * Math.sin(DANCE_TAU * p);
    } },
    { name: 'hop', minEnergy: 0.45, fn(p, k, out) {
        const air = Math.abs(Math.sin(Math.PI * p));                              // 0 on the beat (landing), 1 between beats
        out.hop = 0.5 * k * air; out.squat = 0.5 * k * (1 - air) * (1 - air);
        out.liftL = out.liftR = 0.9 * air;
        out.handLx = out.handRx = 1.0; out.handLy = out.handRy = -0.55 + 0.45 * (1 - air);
    } },
    { name: 'step-touch', minEnergy: 0, fn(p, k, out) {
        const s = Math.sin(Math.PI * p);                                          // 2-beat cycle
        out.hipX = 0.5 * k * s; out.stance = 0.8;
        out.liftL = Math.max(0, s) * 0.9; out.liftR = Math.max(0, -s) * 0.9;
        out.squat = 0.12 + 0.12 * Math.abs(Math.sin(DANCE_TAU * p));
        out.handLx = out.handRx = 0.7; out.handLy = 1.05 - 0.5 * Math.cos(DANCE_TAU * p); out.handRy = 1.05 + 0.5 * Math.cos(DANCE_TAU * p);
    } },
    { name: 'jive', minEnergy: 0.15, fn(p, k, out) {
        const step = Math.floor((((p % 1) + 1) % 1) * 4);                         // four hard poses per beat, like a robot
        const lx = [0.9, 0.62, 0.9, 0.5], ly = [0.2, -0.2, 1.0, 0.5];
        out.handLx = lx[step]; out.handLy = ly[step];
        out.handRx = lx[(step + 2) % 4]; out.handRy = ly[(step + 2) % 4];
        out.hipX = (step % 2 ? 0.14 : -0.14) * k; out.squat = 0.15; out.headTilt = step % 2 ? 0.3 : -0.3;
    } },
    { name: 'walk', minEnergy: 0, travel: true, speed: 1.0, stride: 0.55, gaitDir: 1, fn(p, k, out) {
        out.stance = 0.55; out.handLx = out.handRx = 0.55; out.handLy = out.handRy = 1.15; out.squat = 0.05;
        out.headTilt = 0.08 * Math.sin(DANCE_TAU * p);
    } },
    { name: 'strut', minEnergy: 0.15, travel: true, speed: 0.9, stride: 0.5, gaitDir: 1, fn(p, k, out) {
        out.stance = 0.6; out.hipX = 0.28 * k * Math.sin(Math.PI * p); out.squat = 0.10;
        out.handLx = out.handRx = 0.62; out.handLy = out.handRy = 0.55; out.headTilt = 0.12 * Math.sin(Math.PI * p);
    } },
    { name: 'skip', minEnergy: 0.4, travel: true, speed: 1.5, stride: 0.7, gaitDir: 1, fn(p, k, out) {
        const air = Math.abs(Math.sin(Math.PI * p));
        out.hop = 0.22 * k * air; out.squat = 0.2 * (1 - air); out.handLx = out.handRx = 0.9; out.handLy = out.handRy = 0.2 + 0.4 * (1 - air);
    } },
    { name: 'moonwalk', minEnergy: 0.2, travel: true, speed: 0.8, stride: 0.35, gaitDir: -1, fn(p, k, out) {
        out.stance = 0.5; out.squat = 0.1; out.handRx = 0.9; out.handRy = -0.7; out.handLx = 0.62; out.handLy = 0.6;
    } },
];

// Constant layer table for the prism style (module level so nothing is allocated per frame)
const PRISM_LAYERS = [
    { sides: 3, radius: 0.62, band: 'bass',   speed:  0.00035, color: 'primary' },
    { sides: 4, radius: 1.00, band: 'vocal',  speed: -0.00025, color: 'secondary' },
    { sides: 6, radius: 1.45, band: 'treble', speed:  0.00018, color: 'primary' },
];

// DUEL_MOVES: each writes blade targets for beat phase `p` into `out` (fields in DUEL_NEUTRAL; index L = left sword, R = right).
//   angleL/angleR  blade angle in radians from vertical, positive = leaning inward (0.52 = the blades meet)
//   thrustL/thrustR blade length multiplier; liftL/liftR pivot raised by this many units; spread = pivot distance multiplier
//   strikes: how many times per beat both blades are kicked into a clash (0 = the move never clashes)
const DUEL_NEUTRAL = { angleL: -0.5, angleR: -0.5, thrustL: 1, thrustR: 1, liftL: 0, liftR: 0, spread: 1 };
const DUEL_KEYS = Object.keys(DUEL_NEUTRAL);
const DUEL_MOVES = [
    { name: 'clash', minEnergy: 0, strikes: 1, fn(p, k, out) {
        out.angleL = out.angleR = -0.5 + 0.04 * Math.sin(DANCE_TAU * p);
    } },
    { name: 'flurry', minEnergy: 0.45, strikes: 2, fn(p, k, out) {
        out.angleL = out.angleR = -0.18;                                   // blades held close to the centre, so every strike lands fast
        out.spread = 0.92;
    } },
    { name: 'circle', minEnergy: 0, strikes: 0, fn(p, k, out) {
        const a = Math.PI * p;                                             // 2-beat orbit, blades in quadrature
        out.angleL = -0.12 + 0.34 * Math.sin(a); out.angleR = -0.12 + 0.34 * Math.cos(a);
        out.liftL = 0.18 * Math.cos(a); out.liftR = -0.18 * Math.sin(a);
        out.spread = 1.0;
    } },
    { name: 'lunge', minEnergy: 0.2, strikes: 0, fn(p, k, out) {
        const sign = Math.max(-1, Math.min(1, 3 * Math.sin(Math.PI * p))); // flips every 2 beats, smoothly
        const right = 0.5 + 0.5 * sign, left = 1 - right;
        out.angleR = -0.5 + 0.9 * right; out.thrustR = 1 + 0.2 * right; out.liftR = -0.12 * right;
        out.angleL = -0.5 + 0.9 * left;  out.thrustL = 1 + 0.2 * left;  out.liftL = -0.12 * left;
    } },
    { name: 'salute', minEnergy: 0, strikes: 0, fn(p, k, out) {
        out.angleL = out.angleR = -0.22 + 0.10 * Math.sin(Math.PI * p);   // blades raised, swaying
        out.liftL = out.liftR = 0.10; out.thrustL = out.thrustR = 1.05; out.spread = 0.85;
    } },
];

// CAT_TRICKS: what the cat does with the yarn. mode: 'chase' = runs after the ball and bats it on the beat (ticks = events per beat);
// 'carry' = trots across the stage with the ball bouncing in front; 'stay' = stands still and juggles / sings.
// roams: true needs room to move; the pool skips those tricks when the canvas is too narrow.
const CAT_TRICKS = [
    { name: 'chase',  minEnergy: 0,   mode: 'chase', ticks: 0.5, roams: true },
    { name: 'carry',  minEnergy: 0.3, mode: 'carry', ticks: 2,   roams: true, speed: 0.9 },
    { name: 'juggle', minEnergy: 0.2, mode: 'stay',  ticks: 1,   roams: true },
    { name: 'sing',   minEnergy: 0,   mode: 'stay',  ticks: 0,   roams: true },
];
// Leg layout in body space (+x = the way it faces). near = drawn in front of the torso. Diagonal pairs share a gait offset.
const CAT_LEGS = [
    { hipX:  0.75, offset: 0.5, near: false, front: true  },
    { hipX: -0.80, offset: 0.0, near: false, front: false },
    { hipX:  0.75, offset: 0.0, near: true,  front: true  },
    { hipX: -0.80, offset: 0.5, near: true,  front: false },
];

// Trig tables for closed shapes, built once: angle i/N of a turn, starting at the bottom like bars (so the bass zone is at the bottom).
// Anything of the form sin(m·θ − ωt) becomes  sinM[i]·cos(ωt) − cosM[i]·sin(ωt): two multiplies per point instead of a sin().
const LOOP_POINTS = 72;
const LOOP = (() => {
    const make = () => new Float32Array(LOOP_POINTS);
    const table = { cos: make(), sin: make(), vertical: make(), sin3: make(), cos3: make(), sin5: make(), cos5: make(), sin8: make(), cos8: make() };
    for (let i = 0; i < LOOP_POINTS; i++) {
        const angle = (i / LOOP_POINTS) * Math.PI * 2 + Math.PI / 2;
        table.cos[i] = Math.cos(angle); table.sin[i] = Math.sin(angle); table.vertical[i] = verticalnessAtAngle(angle);
        table.sin3[i] = Math.sin(3 * angle); table.cos3[i] = Math.cos(3 * angle);
        table.sin5[i] = Math.sin(5 * angle); table.cos5[i] = Math.cos(5 * angle);
        table.sin8[i] = Math.sin(8 * angle); table.cos8[i] = Math.cos(8 * angle);
    }
    return table;
})();

const AURORA_POINTS = 40;

// ═══════════════════════════════════════════════════════════════════
// CIRCLE STYLES
// Each style receives (ctx, frameValues, styleParams, drawContext):
//   frameValues = { bass, vocal, treble }         — current response-model output, 0..1
//   styleParams = resolved from this style's own `params` list + any
//                 overrides the user set in the Studio
//   drawContext = { centerX, centerY, baseRadius, nowMs, colors, bassTrailHistory }
//
// Every style may define createState(); the same object is handed back to draw() each frame.
// All positions inside a style are in "units" (1 unit = drawContext.baseRadius * params.size).
//
// General Note: For "smooth" motion, on each hit DON'T make the whole shape jumps. keep the fast
// signal small and local (e.g.: ±12% radius on orbit style), and split the bands across different 
// elements, so no single thing carries the whole beat.
// ═══════════════════════════════════════════════════════════════════
const CIRCLE_STYLES = {
    sweep: {
        label: 'Sweep',
        tip: 'Rotating conic arc, echo ring, orbiting dots, and treble glints.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1,
              tip: 'Circle size inside its frame. Kept at 1 or below so glow never clips the canvas edge.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1,
              tip: 'Conic arc halo strength.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 1.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        createState() {
            return { bass: createSpring(), vocal: createSpring(), treble: createSpring(), ripples: createRipples(3) };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const deltaSeconds = frameSeconds(drawContext);

            if (frameValues.hitDetected) spawnRipple(state.ripples, frameValues.hitStrength || frameValues.bass);
            stepSpring(state.bass, frameValues.bass, 6, 0.9, deltaSeconds);
            stepSpring(state.vocal, frameValues.vocal, 3, 1, deltaSeconds);
            stepSpring(state.treble, frameValues.treble, 5, 1, deltaSeconds);
            advanceRipples(state.ripples, deltaSeconds, 0.6);
            const bass = clamp(state.bass.value, 0, 1.2), vocal = clamp(state.vocal.value, 0, 1), treble = clamp(state.treble.value, 0, 1);

            // The ring itself only breathes by ±5%; the beat is expressed by the ripples.
            const radius = drawContext.baseRadius * styleParams.size * (0.95 + 0.10 * bass);

            // Ambient wash — brightens with the vocal level
            if (vocal > 0.01) {
                const wash = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 2.2);
                wash.addColorStop(0, withAlpha(colors.glow, vocal * 0.3));
                wash.addColorStop(0.6, withAlpha(colors.glow, vocal * 0.12));
                wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = wash;
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius * 2.2, 0, Math.PI * 2);
                ctx.fill();
            }

            for (const ripple of state.ripples) {
                if (ripple.age >= 1) continue;
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius * (1 + ripple.age * 0.85), 0, Math.PI * 2);
                ctx.strokeStyle = colors.primary;
                ctx.lineWidth = 0.5 + 2 * (1 - ripple.age);
                ctx.globalAlpha = (1 - ripple.age) * (1 - ripple.age) * 0.55 * ripple.strength;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            // Rotating conic arc — the main reactive element
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((nowMs * 0.00025) % (Math.PI * 2));
            let sweepStyle;
            if (ctx.createConicGradient) {
                const sweepGradient = ctx.createConicGradient(0, 0, 0);
                sweepGradient.addColorStop(0, colors.primary);
                sweepGradient.addColorStop(0.5, colors.secondary);
                sweepGradient.addColorStop(1, colors.primary);
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.arc(0, 0, radius, -Math.PI * 0.35, Math.PI * 1.1);
                sweepStyle = sweepGradient;
            } else { // fallback for engines without createConicGradient
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.arc(0, 0, radius, -Math.PI * 0.35, Math.PI * 1.1);
                sweepStyle = colors.primary;
            }
            const lw =  3 + 1.2 * bass;
            strokeWithGlow(ctx, sweepStyle, lw, 0.25 * styleParams.glow, createBloomGradient(ctx, 0, 0, colors),
                           { haloWidth: lw * styleParams.glowWidth });
            ctx.restore();

            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.82, 0, Math.PI * 2);
            ctx.strokeStyle = colors.secondary;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.25 + 0.2 * bass;
            ctx.stroke();

            // Orbiting dots
            const dotCount = 28;
            for (let dotIndex = 0; dotIndex < dotCount; dotIndex++) {
                const angle = (dotIndex / dotCount) * Math.PI * 2 + nowMs * 0.00015;
                const wobble = Math.sin(angle * 4 + nowMs * 0.002) * vocal * radius * 0.08;
                ctx.beginPath();
                ctx.arc(centerX + Math.cos(angle) * (radius + wobble), centerY + Math.sin(angle) * (radius + wobble), 1.2 + 0.8 * bass, 0, Math.PI * 2);
                ctx.fillStyle = dotIndex % 2 === 0 ? colors.primary : colors.secondary;
                ctx.globalAlpha = 0.3 + 0.3 * bass;
                ctx.fill();
            }

            // Treble glints fade continuously — no hard on/off threshold, which looked like flicker.
            if (treble > 0.02) {
                const tickCount = 40, tickRadius = radius * 1.3;
                ctx.strokeStyle = colors.secondary;
                ctx.lineWidth = 1;
                for (let tickIndex = 0; tickIndex < tickCount; tickIndex++) {
                    const phase = nowMs * 0.004 * (1 + (tickIndex % 5) * 0.37) + tickIndex * 2.4;
                    const brightness = (0.5 + 0.5 * Math.sin(phase)) ** 2 * treble;
                    if (brightness < 0.15) continue; // most ticks are invisible at any instant — that's the "sparkle" look
                    const angle = (tickIndex / tickCount) * Math.PI * 2;
                    const length = 2 + 4 * brightness;
                    const tickX = centerX + Math.cos(angle) * tickRadius, tickY = centerY + Math.sin(angle) * tickRadius;
                    ctx.beginPath();
                    ctx.moveTo(tickX - Math.cos(angle) * length / 2, tickY - Math.sin(angle) * length / 2);
                    ctx.lineTo(tickX + Math.cos(angle) * length / 2, tickY + Math.sin(angle) * length / 2);
                    ctx.globalAlpha = brightness;
                    ctx.stroke();
                }
            }

            // // Solid core — anchors the ring visually
            // const coreRadius = radius * 0.08 * (1 + 0.15 * bass);
            // ctx.beginPath();
            // ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            // strokeWithGlow(ctx, colors.primary, 0, 0.5 * styleParams.glow, undefined, 
            //                { haloWidth: coreRadius * 0.6 });  // halo only
            // ctx.globalAlpha = 0.5 + 0.3 * bass;
            // ctx.fillStyle = colors.primary;
            // ctx.fill();
            // ctx.globalAlpha = 1;
        },
    },

    ring: {
        label: 'Ring',
        tip: 'Single bold ring with a vocal wash. Each hit sends a soft shockwave outward; the ring itself stays steady.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Circle size inside its frame.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Ring halo strength.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.0,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        createState() {
            return { bass: createSpring(), vocal: createSpring(), ripples: createRipples(3) };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, colors } = drawContext;
            const deltaSeconds = frameSeconds(drawContext);

            if (frameValues.hitDetected) spawnRipple(state.ripples, frameValues.hitStrength || frameValues.bass);
            stepSpring(state.bass, frameValues.bass, 6, 0.9, deltaSeconds);
            stepSpring(state.vocal, frameValues.vocal, 3, 1, deltaSeconds);
            advanceRipples(state.ripples, deltaSeconds, 0.7);
            const bass = clamp(state.bass.value, 0, 1.2), vocal = clamp(state.vocal.value, 0, 1);

            const radius = drawContext.baseRadius * 1.5 * styleParams.size * (1 + 0.07 * bass);

            if (vocal > 0.01) {
                const wash = ctx.createRadialGradient(centerX, centerY, 10, centerX, centerY, radius * 1.8);
                wash.addColorStop(0, withAlpha(colors.glow, vocal * 0.3));
                wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = wash;
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius * 2, 0, Math.PI * 2);
                ctx.fill();
            }

            for (const ripple of state.ripples) {
                if (ripple.age >= 1) continue;
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius * (1 + ripple.age * 0.6), 0, Math.PI * 2);
                ctx.strokeStyle = colors.primary;
                ctx.lineWidth = 1 + 5 * (1 - ripple.age);
                ctx.globalAlpha = (1 - ripple.age) * (1 - ripple.age) * 0.5 * ripple.strength;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            const lw = 6 + 1.5 * bass;
            strokeWithGlow(ctx, colors.primary, lw, 0.30 * styleParams.glow,
                           createBloomGradient(ctx, centerX, centerY, colors), 
                           { haloWidth: lw * styleParams.glowWidth });
        },
    },

    bars: {
        label: 'Radial',
        tip: 'Ring of bars: bottom follows bass, sides follow vocal, top follows treble.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Ring size inside its frame.' },
            { key: 'barCount', label: 'Bars', min: 24, max: 96, step: 4, default: 56, tip: 'Number of bars around the ring.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
            { key: 'glowMode', label: 'Glow mode', min: 0, max: 1, step: 1, default: 0,
              fmt: v => Number(v) >= 0.5 ? 'Ramp' : 'Uniform', // hack but works instead of changing createSliderControl in studio
              tip: 'Uniform = one halo pass per frame (cheap, even bloom). Ramp = per-element bloom depth (heavier, more dramatic).' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const barCount = styleParams.barCount;
            const innerRadius = drawContext.baseRadius * styleParams.size * (1 + 0.15 * bass);
            const maxBarLength = drawContext.baseRadius * styleParams.size * 1.1;
            const lineWidth = Math.max(1.5, (2 * Math.PI * innerRadius / barCount) * 0.45);

            // geometry first, into a reusable buffer. No canvas calls in this loop.
            const segments = scratchBuffer('barSegments', barCount * 4);
            for (let barIndex = 0; barIndex < barCount; barIndex++) {
                const positionFraction = barIndex / barCount;
                const angle = positionFraction * Math.PI * 2 + Math.PI / 2;
                const verticalness = 1 - Math.abs(2 * positionFraction - 1);

                const bassContribution = bass * Math.max(0, 1 - verticalness * 2.2);
                const vocalContribution = vocal * Math.max(0, 1 - Math.abs(verticalness - 0.5) * 3);
                const trebleContribution = treble * Math.max(0, (verticalness - 0.55) * 2.2);
                const energy = bassContribution + vocalContribution + trebleContribution;

                const wobble = 0.85 + 0.15 * Math.sin(nowMs * 0.004 + barIndex * 1.7);
                const barLength = maxBarLength * (0.1 + Math.min(1, energy) * wobble);

                const cosAngle = Math.cos(angle), sinAngle = Math.sin(angle);
                const offset = barIndex * 4;
                segments[offset]     = centerX + cosAngle * innerRadius;
                segments[offset + 1] = centerY + sinAngle * innerRadius;
                segments[offset + 2] = centerX + cosAngle * (innerRadius + barLength);
                segments[offset + 3] = centerY + sinAngle * (innerRadius + barLength);
            }
            const addBar = (barIndex) => {
                const offset = barIndex * 4;
                ctx.moveTo(segments[offset], segments[offset + 1]);
                ctx.lineTo(segments[offset + 2], segments[offset + 3]);
            };

            // bloom. 'ramp' = option 1, anything else = option 2.
            const glowAlpha = 0.20 * styleParams.glow * (0.5 + 0.5 * bass);
            const haloStyle = createBloomGradient(ctx, centerX, centerY, colors);
            // const useRamp = BLOOM.mode === 'ramp' && glowAlpha > 0.01;
            const useRamp = (styleParams.glowMode >= 0.5) && glowAlpha > 0.01;

            ctx.save();                                                 // lineCap no longer leaks into the next style
            ctx.lineCap = 'round';
            if (useRamp) {
                // Bar k gets glowAlpha * (barCount - k) passes, exactly what the in-loop call accumulated.
                const weights = scratchBuffer('barWeights', barCount);
                for (let barIndex = 0; barIndex < barCount; barIndex++) weights[barIndex] = glowAlpha * (barCount - barIndex);
                strokeBloomTiers(ctx, barCount, weights, addBar, haloStyle, lineWidth * styleParams.glowWidth);
            }
            ctx.beginPath();
            for (let barIndex = 0; barIndex < barCount; barIndex++) addBar(barIndex);
            // ramp: halo already drawn, so glowAlpha 0 here = crisp pass only.
            // uniform: weight = mean of the ramp, so brightness is comparable when you flip BLOOM.mode.
            strokeWithGlow(ctx, colors.primary, lineWidth, useRamp ? 0 : glowAlpha, haloStyle,
                           { weight: glowAlpha * barCount * 0.5, haloWidth: lineWidth * styleParams.glowWidth });
            ctx.restore();
        },
    },

    orbit: {
        label: 'Orbit',
        tip: 'Three dotted rings at different speeds, each listening to a different band.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Overall size.' },
            { key: 'dotsPerRing', label: 'Dots per ring', min: 8, max: 48, step: 2, default: 24, tip: 'Density of each ring.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Dot and core bloom strength.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 1.0,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const baseRadius = drawContext.baseRadius * styleParams.size;
            const dotsPerRing = styleParams.dotsPerRing;

            const rings = [
                { radiusMultiplier: 1.0, energy: frameValues.bass,   rotationSpeed:  0.0002, color: colors.primary },
                { radiusMultiplier: 1.5, energy: frameValues.vocal,  rotationSpeed: -0.00014, color: colors.secondary },
                { radiusMultiplier: 2.0, energy: frameValues.treble, rotationSpeed:  0.0001, color: colors.primary },
            ];

            // one path + one fill + one halo per RING.
            for (const ring of rings) {
                const ringRadius = baseRadius * ring.radiusMultiplier * (1 + ring.energy * 0.12);
                const dotRadius = 1.4 + ring.energy * 2.6;
                ctx.beginPath();
                for (let dotIndex = 0; dotIndex < dotsPerRing; dotIndex++) {
                    const angle = (dotIndex / dotsPerRing) * Math.PI * 2 + nowMs * ring.rotationSpeed;
                    const dotX = centerX + Math.cos(angle) * ringRadius;
                    const dotY = centerY + Math.sin(angle) * ringRadius;
                    ctx.moveTo(dotX + dotRadius, dotY);                     // separate sub-path per dot, so no connecting lines
                    ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
                }
                // halo-only stroke; width > dot diameter, so each dot becomes a solid disc that bleeds outward
                strokeWithGlow(ctx, ring.color, 0, 0.15 * styleParams.glow * (0.4 + ring.energy), undefined, 
                               { haloWidth: dotRadius * styleParams.glowWidth });
                ctx.fillStyle = ring.color;
                ctx.globalAlpha = 0.35 + ring.energy * 0.6;
                ctx.fill();
            }

            // // core
            // const coreRadius = baseRadius * 0.12 * (1 + frameValues.bass * 0.5);
            // const coreDotRadius = coreRadius * 0.18 * (1 + 0.25 * frameValues.bass);
            // ctx.beginPath();
            // ctx.arc(centerX, centerY, coreDotRadius, 0, Math.PI * 2);
            // strokeWithGlow(ctx, colors.primary, 0, 0.5 * styleParams.glow, undefined, 
            //                { haloWidth: coreDotRadius * styleParams.glowWidth });
            // ctx.fillStyle = colors.primary;
            // ctx.globalAlpha = 0.55 + frameValues.bass * 0.45;
            // ctx.fill();
            // ctx.globalAlpha = 1;
        },
    },

    portal: {
        label: 'Portal',
        tip: 'Hand-drawn ring: beat pulses the ring and sends shock rings, vocal fills the haze inside, treble grows needles around the rim.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Ring size inside its frame. Kept at 1 or below so the needles never clip the canvas edge.' },
            { key: 'needles', label: 'Needles', min: 24, max: 120, step: 4, default: 72, tip: 'Number of needles around the rim. They cluster on one side.' },
            { key: 'sketch', label: 'Sketchiness', min: 0, max: 1, step: 0.05, default: 0.5, tip: 'How hand-drawn the ring looks: wobble and doubled outline.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 0.6, tip: 'Halo strength around the ring and needles.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 1.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        createState() {
            // Per-needle values are fixed once (seeded), so nothing random happens per frame: stable and smooth.
            let seed = 1234567;
            const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const needles = [];
            for (let i = 0; i < 120; i++) needles.push({ jitter: rand(), len: 0.35 + 0.65 * rand(), phase: rand() * Math.PI * 2, tick: rand() < 0.35, dot: rand() < 0.12 });
            return { bass: createSpring(), vocal: createSpring(), treble: createSpring(), ripples: createRipples(3), needles };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const dt = frameSeconds(drawContext);

            if (frameValues.hitDetected) spawnRipple(state.ripples, frameValues.hitStrength || frameValues.bass);
            stepSpring(state.bass,   frameValues.bass,   6, 0.9, dt);
            stepSpring(state.vocal,  frameValues.vocal,  3, 1,   dt);
            stepSpring(state.treble, frameValues.treble, 5, 1,   dt);
            advanceRipples(state.ripples, dt, 0.6);
            const bass = clamp(state.bass.value, 0, 1.2), vocal = clamp(state.vocal.value, 0, 1), treble = clamp(state.treble.value, 0, 1);

            const t = nowMs * 0.001;
            const radius = drawContext.baseRadius * styleParams.size * (0.96 + 0.08 * bass);
            const wobble = 0.012 * styleParams.sketch * (1 + 0.8 * bass);
            const haloStyle = createBloomGradient(ctx, centerX, centerY, colors);
            ctx.save();

            // 1. outer fog
            const fog = ctx.createRadialGradient(centerX, centerY, radius * 0.9, centerX, centerY, radius * 2.1);
            fog.addColorStop(0, withAlpha(colors.glow, 0.10 + 0.12 * bass));
            fog.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = fog;
            ctx.beginPath(); ctx.arc(centerX, centerY, radius * 2.1, 0, Math.PI * 2); ctx.fill();

            // 2. faint guide arcs on the left
            ctx.strokeStyle = colors.secondary; ctx.lineWidth = 1;
            const guideStart = Math.PI * 0.55 - t * 0.02;
            ctx.globalAlpha = 0.16 + 0.10 * bass;
            ctx.beginPath(); ctx.arc(centerX, centerY, radius * 1.14, guideStart, guideStart + Math.PI * 0.9); ctx.stroke();
            ctx.globalAlpha = 0.10 + 0.08 * bass;
            ctx.beginPath(); ctx.arc(centerX, centerY, radius * 1.27, guideStart + 0.3, guideStart + 0.3 + Math.PI * 0.7); ctx.stroke();

            // 3. shock rings on each beat
            for (const ripple of state.ripples) {
                if (ripple.age >= 1) continue;
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius * (1 + ripple.age * 0.8), 0, Math.PI * 2);
                ctx.strokeStyle = colors.primary;
                ctx.lineWidth = 0.5 + 1.8 * (1 - ripple.age);
                ctx.globalAlpha = (1 - ripple.age) * (1 - ripple.age) * 0.5 * ripple.strength;
                ctx.stroke();
            }

            // 4. full circle (beat): hand-drawn outline, doubled
            const lineWidth = 1.3 + 1.3 * bass;
            ctx.beginPath();
            traceWobblyCircle(ctx, centerX, centerY, radius, wobble, t * 0.5);
            strokeWithGlow(ctx, colors.primary, lineWidth, 0.22 * styleParams.glow, haloStyle, { haloWidth: lineWidth * styleParams.glowWidth });
            ctx.strokeStyle = colors.secondary; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.35;
            ctx.beginPath(); traceWobblyCircle(ctx, centerX, centerY, radius * 1.018, wobble * 1.6, t * 0.5 + 2.1); ctx.stroke();

            // 5. crescent moon inside the full circle (vocal lives here)
            const tilt = 0.35 - 0.80 * Math.sin(t * 0.17);              // thick side faces right/upper-right and drifts gently
            const ux = Math.cos(tilt), uy = Math.sin(tilt);
            const moonOuter = radius, moonInner = radius * 0.89;        // moonInner closer to moonOuter = longer, sharper horns
            const cut = radius * (0.12 + 0.05 * bass);                  // cutout slides toward the thin side; the beat fattens the moon
            const cutX = centerX - ux * cut, cutY = centerY - uy * cut;
            const thick = moonOuter - moonInner + cut;                  // thickness at the middle of the thick side
            const box = radius * 1.2;
            ctx.save();
            ctx.beginPath(); traceWobblyCircle(ctx, centerX, centerY, moonOuter, wobble, t * 0.5 + 0.7); ctx.clip();
            ctx.beginPath(); ctx.rect(centerX - box, centerY - box, box * 2, box * 2);
            traceWobblyCircle(ctx, cutX, cutY, moonInner, wobble, t * 0.5 + 1.6);
            ctx.clip('evenodd');                                               // outer disc minus the cutout = the crescent
            ctx.globalAlpha = 0.14 + 0.10 * bass; ctx.fillStyle = colors.secondary;
            ctx.fillRect(centerX - box, centerY - box, box * 2, box * 2);
            if (vocal > 0.01) {                                                // vocal: light gathers in the thick middle of the moon
                const mx = centerX + ux * (moonOuter - thick * 0.5), my = centerY + uy * (moonOuter - thick * 0.5);
                const spot = ctx.createRadialGradient(mx, my, 0, mx, my, radius); // radius * 0.60
                spot.addColorStop(0,   withAlpha(colors.glow, 0.15 + 0.65 * vocal));
                spot.addColorStop(0.5, withAlpha(colors.glow, 0.05 + 0.25 * vocal));
                spot.addColorStop(1,   'rgba(0, 0, 0, 0)');
                ctx.globalAlpha = 1; ctx.fillStyle = spot;
                ctx.fillRect(centerX - box, centerY - box, box * 2, box * 2);
            }
            const edgeW = 2 * (0.9 + 0.7 * bass);                               // doubled: the half outside the moon is clipped away
            ctx.beginPath();
            traceWobblyCircle(ctx, centerX, centerY, moonOuter, wobble, t * 0.5 + 0.7);
            traceWobblyCircle(ctx, cutX, cutY, moonInner, wobble, t * 0.5 + 1.6);
            strokeWithGlow(ctx, colors.primary, edgeW, (0.10 + 0.45 * vocal) * styleParams.glow, haloStyle, { alpha: 0.75, haloWidth: edgeW * styleParams.glowWidth });
            ctx.restore();

            // 6. needles (treble): one batched path
            const count = Math.min(styleParams.needles | 0, state.needles.length);
            const clusterAngle = tilt;
            const r0 = radius * 1.02;
            ctx.beginPath();
            for (let i = 0; i < count; i++) {
                const needle = state.needles[i];
                const angle = ((i + (needle.jitter - 0.5) * 0.8) / count) * Math.PI * 2;
                const cluster = 0.2 + 0.8 * ((1 + Math.cos(angle - clusterAngle)) * 0.5) ** 2;
                const shimmer = 0.6 + 0.4 * Math.sin(nowMs * 0.005 * (0.6 + needle.jitter) + needle.phase);
                const length = radius * needle.len * cluster * (0.03 + 0.34 * treble * shimmer);
                const cos = Math.cos(angle), sin = Math.sin(angle);
                ctx.moveTo(centerX + cos * r0, centerY + sin * r0);
                ctx.lineTo(centerX + cos * (r0 + length), centerY + sin * (r0 + length));
                if (needle.tick && length > radius * 0.06) {                       // crossbar
                    const mid = r0 + length * 0.6, half = radius * 0.025;
                    ctx.moveTo(centerX + cos * mid - sin * half, centerY + sin * mid + cos * half);
                    ctx.lineTo(centerX + cos * mid + sin * half, centerY + sin * mid - cos * half);
                }
            }
            strokeWithGlow(ctx, colors.secondary, 1, 0.12 * styleParams.glow * treble, haloStyle, 
                           { alpha: 0.35 + 0.5 * treble , haloWidth: 2 * styleParams.glowWidth });

            // floating dots past the needle tips fade in with treble (no hard threshold)
            if (treble > 0.2) {
                ctx.lineCap = 'round'; ctx.lineWidth = 2.2; ctx.strokeStyle = colors.primary;
                ctx.globalAlpha = (treble - 0.2) * 1.1;
                ctx.beginPath();
                for (let i = 0; i < count; i++) {
                    const needle = state.needles[i];
                    if (!needle.dot) continue;
                    const angle = ((i + (needle.jitter - 0.5) * 0.8) / count) * Math.PI * 2;
                    const reach = r0 + radius * (0.10 + 0.30 * treble * needle.len);
                    const x = centerX + Math.cos(angle) * reach, y = centerY + Math.sin(angle) * reach;
                    ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y);
                }
                ctx.stroke();
            }
            ctx.restore();
        },
    },

    mandala: {
        label: 'Mandala',
        tip: 'Concentric rings of smoky repeating shapes. Beat sends a wave out from the centre, vocal lights the core and speeds the morphing, treble adds wisps and sparkles to the outer rings.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Pattern size. At 1 it fills the whole frame.' },
            { key: 'rings', label: 'Rings', min: 4, max: 12, step: 1, default: 8, tip: 'Number of concentric rings. More rings = more shapes to draw.' },
            { key: 'wisp', label: 'Wisp', min: 0, max: 1, step: 0.05, default: 0.6, tip: 'How wild and smoky the shapes are; treble pushes it further on the outer rings.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 0.6, tip: 'Halo strength on the three inner rings.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 1.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        createState() {
            return { bass: createSpring(), vocal: createSpring(), treble: createSpring(), ripples: createRipples(3), phase: 0, spin: 0 };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, colors } = drawContext;
            const dt = frameSeconds(drawContext);

            if (frameValues.hitDetected) spawnRipple(state.ripples, frameValues.hitStrength || frameValues.bass);
            stepSpring(state.bass,   frameValues.bass,   6, 0.9, dt);
            stepSpring(state.vocal,  frameValues.vocal,  3, 1,   dt);
            stepSpring(state.treble, frameValues.treble, 5, 1,   dt);
            advanceRipples(state.ripples, dt, 0.5);
            const bass = clamp(state.bass.value, 0, 1.2), vocal = clamp(state.vocal.value, 0, 1), treble = clamp(state.treble.value, 0, 1);

            state.phase += dt * (0.25 + 0.9 * vocal);        // the shapes morph faster when the vocal is up
            state.spin  += dt * 0.05;

            const maxR = Math.min(ctx.canvas.width, ctx.canvas.height) * 0.5 * 0.97 * styleParams.size * (1 + 0.03 * bass);
            const rings = styleParams.rings | 0;
            const SAMPLES = 14;
            const gx = scratchBuffer('mandalaGx', SAMPLES), gy = scratchBuffer('mandalaGy', SAMPLES);   // one glyph in ring-local space
            const px = scratchBuffer('mandalaPx', SAMPLES), py = scratchBuffer('mandalaPy', SAMPLES);   // the same glyph in canvas space
            const dots = scratchBuffer('mandalaDots', 512);
            let dotCount = 0;
            const haloStyle = createBloomGradient(ctx, centerX, centerY, colors);

            ctx.save();
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';

            // central wash (vocal)
            const wash = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxR * 0.4);
            wash.addColorStop(0, withAlpha(colors.glow, 0.12 + 0.35 * vocal));
            wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = wash;
            ctx.beginPath(); ctx.arc(centerX, centerY, maxR * 0.4, 0, Math.PI * 2); ctx.fill();

            for (let k = 0; k < rings; k++) {
                const u = (k + 0.6) / rings;
                const rk = maxR * Math.pow(u, 1.35);                              // rings are denser near the centre
                const spacing = maxR * Math.pow((k + 1.6) / rings, 1.35) - rk;
                const n = 6 + 4 * k;                                              // repeats per ring
                const amp = Math.min((2 * Math.PI * rk) / n, spacing * 1.6) * 0.5; // glyph size is bounded by its neighbours
                const innerW = Math.max(0, 1 - u * 1.6), outerW = u * u;

                // beat wave: each shock ring lights up and swells the ring it passes
                let boost = 0;
                for (const ripple of state.ripples) {
                    if (ripple.age >= 1) continue;
                    const d = u - ripple.age;
                    boost += ripple.strength * (1 - ripple.age) * Math.exp(-(d * d) / 0.012);
                }
                boost = Math.min(boost, 1.2);

                const scale = 0.6 + 0.25 * bass * (1 - 0.5 * u) + 0.9 * boost + 0.35 * vocal * innerW;
                const wispAmp = styleParams.wisp * (0.35 + 0.9 * treble * outerW);
                const alpha = clamp((0.30 + 0.45 * (1 - u)) * (0.6 + 0.3 * bass) + 0.9 * boost + 0.3 * vocal * innerW, 0, 1);
                const dir = k % 2 ? -1 : 1;
                const rot = state.spin * dir / (1 + 0.3 * k);
                const p1 = state.phase * dir + k * 0.9, p2 = state.phase * 1.7 * dir + k * 1.7, p3 = state.phase * 0.8 + k * 2.3;

                for (let i = 0; i < SAMPLES; i++) {                               // one smoky Lissajous-style loop, computed once per ring
                    const s = (i / SAMPLES) * Math.PI * 2;
                    gx[i] = amp * scale * (0.5 * Math.sin(s + p1) + 0.35 * wispAmp * Math.sin(3 * s + p2));
                    gy[i] = amp * scale * (0.9 * Math.sin(2 * s + p3) + 0.30 * wispAmp * Math.cos(5 * s - p1));
                }

                ctx.beginPath();
                for (let j = 0; j < n; j++) {                                     // N-fold repeats of the same glyph
                    const a = rot + (j / n) * Math.PI * 2;
                    const ca = Math.cos(a), sa = Math.sin(a);
                    for (let i = 0; i < SAMPLES; i++) {
                        const radial = rk + gx[i];
                        px[i] = centerX + ca * radial - sa * gy[i];
                        py[i] = centerY + sa * radial + ca * gy[i];
                    }
                    ctx.moveTo((px[SAMPLES - 1] + px[0]) * 0.5, (py[SAMPLES - 1] + py[0]) * 0.5);
                    for (let i = 0; i < SAMPLES; i++) {                           // closed smooth curve through the midpoints
                        const ni = (i + 1) % SAMPLES;
                        ctx.quadraticCurveTo(px[i], py[i], (px[i] + px[ni]) * 0.5, (py[i] + py[ni]) * 0.5);
                    }
                    if (outerW > 0.25 && treble > 0.05 && (j + k) % 3 === 0 && dotCount < 256) {
                        dots[dotCount * 2] = px[0]; dots[dotCount * 2 + 1] = py[0]; dotCount++;
                    }
                }
                const style = k < rings * 0.5 ? colors.primary : colors.secondary;
                const lineWidth = 0.8 + 0.9 * (1 - u) + 0.8 * boost;
                ctx.strokeStyle = style; ctx.lineWidth = lineWidth; ctx.globalAlpha = alpha;
                if (k < 3) strokeWithGlow(ctx, style, lineWidth, 0.18 * styleParams.glow * (0.4 + 0.6 * (0.6 * vocal + 0.4 * bass)), haloStyle, { haloWidth: lineWidth * styleParams.glowWidth });
                else ctx.stroke();

                ctx.strokeStyle = style; ctx.lineWidth = 0.7; ctx.globalAlpha = alpha * 0.45;   // thin guide circle through the glyphs
                ctx.beginPath(); ctx.arc(centerX, centerY, rk, 0, Math.PI * 2); ctx.stroke();
            }

            // treble sparkles on the outer rings: one batched path of zero-length round-capped segments
            if (dotCount) {
                ctx.beginPath();
                for (let d = 0; d < dotCount; d++) { ctx.moveTo(dots[d * 2], dots[d * 2 + 1]); ctx.lineTo(dots[d * 2] + 0.01, dots[d * 2 + 1]); }
                ctx.strokeStyle = colors.primary; ctx.lineWidth = 1.5 + 2.5 * treble; ctx.globalAlpha = Math.min(1, treble * 1.1);
                ctx.stroke();
            }
            ctx.restore();
        },
    },

    petals: {
        label: 'Petals',
        tip: 'Two layers of petals that open with the music: bottom follows bass, sides follow vocal, top follows treble.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Flower size inside its frame.' },
            { key: 'petals', label: 'Petals', min: 6, max: 24, step: 2, default: 14, tip: 'Petals per layer.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 4,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },        
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const unit = drawContext.baseRadius * styleParams.size;
            const petalCount = styleParams.petals;
            const glowAlpha = 0.18 * styleParams.glow * (0.5 + 0.5 * bass);
            const haloStyle = createBloomGradient(ctx, centerX, centerY, colors);

            ctx.save();
            ctx.lineJoin = 'round';
            for (let layer = 0; layer < 2; layer++) {
                const isInner = layer === 1;
                const startRadius = unit * (isInner ? 0.30 : 0.45) * (1 + 0.12 * bass);
                const maxLength = unit * (isInner ? 0.80 : 1.30);
                const spin = isInner ? -nowMs * 0.00018 : 0;                // inner layer counter-rotates through the bass/vocal/treble zones
                const offset = isInner ? Math.PI / petalCount : 0;

                ctx.beginPath();
                for (let petalIndex = 0; petalIndex < petalCount; petalIndex++) {
                    const angle = (petalIndex / petalCount) * Math.PI * 2 + Math.PI / 2 + offset + spin;
                    const energy = Math.min(1, bandEnergy(verticalnessAtAngle(angle), bass, vocal, treble));
                    const wobble = 0.85 + 0.15 * Math.sin(nowMs * 0.004 + petalIndex * 1.7 + layer * 2.3);
                    const length = maxLength * (0.14 + energy * wobble);
                    const halfWidth = (Math.PI * startRadius / petalCount) * (1.25 + 0.75 * energy);   // petals widen as they open

                    const ux = Math.cos(angle), uy = Math.sin(angle);
                    const vx = -uy, vy = ux;
                    const baseX = centerX + ux * startRadius, baseY = centerY + uy * startRadius;
                    const tipX = baseX + ux * length, tipY = baseY + uy * length;
                    const nearX = baseX + ux * length * 0.15, nearY = baseY + uy * length * 0.15;
                    const farX = baseX + ux * length * 0.75, farY = baseY + uy * length * 0.75;
                    ctx.moveTo(baseX, baseY);
                    ctx.bezierCurveTo(nearX + vx * halfWidth * 1.6, nearY + vy * halfWidth * 1.6,
                                      farX + vx * halfWidth * 0.9, farY + vy * halfWidth * 0.9, tipX, tipY);
                    ctx.bezierCurveTo(farX - vx * halfWidth * 0.9, farY - vy * halfWidth * 0.9,
                                      nearX - vx * halfWidth * 1.6, nearY - vy * halfWidth * 1.6, baseX, baseY);
                }
                ctx.globalAlpha = isInner ? 0.26 : 0.18;
                ctx.fillStyle = isInner ? colors.secondary : colors.primary;
                ctx.fill();
                const lw = Math.max(1.5, unit * 0.035);
                strokeWithGlow(ctx, isInner ? colors.secondary : colors.primary, lw, 
                               glowAlpha, haloStyle, { haloWidth: lw * styleParams.glowWidth });
            }

            const coreRadius = unit * 0.10 * (1 + 0.35 * bass);
            ctx.beginPath();
            ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            strokeWithGlow(ctx, colors.primary, 0, 0.25 * styleParams.glow, undefined, { haloWidth: coreRadius * styleParams.glowWidth });
            ctx.globalAlpha = 0.7;
            ctx.fillStyle = colors.primary;
            ctx.fill();
            ctx.restore();
        },
    },

    liquid: {
        label: 'Liquid',
        tip: 'One flowing outline: the bars envelope smoothed into a single curve, with travelling waves from vocal and treble.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Ring size inside its frame.' },
            { key: 'fluidity', label: 'Fluidity', min: 0, max: 1, step: 0.05, default: 0.6, tip: 'How much the outline ripples. 0 is a smooth blob.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const unit = drawContext.baseRadius * styleParams.size;
            const seconds = nowMs / 1000;
            const POINTS = 120;

            // radius per angle: the bars envelope + travelling waves, then smoothed so the band-zone kinks disappear
            const radii = scratchBuffer('liquidRadii', POINTS);
            const spare = scratchBuffer('liquidSpare', POINTS);
            for (let i = 0; i < POINTS; i++) {
                const angle = (i / POINTS) * Math.PI * 2 + Math.PI / 2;
                const energy = Math.min(1, bandEnergy(verticalnessAtAngle(angle), bass, vocal, treble));
                const ripple = styleParams.fluidity * (
                    vocal * 0.18 * Math.sin(3 * angle - seconds * 1.6) +
                    treble * 0.14 * Math.sin(8 * angle + seconds * 5.5) +
                    0.05 * Math.sin(5 * angle + seconds * 0.9));
                radii[i] = unit * (0.80 + 0.12 * bass + 1.05 * energy + ripple);
            }
            for (let pass = 0; pass < 2; pass++) {
                for (let i = 0; i < POINTS; i++) spare[i] = (radii[(i + POINTS - 1) % POINTS] + 2 * radii[i] + radii[(i + 1) % POINTS]) * 0.25;
                for (let i = 0; i < POINTS; i++) radii[i] = spare[i];
            }

            // closed curve through the midpoints, so the outline has no corners
            const traceLoop = (scale) => {
                const pointX = (i) => centerX + Math.cos((i / POINTS) * Math.PI * 2 + Math.PI / 2) * radii[i % POINTS] * scale;
                const pointY = (i) => centerY + Math.sin((i / POINTS) * Math.PI * 2 + Math.PI / 2) * radii[i % POINTS] * scale;
                ctx.beginPath();
                ctx.moveTo((pointX(POINTS - 1) + pointX(0)) / 2, (pointY(POINTS - 1) + pointY(0)) / 2);
                for (let i = 0; i < POINTS; i++) {
                    ctx.quadraticCurveTo(pointX(i), pointY(i), (pointX(i) + pointX(i + 1)) / 2, (pointY(i) + pointY(i + 1)) / 2);
                }
                ctx.closePath();
            };

            ctx.save();
            ctx.lineJoin = 'round';
            const wash = ctx.createRadialGradient(centerX, centerY, unit * 0.2, centerX, centerY, unit * 2.1);
            wash.addColorStop(0, withAlpha(colors.glow, 0.0));
            wash.addColorStop(1, withAlpha(colors.glow, 0.30));
            traceLoop(1);
            ctx.fillStyle = wash;
            ctx.fill();

            traceLoop(0.82);                                       // quieter echo ring inside
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = Math.max(1, unit * 0.025);
            ctx.strokeStyle = colors.secondary;
            ctx.stroke();

            traceLoop(1);                                          // the main outline: a single element carrying the whole bloom
            const lw = Math.max(2, unit * (0.05 + 0.03 * bass));
            strokeWithGlow(ctx, colors.primary, lw, 0.38 * styleParams.glow,
                           createBloomGradient(ctx, centerX, centerY, colors), 
                           { haloWidth: lw * styleParams.glowWidth });
            ctx.restore();
        },
    },

    skyline: {
        label: 'Skyline',
        tip: 'A mirrored equalizer across the frame: bass in the middle, vocal either side, treble at the edges. Each bar glows with its own energy.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Width and height inside the frame.' },
            { key: 'barCount', label: 'Bars', min: 17, max: 61, step: 4, default: 37, tip: 'How many bars across.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const barCount = styleParams.barCount;
            const halfSpan = drawContext.baseRadius * styleParams.size * 2.05;
            const maxHalfHeight = drawContext.baseRadius * styleParams.size * 1.30;
            const lineWidth = Math.max(2, (2 * halfSpan / (barCount - 1)) * 0.55);

            const columns = scratchBuffer('skylineColumns', barCount * 3);       // x, top, bottom per bar
            const weights = scratchBuffer('skylineWeights', barCount);
            for (let barIndex = 0; barIndex < barCount; barIndex++) {
                const across = barIndex / (barCount - 1);
                const fromCentre = Math.abs(2 * across - 1);                      // 0 in the middle, 1 at the edges
                const energy = Math.min(1, bandEnergy(fromCentre, bass, vocal, treble));
                const wobble = 0.85 + 0.15 * Math.sin(nowMs * 0.004 + barIndex * 1.7);
                const halfHeight = maxHalfHeight * (0.05 + energy * wobble) * (1 - 0.3 * fromCentre * fromCentre);
                const offset = barIndex * 3;
                columns[offset] = centerX + (across - 0.5) * 2 * halfSpan;
                columns[offset + 1] = centerY - halfHeight;
                columns[offset + 2] = centerY + halfHeight;
                weights[barIndex] = styleParams.glow * (0.3 + 4.5 * energy);      // glow follows each bar's own energy, not its index
            }
            const addBar = (barIndex) => {
                const offset = barIndex * 3;
                ctx.moveTo(columns[offset], columns[offset + 1]);
                ctx.lineTo(columns[offset], columns[offset + 2]);
            };

            ctx.save();
            ctx.lineCap = 'round';
            let haloStyle = colors.primary;
            if (ctx.createLinearGradient) {
                haloStyle = ctx.createLinearGradient(centerX - halfSpan, 0, centerX + halfSpan, 0);
                haloStyle.addColorStop(0, colors.primary);
                haloStyle.addColorStop(0.5, colors.glowAccent || colors.secondary);
                haloStyle.addColorStop(1, colors.primary);
            }
            ctx.beginPath();                                                      // faint centre line gives the bars something to stand on
            ctx.moveTo(centerX - halfSpan * 1.06, centerY);
            ctx.lineTo(centerX + halfSpan * 1.06, centerY);
            ctx.globalAlpha = 0.22;
            ctx.lineWidth = Math.max(1, lineWidth * 0.3);
            ctx.strokeStyle = colors.secondary;
            ctx.stroke();

            strokeBloomTiers(ctx, barCount, weights, addBar, haloStyle, lineWidth * styleParams.glowWidth);
            ctx.beginPath();
            for (let barIndex = 0; barIndex < barCount; barIndex++) addBar(barIndex);
            strokeWithGlow(ctx, colors.primary, lineWidth, 0, undefined, undefined,
                           { haloWidth: lineWidth * styleParams.glowWidth });
            ctx.restore();
        },
    },

    prism: {
        label: 'Prism',
        tip: 'Three nested shapes — triangle, square, hexagon — spinning against each other. Each follows one band and its corners react to where they are on screen.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Prism size inside its frame.' },
            { key: 'spin', label: 'Spin', min: 0, max: 2, step: 0.1, default: 1, tip: 'Rotation speed. 0 holds the shapes still.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.0,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const unit = drawContext.baseRadius * styleParams.size;
            const haloStyle = createBloomGradient(ctx, centerX, centerY, colors);

            ctx.save();
            ctx.lineJoin = 'miter';
            ctx.miterLimit = 6;
            for (let layerIndex = 0; layerIndex < PRISM_LAYERS.length; layerIndex++) {
                const layer = PRISM_LAYERS[layerIndex];
                const ownBand = frameValues[layer.band];
                const rotation = nowMs * layer.speed * styleParams.spin;
                const breathing = 1 + 0.15 * ownBand;

                ctx.beginPath();
                for (let corner = 0; corner < layer.sides; corner++) {
                    const angle = rotation + (corner / layer.sides) * Math.PI * 2 - Math.PI / 2;
                    const energy = Math.min(1, 0.6 * ownBand + 0.7 * bandEnergy(verticalnessAtAngle(angle), frameValues.bass, frameValues.vocal, frameValues.treble));
                    const wobble = 0.7 + 0.3 * Math.sin(nowMs * 0.003 + corner * 2.1 + layerIndex);
                    const radius = unit * layer.radius * breathing * (1 + 0.55 * energy * wobble);
                    const cornerX = centerX + Math.cos(angle) * radius, cornerY = centerY + Math.sin(angle) * radius;
                    if (corner === 0) ctx.moveTo(cornerX, cornerY); else ctx.lineTo(cornerX, cornerY);
                }
                ctx.closePath();
                ctx.globalAlpha = 0.07 + 0.10 * ownBand;
                ctx.fillStyle = colors[layer.color];
                ctx.fill();
                const lw = Math.max(2, unit * (0.045 + 0.05 * ownBand));
                strokeWithGlow(ctx, colors[layer.color], lw, 0.35 * styleParams.glow * (0.5 + ownBand), 
                               haloStyle, { haloWidth: lw * styleParams.glowWidth });
            }
            ctx.restore();
        },
    },

    vortex: { // heaviest, lower its dots default first if the frame rate drops.
        label: 'Vortex',
        tip: 'A spiral galaxy of dots. Each dot pushes outward and brightens with the band at its position on screen; only the lit ones bloom.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Spiral size inside its frame.' },
            { key: 'dots', label: 'Dots', min: 48, max: 180, step: 12, default: 108, tip: 'Total dots across the three arms.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.2, max: 1, step: 0.1, default: 0.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const unit = drawContext.baseRadius * styleParams.size;
            const ARMS = 3;
            const perArm = Math.floor(styleParams.dots / ARMS);
            const total = perArm * ARMS;
            const rotation = nowMs * 0.00028;

            const dotX = scratchBuffer('vortexX', total), dotY = scratchBuffer('vortexY', total);
            const dotSize = scratchBuffer('vortexSize', total), dotEnergy = scratchBuffer('vortexEnergy', total);
            const weights = scratchBuffer('vortexWeights', total);
            for (let arm = 0; arm < ARMS; arm++) {
                for (let step = 0; step < perArm; step++) {
                    const index = arm * perArm + step;
                    const t = step / (perArm - 1);                                    // 0 at the core, 1 at the rim
                    const angle = (arm / ARMS) * Math.PI * 2 + t * 1.15 * Math.PI * 2 + rotation;
                    const energy = Math.min(1, bandEnergy(verticalnessAtAngle(angle), bass, vocal, treble)) * (0.55 + 0.45 * t);
                    const wobble = 0.85 + 0.15 * Math.sin(nowMs * 0.004 + index * 1.7);
                    const radius = unit * (0.20 + 1.75 * t) + unit * 0.38 * energy * wobble * (0.3 + t);
                    dotX[index] = centerX + Math.cos(angle) * radius;
                    dotY[index] = centerY + Math.sin(angle) * radius;
                    dotSize[index] = 1.0 + 0.9 * t + 3.2 * energy * (0.4 + 0.6 * t);
                    dotEnergy[index] = energy;
                    weights[index] = styleParams.glow * 6 * energy;                    // idle dots get no halo at all
                }
            }
            const addDot = (index) => { ctx.moveTo(dotX[index], dotY[index]); ctx.lineTo(dotX[index] + 0.01, dotY[index]); };

            ctx.save();
            ctx.lineCap = 'round';
            strokeBloomTiers(ctx, total, weights, addDot, createBloomGradient(ctx, centerX, centerY, colors), 
                             Math.max(6, unit * 0.2) * styleParams.glowWidth);

            // two fills per colour: every dot dim, then the lit ones bright on top. Never a fill per dot.
            for (let colorGroup = 0; colorGroup < 2; colorGroup++) {
                ctx.fillStyle = colorGroup === 0 ? colors.primary : colors.secondary;
                for (let pass = 0; pass < 2; pass++) {
                    ctx.beginPath();
                    for (let arm = colorGroup; arm < ARMS; arm += 2) {                 // arms 0 and 2 primary, arm 1 secondary
                        for (let step = 0; step < perArm; step++) {
                            const index = arm * perArm + step;
                            if (pass === 1 && dotEnergy[index] < 0.35) continue;
                            ctx.moveTo(dotX[index] + dotSize[index], dotY[index]);
                            ctx.arc(dotX[index], dotY[index], dotSize[index], 0, Math.PI * 2);
                        }
                    }
                    ctx.globalAlpha = pass === 0 ? 0.38 : 0.92;
                    ctx.fill();
                }
            }

            // const coreRadius = unit * 0.10 * (1 + 0.35 * bass);
            // ctx.beginPath();
            // ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            // strokeWithGlow(ctx, colors.primary, 0, 0.5 * styleParams.glow, undefined, { haloWidth: coreRadius * styleParams.glowWidth });
            // ctx.globalAlpha = 0.8;
            // ctx.fillStyle = colors.primary;
            // ctx.fill();
            ctx.restore();
        },
    },

    // Same bars recipe (bandEnergy by screen position, per-element wobble), plus: every moving value is eased
    // (easeToward / springs / trails), nothing waits for hitDetected, trig comes from tables, and nothing allocates per frame.
    aurora: {
        label: 'Aurora',
        tip: 'Curtains of light flowing across the frame. The lowest follows bass, the middle vocal, the top treble; they ripple faster as the music gets busier.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Width and height inside the frame.' },
            { key: 'curtains', label: 'Curtains', min: 2, max: 6, step: 1, default: 4, tip: 'How many layers of light.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },       
        ],
        createState() {
            return { heights: new Float32Array(6 * AURORA_POINTS), flow: 0, energy: new Float32Array(6), xs: new Float32Array(AURORA_POINTS), ys: new Float32Array(AURORA_POINTS) };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const layers = styleParams.curtains, N = AURORA_POINTS;
            const halfSpan = Math.min(centerX * 0.97, drawContext.baseRadius * 4.4) * styleParams.size;

            state.flow += deltaSeconds * (0.5 + 1.4 * vocal + 0.8 * bass);        // flow speed is integrated, so a loud moment speeds the waves up without ever jumping them
            const flow = state.flow;
            const { xs, ys, heights } = state;
            for (let i = 0; i < N; i++) xs[i] = centerX + ((i / (N - 1)) * 2 - 1) * halfSpan;

            const haloStyle = ctx.createLinearGradient(centerX - halfSpan, 0, centerX + halfSpan, 0);
            haloStyle.addColorStop(0, colors.primary);
            haloStyle.addColorStop(0.5, colors.glowAccent || colors.secondary);
            haloStyle.addColorStop(1, colors.primary);

            ctx.save();
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            for (let layer = 0; layer < layers; layer++) {
                const vertical = layers === 1 ? 0.5 : layer / (layers - 1);                // 0 = lowest curtain (bass) .. 1 = highest (treble)
                state.energy[layer] = easeToward(state.energy[layer], Math.min(1, bandEnergy(vertical, bass, vocal, treble)), deltaSeconds, 0.06);
                const energy = state.energy[layer];
                const baseY = unit * (1.0 - 1.85 * vertical);
                const amplitude = unit * (0.30 + 1.00 * energy); // If you want it livelier, raise this.
                const thickness = unit * (0.55 + 0.70 * energy);

                for (let i = 0; i < N; i++) {
                    const across = i / (N - 1);
                    const taper = 0.35 + 0.65 * Math.sin(Math.PI * across);                  // curtains calm down toward the sides
                    const wave = 0.55 * Math.sin(across * 5.2 + flow * (1 + 0.25 * layer) + layer * 1.7)
                               + 0.45 * Math.sin(across * 2.4 + flow * 0.4 + layer)
                               + 0.30 * (0.4 + treble) * Math.sin(across * 11.5 - flow * 1.3 + layer * 0.9);
                    const index = layer * N + i;
                    heights[index] = easeToward(heights[index], baseY - amplitude * wave * taper, deltaSeconds, 0.06);   // temporal smoothing on top of the spatial curve
                    ys[i] = centerY + heights[index];
                }

                const color = layer % 2 === 0 ? colors.primary : colors.secondary;
                const top = centerY + baseY - amplitude * 1.2, bottom = centerY + baseY + thickness;
                const curtain = ctx.createLinearGradient(0, top, 0, bottom);                // light hangs from the curve and fades out below it
                curtain.addColorStop(0, withAlpha(color, 0.62 * styleParams.glow + 0.1));
                curtain.addColorStop(1, withAlpha(color, 0));
                ctx.beginPath();
                traceSmoothCurve(ctx, xs, ys, 0, N);
                ctx.lineTo(xs[N - 1], bottom);
                ctx.lineTo(xs[0], bottom);
                ctx.closePath();
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = curtain;
                ctx.fill();
                ctx.globalCompositeOperation = 'source-over';

                ctx.beginPath();                                                            // bright leading edge with the shared bloom
                traceSmoothCurve(ctx, xs, ys, 0, N);
                const lw = Math.max(1.5, unit * (0.03 + 0.03 * energy));
                strokeWithGlow(ctx, color, lw, 0.18 * styleParams.glow * (0.4 + energy), haloStyle, 
                               { haloWidth: lw * styleParams.glowWidth });
            }
            ctx.restore();
        },
    },

    ripples: {
        label: 'Ripples',
        tip: 'Contour rings like a pond. Every beat sends a pulse rippling outward: each ring answers the music a moment after the one inside it, and the ring carrying the pulse blooms white-hot.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Pond size inside its frame.' },
            { key: 'rings', label: 'Rings', min: 3, max: 9, step: 1, default: 6, tip: 'How many contour rings.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Bloom strength: stacked additive halo, no blur filter.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 1.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },  
        ],
        createState() {
            return { bass: createTrail(), vocal: createTrail(), treble: createTrail(), easedBass: 0, easedVocal: 0, easedTreble: 0,
                     xs: new Float32Array(9 * LOOP_POINTS), ys: new Float32Array(9 * LOOP_POINTS),
                     radii: new Float32Array(LOOP_POINTS), spare: new Float32Array(LOOP_POINTS), ringBass: new Float32Array(9), ringGlow: new Float32Array(9) };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const seconds = nowMs / 1000;
            const rings = styleParams.rings, N = LOOP_POINTS;
            const { xs, ys, radii, spare, ringBass, ringGlow } = state;

            state.easedBass = easeToward(state.easedBass, frameValues.bass, deltaSeconds, 0.04);       // a hair of smoothing: pulses swell instead of popping
            state.easedVocal = easeToward(state.easedVocal, frameValues.vocal, deltaSeconds, 0.08);
            state.easedTreble = easeToward(state.easedTreble, frameValues.treble, deltaSeconds, 0.05);
            pushTrail(state.bass, state.easedBass, deltaSeconds);                           // each ring reads the bands from the past,
            pushTrail(state.vocal, state.easedVocal, deltaSeconds);                         // a little further back for every step outward
            pushTrail(state.treble, state.easedTreble, deltaSeconds);

            for (let ring = 0; ring < rings; ring++) {
                const t = ring / (rings - 1);
                const delay = ring * 0.075;
                const bass = readTrail(state.bass, delay), vocal = readTrail(state.vocal, delay), treble = readTrail(state.treble, delay);
                ringBass[ring] = bass;
                const baseRadius = unit * (0.45 + 1.55 * t);
                const amplitude = 0.30 - 0.12 * t;                                          // outer rings move less

                const w3 = seconds * 1.6 + ring * 0.7, w8 = seconds * 5.5 + ring * 1.3, w5 = seconds * 0.9 + ring * 0.4;
                const c3 = Math.cos(w3), s3 = Math.sin(w3), c8 = Math.cos(w8), s8 = Math.sin(w8), c5 = Math.cos(w5), s5 = Math.sin(w5);
                for (let i = 0; i < N; i++) {
                    const energy = Math.min(1, bandEnergy(LOOP.vertical[i], bass, vocal, treble));
                    const ripple = 0.10 * vocal * (LOOP.sin3[i] * c3 - LOOP.cos3[i] * s3)       // sin(3θ − ωt) from the tables
                                 + 0.08 * treble * (LOOP.sin8[i] * c8 - LOOP.cos8[i] * s8)
                                 + 0.03 * (LOOP.sin5[i] * c5 - LOOP.cos5[i] * s5);
                    radii[i] = baseRadius * (1 + amplitude * energy + ripple);
                }
                for (let i = 0; i < N; i++) spare[i] = (radii[i === 0 ? N - 1 : i - 1] + 2 * radii[i] + radii[i + 1 === N ? 0 : i + 1]) * 0.25;   // one blur pass: no band-zone kinks
                const offset = ring * N;
                for (let i = 0; i < N; i++) { xs[offset + i] = centerX + LOOP.cos[i] * spare[i]; ys[offset + i] = centerY + LOOP.sin[i] * spare[i]; }
            }

            ctx.save();
            ctx.lineJoin = 'round';
            const weights = scratchBuffer('rippleWeights', rings);
            for (let ring = 0; ring < rings; ring++) {
                ringGlow[ring] = easeToward(ringGlow[ring], styleParams.glow * (0.25 + 5.0 * ringBass[ring]), deltaSeconds, 0.05);   // the ring carrying the pulse blooms, swelling and fading smoothly
                weights[ring] = ringGlow[ring];
            }
            const haloStyle = createBloomGradient(ctx, centerX, centerY, colors);
            // halos are wide and soft, so they trace every second point with straight segments: half the path work of the crisp rings
            const addHalo = (ring) => { const o = ring * N; ctx.moveTo(xs[o], ys[o]); for (let i = 2; i < N; i += 2) ctx.lineTo(xs[o + i], ys[o + i]); ctx.closePath(); };
            strokeBloomTiers(ctx, rings, weights, addHalo, haloStyle, unit * 0.05 * styleParams.glowWidth);

            for (let ring = rings - 1; ring >= 0; ring--) {                                // crisp rings, outer to inner
                const t = ring / (rings - 1);
                ctx.beginPath();
                traceSmoothLoop(ctx, xs, ys, ring * N, N);
                ctx.globalAlpha = 0.95 - 0.5 * t;
                ctx.lineWidth = Math.max(1, unit * (0.055 - 0.03 * t));
                ctx.strokeStyle = ring % 2 === 0 ? colors.primary : colors.secondary;
                ctx.stroke();
            }

            // const coreRadius = unit * 0.08 * (1 + 0.15 * frameValues.bass);
            // ctx.beginPath();
            // ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            // strokeWithGlow(ctx, colors.primary, 0, 0.4 * styleParams.glow, undefined, { haloWidth: coreRadius * styleParams.glowWidth });
            // ctx.globalAlpha = 0.85;
            // ctx.fillStyle = colors.primary;
            // ctx.fill();
            ctx.restore();
        },
    },

    blobs: {
        label: 'Blobs',
        tip: 'Soft glowing blobs drifting and swelling like a lava lamp. Each blob grows and pushes outward with the band at its place on screen, and they melt together where they overlap.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Lamp size inside its frame.' },
            { key: 'blobs', label: 'Blobs', min: 4, max: 10, step: 1, default: 7, tip: 'How many blobs.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Brightness of the blobs.' },
        ],
        createState() {
            return { spin: 0, push: new Float32Array(10), pulse: 0 };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const seconds = nowMs / 1000;
            const blobs = styleParams.blobs;
            const stretch = clamp(centerX / centerY, 1, 1.5);                                 // spread wider on wide canvases

            state.spin += deltaSeconds * (0.12 + 0.35 * vocal);                               // integrated, so it speeds up and slows down without jumping
            state.pulse = easeToward(state.pulse, bass, deltaSeconds, 0.06);

            ctx.save();
            ctx.globalCompositeOperation = 'lighter';                                         // overlapping blobs add up: that is the "melting together"
            for (let blob = 0; blob < blobs; blob++) {
                const ring = blob % 3;
                const angle = (blob / blobs) * Math.PI * 2 + Math.PI / 2
                            + state.spin * (ring % 2 === 0 ? 1 : -1) * (0.7 + 0.3 * ring)
                            + 0.35 * Math.sin(seconds * 0.5 + blob * 1.9);
                const target = Math.min(1, bandEnergy(verticalnessAtAngle(angle), bass, vocal, treble));
                state.push[blob] = easeToward(state.push[blob], target, deltaSeconds, 0.08);
                const push = state.push[blob];

                const radial = unit * (0.5 + 0.55 * ring + 0.45 * push + 0.15 * state.pulse);
                const x = centerX + Math.cos(angle) * radial * stretch, y = centerY + Math.sin(angle) * radial;
                const radius = unit * (0.65 + 0.20 * ring) * (0.85 + 0.9 * push);
                const color = ring === 0 ? colors.primary : (ring === 1 ? colors.secondary : (colors.glowAccent || colors.primary));

                const body = ctx.createRadialGradient(x, y, 0, x, y, radius);
                body.addColorStop(0, withAlpha(color, Math.min(1, 0.80 * styleParams.glow + 0.20 * push)));
                body.addColorStop(0.5, withAlpha(color, 0.38 * styleParams.glow));
                body.addColorStop(1, withAlpha(color, 0));
                ctx.fillStyle = body;
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fill();

                const hot = ctx.createRadialGradient(x, y, 0, x, y, radius * 0.38);          // small hot core, brightest when the blob is loud
                hot.addColorStop(0, `rgba(255, 255, 255, ${(0.25 + 0.6 * push) * styleParams.glow})`);
                hot.addColorStop(1, 'rgba(255, 255, 255, 0)');
                ctx.fillStyle = hot;
                ctx.beginPath();
                ctx.arc(x, y, radius * 0.38, 0, Math.PI * 2);
                ctx.fill();
            }

            // const coreRadius = unit * (0.8 + 0.5 * state.pulse);                           // a large soft core that breathes with the bass
            // const core = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, coreRadius);
            // core.addColorStop(0, withAlpha(colors.primary, 0.65 * styleParams.glow));
            // core.addColorStop(1, withAlpha(colors.primary, 0));
            // ctx.fillStyle = core;
            // ctx.beginPath();
            // ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            // ctx.fill();
            ctx.restore();
        },
    },

    // ── experimental animations section ──
    dancer: {
        label: 'Dancer',
        tip: 'A line-art dancer that walks, struts, skips and moonwalks across the screen between a pool of dance moves, all on the beat. Arms rise with vocal, body pumps with bass, hands sparkle with treble.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Figure size inside its frame.' },
            { key: 'energy', label: 'Energy', min: 0.4, max: 1.6, step: 0.1, default: 1, tip: 'How hard the dancer moves on each beat.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Soft halo around the figure.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.0,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
            { key: 'moveBeats', label: 'Move length', min: 2, max: 16, step: 2, default: 8, tip: 'Beats before the dancer switches to a new move.' },
            { key: 'roam', label: 'Roam', min: 0, max: 1, step: 0.1, default: 1, tip: 'How much of the screen width the dancer travels across. 0 keeps it in the centre.' },        
        ],
        createState() {
            const makeLeg = () => ({ hipX: 0, hipY: 0, kneeX: 0, kneeY: 0, footX: 0, footY: 0 });
            const makeArm = () => ({ shoulderX: 0, shoulderY: 0, elbowX: 0, elbowY: 0, handX: 0, handY: 0 });
            const state = {
                choreo: createChoreographer(DANCE_MOVES.length),
                kick: createSpring(), treble: createSpring(),
                pose: Object.assign({}, DANCE_NEUTRAL),                 // smoothed pose actually drawn
                targetNow: Object.assign({}, DANCE_NEUTRAL),            // scratch: target pose of the current move
                targetPrev: Object.assign({}, DANCE_NEUTRAL),           // scratch: target pose of the move fading out
                energyNow: 0, canRoam: false, walker: createStageWalker(),
                legs: [makeLeg(), makeLeg()], arms: [makeArm(), makeArm()],
                joint: { x: 0, y: 0, endX: 0, endY: 0 },                // scratch output of the limb solver
            };
            state.accept = (index) => DANCE_MOVES[index].minEnergy <= state.energyNow + 0.15 && (!DANCE_MOVES[index].travel || state.canRoam);   // built once, not per frame   // built once, not per frame
            return state;
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const seconds = nowMs / 1000;
            const toX = (unitsX) => centerX + (unitsX + state.walker.x) * unit;     // everything the figure draws is shifted by where it stands on the stage
            const toY = (unitsY) => centerY + unitsY * unit;

            // ── choreography: pick a move every few beats, crossfade into it, run it on the beat clock ──
            state.energyNow = clamp(Math.max(frameValues.bass, frameValues.vocal), 0, 1);
            const intensity = styleParams.energy * (0.5 + 0.7 * state.energyNow);      // quiet passages = smaller moves, never frozen
            stepChoreographer(state.choreo, frameValues, deltaSeconds, DANCE_MOVES.length, styleParams.moveBeats, state.accept);

            const choreo = state.choreo, target = state.targetNow, previous = state.targetPrev;
            const move = DANCE_MOVES[choreo.current], walker = state.walker;
            const halfRange = Math.max(0, styleParams.roam * (centerX / unit - 1.5));      // room either side of centre, in figure units
            state.canRoam = halfRange > 0.8;
            planStage(walker, choreo.phase, deltaSeconds, move.travel === true, choreo.beatsLeft, halfRange, (move.speed || 1) * (0.75 + 0.5 * state.energyNow));
            const gaitDir = move.gaitDir || 1, stride = (move.stride || 0.5) * walker.pace;
            Object.assign(target, DANCE_NEUTRAL);
            DANCE_MOVES[choreo.current].fn(choreo.phase, intensity, target);
            if (choreo.blend < 1) {
                Object.assign(previous, DANCE_NEUTRAL);
                DANCE_MOVES[choreo.previous].fn(choreo.phase, intensity, previous);
                const mix = smoothstep(choreo.blend);
                for (const key of DANCE_KEYS) target[key] = previous[key] + (target[key] - previous[key]) * mix;
            }

            // continuous layer (the bars recipe): bands push on top of whatever move is playing, every frame
            target.handLy -= 0.7 * frameValues.vocal;  target.handRy -= 0.7 * frameValues.vocal;     // arms rise with vocal
            target.handLx += 0.15 * frameValues.vocal; target.handRx += 0.15 * frameValues.vocal;
            target.handLy = Math.max(-1.05, target.handLy);                                           // never reach past the top of the frame
            target.handRy = Math.max(-1.05, target.handRy);
            target.squat += 0.22 * frameValues.bass;                                                  // body pumps with bass
            target.headTilt += 0.35 * frameValues.treble * Math.sin(seconds * 9);                    // head flicks with treble

            if (frameValues.hitDetected) state.kick.velocity += 9 * styleParams.energy * (frameValues.hitStrength || 0.7);
            stepSpring(state.kick, 0, 2.6, 0.45, deltaSeconds);        // extra dip on every detected hit, on top of the move
            stepSpring(state.treble, frameValues.treble, 5, 0.8, deltaSeconds);

            const follow = 1 - Math.exp(-deltaSeconds / 0.05);         // 50ms glide: hides the small phase corrections
            const pose = state.pose;
            for (const key of DANCE_KEYS) pose[key] += (target[key] - pose[key]) * follow;

            // ── rig ──
            const groundY = 2.1;
            const squat = clamp(pose.squat + state.kick.value * 0.5 + 0.12 * walker.pace * (0.5 - 0.5 * Math.cos(2 * DANCE_TAU * walker.gait)), -0.4, 1.2);   // bobs twice per walk cycle
            const sway = Math.sin(seconds * 1.4) * 0.06;               // always a little alive, even in silence
            const hipX = pose.hipX + sway;
            const hipY = groundY - (1.72 - 0.55 * squat) - pose.hop;
            const lean = pose.lean + sway * 0.5 + walker.turn * 0.12 * walker.pace * gaitDir;   // leans into the direction of travel
            const shoulderCenterX = hipX + Math.sin(lean) * 1.1;
            const shoulderCenterY = hipY - Math.cos(lean) * 1.1;
            const headAngle = lean + pose.headTilt * 0.25;
            const headX = shoulderCenterX + Math.sin(headAngle) * 0.58;
            const headY = shoulderCenterY - Math.cos(headAngle) * 0.58;

            for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
                const side = sideIndex === 0 ? -1 : 1;

                const leg = state.legs[sideIndex];
                const stepPhase = DANCE_TAU * (walker.gait * gaitDir + (side < 0 ? 0 : 0.5));        // legs alternate half a cycle apart
                const footLift = 0.4 * (side < 0 ? pose.liftL : pose.liftR) + pose.hop * 0.9
                               + 0.45 * walker.pace * Math.max(0, Math.cos(stepPhase)) * (gaitDir > 0 ? 1 : 0.3);   // moonwalk slides, so barely lifts
                const footX = side * 0.62 * pose.stance * pose.width * (1 - 0.2 * walker.pace) + walker.turn * stride * 0.8 * Math.sin(stepPhase);   // keeps the feet from crossing in an X
                leg.hipX = hipX + side * 0.2 * pose.width;
                leg.hipY = hipY;
                solveTwoBoneJoint(leg.hipX, leg.hipY, footX, groundY - footLift, 0.95, side, state.joint);
                leg.kneeX = state.joint.x; leg.kneeY = state.joint.y; leg.footX = state.joint.endX; leg.footY = state.joint.endY;

                const arm = state.arms[sideIndex];
                arm.shoulderX = shoulderCenterX + Math.cos(lean) * 0.38 * side * pose.width;
                arm.shoulderY = shoulderCenterY + Math.sin(lean) * 0.38 * side;
                const reach = side < 0 ? pose.handLx : pose.handRx;
                const drop = (side < 0 ? pose.handLy : pose.handRy) + side * 0.35 * walker.pace * Math.sin(DANCE_TAU * walker.gait * gaitDir);   // arms swing against the legs
                const wave = Math.sin(seconds * 6 + side * 1.2) * (0.05 + 0.12 * frameValues.vocal);
                const handTargetX = arm.shoulderX + side * reach * pose.width + wave * 0.5;
                const handTargetY = arm.shoulderY + drop + wave * 0.35 + squat * 0.25;
                solveTwoBoneJoint(arm.shoulderX, arm.shoulderY, handTargetX, handTargetY, 0.72, side, state.joint);
                arm.elbowX = state.joint.x; arm.elbowY = state.joint.y; arm.handX = state.joint.endX; arm.handY = state.joint.endY;
            }

            // ── draw ──
            const glowAlpha = 0.10 * styleParams.glow;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            ctx.globalAlpha = 0.22;                                    // ground shadow shrinks as the dancer rises
            ctx.fillStyle = colors.primary;
            ctx.beginPath();
            ctx.ellipse(toX(hipX * 0.5), toY(groundY + 0.08), unit * (1.0 - 0.15 * squat), unit * 0.14, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;

            ctx.beginPath();                                           // legs and torso
            for (const leg of state.legs) {
                ctx.moveTo(toX(leg.hipX), toY(leg.hipY));
                ctx.lineTo(toX(leg.kneeX), toY(leg.kneeY));
                ctx.lineTo(toX(leg.footX), toY(leg.footY));
            }
            ctx.moveTo(toX(hipX), toY(hipY));
            ctx.lineTo(toX(shoulderCenterX), toY(shoulderCenterY));
            const legLw = unit * 0.2;
            strokeWithGlow(ctx, colors.primary, legLw, glowAlpha, undefined, 
                           { haloWidth: legLw * styleParams.glowWidth });

            ctx.beginPath();                                           // arms
            for (const arm of state.arms) {
                ctx.moveTo(toX(arm.shoulderX), toY(arm.shoulderY));
                ctx.lineTo(toX(arm.elbowX), toY(arm.elbowY));
                ctx.lineTo(toX(arm.handX), toY(arm.handY));
            }
            const armLW = unit * 0.16;
            strokeWithGlow(ctx, colors.secondary, armLW, glowAlpha, undefined, 
                           { haloWidth: armLW * styleParams.glowWidth });

            ctx.beginPath();                                           // head
            ctx.arc(toX(headX), toY(headY), unit * 0.36, 0, Math.PI * 2);
            ctx.globalAlpha = 0.25;
            ctx.fillStyle = colors.primary;
            ctx.fill();
            const headLw = unit * 0.1;
            strokeWithGlow(ctx, colors.primary, headLw, glowAlpha, undefined,
                           { haloWidth: headLw * styleParams.glowWidth });

            const treble = clamp(state.treble.value, 0, 1);            // hand sparkles
            if (treble > 0.03) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = Math.max(1, unit * 0.04);
                for (let armIndex = 0; armIndex < 2; armIndex++) {
                    const arm = state.arms[armIndex];
                    for (let sparkle = 0; sparkle < 3; sparkle++) {
                        const phase = seconds * 7 + sparkle * 2.1 + armIndex * 1.3;
                        const reach = (0.22 + 0.12 * sparkle) * unit;
                        const sparkleX = toX(arm.handX) + Math.cos(phase) * reach, sparkleY = toY(arm.handY) + Math.sin(phase * 1.3) * reach;
                        const crossSize = unit * 0.06 * (0.5 + 0.5 * Math.sin(phase * 2));
                        ctx.globalAlpha = treble * (0.4 + 0.4 * Math.sin(phase * 2));
                        ctx.beginPath();
                        ctx.moveTo(sparkleX - crossSize, sparkleY); ctx.lineTo(sparkleX + crossSize, sparkleY);
                        ctx.moveTo(sparkleX, sparkleY - crossSize); ctx.lineTo(sparkleX, sparkleY + crossSize);
                        ctx.stroke();
                    }
                }
            }
            ctx.globalAlpha = 1;
        },
    },

    cat: {
        label: 'Cat',
        tip: 'A full-body cat that chases a ball of yarn across the screen, bats it on the beat, trots with it, juggles and sings. Bass bounces it and sets how hard it bats, vocal wags the tail and opens the mouth, treble twitches the ears.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Overall size inside its frame.' },
            { key: 'playfulness', label: 'Playfulness', min: 0.6, max: 1.4, step: 0.1, default: 1, tip: 'How high the ball bounces.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Soft halo on the line art.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.0,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
            { key: 'trickBeats', label: 'Trick length', min: 2, max: 16, step: 2, default: 8, tip: 'Beats before the cat switches to a new trick.' },            
            { key: 'roam', label: 'Roam', min: 0, max: 1, step: 0.1, default: 1, tip: 'How much of the screen width the cat runs across. 0 keeps it in the centre.' },
        ],
        createState() {
            const state = {
                squat: createSpring(), pupilX: createSpring(), pupilY: createSpring(),
                ear: createSpring(), mouth: createSpring(), pawReach: createSpring(),
                walker: createStageWalker(), trail: createTrail(),
                ball: { x: 1.5, vx: 0, y: 1.85, vy: 0, spin: 0 },
                choreo: createChoreographer(CAT_TRICKS.length), trickIndex: -1, lastSlot: 0, energyNow: 0, canRoam: false, batDirection: -1,
                joint: { x: 0, y: 0, endX: 0, endY: 0 },                // scratch output of the leg solver
            };
            state.accept = (index) => CAT_TRICKS[index].minEnergy <= state.energyNow + 0.15 && (!CAT_TRICKS[index].roams || state.canRoam);
            return state;
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const seconds = nowMs / 1000;
            const toX = (unitsX) => centerX + unitsX * unit;           // screen position of a point in character units (0 = canvas centre)
            const toY = (unitsY) => centerY + unitsY * unit;

            const GROUND = 2.3, ballRadius = 0.45, ballRestY = GROUND - ballRadius, gravity = 28;
            const HEAD_SCALE = 0.56, headX = 0, headY = -0.25;         // the original front-facing head, drawn at 56% on the body
            const walker = state.walker, ball = state.ball;

            // ── tricks: a new one every few beats; ball events are locked to the beat clock ──
            state.energyNow = clamp(Math.max(frameValues.bass, frameValues.vocal), 0, 1);
            stepChoreographer(state.choreo, frameValues, deltaSeconds, CAT_TRICKS.length, styleParams.trickBeats, state.accept);
            const trick = CAT_TRICKS[state.choreo.current], phase = state.choreo.phase;
            const halfRange = Math.max(0, styleParams.roam * (centerX / unit - 1.9));      // room either side of centre for body + ball
            state.canRoam = halfRange > 0.8;
            const energy = state.energyNow;
            pushTrail(state.trail, frameValues.vocal, deltaSeconds);

            if (state.trickIndex !== state.choreo.current) {           // new trick: don't fire a burst of missed ticks
                state.trickIndex = state.choreo.current;
                state.lastSlot = Math.floor(phase * trick.ticks);
                ball.vx = 0;
                state.batDirection = ball.x > 0 ? -1 : 1;
            }
            const slot = Math.floor(phase * trick.ticks);
            const tick = trick.ticks > 0 && frameValues.hitDetected;   // a real beat, not a seek
            if (slot !== state.lastSlot) state.lastSlot = slot;  // also follows a backwards seek, so events can't get stuck
            const launch = (apex) => {  // speed needed to reach a fixed apex from where the ball is NOW
                ball.vy = -Math.sqrt(2 * gravity * Math.max(0, ball.y - (ballRestY - apex * styleParams.playfulness)));
            };

            let ballTargetX = ball.x, ballFollow = 0;
            if (trick.mode === 'chase') {
                // run to just behind the ball, then bat it away on the beat; the harder the bass, the farther it flies
                const dir = state.batDirection;
                const standX = ball.x - dir * 1.15;
                pursueStage(walker, standX, deltaSeconds, 2.2 + 3.0 * energy, halfRange);
                if (Math.abs(walker.vel) < 0.3) walker.facing = dir;
                if (tick && Math.abs(walker.x - standX) < 0.6 && Math.abs(ball.vx) < 1.2) {
                    ball.vx = dir * (3.2 + 3.2 * frameValues.bass);
                    launch(0.5);
                    state.pawReach.velocity += 10;
                }
                const limit = halfRange + 0.9;
                ball.x += ball.vx * deltaSeconds;
                ball.vx *= Math.exp(-1.6 * deltaSeconds);
                if (Math.abs(ball.x) > limit) { ball.x = Math.sign(ball.x) * limit; ball.vx = -ball.vx * 0.6; }
                if (Math.abs(ball.vx) < 0.5) state.batDirection = ball.x > halfRange * 0.3 ? -1 : (ball.x < -halfRange * 0.3 ? 1 : state.batDirection);
            } else if (trick.mode === 'carry') {
                // trot across the stage with the ball bouncing along in front
                planStage(walker, phase, deltaSeconds, true, state.choreo.beatsLeft, halfRange, trick.speed * (0.75 + 0.5 * energy));
                ballTargetX = walker.x + walker.facing * 1.3; ballFollow = 0.1;
                if (tick) { launch(0.45); state.pawReach.velocity += 8; }
            } else {
                planStage(walker, phase, deltaSeconds, false, 0, halfRange, 1);
                if (trick.name === 'juggle') {
                    const s = Math.sin(Math.PI * phase);
                    ballTargetX = walker.x + 2.1 * Math.sign(s) * Math.sqrt(Math.abs(s)); ballFollow = 0.07;   // arcs out beside the head and back
                    if (tick) launch(1.7);
                } else {
                    ballTargetX = walker.x + walker.facing * 1.35; ballFollow = 0.18;                          // sing: ball waits at its feet
                }
            }
            if (trick.mode !== 'chase') ball.x += (ballTargetX - ball.x) * (1 - Math.exp(-deltaSeconds / ballFollow));
            const ballEdge = centerX / unit - ballRadius - 0.1;           // the ball never leaves the canvas, whatever the trick
            ball.x = clamp(ball.x, -ballEdge, ballEdge);

            if (frameValues.hitDetected) state.squat.velocity += 5 * frameValues.bass * (frameValues.hitStrength || 0.7);   // head nods on every detected hit
            stepSpring(state.squat, 0.30 * frameValues.bass, 3, 0.5, deltaSeconds);       // continuous bob with the bass level
            stepSpring(state.pawReach, 0, 5, 0.6, deltaSeconds);
            stepSpring(state.ear, frameValues.treble, 5, 0.8, deltaSeconds);
            stepSpring(state.mouth, frameValues.vocal, 6, 0.8, deltaSeconds);

            ball.vy += gravity * deltaSeconds;
            ball.y += ball.vy * deltaSeconds;
            if (ball.y > ballRestY) {                                  // bounce, losing energy each time
                ball.y = ballRestY;
                ball.vy = Math.abs(ball.vy) < 1.5 ? 0 : -ball.vy * 0.5;
            }
            ball.spin += (ball.vx + (ballTargetX - ball.x) * 6) * deltaSeconds / ballRadius;

            const vocalNow = clamp(frameValues.vocal, 0, 1);
            const bob = clamp(state.squat.value, -0.5, 1);
            const headWorldX = walker.x + walker.turn * 1.0;
            const eyeY = headY - 0.1;
            stepSpring(state.pupilX, clamp((ball.x - headWorldX) / 2.5, -1, 1) * 0.11, 7, 0.8, deltaSeconds);   // pupils follow the ball
            stepSpring(state.pupilY, clamp((ball.y - 0.5) / 3.5, -1, 1) * 0.1, 7, 0.8, deltaSeconds);
            const headTilt = clamp((ball.x - headWorldX) / 3, -1, 1) * 0.08
                           + (trick.name === 'sing' ? 0.12 * Math.sin(Math.PI * phase) * (0.4 + 0.6 * energy) : 0)   // swaying head while singing
                           + 0.03 * Math.sin(seconds * 2.2) * vocalNow;

            const glowAlpha = 0.10 * styleParams.glow;
            const lineWidth = unit * 0.07;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // ── ground shadows (cat and ball) ──
            const ballHeight = clamp((ballRestY - ball.y) / 2.5, 0, 1);
            ctx.globalAlpha = 0.22;
            ctx.fillStyle = colors.primary;
            ctx.beginPath();
            ctx.ellipse(toX(walker.x), toY(GROUND + 0.08), unit * 1.5, unit * 0.12, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.22 * (1 - 0.6 * ballHeight);
            ctx.beginPath();
            ctx.ellipse(toX(ball.x), toY(GROUND + 0.08), unit * ballRadius * (1 - 0.4 * ballHeight), unit * 0.1, 0, 0, Math.PI * 2);
            ctx.fill();

            // ── body (profile view, drawn facing +x and mirrored by `turn`, so it squashes through a flip when it changes direction) ──
            const bodyY = 1.2 + 0.05 * bob + 0.04 * walker.pace * Math.cos(2 * DANCE_TAU * walker.gait);   // bobs twice per walk cycle
            const hipY = GROUND - 0.55;
            const pawLift = clamp(state.pawReach.value, 0, 1.2);
            const legs = CAT_LEGS;
            ctx.save();
            ctx.translate(toX(walker.x), 0);
            ctx.scale(Math.abs(walker.turn) < 0.06 ? 0.06 * (walker.facing || 1) : walker.turn, 1);

            for (let pass = 0; pass < 2; pass++) {                     // pass 0: far-side legs (behind the body), pass 1: near-side legs
                ctx.beginPath();
                for (const leg of legs) {
                    if ((leg.near ? 1 : 0) !== pass) continue;
                    const cycle = DANCE_TAU * (walker.gait + leg.offset);
                    let footX = leg.hipX + Math.sin(cycle) * 0.38 * walker.pace;
                    let footY = GROUND - Math.max(0, Math.cos(cycle)) * 0.22 * walker.pace;
                    if (leg.front && leg.near) { footX += 0.9 * pawLift; footY -= 0.55 * pawLift; }   // the bat: near front paw swings out and up
                    solveTwoBoneJoint(leg.hipX, hipY, footX, footY, 0.3, leg.front ? -1 : 1, state.joint);   // front legs bend back, hind legs bend forward
                    ctx.moveTo(leg.hipX * unit, toY(hipY));
                    ctx.lineTo(state.joint.x * unit, toY(state.joint.y));
                    ctx.lineTo(state.joint.endX * unit, toY(state.joint.endY));
                }
                ctx.globalAlpha = pass === 0 ? 0.55 : 1;
                const legLw = unit * 0.1;
                strokeWithGlow(ctx, colors.primary, legLw, glowAlpha, undefined, 
                               { haloWidth: legLw * styleParams.glowWidth });
            }

            ctx.beginPath();                                           // torso
            ctx.ellipse(-0.05 * unit, toY(bodyY), unit * 1.2, unit * 0.6 * (1 + 0.05 * frameValues.bass), 0, 0, Math.PI * 2);
            ctx.globalAlpha = 0.14;
            ctx.fillStyle = colors.primary;
            ctx.fill();
            ctx.globalAlpha = 1;
            strokeWithGlow(ctx, colors.primary, lineWidth, glowAlpha, undefined,
                           { haloWidth: lineWidth * styleParams.glowWidth });

            ctx.beginPath();                                           // tail: a vocal pulse runs up it, like the jellyfish tentacles
            let tailX = -1.1, tailY = bodyY - 0.05, tailAngle = -2.5;
            ctx.moveTo(tailX * unit, toY(tailY));
            for (let segment = 1; segment <= 10; segment++) {
                const t = segment / 10;
                const wag = Math.sin(seconds * 3.2 - t * 4) * (0.06 + 0.30 * readTrail(state.trail, t * 0.3)) + 0.05 * state.ear.value * Math.sin(seconds * 15 + t * 6);
                tailAngle += 0.11 + wag;
                tailX += Math.cos(tailAngle) * 0.17; tailY += Math.sin(tailAngle) * 0.17;
                ctx.lineTo(tailX * unit, toY(tailY));
            }
            const tailLw = unit * 0.085;
            strokeWithGlow(ctx, colors.primary, tailLw, glowAlpha, undefined,
                           { haloWidth: tailLw * styleParams.glowWidth });

            ctx.fillStyle = colors.primary;                            // paws
            ctx.beginPath();
            for (const leg of legs) {
                const cycle = DANCE_TAU * (walker.gait + leg.offset);
                let footX = leg.hipX + Math.sin(cycle) * 0.38 * walker.pace;
                let footY = GROUND - Math.max(0, Math.cos(cycle)) * 0.22 * walker.pace;
                if (leg.front && leg.near) { footX += 0.9 * pawLift; footY -= 0.55 * pawLift; }
                ctx.moveTo((footX + 0.1) * unit, toY(footY));
                ctx.ellipse(footX * unit + unit * 0.04, toY(footY), unit * 0.14, unit * 0.08, 0, 0, Math.PI * 2);
            }
            ctx.globalAlpha = 0.9;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.restore();

            // ── head: the front-facing head, scaled onto the body; it slides across as the cat turns ──
            ctx.save();
            ctx.translate(toX(headWorldX), toY(0.5 + 0.05 * bob + 0.03 * walker.pace * Math.cos(2 * DANCE_TAU * walker.gait)));
            ctx.scale(HEAD_SCALE, HEAD_SCALE);
            ctx.translate(-toX(headX), -toY(headY));
            // ── head (squashes slightly on the beat, tilts toward the ball) ──
            ctx.save();
            ctx.translate(toX(headX), toY(headY + 1.2));
            ctx.rotate(headTilt);
            ctx.scale(1 + 0.04 * bob, 1 - 0.06 * bob);
            ctx.translate(-toX(headX), -toY(headY + 1.2));

            // ears (twitch with treble)
            const twitch = clamp(state.ear.value, 0, 1) * Math.sin(seconds * 13);
            for (let earIndex = 0; earIndex < 2; earIndex++) {
                const side = earIndex === 0 ? -1 : 1;
                ctx.save();
                ctx.translate(toX(headX + side * 0.9), toY(headY - 0.8));
                ctx.rotate(side * (0.05 + 0.3 * twitch + 0.12 * vocalNow));
                ctx.beginPath();
                ctx.moveTo(-side * unit * 0.45, unit * 0.45);
                ctx.lineTo(side * unit * 0.1, -unit * 1.15);
                ctx.lineTo(side * unit * 0.55, unit * 0.35);
                ctx.closePath();
                ctx.globalAlpha = 0.16;
                ctx.fillStyle = colors.primary;
                ctx.fill();
                ctx.globalAlpha = 0.3;
                ctx.fillStyle = colors.secondary;
                ctx.beginPath();
                ctx.moveTo(-side * unit * 0.15, unit * 0.25);
                ctx.lineTo(side * unit * 0.1, -unit * 0.7);
                ctx.lineTo(side * unit * 0.35, unit * 0.2);
                ctx.closePath();
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(-side * unit * 0.45, unit * 0.45);
                ctx.lineTo(side * unit * 0.1, -unit * 1.15);
                ctx.lineTo(side * unit * 0.55, unit * 0.35);
                strokeWithGlow(ctx, colors.primary, lineWidth, glowAlpha, undefined, 
                               { haloWidth: lineWidth * styleParams.glowWidth });
                ctx.restore();
            }

            ctx.beginPath();                                           // head outline + soft fill
            ctx.ellipse(toX(headX), toY(headY), unit * 1.5, unit * 1.25, 0, 0, Math.PI * 2);
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = colors.primary;
            ctx.fill();
            strokeWithGlow(ctx, colors.primary, lineWidth, glowAlpha, undefined, 
                           { haloWidth: lineWidth * styleParams.glowWidth });

            for (let eyeIndex = 0; eyeIndex < 2; eyeIndex++) {          // eyes
                const side = eyeIndex === 0 ? -1 : 1;
                const eyeX = headX + side * 0.55;
                const blink = (seconds % 4.3) > 4.18 ? 0.15 : 1;       // blinks every few seconds
                ctx.fillStyle = colors.primary;
                ctx.globalAlpha = 0.95;
                ctx.beginPath();
                ctx.ellipse(toX(eyeX), toY(eyeY), unit * 0.3, unit * 0.36 * blink, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#0b0b14';
                ctx.beginPath();
                ctx.ellipse(toX(eyeX + state.pupilX.value), toY(eyeY + state.pupilY.value), unit * (0.09 + 0.05 * clamp(frameValues.bass, 0, 1)), unit * 0.24 * blink, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.globalAlpha = 0.9 * blink;
                ctx.beginPath();
                ctx.arc(toX(eyeX + state.pupilX.value - 0.05), toY(eyeY + state.pupilY.value - 0.1), unit * 0.04, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            ctx.fillStyle = colors.secondary;                          // nose
            ctx.beginPath();
            ctx.moveTo(toX(headX - 0.13), toY(headY + 0.22));
            ctx.lineTo(toX(headX + 0.13), toY(headY + 0.22));
            ctx.lineTo(toX(headX), toY(headY + 0.36));
            ctx.closePath();
            ctx.fill();

            const mouthOpen = clamp(state.mouth.value, 0, 1);          // mouth: a small "w", opens with the vocal
            ctx.beginPath();
            ctx.moveTo(toX(headX), toY(headY + 0.36));
            ctx.lineTo(toX(headX), toY(headY + 0.5));
            ctx.arc(toX(headX - 0.17), toY(headY + 0.5), unit * 0.17, 0, Math.PI * (0.9 + 0.15 * mouthOpen));
            ctx.moveTo(toX(headX), toY(headY + 0.5));
            ctx.arc(toX(headX + 0.17), toY(headY + 0.5), unit * 0.17, Math.PI, Math.PI * (0.1 - 0.15 * mouthOpen), true);
            ctx.strokeStyle = colors.primary;
            ctx.lineWidth = lineWidth * 0.8;
            ctx.stroke();
            if (mouthOpen > 0.08) {
                ctx.fillStyle = '#0b0b14';
                ctx.globalAlpha = 0.85;
                ctx.beginPath();
                ctx.ellipse(toX(headX), toY(headY + 0.62), unit * (0.1 + 0.12 * mouthOpen), unit * 0.32 * mouthOpen, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            ctx.beginPath();                                           // whiskers
            const whiskerWiggle = clamp(state.ear.value, 0, 1) * 0.12;
            for (let whisker = 0; whisker < 3; whisker++) {
                const spread = (whisker - 1) * 0.16 + Math.sin(seconds * 12 + whisker) * whiskerWiggle;
                for (const side of [-1, 1]) {
                    const startX = headX + side * 0.8, startY = headY + 0.3 + whisker * 0.06;
                    ctx.moveTo(toX(startX), toY(startY));
                    ctx.lineTo(toX(startX + side * 1.15 * Math.cos(spread)), toY(startY + 1.15 * Math.sin(spread)));
                }
            }
            ctx.globalAlpha = 0.7;
            ctx.strokeStyle = colors.primary;
            ctx.lineWidth = lineWidth * 0.5;
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.restore();
            ctx.restore();

            // ── yarn ball ──
            ctx.fillStyle = colors.secondary;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(toX(ball.x), toY(ball.y), unit * ballRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.6;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = lineWidth * 0.6;
            for (let strand = 0; strand < 3; strand++) {
                ctx.beginPath();
                ctx.arc(toX(ball.x), toY(ball.y), unit * ballRadius * (0.45 + strand * 0.2), ball.spin + strand * 2.1, ball.spin + strand * 2.1 + 1.6);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        },
    },

    jellyfish: {
        label: 'Jellyfish',
        tip: 'A drifting jellyfish: the bell breathes with the bass and jets on each beat, a vocal pulse runs down every tentacle, tips and rim lights twinkle with treble.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Overall size inside its frame.' },
            { key: 'tentacles', label: 'Tentacles', min: 6, max: 18, step: 2, default: 14, tip: 'Number of thin tentacles.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Soft halo.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.5, max: 4, step: 0.1, default: 2.0,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },      
        ],
        createState() {
            return { contract: createSpring(), lift: createSpring(), vocal: createSpring(), treble: createSpring(), trail: createTrail() };
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const seconds = nowMs / 1000;
            const toX = (unitsX) => centerX + unitsX * unit;
            const toY = (unitsY) => centerY + unitsY * unit;

            if (frameValues.hitDetected) {
                const strength = 0.7 + 0.3 * frameValues.bass;
                state.contract.velocity += 12 * strength;              // the bell squeezes...
                state.lift.velocity -= 3.2 * strength;                 // ...and jets the whole animal upward
            }
            stepSpring(state.contract, 0, 2.4, 0.45, deltaSeconds);    // the bell snap on hits, change "0" to "0.3 * frameValues.bass" to follow bass continuously
            pushTrail(state.trail, frameValues.vocal, deltaSeconds);   // vocal history for the travelling pulse
            stepSpring(state.lift, 0, 0.8, 0.9, deltaSeconds);
            state.lift.value = clamp(state.lift.value, -1.0, 0.6);   // fast hit streaks stack impulses; keep the animal on screen
            stepSpring(state.vocal, frameValues.vocal, 3, 1, deltaSeconds);
            stepSpring(state.treble, frameValues.treble, 5, 1, deltaSeconds);
            const squeeze = clamp(state.contract.value, -0.3, 1);
            const vocal = clamp(state.vocal.value, 0, 1), treble = clamp(state.treble.value, 0, 1);

            const halfWidth = 1.05 * (1 - 0.30 * squeeze);             // squash and stretch: narrower and taller when squeezed
            const bellHeight = 1.35 * (1 + 0.25 * squeeze);
            const rimY = -0.1 + state.lift.value + Math.sin(seconds * 0.9) * 0.12;
            const glowAlpha = 0.09 * styleParams.glow;

            // tentacles first, so the bell sits in front of their roots
            const segmentCount = 9;
            const tentacleCount = Math.round(styleParams.tentacles);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            const tips = scratchBuffer('jellyTips', tentacleCount * 2);
            ctx.beginPath();
            for (let tentacle = 0; tentacle < tentacleCount; tentacle++) {
                const along = tentacleCount === 1 ? 0.5 : tentacle / (tentacleCount - 1);
                const anchorX = (along * 2 - 1) * halfWidth * 0.92;
                const length = (1.7 + 0.5 * Math.sin(tentacle * 2.1)) * (1 + 0.10 * vocal);
                const phase = tentacle * 0.9;
                const personalDelay = (tentacle % 4) * 0.012;          // neighbours are slightly out of step, so the fringe ripples instead of moving as one
                ctx.moveTo(toX(anchorX), toY(rimY));
                for (let segment = 1; segment <= segmentCount; segment++) {
                    const progress = segment / segmentCount;
                    // the vocal level that left the bell a moment ago has only now reached this segment: a pulse runs down the tentacle
                    const vocalHere = readTrail(state.trail, progress * 0.30 + personalDelay);
                    const swirl = Math.sin(seconds * 2 - progress * 4.5 + phase);
                    const shimmer = 0.035 * treble * Math.sin(seconds * 14 + progress * 9 + phase);
                    const pointX = anchorX + (swirl * (0.07 + 0.55 * vocalHere) + shimmer) * progress;
                    const pointY = rimY + progress * length * (1 - 0.18 * squeeze);
                    ctx.lineTo(toX(pointX), toY(pointY));
                    if (segment === segmentCount) { tips[tentacle * 2] = toX(pointX); tips[tentacle * 2 + 1] = toY(pointY); }
                }
            }
            const tentLW = unit * 0.035;
            strokeWithGlow(ctx, colors.secondary, tentLW, glowAlpha, undefined, 
                           { alpha: 0.7, haloWidth: tentLW * styleParams.glowWidth });

            ctx.beginPath();                                           // four thick oral arms
            for (let arm = 0; arm < 4; arm++) {
                const anchorX = (arm - 1.5) * halfWidth * 0.3;
                ctx.moveTo(toX(anchorX), toY(rimY));
                for (let segment = 1; segment <= segmentCount; segment++) {
                    const progress = segment / segmentCount;
                    const vocalHere = readTrail(state.trail, 0.10 + progress * 0.45);    // heavier arms lag further behind the vocal
                    const sway = Math.sin(seconds * 1.3 - progress * 3 + arm * 1.7) * (0.10 + 0.32 * vocalHere) * progress;
                    ctx.lineTo(toX(anchorX + sway), toY(rimY + progress * 1.4 * (1 + 0.12 * frameValues.bass) * (1 - 0.18 * squeeze)));
                }
            }
            const armLW = unit * 0.09;
            strokeWithGlow(ctx, colors.primary, armLW, glowAlpha, undefined, 
                           { alpha: 0.85, haloWidth: armLW * styleParams.glowWidth });     // oral arms (line 1038)

            // bell
            ctx.beginPath();
            ctx.moveTo(toX(-halfWidth), toY(rimY));
            ctx.bezierCurveTo(toX(-halfWidth), toY(rimY - bellHeight * 1.35), toX(halfWidth), toY(rimY - bellHeight * 1.35), toX(halfWidth), toY(rimY));
            const scallopCount = 6;
            for (let scallop = 0; scallop < scallopCount; scallop++) {
                const fromX = halfWidth - 2 * halfWidth * (scallop / scallopCount);
                const toXUnits = halfWidth - 2 * halfWidth * ((scallop + 1) / scallopCount);
                ctx.quadraticCurveTo(toX((fromX + toXUnits) / 2), toY(rimY + 0.16), toX(toXUnits), toY(rimY));
            }
            ctx.closePath();
            const bellGradient = ctx.createLinearGradient(0, toY(rimY - bellHeight), 0, toY(rimY));
            bellGradient.addColorStop(0, colors.primary);
            bellGradient.addColorStop(1, colors.secondary);
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = bellGradient;
            ctx.fill();
            const bellLw = unit * 0.06;
            strokeWithGlow(ctx, colors.primary, bellLw, glowAlpha, undefined, { haloWidth: bellLw * styleParams.glowWidth });

            ctx.beginPath();                                           // radial canals inside the bell
            for (let canal = 0; canal < 5; canal++) {
                const targetX = (canal / 4 * 2 - 1) * halfWidth * 0.85;
                ctx.moveTo(toX(0), toY(rimY - bellHeight * 0.95));
                ctx.quadraticCurveTo(toX(targetX * 0.9), toY(rimY - bellHeight * 0.55), toX(targetX), toY(rimY - 0.05));
            }
            ctx.globalAlpha = 0.2 + 0.5 * vocal;                       // canals light up with the vocal
            ctx.strokeStyle = colors.secondary;
            ctx.lineWidth = unit * 0.03;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';                                 // rim lights: continuous twinkle, no pop-in
            for (let light = 0; light < 12; light++) {
                const brightness = treble * (0.5 + 0.5 * Math.sin(seconds * 9 + light * 1.7));
                if (brightness < 0.03) continue;
                ctx.globalAlpha = brightness;
                ctx.beginPath();
                ctx.arc(toX(-halfWidth + (2 * halfWidth) * (light / 11)), toY(rimY + 0.02), unit * 0.05, 0, Math.PI * 2);
                ctx.fill();
            }

            if (treble > 0.15) {                                       // tentacle tips glint with treble
                const tipRadius = unit * 0.04 * (1 + treble);
                ctx.beginPath();
                for (let tentacle = 0; tentacle < tentacleCount; tentacle++) {
                    ctx.moveTo(tips[tentacle * 2] + tipRadius, tips[tentacle * 2 + 1]);
                    ctx.arc(tips[tentacle * 2], tips[tentacle * 2 + 1], tipRadius, 0, Math.PI * 2);
                }
                strokeWithGlow(ctx, colors.secondary, 0, 0.35 * treble * styleParams.glow, undefined, 
                               { haloWidth: tipRadius * styleParams.glowWidth });
                ctx.globalAlpha = 0.25 + 0.7 * treble;
                ctx.fillStyle = '#ffffff';
                ctx.fill();
            }            
            ctx.globalAlpha = 1;
        },
    },

    duel: {
        label: 'Swords',
        tip: 'Two swords duel through a pool of moves switched on the beat. Clashes throw sparks, blades shimmer with the vocal, bass leans them in, treble sparks off the tips.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Overall size inside its frame.' },
            { key: 'sparks', label: 'Sparks', min: 0, max: 1.5, step: 0.1, default: 1, tip: 'How many sparks each clash throws.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Blade halo and clash flash.' },
            { key: 'glowWidth', label: 'Glow width', min: 0.2, max: 1, step: 0.1, default: 0.5,
              tip: 'How wide the halo spreads. Lower = tighter and cheaper to draw, higher = softer and more expensive.' },
            { key: 'moveBeats', label: 'Move length', min: 2, max: 16, step: 2, default: 8, tip: 'Beats before the duelists switch to a new move.' },        
        ],
        createState() {
            const SPARK_POOL = 40;
            const makeGeometry = () => ({ originX: 0, originY: 0, directionX: 0, directionY: 0, perpendicularX: 0, perpendicularY: 0, tipX: 0, tipY: 0 });
            const state = {
                swords: [{ side: -1, spring: createSpring(-0.5) }, { side: 1, spring: createSpring(-0.5) }],
                geometry: [makeGeometry(), makeGeometry()],
                choreo: createChoreographer(DUEL_MOVES.length),
                pose: Object.assign({}, DUEL_NEUTRAL), targetNow: Object.assign({}, DUEL_NEUTRAL), targetPrev: Object.assign({}, DUEL_NEUTRAL),
                moveIndex: -1, lastSlot: 0, energyNow: 0,
                hitCount: 0, flash: 0,
                sparkX: new Float32Array(SPARK_POOL), sparkY: new Float32Array(SPARK_POOL),
                sparkVelocityX: new Float32Array(SPARK_POOL), sparkVelocityY: new Float32Array(SPARK_POOL),
                sparkLife: new Float32Array(SPARK_POOL), nextSpark: 0,
                treble: createSpring(), vocal: createSpring(),
            };
            state.accept = (index) => DUEL_MOVES[index].minEnergy <= state.energyNow + 0.15;
            return state;
        },
        draw(ctx, frameValues, styleParams, drawContext, state) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const unit = drawContext.baseRadius * styleParams.size;
            const deltaSeconds = frameSeconds(drawContext);
            const seconds = nowMs / 1000;
            const toX = (unitsX) => centerX + unitsX * unit;
            const toY = (unitsY) => centerY + unitsY * unit;

            const clashAngle = 0.52, backswingLimit = -0.62;       // radians from vertical, positive = leaning inward
            const pivotX = 1.1, pivotY = 1.5, bladeLength = 2.8;
            const clashY = pivotY - (pivotX / Math.sin(clashAngle)) * Math.cos(clashAngle);   // where the blades cross

            stepSpring(state.treble, frameValues.treble, 5, 0.9, deltaSeconds);
            stepSpring(state.vocal, frameValues.vocal, 3, 1, deltaSeconds);
            const treble = clamp(state.treble.value, 0, 1), vocal = clamp(state.vocal.value, 0, 1);
            const bass = clamp(frameValues.bass, 0, 1);

            // ── choreography: a move every few beats, crossfaded; strikes are kicked on the beat clock, not only on detected hits ──
            state.energyNow = clamp(Math.max(frameValues.bass, frameValues.vocal), 0, 1);
            stepChoreographer(state.choreo, frameValues, deltaSeconds, DUEL_MOVES.length, styleParams.moveBeats, state.accept);
            const choreo = state.choreo, move = DUEL_MOVES[choreo.current];
            const target = state.targetNow, previous = state.targetPrev;
            Object.assign(target, DUEL_NEUTRAL);
            move.fn(choreo.phase, 1, target);
            if (choreo.blend < 1) {
                Object.assign(previous, DUEL_NEUTRAL);
                DUEL_MOVES[choreo.previous].fn(choreo.phase, 1, previous);
                const mix = smoothstep(choreo.blend);
                for (const key of DUEL_KEYS) target[key] = previous[key] + (target[key] - previous[key]) * mix;
            }
            const follow = 1 - Math.exp(-deltaSeconds / 0.06);
            for (const key of DUEL_KEYS) state.pose[key] += (target[key] - state.pose[key]) * follow;
            const pose = state.pose;

            if (state.moveIndex !== choreo.current) {  // new move: don't fire a burst of missed strikes
                state.moveIndex = choreo.current;
                state.lastSlot = Math.floor(choreo.phase * Math.max(1, move.strikes));
            }
            if (move.strikes > 0) {
                let strike = frameValues.hitDetected;
                if (move.strikes === 2) { // flurry: a second strike a fixed fraction of a beat after each hit
                    if (strike) state.secondStrikeAt = nowMs + 0.4 * frameValues.beatPeriodMs;
                    else if (state.secondStrikeAt && nowMs >= state.secondStrikeAt) { strike = true; state.secondStrikeAt = 0; }
                }
                if (strike) {
                    state.hitCount++;
                    for (const sword of state.swords) sword.spring.velocity += 60 * (0.85 + 0.15 * bass);
                }
            }
            if (frameValues.hitDetected) state.flash = Math.max(state.flash, 0.45 * (frameValues.hitStrength || 0.7));   // every detected hit pulses, even in moves that never clash

            let impactSpeed = 0;
            for (let swordIndex = 0; swordIndex < 2; swordIndex++) {
                const sword = state.swords[swordIndex];
                const ready = (sword.side < 0 ? pose.angleL : pose.angleR) + 0.16 * bass + Math.sin(seconds * 1.7 + sword.side) * 0.03;   // bass leans the blades in
                const springFrequency = move.strikes > 0 ? 2.5 : 4.5;      // strike moves keep the original soft spring (it needs the long swing); the others track their target faster
                stepSpring(sword.spring, Math.min(ready, move.strikes > 0 ? clashAngle - 0.05 : clashAngle - 0.02), springFrequency, 0.6, deltaSeconds);
                if (sword.spring.value < backswingLimit) {         // the recoil must not fling the blade out of the frame
                    sword.spring.value = backswingLimit;
                    sword.spring.velocity = Math.max(0, sword.spring.velocity);
                }
                if (sword.spring.value > clashAngle) {             // contact: stop dead, bounce back (the dominant side alternates)
                    sword.spring.value = clashAngle;
                    if (sword.spring.velocity > 0) {
                        impactSpeed = Math.max(impactSpeed, sword.spring.velocity);
                        const dominant = (state.hitCount % 2 === 0) === (sword.side < 0);
                        sword.spring.velocity = -sword.spring.velocity * (dominant ? 0.2 : 0.55);
                    }
                }
            }

            // blade geometry, once per frame
            for (let swordIndex = 0; swordIndex < 2; swordIndex++) {
                const sword = state.swords[swordIndex], geo = state.geometry[swordIndex];
                const lift = sword.side < 0 ? pose.liftL : pose.liftR;
                const length = bladeLength * (sword.side < 0 ? pose.thrustL : pose.thrustR) * (1 + 0.03 * bass);
                const angle = sword.spring.value;
                geo.originX = sword.side * pivotX * pose.spread; geo.originY = pivotY - lift;
                geo.directionX = -sword.side * Math.sin(angle); geo.directionY = -Math.cos(angle);
                geo.perpendicularX = -geo.directionY; geo.perpendicularY = geo.directionX;
                geo.tipX = geo.originX + geo.directionX * length; geo.tipY = geo.originY + geo.directionY * length;
            }

            if (impactSpeed > 0) {                                 // clash: flash + sparks
                const impact = clamp(impactSpeed / 34, 0.3, 1.2);
                state.flash = Math.max(state.flash, Math.min(1, impact));
                const sparkCount = Math.round((6 + 12 * treble + 6 * impact) * styleParams.sparks);
                for (let spark = 0; spark < sparkCount; spark++) {
                    const index = state.nextSpark;
                    state.nextSpark = (state.nextSpark + 1) % state.sparkLife.length;
                    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
                    const speed = 2 + Math.random() * 3.2 * impact;
                    state.sparkX[index] = 0; state.sparkY[index] = clashY;
                    state.sparkVelocityX[index] = Math.cos(angle) * speed; state.sparkVelocityY[index] = Math.sin(angle) * speed;
                    state.sparkLife[index] = 0.6 + Math.random() * 0.4;
                }
            }
            if (treble > 0.25 && Math.random() < treble * deltaSeconds * 18 * styleParams.sparks) {   // treble: a trickle of sparks off a blade tip
                const geo = state.geometry[Math.random() < 0.5 ? 0 : 1];
                const index = state.nextSpark;
                state.nextSpark = (state.nextSpark + 1) % state.sparkLife.length;
                state.sparkX[index] = geo.tipX; state.sparkY[index] = geo.tipY;
                state.sparkVelocityX[index] = (Math.random() - 0.5) * 2.5; state.sparkVelocityY[index] = -1 - Math.random() * 1.5;
                state.sparkLife[index] = 0.5 + Math.random() * 0.3;
            }
            state.flash = Math.max(0, state.flash - deltaSeconds * 5);

            // ── draw ──
            if (state.flash > 0.01 && styleParams.glow > 0) {
                const flash = ctx.createRadialGradient(toX(0), toY(clashY), 0, toX(0), toY(clashY), unit * 1.3);
                flash.addColorStop(0, '#ffffff');
                flash.addColorStop(0.35, colors.primary);
                flash.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = state.flash * 0.7 * styleParams.glow;
                ctx.fillStyle = flash;
                ctx.beginPath();
                ctx.arc(toX(0), toY(clashY), unit * 1.3, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
            }

            ctx.lineCap = 'round';
            ctx.beginPath();                                       // one bloom pass for both blades: depth follows bass and vocal
            for (const geo of state.geometry) { 
                ctx.moveTo(toX(geo.originX), toY(geo.originY)); 
                ctx.lineTo(toX(geo.tipX), toY(geo.tipY)); 
            }
            stackHalo(ctx, colors.primary, unit * 0.4 * styleParams.glowWidth, styleParams.glow * (0.25 + 1.0 * bass + 0.8 * vocal));

            for (let swordIndex = 0; swordIndex < 2; swordIndex++) {
                const geo = state.geometry[swordIndex];
                const { originX, originY, directionX, directionY, perpendicularX, perpendicularY, tipX, tipY } = geo;

                ctx.globalAlpha = 0.92;                            // blade: tapered polygon
                ctx.fillStyle = colors.primary;
                ctx.beginPath();
                ctx.moveTo(toX(originX + perpendicularX * 0.11), toY(originY + perpendicularY * 0.11));
                ctx.lineTo(toX(tipX + perpendicularX * 0.025), toY(tipY + perpendicularY * 0.025));
                ctx.lineTo(toX(tipX - perpendicularX * 0.025), toY(tipY - perpendicularY * 0.025));
                ctx.lineTo(toX(originX - perpendicularX * 0.11), toY(originY - perpendicularY * 0.11));
                ctx.closePath();
                ctx.fill();

                ctx.globalAlpha = 0.7;                             // edge highlight
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = Math.max(1, unit * 0.03);
                ctx.beginPath();
                ctx.moveTo(toX(originX), toY(originY));
                ctx.lineTo(toX(tipX), toY(tipY));
                ctx.stroke();

                const length = Math.hypot(tipX - originX, tipY - originY);
                const glintPosition = ((seconds * (0.9 + 1.2 * vocal) + swordIndex * 0.5) % 1) * length;   // a glint slides along the blade, faster with vocal
                ctx.globalAlpha = 0.25 + 0.65 * vocal;
                ctx.lineWidth = unit * 0.12;
                ctx.beginPath();
                ctx.moveTo(toX(originX + directionX * glintPosition), toY(originY + directionY * glintPosition));
                ctx.lineTo(toX(originX + directionX * (glintPosition + 0.28)), toY(originY + directionY * (glintPosition + 0.28)));
                ctx.stroke();

                ctx.globalAlpha = 1;                               // hilt: crossguard, grip, pommel
                ctx.strokeStyle = colors.secondary;
                ctx.lineWidth = unit * 0.1;
                ctx.beginPath();
                ctx.moveTo(toX(originX - perpendicularX * 0.42), toY(originY - perpendicularY * 0.42));
                ctx.lineTo(toX(originX + perpendicularX * 0.42), toY(originY + perpendicularY * 0.42));
                ctx.stroke();
                ctx.lineWidth = unit * 0.13;
                ctx.beginPath();
                ctx.moveTo(toX(originX), toY(originY));
                ctx.lineTo(toX(originX - directionX * 0.55), toY(originY - directionY * 0.55));
                ctx.stroke();
                ctx.fillStyle = colors.primary;
                ctx.beginPath();
                ctx.arc(toX(originX - directionX * 0.64), toY(originY - directionY * 0.64), unit * 0.12, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.strokeStyle = '#fff4d6';                           // sparks: short streaks with gravity
            ctx.lineWidth = Math.max(1, unit * 0.045);
            ctx.globalCompositeOperation = 'lighter';
            for (let spark = 0; spark < state.sparkLife.length; spark++) {
                if (state.sparkLife[spark] <= 0) continue;
                state.sparkVelocityY[spark] += 9 * deltaSeconds;
                state.sparkX[spark] += state.sparkVelocityX[spark] * deltaSeconds;
                state.sparkY[spark] += state.sparkVelocityY[spark] * deltaSeconds;
                state.sparkLife[spark] -= deltaSeconds / 0.5;
                ctx.globalAlpha = clamp(state.sparkLife[spark], 0, 1);
                ctx.beginPath();
                ctx.moveTo(toX(state.sparkX[spark]), toY(state.sparkY[spark]));
                ctx.lineTo(toX(state.sparkX[spark] - state.sparkVelocityX[spark] * 0.04), toY(state.sparkY[spark] - state.sparkVelocityY[spark] * 0.04));
                ctx.stroke();
            }
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
        },
    },
};

// ───────────────────────────────────────────────────────────────────
// EFFECTS — apply to circle, text, or both. Each `transform` returns an
// offset { offsetX, offsetY, scale, rotation } in normalized units:
//   offsetX/offsetY: fraction of the target's own size (circle radius, or
//                     ~48px for text)
//   scale: multiplier, 1 = no change
//   rotation: radians
// Multiple effects on the same target are summed/multiplied together.
// ───────────────────────────────────────────────────────────────────
const EFFECTS = {

    breath: {
        scope: 'both', // circle' or 'text' restricts an effect to one targe. 'both' applies to either.
        label: 'Soft breath',
        tip: 'Slow idle scale pulse plus a small swell on bass. No positional movement.',
        params: [
            { key: 'idleAmount', label: 'Idle', min: 0, max: 0.03, step: 0.002, default: 0.006, tip: 'Always-on gentle scale, independent of audio.' },
            { key: 'bassSwell', label: 'Bass swell', min: 0, max: 0.06, step: 0.002, default: 0.015, tip: 'Extra scale on kicks.' },
        ],
        transform(frameValues, params, nowMs) {
            const idlePulse = 1 + Math.sin(nowMs * 0.0009) * params.idleAmount;
            const bassPulse = 1 + frameValues.bass * params.bassSwell;
            return { scale: idlePulse * bassPulse };
        },
    },

    shake: {
        scope: 'both',
        label: 'Soft shake',
        tip: 'Smooth low-frequency drift on hits. Replaces the earlier random jitter.',
        params: [
            { key: 'amount', label: 'Amount', min: 0, max: 0.08, step: 0.005, default: 0.03, tip: 'Drift distance.' },
            { key: 'speed', label: 'Speed', min: 0.001, max: 0.01, step: 0.001, default: 0.004, tip: 'Drift rate.' },
        ],
        transform(frameValues, params, nowMs) {
            return {
                offsetX: Math.sin(nowMs * params.speed) * params.amount * frameValues.bass,
                offsetY: Math.cos(nowMs * params.speed * 1.31) * params.amount * frameValues.bass,
            };
        },
    },

    wobble: {
        scope: 'both',
        label: 'Wobble',
        tip: 'Gentle rotation that follows the vocal level.',
        params: [
            { key: 'degrees', label: 'Degrees', min: 0, max: 8, step: 0.5, default: 2, tip: 'Maximum tilt.' },
            { key: 'speed', label: 'Speed', min: 0.0005, max: 0.006, step: 0.0005, default: 0.002, tip: 'Sway rate.' },
        ],
        transform(frameValues, params, nowMs) {
            const maxRadians = params.degrees * Math.PI / 180;
            return { rotation: Math.sin(nowMs * params.speed) * maxRadians * frameValues.vocal };
        },
    },

    bounce: {
        scope: 'both',
        label: 'Bounce',
        tip: 'Quick hop up on each hit, settles back down.',
        params: [
            { key: 'height', label: 'Height', min: 0, max: 0.15, step: 0.005, default: 0.05, tip: 'Hop height.' },
        ],
        transform(frameValues, params) {
            return { offsetY: -params.height * frameValues.bass };
        },
    },

    sway: {
        scope: 'both',
        label: 'Sway',
        tip: 'Slow side-to-side drift that widens with the vocal.',
        params: [
            { key: 'width', label: 'Width', min: 0, max: 0.1, step: 0.005, default: 0.04, tip: 'Drift distance.' },
            { key: 'speed', label: 'Speed', min: 0.0004, max: 0.004, step: 0.0002, default: 0.0012, tip: 'Drift rate.' },
        ],
        transform(frameValues, params, nowMs) {
            return { offsetX: Math.sin(nowMs * params.speed) * params.width * (0.3 + frameValues.vocal) };
        },
    },

    spin: {
        scope: 'circle',
        label: 'Spin',
        tip: 'Constant rotation of the whole circle. Circle only.',
        params: [
            { key: 'radiansPerMs', label: 'Rate', min: 0, max: 0.002, step: 0.0001, default: 0.0004,
              tip: 'Deliberately time-based, not audio-reactive — a rotation speed that follows the audio would jump every time the value changes.' },
        ],
        transform(frameValues, params, nowMs) {
            return { rotation: nowMs * params.radiansPerMs };
        },
    },

    lift: {
        scope: 'text',
        label: 'Lift',
        tip: 'Text rises slightly with the vocal level. Text only.',
        params: [
            { key: 'height', label: 'Height', min: 0, max: 0.3, step: 0.01, default: 0.12, tip: 'Rise distance, in units of ~48px.' },
        ],
        transform(frameValues, params) {
            return { offsetY: -params.height * frameValues.vocal };
        },
    },
};

// ───────────────────────────────────────────────────────────────────
// TEXT ENTRY/EXIT — play once per lyric line change, via the Web Animations
// API. getKeyframes(direction, params) returns a keyframe array for
// direction 'in' or 'out'. Only `transform` and `opacity` are used, so
// these stay compositor-only (no layout or paint cost).
// ───────────────────────────────────────────────────────────────────
const TEXT_TRANSITIONS = {

    fade: {
        label: 'Fade',
        tip: 'Simple opacity fade.',
        params: [{ key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 260, tip: 'Length in ms.' }],
        getKeyframes(direction) {
            return direction === 'in'
                ? [{ opacity: 0 }, { opacity: 1 }]
                : [{ opacity: 1 }, { opacity: 0 }];
        },
    },

    swipe: {
        label: 'Swipe',
        tip: 'Slides in from the left, out to the right.',
        params: [
            { key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 320, tip: 'Length in ms.' },
            { key: 'distancePx', label: 'Distance', min: 10, max: 160, step: 5, default: 50, tip: 'Travel distance in px.' },
        ],
        getKeyframes(direction, params) {
            return direction === 'in'
                ? [{ opacity: 0, transform: `translateX(${-params.distancePx}px)` }, { opacity: 1, transform: 'none' }]
                : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${params.distancePx}px)` }];
        },
    },

    rise: {
        label: 'Rise',
        tip: 'Floats up on entry, drops out on exit.',
        params: [
            { key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 300, tip: 'Length in ms.' },
            { key: 'distancePx', label: 'Distance', min: 10, max: 120, step: 5, default: 30, tip: 'Travel distance in px.' },
        ],
        getKeyframes(direction, params) {
            return direction === 'in'
                ? [{ opacity: 0, transform: `translateY(${params.distancePx}px)` }, { opacity: 1, transform: 'none' }]
                : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${params.distancePx}px)` }];
        },
    },

    zoom: {
        label: 'Zoom',
        tip: 'Scales up on entry, shrinks on exit.',
        params: [
            { key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 260, tip: 'Length in ms.' },
            { key: 'startScale', label: 'Start scale', min: 0.5, max: 0.98, step: 0.02, default: 0.85, tip: 'Starting size.' },
        ],
        getKeyframes(direction, params) {
            return direction === 'in'
                ? [{ opacity: 0, transform: `scale(${params.startScale})` }, { opacity: 1, transform: 'none' }]
                : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `scale(${params.startScale})` }];
        },
    },

    drop: {
        label: 'Drop',
        tip: 'Falls in from above with a small overshoot; lifts out.',
        params: [
            { key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 340, tip: 'Length in ms.' },
            { key: 'distancePx', label: 'Distance', min: 10, max: 120, step: 5, default: 40, tip: 'Fall height in px.' },
        ],
        getKeyframes(direction, params) {
            if (direction === 'in') {
                const overshoot = params.distancePx * 0.08;
                return [
                    { opacity: 0, transform: `translateY(${-params.distancePx}px)` },
                    { opacity: 1, transform: `translateY(${overshoot}px)`, offset: 0.7 },
                    { opacity: 1, transform: 'none' },
                ];
            }
            return [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-params.distancePx}px)` }];
        },
    },

    flip: {
        label: 'Flip',
        tip: 'Rotates in around the horizontal axis.',
        params: [
            { key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 380, tip: 'Length in ms.' },
            { key: 'startAngleDeg', label: 'Angle', min: 20, max: 90, step: 5, default: 70, tip: 'Starting tilt.' },
        ],
        getKeyframes(direction, params) {
            return direction === 'in'
                ? [{ opacity: 0, transform: `perspective(500px) rotateX(${-params.startAngleDeg}deg)` }, { opacity: 1, transform: 'none' }]
                : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `perspective(500px) rotateX(${params.startAngleDeg}deg)` }];
        },
    },

    stretch: {
        label: 'Stretch',
        tip: 'Wide and transparent to normal on entry, then squeezes out.',
        params: [
            { key: 'durationMs', label: 'Duration', min: 80, max: 800, step: 20, default: 300, tip: 'Length in ms.' },
            { key: 'startWidthMultiplier', label: 'Width', min: 1.05, max: 2, step: 0.05, default: 1.4, tip: 'Starting width multiplier.' },
        ],
        getKeyframes(direction, params) {
            return direction === 'in'
                ? [{ opacity: 0, transform: `scaleX(${params.startWidthMultiplier})` }, { opacity: 1, transform: 'none' }]
                : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `scaleX(${params.startWidthMultiplier})` }];
        },
    },
};

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════
// palette used when a circle/text has no explicit colors
const DEFAULT_COLORS = {
    primary:   '#ff2d78',                 // primary stroke/fill (--viz-color)
    secondary: 'rgba(0,255,220,0.4)',     // accent (--viz-secondary)
    glow:      'rgba(255,40,120,0.55)',   // shadow color (--viz-glow)
    glowAccent: 'rgba(0,255,220,0.6)',   // optional; themes can override
};

// Note: If a style is renamed or removed, the config silently holds an unknown id
const DEFAULT_ANIM_CONFIG = {
    response: { model: 'punch', smoothness: 0.5, punchSensitivity: 0.06, offsetMs: 0, 
                decayMs: 60, attackMs: 0, punchDepth: 0.6, punchFloor: 0.3, accentFloor: 0.55 },
    circle: { enabled: true, style: 'mandala', params: {}, effects: [{ id: 'bounce', params: {} }] },
    text: {
        enabled: true,
        glowStrength: 0.9,
        breatheAmount: 0.08,
        entry: { id: 'zoom', params: {} }, // empty params = use defaults
        exit: { id: 'stretch', params: {} },
        effects: [{ id: 'bounce', params: {} }],
    },
};
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

// ─── Utility: rewrite the alpha channel of an rgba(...) string ───
// Brightens or dims an rgba() color string by replacing the number with 
// a clamped, fixed-precision alpha value. Intended for rgba() strings only.
// Used wherever a style needs the same base color at a different opacity
// (e.g. a glow that fades in with the vocal level).
function withAlpha(rgbaColor, alpha) {
    const clampedAlpha = Math.min(Math.max(alpha, 0), 1);
    // The regex is designed for rgba(r,g,b,a) strings. A hex or rgb() string would not be transformed correctly. Fragile but col.glow which is always rgba(...)
    return rgbaColor.replace(/[\d.]+\)$/, clampedAlpha.toFixed(3) + ')');
}

// Default palette used when a circle/text has no explicit colors
const DEFAULT_COLORS = {
    primary:   '#ff2d78',                 // primary stroke/fill (--viz-color)
    secondary: 'rgba(0,255,220,0.4)',     // accent (--viz-secondary)
    glow:      'rgba(255,40,120,0.55)',   // shadow color (--viz-glow)
};

// ═══════════════════════════════════════════════════════════════════
// CIRCLE STYLES
// Each style receives (ctx, frameValues, styleParams, drawContext):
//   frameValues = { bass, vocal, treble }         — current response-model output, 0..1
//   styleParams = resolved from this style's own `params` list + any
//                 overrides the user set in the Studio
//   drawContext = { centerX, centerY, baseRadius, nowMs, colors, bassTrailHistory }
// ═══════════════════════════════════════════════════════════════════
const CIRCLE_STYLES = {
    sweep: {
        label: 'Layered sweep',
        tip: 'Rotating conic arc, echo ring, orbiting dots, and treble glints.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1,
              tip: 'Circle size inside its frame. Kept at 1 or below so glow never clips the canvas edge.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1,
              tip: 'Canvas shadow-blur strength. Lower this on weaker GPUs.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors, bassTrailHistory } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const radius = drawContext.baseRadius * styleParams.size * (0.75 + 0.6 * bass);
            const glowAmount = (baseBlur) => baseBlur * styleParams.glow;

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

            // Trail rings — faint echoes of the bass value from a few frames ago
            const trailDelays = [2, 4, 6];
            trailDelays.forEach((delayFrames, trailIndex) => {
                const historyIndex = Math.max(0, bassTrailHistory.length - 1 - delayFrames);
                const pastBass = bassTrailHistory[historyIndex] || 0;
                const trailRadius = 0.3 * radius + pastBass * radius * 0.7;
                ctx.beginPath();
                ctx.arc(centerX, centerY, trailRadius, 0, Math.PI * 2);
                ctx.strokeStyle = colors.primary;
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = (0.16 - trailIndex * 0.045) * (0.3 + pastBass * 0.7);
                ctx.stroke();
            });
            ctx.globalAlpha = 1;

            // Rotating conic arc — the main reactive element
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((nowMs * 0.00025) % (Math.PI * 2));
            if (ctx.createConicGradient) {
                const sweepGradient = ctx.createConicGradient(0, 0, 0);
                sweepGradient.addColorStop(0, colors.primary);
                sweepGradient.addColorStop(0.5, colors.secondary);
                sweepGradient.addColorStop(1, colors.primary);
                ctx.strokeStyle = sweepGradient;
            } else {
                ctx.strokeStyle = colors.primary; // fallback for engines without createConicGradient
            }
            ctx.lineWidth = 2 + bass * 4;
            ctx.lineCap = 'round';
            ctx.shadowColor = colors.glow;
            ctx.shadowBlur = glowAmount(8 + bass * 24);
            ctx.globalAlpha = 0.6 + bass * 0.4;
            ctx.beginPath();
            ctx.arc(0, 0, radius, -Math.PI * 0.35, Math.PI * 1.1);
            ctx.stroke();
            ctx.restore();
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;

            // Thin inner echo ring
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.82, 0, Math.PI * 2);
            ctx.strokeStyle = colors.secondary;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.25 + bass * 0.35;
            ctx.stroke();
            ctx.globalAlpha = 1;

            // Orbiting dots
            const dotCount = 28;
            for (let dotIndex = 0; dotIndex < dotCount; dotIndex++) {
                const angle = (dotIndex / dotCount) * Math.PI * 2 + nowMs * 0.00015;
                const wobble = Math.sin(angle * 4 + nowMs * 0.002) * vocal * 5;
                const dotX = centerX + Math.cos(angle) * (radius + wobble);
                const dotY = centerY + Math.sin(angle) * (radius + wobble);
                ctx.beginPath();
                ctx.arc(dotX, dotY, 1.2 + bass * 1.6, 0, Math.PI * 2);
                ctx.fillStyle = dotIndex % 2 === 0 ? colors.primary : colors.secondary;
                ctx.globalAlpha = 0.3 + bass * 0.5;
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // Treble glints — sparse, independently flickering tick marks
            if (treble > 0.02) {
                const tickCount = 40;
                const tickRadius = radius * 1.3;
                for (let tickIndex = 0; tickIndex < tickCount; tickIndex++) {
                    const angle = (tickIndex / tickCount) * Math.PI * 2;
                    const flickerPhase = nowMs * 0.006 * (1 + (tickIndex % 5) * 0.37) + tickIndex * 2.4;
                    const brightness = Math.abs(Math.sin(flickerPhase)) * treble;
                    if (brightness < 0.15) continue; // most ticks are invisible at any instant — that's the "sparkle" look
                    const tickX = centerX + Math.cos(angle) * tickRadius;
                    const tickY = centerY + Math.sin(angle) * tickRadius;
                    const tickLength = 2 + brightness * 5;
                    ctx.beginPath();
                    ctx.moveTo(tickX - Math.cos(angle) * tickLength / 2, tickY - Math.sin(angle) * tickLength / 2);
                    ctx.lineTo(tickX + Math.cos(angle) * tickLength / 2, tickY + Math.sin(angle) * tickLength / 2);
                    ctx.strokeStyle = colors.secondary;
                    ctx.lineWidth = 1;
                    ctx.globalAlpha = brightness;
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;

            // Solid core — anchors the ring visually
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.18, 0, Math.PI * 2);
            ctx.fillStyle = colors.primary;
            ctx.shadowColor = colors.glow;
            ctx.shadowBlur = glowAmount(10 + bass * 20);
            ctx.globalAlpha = 0.5 + bass * 0.5;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        },
    },

    ring: {
        label: 'Classic ring',
        tip: 'Single bold ring with a vocal wash — the test_v2 look.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Circle size inside its frame.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Canvas shadow-blur strength.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, colors } = drawContext;
            const { bass, vocal } = frameValues;
            const radius = drawContext.baseRadius * 1.5 * styleParams.size * (1 + bass * 0.42);

            if (vocal > 0) {
                const wash = ctx.createRadialGradient(centerX, centerY, 10, centerX, centerY, radius * 1.8);
                wash.addColorStop(0, withAlpha(colors.glow, vocal * 0.3));
                wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = wash;
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius * 2, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.save();
            ctx.shadowBlur = (15 + bass * 30) * styleParams.glow;
            ctx.shadowColor = colors.glow;
            ctx.lineWidth = 6 + bass * 10;
            ctx.strokeStyle = colors.primary;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        },
    },

    bars: {
        label: 'Radial bars',
        tip: 'Ring of bars: bottom follows bass, sides follow vocal, top follows treble.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Ring size inside its frame.' },
            { key: 'barCount', label: 'Bars', min: 24, max: 96, step: 4, default: 56, tip: 'Number of bars around the ring.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Canvas shadow-blur strength — one stroke for all bars, so this stays cheap.' },
        ],
        draw(ctx, frameValues, styleParams, drawContext) {
            const { centerX, centerY, nowMs, colors } = drawContext;
            const { bass, vocal, treble } = frameValues;
            const barCount = styleParams.barCount;
            const innerRadius = drawContext.baseRadius * styleParams.size * (1 + 0.15 * bass);
            const maxBarLength = drawContext.baseRadius * styleParams.size * 1.1;

            ctx.lineCap = 'round';
            ctx.lineWidth = Math.max(1.5, (2 * Math.PI * innerRadius / barCount) * 0.45);
            ctx.strokeStyle = colors.primary;
            ctx.shadowColor = colors.glow;
            ctx.shadowBlur = 10 * styleParams.glow;
            ctx.beginPath();

            for (let barIndex = 0; barIndex < barCount; barIndex++) {
                const positionFraction = barIndex / barCount;      // 0..1 around the ring
                const angle = positionFraction * Math.PI * 2 + Math.PI / 2;

                // verticalness: 0 at the very bottom, 1 at the very top, mirrored left/right
                const verticalness = 1 - Math.abs(2 * positionFraction - 1);

                const bassContribution = bass * Math.max(0, 1 - verticalness * 2.2);       // strongest at the bottom
                const vocalContribution = vocal * Math.max(0, 1 - Math.abs(verticalness - 0.5) * 3); // strongest at the sides
                const trebleContribution = treble * Math.max(0, (verticalness - 0.55) * 2.2);        // strongest at the top
                const energy = bassContribution + vocalContribution + trebleContribution;

                const wobble = 0.85 + 0.15 * Math.sin(nowMs * 0.004 + barIndex * 1.7);
                const barLength = maxBarLength * (0.1 + Math.min(1, energy) * wobble);

                const cosAngle = Math.cos(angle);
                const sinAngle = Math.sin(angle);
                ctx.moveTo(centerX + cosAngle * innerRadius, centerY + sinAngle * innerRadius);
                ctx.lineTo(centerX + cosAngle * (innerRadius + barLength), centerY + sinAngle * (innerRadius + barLength));
            }

            ctx.stroke();
            ctx.shadowBlur = 0;
        },
    },

    orbit: {
        label: 'Orbit rings',
        tip: 'Three dotted rings at different speeds, each listening to a different band.',
        params: [
            { key: 'size', label: 'Size', min: 0.5, max: 1, step: 0.05, default: 1, tip: 'Overall size.' },
            { key: 'dotsPerRing', label: 'Dots per ring', min: 8, max: 48, step: 2, default: 24, tip: 'Density of each ring.' },
            { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.05, default: 1, tip: 'Core glow strength.' },
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

            rings.forEach((ring) => {
                const ringRadius = baseRadius * ring.radiusMultiplier * (1 + ring.energy * 0.12);
                ctx.fillStyle = ring.color;
                ctx.globalAlpha = 0.35 + ring.energy * 0.6;
                for (let dotIndex = 0; dotIndex < dotsPerRing; dotIndex++) {
                    const angle = (dotIndex / dotsPerRing) * Math.PI * 2 + nowMs * ring.rotationSpeed;
                    const dotX = centerX + Math.cos(angle) * ringRadius;
                    const dotY = centerY + Math.sin(angle) * ringRadius;
                    ctx.beginPath();
                    ctx.arc(dotX, dotY, 1.4 + ring.energy * 2.6, 0, Math.PI * 2);
                    ctx.fill();
                }
            });

            ctx.globalAlpha = 1;
            const coreRadius = baseRadius * 0.22 * (1 + frameValues.bass * 0.5);
            ctx.beginPath();
            ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
            ctx.fillStyle = colors.primary;
            ctx.shadowColor = colors.glow;
            ctx.shadowBlur = 14 * styleParams.glow;
            ctx.globalAlpha = 0.55 + frameValues.bass * 0.45;
            ctx.fill();
            ctx.shadowBlur = 0;
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

// Note: If a style is renamed or removed, the config silently holds an unknown id
const DEFAULT_ANIM_CONFIG = {
    response: { model: 'punch', decayMs: 60, punchSensitivity: 0.06, offsetMs: 0 },
    circle: { enabled: true, style: 'bars', params: {}, effects: [{ id: 'breath', params: {} }] },
    text: {
        enabled: true,
        glowStrength: 0.9,
        breatheAmount: 0.08,
        entry: { id: 'swipe', params: {} }, // empty params = use defaults
        exit: { id: 'fade', params: {} },
        effects: [{ id: 'wobble', params: {} }],
    },
};
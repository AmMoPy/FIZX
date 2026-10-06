// ═══════════════════════════════════════════════════════════════════
// rendercore.js — Knows nothing about which styles/effects exist by name
// it just looks up whatever id is in the config against the stylekit.js
// registries. Template and Studio both use this unchanged.
// ═══════════════════════════════════════════════════════════════════

// Exponential approach toward a target value, using a time constant rather
// than a fixed per-frame fraction. This makes the result frame-rate
// independent: the same timeConstantMs produces the same real-world
// decay speed whether the display is 60Hz or 144Hz.
//
function exponentialApproach(currentValue, targetValue, timeConstantMs, deltaTimeMs) {
    const approachFraction = 1 - Math.exp(-deltaTimeMs / Math.max(1, timeConstantMs));
    return currentValue + (targetValue - currentValue) * approachFraction;
}

// Turns the raw per-frame bass/vocal/treble LUT values into smoothed
// render values, according to the selected response model:
//
//  - 'baseline'/'fastdecay': bass snaps up instantly, decays over
//     `decayMs`. Vocal/treble always use the same moderate decay — only
//     bass behavior is varied by model, so that's the one variable being
//     tested when comparing models.
//
//  - 'punch': bass is the max of two independent values —
//      sustainedLevel: slow envelope of the overall loudness (same
//        snap-up/decay-down shape as baseline), used for ambient glow.
//      punchValue: resets to full strength on every detected rise,
//        decays fast on its own fixed schedule regardless of what
//        sustainedLevel is doing. This is what keeps two closely-spaced
//        hits visually distinct — each one retriggers punchValue on its
//        own, instead of being read off a single continuously-decaying
//        level.
//
// Returns { bass, vocal, treble, hitDetected } — hitDetected is true on
// any frame where a rise crossed the punch threshold, used by callers
// that want to trigger something once per hit (e.g. the scan effect).
function createResponseModel(responseConfig) {
    let sustainedLevel = 0;
    let punchValue = 0;
    let previousBassTarget = 0;
    let punchCooldownMs = 0;
    let bassValue = 0;
    let vocalValue = 0;
    let trebleValue = 0;

    const PUNCH_COOLDOWN_MS = 70; // minimum gap between retriggers, prevents one real hit from firing twice across a couple of noisy frames

    return {
        reset() {
            sustainedLevel = 0;
            punchValue = 0;
            previousBassTarget = 0;
            punchCooldownMs = 0;
            bassValue = 0;
            vocalValue = 0;
            trebleValue = 0;
        },

        step(targetBass, targetVocal, targetTreble, deltaTimeMs) {
            punchCooldownMs = Math.max(0, punchCooldownMs - deltaTimeMs);
            const rise = targetBass - previousBassTarget;
            previousBassTarget = targetBass;
            const hitDetected = rise > responseConfig.punchSensitivity && targetBass > 0.15 && punchCooldownMs <= 0;
            if (hitDetected) punchCooldownMs = PUNCH_COOLDOWN_MS;

            let outputBass;
            if (responseConfig.model === 'punch') {
                sustainedLevel = targetBass > sustainedLevel
                    ? targetBass
                    : exponentialApproach(sustainedLevel, targetBass, 70, deltaTimeMs);
                punchValue = hitDetected
                    ? Math.max(0.55, targetBass)
                    : exponentialApproach(punchValue, 0, 45, deltaTimeMs);
                outputBass = Math.max(sustainedLevel * 0.8, punchValue);
            } else {
                const decayMs = responseConfig.model === 'fastdecay'
                    ? Math.min(responseConfig.decayMs, 28)
                    : responseConfig.decayMs;
                bassValue = targetBass > bassValue
                    ? targetBass
                    : exponentialApproach(bassValue, targetBass, decayMs, deltaTimeMs);
                outputBass = bassValue;
            }

            vocalValue = exponentialApproach(vocalValue, targetVocal, 90, deltaTimeMs);
            trebleValue = exponentialApproach(trebleValue, targetTreble, 60, deltaTimeMs);

            // Write into the shared output object (no per-frame allocation)
            // this means any caller holding a reference sees the values mutate
            // on the next step() but since the caller reads them synchronously 
            // after renderFrame, this is fine in a single-instance setup.
            return { bass: outputBass, vocal: vocalValue, treble: trebleValue, hitDetected };
        },
    };
}

// Drives both the circle canvas and the animated text block from one LUT
// data source and one response model. Owns the circle's canvas element and
// its resize handling; the host page owns everything else (positioning,
// drag/resize UI, which DOM elements it hands in).
class AnimCore {
    /**
     * @param hostElements {
     *   circleContainer: element the circle canvas is mounted into
     *   textFxContainer: element to apply CSS transform
     *   textIoContainer: element to receive WAAPI transitions (entry/exit)
     *   textLine: element whose textContent is the lyric text
     *   textGlow: duplicate text element used for a blurred glow layer
     *   getColors: optional () => { primary, secondary, glow } — defaults
     *              to DEFAULT_COLORS if omitted
     * }
     * @param config one of the shapes in DEFAULT_ANIM_CONFIG
     */
    constructor(hostElements, config) {
        this.hostElements = hostElements;
        this.lutData = null;
        this.bassTrailHistory = new Array(8).fill(0);
        this.visibility = { circle: true, text: true };

        this.circleCanvasEl = document.createElement('canvas');
        this.hostElements.circleContainer.appendChild(this.circleCanvasEl);
        this.circleCtx = this.circleCanvasEl.getContext('2d');

        this.circleResizeObserver = new ResizeObserver(() => this.resizeCircleCanvas()); // TODO: debounce?
        this.circleResizeObserver.observe(this.hostElements.circleContainer);
        this.resizeCircleCanvas();

        this.circleEffectOffsets = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 };
        this.textEffectOffsets = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 };

        this.setConfig(config);
    }

    resizeCircleCanvas() {
        const containerRect = this.hostElements.circleContainer.getBoundingClientRect();
        this.circleCanvasEl.width = containerRect.width;
        this.circleCanvasEl.height = containerRect.height;
        this.drawContext = {
            centerX: containerRect.width / 2,
            centerY: containerRect.height / 2,
            baseRadius: Math.min(containerRect.width, containerRect.height) * 0.20,
            nowMs: 0,
            colors: DEFAULT_COLORS,
            bassTrailHistory: this.bassTrailHistory,
        };
    }

    // Resolves a config's effect-slot list into { effectDefinition, resolvedParams } pairs, filtered by scope
    resolveEffectList(effectSlots, scope) {
        return (effectSlots || [])
            .map((slot) => {
                const effectDefinition = EFFECTS[slot.id];
                if (!effectDefinition) return null;
                const defaultParams = {};
                effectDefinition.params.forEach((paramDef) => { defaultParams[paramDef.key] = paramDef.default; });
                return { effectDefinition, resolvedParams: Object.assign(defaultParams, slot.params) };
            })
            .filter((resolved) => resolved && (resolved.effectDefinition.scope === 'both' || resolved.effectDefinition.scope === scope));
    }

    setConfig(config) {
        this.config = config;

        this.responseModel = createResponseModel(config.response);

        this.circleStyle = CIRCLE_STYLES[config.circle.style] || CIRCLE_STYLES.sweep;
        const defaultStyleParams = {};
        this.circleStyle.params.forEach((paramDef) => { defaultStyleParams[paramDef.key] = paramDef.default; });
        this.circleStyleParams = Object.assign(defaultStyleParams, config.circle.params);

        this.circleEffects = this.resolveEffectList(config.circle.effects, 'circle');
        this.textEffects = this.resolveEffectList(config.text.effects, 'text');

        const resolveTransition = (slot) => {
            const transitionDefinition = TEXT_TRANSITIONS[slot && slot.id];
            if (!transitionDefinition) return null;
            const defaultParams = {};
            transitionDefinition.params.forEach((paramDef) => { defaultParams[paramDef.key] = paramDef.default; });
            return { transitionDefinition, resolvedParams: Object.assign(defaultParams, slot.params) };
        };
        this.textEntryTransition = resolveTransition(config.text.entry);
        this.textExitTransition = resolveTransition(config.text.exit);
    }

    setLutData(lutData) {
        this.lutData = lutData; // { stepMs, bass: [...], vocal: [...], treble: [...] }
    }

    setVisibility(visibility) {
        this.visibility = visibility;
        this.circleCanvasEl.style.display = visibility.circle ? '' : 'none';
        this.hostElements.textFxContainer.style.display = visibility.text ? '' : 'none';
    }

    // Sums every effect in the list into one combined offset
    accumulateEffectOffsets(effectList, frameValues, nowMs, outputOffsets) {
        outputOffsets.offsetX = 0;
        outputOffsets.offsetY = 0;
        outputOffsets.scale = 1;
        outputOffsets.rotation = 0;
        for (const { effectDefinition, resolvedParams } of effectList) {
            const contribution = effectDefinition.transform(frameValues, resolvedParams, nowMs);
            outputOffsets.offsetX += contribution.offsetX || 0;
            outputOffsets.offsetY += contribution.offsetY || 0;
            outputOffsets.scale *= contribution.scale || 1;
            outputOffsets.rotation += contribution.rotation || 0;
        }
        return outputOffsets;
    }

    // Advances one frame: reads the LUT at playbackTimeSec, runs the
    // response model, draws the circle, and updates the text element's
    // transform/opacity. Returns the response model's output for the
    // frame, so the host can react to it (e.g. trigger the scan effect
    // on hitDetected).
    renderFrame(playbackTimeSec, deltaTimeMs, nowMs) {
        const lutIndex = Math.max(0, Math.floor((playbackTimeSec * 1000 + this.config.response.offsetMs) / this.lutData.stepMs));
        const frameValues = this.responseModel.step(
            this.lutData.bass[lutIndex] || 0,
            this.lutData.vocal[lutIndex] || 0,
            this.lutData.treble[lutIndex] || 0,
            deltaTimeMs,
        );

        if (this.visibility.circle && this.config.circle.enabled) {
            this.bassTrailHistory.push(frameValues.bass);
            this.bassTrailHistory.shift();

            this.drawContext.nowMs = nowMs;
            this.drawContext.colors = this.hostElements.getColors ? this.hostElements.getColors() : DEFAULT_COLORS;

            const offsets = this.accumulateEffectOffsets(this.circleEffects, frameValues, nowMs, this.circleEffectOffsets);
            const ctx = this.circleCtx;
            const { centerX, centerY } = this.drawContext;

            ctx.clearRect(0, 0, this.circleCanvasEl.width, this.circleCanvasEl.height);
            ctx.save();
            ctx.translate(centerX + offsets.offsetX * this.drawContext.baseRadius, centerY + offsets.offsetY * this.drawContext.baseRadius);
            ctx.rotate(offsets.rotation);
            ctx.scale(offsets.scale, offsets.scale);
            ctx.translate(-centerX, -centerY);
            this.circleStyle.draw(ctx, frameValues, this.circleStyleParams, this.drawContext);
            ctx.restore();
        }

        if (this.visibility.text && this.config.text.enabled) {
            const textConfig = this.config.text;
            const offsets = this.accumulateEffectOffsets(this.textEffects, frameValues, nowMs, this.textEffectOffsets);
            const PIXELS_PER_UNIT = 48; // text effect offsets are in "units"; this converts to px
            const breathScale = 1 + frameValues.vocal * textConfig.breatheAmount;

            this.hostElements.textFxContainer.style.transform =
                `translate3d(${offsets.offsetX * PIXELS_PER_UNIT}px, ${offsets.offsetY * PIXELS_PER_UNIT}px, 0) ` +
                `rotate(${offsets.rotation}rad) scale(${breathScale * offsets.scale})`; // compositor-only: transform + opacity below
            
            // Glow opacity tracks vocal (clamped via toFixed, not clamped numerically).
            // the value sent can exceed 1 but browser clamps opacity to 1 anyway.
            this.hostElements.textGlow.style.opacity = (frameValues.vocal * textConfig.glowStrength).toFixed(3);
        }

        return frameValues;
    }

    // Plays an entry or exit transition on the text container. Returns its duration in ms, or 0 if none is configured
    playTextTransition(transitionSlot, direction) {
        if (!transitionSlot || !this.visibility.text) return 0;
        const durationMs = transitionSlot.resolvedParams.durationMs || 260;
        const keyframes = transitionSlot.transitionDefinition.getKeyframes(direction, transitionSlot.resolvedParams);
        this.hostElements.textIoContainer.animate(keyframes, {
            duration: durationMs,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
            fill: 'both',
        });
        return durationMs;
    }

    // Sets the lyric text and plays its entry transition
    setLyricText(text) {
        this.hostElements.textLine.textContent = text;
        this.hostElements.textGlow.textContent = text;
        this.playTextTransition(this.textEntryTransition, 'in');
    }

    // Play the exit animation. Returns duration in ms.
    playTextExit() {
        return this.playTextTransition(this.textExitTransition, 'out');
    }

    // How long the exit animation lasts, in seconds.
    getExitDurationSec() {
        return ((this.textExitTransition && this.textExitTransition.resolvedParams.durationMs) || 0) / 1000;
    }

    // Tear down: disconnect resize observer, remove canvas.
    // does NOT remove listeners or reset the host
    // If the host is reused with a new AnimCore, 
    // host.circle.appendChild adds a second canvas. 
    // Caller must ensure destroy() is called before re-creating.
    destroy() {
        this.circleResizeObserver.disconnect();
        this.circleCanvasEl.remove();
    }
}
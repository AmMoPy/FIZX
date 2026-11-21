// ANALYSIS, WASM_AVAILABLE, WASM_*_B64 and PFFFT are injected globals
'use strict';

// LUT engine's table built lazily, only when 'lut' actually runs —
// each extractRadix() call spins up a fresh Worker anyway, so this resets
// to null every run; the win is just not paying it on other engine runs.
let lutTwRe = null, lutTwIm = null;

// Separate from lutTwRe/lutTwIm: those are indexed by butterfly STAGE
// size and used incrementally inside fft(); these are indexed by output
// BIN number and used once per bin during the unpacking step below.
let unpackTwRe = null, unpackTwIm = null;

// holds the sample data for the lifetime of this worker instance. Only
// ever set by 'load-samples', only ever read by 'kick-preview'. A worker
// instance that only ever receives 'analyze' messages never touches this
// at all — no interference between the two worker roles.
let cachedSampleDataForPreview = null;

// Preview cache: the expensive stage is reused while only the 
// sustain-reject slider moves.
let cachedKickEnvelope = null;

// Module-scope scratch for the rise histogram. 256 bins is finer than the
// envelope's own precision (values are quantized to 3 decimals upstream),
// so the threshold derived from it is indistinguishable from the exact
// percentile. Reused across calls to avoid a per-call allocation.
const _riseHistogram = new Uint32Array(256);

// ── WAVEFORM CONTRACT ─────────────────────────────────────────────
// A single Float32Array lives at worker scope (waveform). It is allocated
// by the dispatcher, then populated by whichever engine branch runs. Each
// engine is responsible for writing its own per-frame envelope into this
// buffer at the correct column granularity (WAVEFORM_COLS, peak per column).
//
// If an engine produces no envelope (e.g. the LUT engine with kick
// disabled), the buffer stays zeroed — the dispatcher still posts it, so
// the main thread always receives a waveform message of consistent shape.
//
// Engines never post the waveform themselves. The dispatcher posts it
// after the engine returns, before the engine-specific type:'done'
// message, so message order is deterministic across all engines.
// ─────────────────────────────────────────────────────────────────
const WAVEFORM_COLS = 400;
const waveform = new Float32Array(WAVEFORM_COLS); // reused across runs, reset by dispatcher

// ── WASM MODULE ──────────────────────────────────────────────────
const PFFFT_REAL = 0;
const PFFFT_FORWARD = 0;

let pffftModulePromise = null; // cached across every frame and every 'analyze' call this worker instance handles

function base64ToArrayBuffer(base64String) {
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}

// Canonical WASM SIMD feature-detection module, verified against the
// wasm-feature-detect package (GoogleChromeLabs) rather than hand-rolled —
// a single wrong byte here would make this silently always report false.
function supportsWasmSimd() {
    const simdTestModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    try {
        return WebAssembly.validate(simdTestModule);
    } catch {
        return false;
    }
}

// Loads and instantiates PFFFT exactly once per worker instance, picking
// the SIMD build when supported. Returns a small wrapper exposing just
// what this worker needs — setup/transform/cleanup — not the raw
// Emscripten Module object.
async function getPffftEngine(fftSize) {
    if (pffftModulePromise) return pffftModulePromise;

    pffftModulePromise = (async () => {
        const useSimd = supportsWasmSimd();
        console.log('[worker] WASM SIMD supported:', useSimd);
        const wasmBinary = base64ToArrayBuffer(useSimd ? WASM_SIMD_B64 : WASM_NOSIMD_B64);
        const Module = await PFFFT({ 
            wasmBinary,
            locateFile: (path) => path,   // dummy; unused because wasmBinary is set
        }); // PFFFT declared directly by the spliced-in glue code above

        const transformSize = fftSize; // 16384 — fixed for this project, setup only ever built for this one size
        const setupHandle = Module._pffft_new_setup(transformSize, PFFFT_REAL);
        if (!setupHandle) throw new Error('PFFFT setup failed for size ' + transformSize);

        // Buffers allocated once, reused for every frame — mirrors how
        // spectrumBuffer/packedBuffer were already allocated once and
        // reused in the pure-JS path, same reasoning: avoid a
        // malloc/free pair 20,000+ times per track.
        const inputPtr = Module._pffft_aligned_malloc(transformSize * 4);
        const outputPtr = Module._pffft_aligned_malloc(transformSize * 4);
        const workPtr = Module._pffft_aligned_malloc(transformSize * 4);
        const inputView = new Float32Array(Module.HEAPF32.buffer, inputPtr, transformSize);
        const outputView = new Float32Array(Module.HEAPF32.buffer, outputPtr, transformSize);

        return {
            usingSimd: useSimd,

            /** Runs one forward real FFT on windowedFrame (length transformSize), returns the interleaved output view (reused — copy out before the next call). */
            transform(windowedFrame) {
                inputView.set(windowedFrame);
                Module._pffft_transform_ordered(setupHandle, inputPtr, outputPtr, workPtr, PFFFT_FORWARD);
                return outputView;
            },

            destroy() {
                Module._pffft_destroy_setup(setupHandle);
                Module._pffft_aligned_free(inputPtr);
                Module._pffft_aligned_free(outputPtr);
                Module._pffft_aligned_free(workPtr);
            },
        };
    })();

    return pffftModulePromise;
}

// ── Twiddle factor table ──────────────────────────────────────────
// Precomputed once for FFT_N. The butterfly loop reads wRe[len] and
// wIm[len] instead of calling Math.cos/Math.sin per pass.
// Keys are len values (2, 4, 8, ..., FFT_N).
// Same table is reused across all frames (FFT_N is fixed).

// twiddle-table construction pulled into a factory so that each engine
// can get its own FFT_N-point table without touching the other FFT_N-point
// when using different values
// ─────────────────────────────────────────────────────────────────
function buildTwiddles(fftSize) {
    const tRe = new Float64Array(fftSize + 1); // using 32-bit floats will cause small rounding errors to compound across the stages.
    const tIm = new Float64Array(fftSize + 1);
    for (let stageSize = 2; stageSize <= fftSize; stageSize <<= 1) {
        const theta = -2 * Math.PI / stageSize;
        tRe[stageSize] = Math.cos(theta);
        tIm[stageSize] = Math.sin(theta);
    }
    return { tRe, tIm };
}

// ── Radix-2 Cooley-Tukey in-place FFT ────────────────────────────
// Iterative butterfly — no recursion, no stack depth risk.
// Reads twiddle factors from precomputed table instead of computing
// Math.cos/Math.sin per butterfly pass.
// ─────────────────────────────────────────────────────────────────
function fft(buffer, twiddleReal, twiddleImag) {
    const sampleCount = buffer.length / 2;

    // Bit-reversal permutation — reorders samples in place so the butterfly
    // passes below can run without extra scratch space. Swaps a sample's
    // real and imaginary parts together, since they always move as a pair.
    let swapWith = 0;
    for (let sample = 1; sample < sampleCount; sample++) {
        let bit = sampleCount >> 1;
        for (; swapWith & bit; bit >>= 1) swapWith ^= bit;
        swapWith ^= bit;
        if (sample < swapWith) {
            const sampleReal = sample * 2;
            const swapReal = swapWith * 2;
            const tempReal = buffer[sampleReal];
            buffer[sampleReal] = buffer[swapReal];
            buffer[swapReal] = tempReal;
            const tempImag = buffer[sampleReal + 1];
            buffer[sampleReal + 1] = buffer[swapReal + 1];
            buffer[swapReal + 1] = tempImag;
        }
    }

    // Butterfly passes — stageSize doubles each pass, from 2 up to the full
    // sample count.
    for (let stageSize = 2; stageSize <= sampleCount; stageSize <<= 1) {
        const halfStage = stageSize >> 1;
        const stepReal = twiddleReal[stageSize];
        const stepImag = twiddleImag[stageSize];

        for (let stageStart = 0; stageStart < sampleCount; stageStart += stageSize) {
            // The twiddle factor rotates by one step per k, starting at
            // 1 + 0i (no rotation) for k = 0.
            let rotationReal = 1;
            let rotationImag = 0;

            for (let k = 0; k < halfStage; k++) {
                const topIndex = (stageStart + k) * 2;
                const bottomIndex = topIndex + halfStage * 2;

                const topReal = buffer[topIndex];
                const topImag = buffer[topIndex + 1];
                const bottomReal = buffer[bottomIndex];
                const bottomImag = buffer[bottomIndex + 1];

                // Rotate the "bottom" sample by the current twiddle factor
                const rotatedReal = rotationReal * bottomReal - rotationImag * bottomImag;
                const rotatedImag = rotationReal * bottomImag + rotationImag * bottomReal;

                buffer[topIndex]        = topReal + rotatedReal;
                buffer[topIndex + 1]    = topImag + rotatedImag;
                buffer[bottomIndex]     = topReal - rotatedReal;
                buffer[bottomIndex + 1] = topImag - rotatedImag;

                // Advance the twiddle factor for the next k
                const nextRotationReal = rotationReal * stepReal - rotationImag * stepImag;
                rotationImag = rotationReal * stepImag + rotationImag * stepReal;
                rotationReal = nextRotationReal;
            }
        }
    }
}

// ── Normalization/smoothing helpers ─────────────────
// mirrors ex_beats.py's keep both in sync if either  
// changes, that's the cross-path parity contract.
// ────────────────────────────────────────────────────
function percentileSorted(sorted, pct) {
    const idx = (pct / 100) * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function windowedNormalize(dbArray, framesPerSec) {
    const n = dbArray.length;
    const LUT_WINDOW_SEC = 8.0;  // must match WINDOW_SEC in ex_beats.py
    const block = Math.max(1, Math.round(LUT_WINDOW_SEC * framesPerSec));
    const nBlocks = Math.ceil(n / block);
    const bFloor = new Float32Array(nBlocks);
    const bCeil  = new Float32Array(nBlocks);
    const scratch = new Float32Array(block); // Pre-allocated workspace typed buffer to eliminate GC allocations inside loops
    for (let b = 0; b < nBlocks; b++) {
        const s = b * block;
        const e = Math.min((b + 1) * block, n);
        const len = e - s;
        // Zero-copy array segment views mapping straight to native sorting algorithms
        for (let i = 0; i < len; i++) scratch[i] = dbArray[s + i];
        // In-place sort over our isolated scratch space view
        const activeSlice = scratch.subarray(0, len);
        activeSlice.sort();
        bFloor[b] = percentileSorted(activeSlice, 5);
        bCeil[b]  = percentileSorted(activeSlice, 95);
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const pos = i / block - 0.5;
        const b0 = Math.max(0, Math.min(nBlocks - 1, Math.floor(pos)));
        const b1 = Math.max(0, Math.min(nBlocks - 1, b0 + 1));
        const t  = Math.max(0, Math.min(1, pos - b0));
        const floor = bFloor[b0] + (bFloor[b1] - bFloor[b0]) * t;
        const ceil  = bCeil[b0]  + (bCeil[b1]  - bCeil[b0])  * t;
        const span  = Math.max(ceil - floor, 1e-6);
        out[i] = Math.max(0, Math.min(1, (dbArray[i] - floor) / span));
    }
    return out;
}

// Combined inline rounding into the smoothing logic to save .map allocations
function smoothAsymmetric(curve, attack, release) {
    const n = curve.length;
    const out = new Float32Array(n); // Return high-speed typed storage fields
    let current = curve[0] || 0;
    for (let i = 0; i < n; i++) {
        const v = curve[i];
        current += (v - current) * (v > current ? attack : release);
        out[i] = Math.round(current * 1000) / 1000;
    }
    return out;
}

// ── BPM ────────────────────────────────────────────────
// Estimates tempo (BPM) from an onset-strength envelope by autocorrelation, 
// then folds the result into a musically conventional range.
// env = onset-strength envelope (e.g. from extractKick)
// stepMs = time step per envelope element, in milliseconds
// ────────────────────────────────────────────────────────
function bpmFromEnv(env, stepMs) {
    const fr = 1000 / stepMs;   // frame rate: envelope frames per second
    const N = env.length;
    if (N === 0) return 120; // Structural guard to avoid infite while loop as best stays 0?

    // Compute the mean of the envelope (needed to center the autocorrelation)
    let m = 0;
    for (let i = 0; i < N; i++) m += env[i]; // plain indexed loop?
    m /= N;
    
    // Autocorrelation search over lags corresponding to BPM range ~60..200
    let best = 0;         // best BPM found
    let bs = -Infinity;   // best score
    
    // Lag range: smallest lag = 200 BPM, largest lag = 60 BPM (capped at N-1)
    const lagMin = Math.floor(fr * 60 / 200);
    const lagMax = Math.min(Math.ceil(fr * 60), N - 1); 
    
    // Step by 2 or 4 to drastically accelerate calculation checks on long files
    const STEP = N > 5000 ? 4 : 1;
    
    // TODO: Lag search is O((lagMax - lagMin) × N), for long envelopes this
    // is quadratic. Worth it for a feature thats only UI?
    for (let lag = lagMin; lag <= lagMax; lag++) {
        // Compute normalized autocorrelation at this lag
        let c = 0;
        let count = 0;
        for (let i = 0; i < N - lag; i += STEP) {
            c += (env[i] - m) * (env[i + lag] - m); // subtracting the mean removes the DC component so the correlation reflects co-variation rather than offset.
            count++;
        }
        c /= count; // normalize by number of overlapping samples. TODO: normalized cross-correlation (divide by the product of standard deviations)?
        
        // Convert lag to BPM: lag frames = lag / fr seconds = 60*fr/lag BPM
        const bpm = fr * 60 / lag;
        if (bpm === 0) continue;

        // Weight the correlation by a log-Gaussian prior centered at 120 BPM
        // This biases the result toward typical musical tempos. It suppresses both 
        // very slow and very fast candidates
        const s = c * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
        
        if (s > bs) {
            bs = s;
            best = bpm;
        }
    }
    
    // Fold the result into a canonical range [70, 175] BPM
    // (handles octave errors: 2× or ½× the "true" tempo)
    while (best > 175) best /= 2;
    while (best < 70 && best > 0) best *= 2;
    
    return best === 0 ? 120 : Math.round(best);
}

// ── SHARED DSP  ────────────────────────────────────────────────
// biquad filter coefficient calculator
// t: is the filter type ('lp' for low-pass, anything else for high-pass)
// f: is the cutoff frequency
// sr: is the sample rate
// Q: is the quality factor with a default of 0.707 (Butterworth response)
// The returned object contains normalized biquad coefficients and initial state variables (x1, x2, y1, y2) for the filter's delay line
// The a0 normalization is applied to all coefficients as is standard in biquad filter implementations
// ─────────────────────────────────────────────────────────────────
function bq(t, f, sr, Q = 0.707) {
    // Calculate the angular frequency
    const w = 2 * Math.PI * f / sr;
    
    // Pre-calculate cosine and sine of angular frequency
    const co = Math.cos(w);
    const a = Math.sin(w) / (2 * Q);
    
    // Declare feedforward coefficients
    let b0, b1, b2;
    
    // Calculate coefficients based on filter type
    if (t === 'lp') {
        // Low-pass filter coefficients
        b0 = (1 - co) / 2;
        b1 = 1 - co;
        b2 = b0;
    } else {
        // High-pass filter coefficients
        b0 = (1 + co) / 2;
        b1 = -(1 + co);
        b2 = b0;
    }
    
    // Normalization factor
    const a0 = 1 + a;
    
    // Return normalized coefficients and initial state variables
    return {
        // Feedforward coefficients (normalized)
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        // Feedback coefficients (normalized)
        a1: -2 * co / a0,
        a2: (1 - a) / a0,
        // Initial state variables for the filter
        x1: 0,
        x2: 0,
        y1: 0,
        y2: 0
    };
}

// ─────────────────────────────────────────────────────────────────
// Direct Form I biquad filter processing a single sample at a time
// Repeated accesses to object properties (f.b0, f.b1, etc.) may be slower than 
// local variable caching on some low-end devices — but V8 and other JS engines 
// typically optimize property access well, and caching to locals would require 
// reading the properties anyway
// f = filter coefficient/state object (from bq function)
// x = current input sample
// ─────────────────────────────────────────────────────────────────
function run(f, x) {    
    // Compute output using the difference equation:
    // The subtraction of a1*y1 and a2*y2 (rather than addition) is 
    // consistent with the coefficient signs returned by bq 
    // which already negates a1 via -2*co/a0
    // y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
    const y = f.b0 * x 
            + f.b1 * f.x1 
            + f.b2 * f.x2 
            - f.a1 * f.y1 
            - f.a2 * f.y2;
    
    // Shift input delay line: x[n-2] = x[n-1], x[n-1] = x[n]
    f.x2 = f.x1;
    f.x1 = x;
    
    // Shift output delay line: y[n-2] = y[n-1], y[n-1] = y[n]
    f.y2 = f.y1;
    f.y1 = y;
    
    // Return the computed output sample
    return y;
}

// ─────────────────────────────────────────────────────────────────
// kick channel: band-pass -> 23ms RMS -> subtract slow envelope -> windowed ceiling
// ─────────────────────────────────────────────────────────────────
// Stage 1 (expensive, depends only on the cutoff): band-pass the signal and
// measure its RMS level once per hop.
function computeKickEnvelope(samples, sampleRate, stepMs, lowpassHz) {
    const hopSize = Math.round(sampleRate * stepMs / 1000);
    const frameCount = Math.floor(samples.length / hopSize);
    // Create filter chain: high-pass at 35 Hz, then two cascaded low-passes at lpHz
    // (cascaded low-passes = steeper rolloff, isolates kick body frequencies)
    // Note: the three biquad filter objects (highpass, lowpassStage1, lowpassStage2)  
    // carry their state across all samples in the loop. This is correct for continuous 
    // processing but means the function is not safe to call concurrently on the same buffer.    
    const highpass = bq('hp', ANALYSIS.kick.hp, sampleRate);
    const lowpassStage1 = bq('lp', lowpassHz, sampleRate);
    const lowpassStage2 = bq('lp', lowpassHz, sampleRate);

    // Process each block: filter the samples and compute mean-square energy
    const meanSquarePerHop = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
        const hopStart = frame * hopSize;
        let sumOfSquares = 0;
        for (let i = 0; i < hopSize; i++) {
            // Average L+R channels (or duplicate mono) then filter
            const filtered = run(lowpassStage2, run(lowpassStage1, run(highpass, samples[hopStart + i])));
            sumOfSquares += filtered * filtered; // accumulate squared samples
        }
        meanSquarePerHop[frame] = sumOfSquares / hopSize; // mean square per block
    }

    // Compute envelope: sqrt of a 2-point moving average of the block energies
    // Note: the first block averages meanSquarePerHop[0] with itself (frame is falsy, 
    // so meanSquarePerHop[frame-1] is replaced by meanSquarePerHop[frame]) this yields a slightly 
    // different smoothing at the start
    const envelope = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
        const previous = frame > 0 ? meanSquarePerHop[frame - 1] : meanSquarePerHop[frame];
        envelope[frame] = Math.sqrt((meanSquarePerHop[frame] + previous) / 2);
    }
    return envelope;
}

// Stage 2 (cheap, about one operation per frame): subtract the slow level so
// held notes cancel, then normalise against a per-8-second ceiling.
function shapeKickChannel(envelope, stepMs, sustainRejection) {
    const frameCount = envelope.length;
    // Attack/release smoothing coefficients for the "slow" adaptive envelope
    // Attack time constant ~120 ms, release time constant ~250 ms
    const attackCoefficient = 1 - Math.exp(-stepMs / ANALYSIS.kick.slowAttMs);
    const releaseCoefficient = 1 - Math.exp(-stepMs / ANALYSIS.kick.slowRelMs);

    const transient = new Float32Array(frameCount);
    let slowLevel = 0, largestTransient = 0;
    for (let frame = 0; frame < frameCount; frame++) {
        // Slow envelope tracks upward fast (attack) and downward slowly (release)
        slowLevel += (envelope[frame] - slowLevel) * (envelope[frame] > slowLevel ? attackCoefficient : releaseCoefficient);
        transient[frame] = Math.max(0, envelope[frame] - sustainRejection * slowLevel);
        // Track largest transient signal (used as a floor for thresholds)
        if (transient[frame] > largestTransient) largestTransient = transient[frame];
    }

    // blockLength: ~8 seconds worth of blocks (per window)
    const blockLength = Math.max(1, Math.round(8000 / stepMs));
    const blockCount = Math.ceil(frameCount / blockLength); // number of windows
    const blockCeiling = new Float32Array(blockCount); // ceiling/threshold per window

    // Reuse a static sortable buffer workspace to eliminate GC allocation thrashing
    const scratchSort = new Float32Array(blockLength);

    // Compute per-window adaptive threshold using 97th percentile
    for (let block = 0; block < blockCount; block++) {
        const startIdx = block * blockLength;
        const endIdx = Math.min(blockCount, (block + 1) * blockLength);
        const len = endIdx - startIdx;

        // Fast buffer alignment copy
        for (let i = 0; i < len; i++) {
            scratchSort[i] = transient[startIdx + i];
        }

        const activeSlice = scratchSort.subarray(0, len);
        activeSlice.sort(); // High-speed typed array in-place sort

        const percentileIndex = Math.floor(len * 0.97);
        const p97 = activeSlice[percentileIndex] || 0.0;

        // Threshold = 97th percentile, but at least 15% of global max, and at least 1e-9
        blockCeiling[block] = Math.max(p97, largestTransient * 0.15, 1e-9);

        // const sorted = Array.from(transient.subarray(block * blockLength, Math.min(frameCount, (block + 1) * blockLength))).sort((a, b) => a - b);
        // blockCeiling[block] = Math.max(sorted[Math.floor(sorted.length * 0.97)] || 0, largestTransient * 0.15, 1e-9);
    }

    // Normalize transient signal against window thresholds with linear interpolation
    const channel = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
        // position = window index as a fractional position (centered: -0.5 offset)
        const position = frame / blockLength - 0.5; // shifts window centers so that the interpolation between thresholds is centered on each window
        const left = Math.max(0, Math.min(blockCount - 1, Math.floor(position)));
        const right = Math.min(blockCount - 1, left + 1);
        const blend = Math.max(0, Math.min(1, position - left)); // interpolation factor

        // Interpolated threshold between adjacent windows
        // Output = transient / threshold, clamped to [0, 1]
        channel[frame] = Math.min(1, transient[frame] / (blockCeiling[left] + (blockCeiling[right] - blockCeiling[left]) * blend));
    }
    return channel;
}

function extractKick(samples, sampleRate, stepMs, lowpassHz, sustainRejection) {
    return shapeKickChannel(computeKickEnvelope(samples, sampleRate, stepMs, lowpassHz), stepMs, sustainRejection);
}

function getKickEnvelope(samples, sampleRate, stepMs, lowpassHz) {
    const cache = cachedKickEnvelope;
    if (cache && cache.samples === samples && cache.sampleRate === sampleRate && cache.stepMs === stepMs && cache.lowpassHz === lowpassHz) {
        return cache.envelope;
    }
    const envelope = computeKickEnvelope(samples, sampleRate, stepMs, lowpassHz);
    cachedKickEnvelope = { samples, sampleRate, stepMs, lowpassHz, envelope };
    return envelope;
}

const roundToThousandths = (value) => Math.round(value * 1000) / 1000;

// ─────────────────────────────────────────────────────────────────
// Convert onset-strength envelope (output of extractKick) into a list of 
// onset timestamps in seconds.
// a = array of onset-strength values, one per stepMs
// stepMs = time step per array element, in milliseconds
// thr = rise threshold: minimum positive jump in strength to count as an onset
// floor = minimum absolute strength required to count as an onset (default 0.15)
// cd = cooldown in milliseconds between detected onsets (default 70 ms)
// ─────────────────────────────────────────────────────────────────

// Derives onset-detection thresholds from the envelope's own statistics,
// so the detector adapts to the track's dynamics instead of using
// hardcoded values that only fit one genre.
//
// Returns:
//   thr   — rise threshold: the 80th-percentile positive rise.
//           Keeps the sharpest ~20% of rises as candidate onsets; the
//           long tail of gentle rises (decays, sustains) is filtered out.
//   floor — absolute floor: 20% of the envelope's max.
//           Rejects onsets during quiet passages.
//   cd    — cooldown: three frames worth of time.
//           Prevents a single transient from producing multiple onsets
//           when the envelope wobbles around the peak.
//
// Cost: O(n) over the envelope with a fixed 256-entry scratch buffer.
// No sort, no dynamic allocation, no arithmetic beyond a subtract and a
// bounds-checked histogram increment. On a 5,633-frame envelope this is
// ~0.1ms per call.
function autoTuneOnsets(envelope, stepMs) {
    const n = envelope.length;
    if (n === 0) return { thr: 0, floor: 0, cd: stepMs * 3 };

    _riseHistogram.fill(0);
    let maxVal = 0;
    let riseCount = 0;
    let prev = 0;

    // Single pass: track max, bucket each positive rise by magnitude.
    for (let i = 0; i < n; i++) {
        const v = envelope[i];
        if (v > maxVal) maxVal = v;
        const r = v - prev;
        if (r > 0) {
            // r is in [0, 1] after windowedNormalize; clamp defensively so
            // a stray value above 1 doesn't index out of the histogram.
            const bin = r >= 1 ? 255 : (r * 256) | 0;
            _riseHistogram[bin]++;
            riseCount++;
        }
        prev = v;
    }

    // 80th percentile of positive rises, read off the histogram.
    // Walk bins from low to high, accumulate counts, stop when the running
    // total crosses 80% of all rises. That bin's midpoint is the threshold.
    let thr = 0;
    if (riseCount > 0) {
        const target = riseCount * 0.80;
        let acc = 0;
        for (let b = 0; b < 256; b++) {
            acc += _riseHistogram[b];
            if (acc >= target) {
                thr = (b + 0.5) / 256;
                break;
            }
        }
    }

    const floor = maxVal * 0.20;
    const cd    = stepMs * 3;

    return { thr, floor, cd };
}

// function detectOnsets(a, stepMs, thr, floor = 0.15, cd = 70) {  
function detectOnsets(a, stepMs) {    
    const {thr, floor, cd} = autoTuneOnsets(a, stepMs);
    const o = [];        // output list of onset times (seconds)
    let p = 0.0;           // previous sample value (for rise detection)
    let c = 0.0;           // remaining cooldown time in milliseconds

    for (let i = 0; i < a.length; i++) {
        // Tick the cooldown down by one step, clamped at 0
        c = Math.max(0.0, c - stepMs);
        
        // Rise = how much the current value exceeds the previous one
        // sensitive to attacks (sudden rises) rather than sustained loudness
        const r = a[i] - p;
        p = a[i]; // update previous for next iteration
        
        // Onset conditions:
        //   1. Rise exceeds the threshold (r > thr)
        //   2. Absolute value exceeds the floor (a[i] > floor)
        //   3. Cooldown has expired (c <= 0)
        if (r > thr && a[i] > floor && c <= 0) {
            // Convert array index to time in seconds (rounded to nearest ms)
            o.push(Math.round(i * stepMs) / 1000); // round and the division on every detection. Detections are relatively rare, so this is fine.
            
            // Start cooldown
            c = cd;
        }
    }
    
    return o;
}

// The per-frame work lives in small functions on purpose: the onmessage
// handler is a large async function that runs once per analysis, so a hot
// loop inlined in it is optimized less well than the same work in a small
// function called once per frame.
// Sum of |X[k]|^2 over bins [firstBin, endBin) of an interleaved
// [re0, im0, re1, im1, ...] spectrum. The energy of a bin range is just
// the sum of squares of the matching flat float range, so re/im pairs
// don't need to be handled separately.
function sumBinEnergy(interleavedSpectrum, firstBin, endBin) {
    let energy = 0;
    for (let i = firstBin * 2; i < endBin * 2; i++) {
        const value = interleavedSpectrum[i];
        energy += value * value;
    }
    return energy;
}

// WASM path: window one frame, run PFFFT, store the three band amplitudes.
function analyzeFrameWasm(frameIndex, analysis) {
    const { samples, sampleCount, hannWindow, fftSize, hopSize, windowedFrame, pffft, bands, profile } = analysis;
    const frameStart = frameIndex * hopSize - fftSize / 2;       // centered frame, edges zero-padded

    for (let i = 0; i < fftSize; i++) {
        const sampleIndex = frameStart + i;
        windowedFrame[i] = (sampleIndex >= 0 && sampleIndex < sampleCount ? samples[sampleIndex] : 0) * hannWindow[i];
    }

    const fftStart = performance.now();
    const spectrum = pffft.transform(windowedFrame);             // interleaved [re, im, ...], ordered
    profile.fftMs += performance.now() - fftStart;

    analysis.vocalEnergy[frameIndex]  = Math.sqrt(sumBinEnergy(spectrum, bands.vocalStart,  bands.vocalEnd)  / (bands.vocalEnd  - bands.vocalStart));
    analysis.trebleEnergy[frameIndex] = Math.sqrt(sumBinEnergy(spectrum, bands.trebleStart, bands.trebleEnd) / (bands.trebleEnd - bands.trebleStart));
    analysis.bassEnergy[frameIndex]   = Math.sqrt(sumBinEnergy(spectrum, bands.bassStart,   bands.bassEnd)   / (bands.bassEnd   - bands.bassStart));
}


// JS fallback path: real-input FFT via a half-size complex FFT plus an unpack step.
//   1. Pack x[2n] as the real part and x[2n+1] as the imaginary
//      part of a half-length (N/2) complex sequence z[n]. One
//      N/2-point complex FFT on z gives Z[0..N/2-1].
//
//   2. Z is Even[k] + i*Odd[k], where Even/Odd are the DFTs of
//      x's even- and odd-indexed samples. Because x is real,
//      Even and Odd are each conjugate-symmetric — which is
//      exactly what lets them be separated back out of Z:
//        Even[k] = (Z[k] + conj(Z[mirror])) / 2
//        Odd[k]  = -i * (Z[k] - conj(Z[mirror])) / 2,  mirror = (N/2 - k) mod (N/2)
//      (k=0 needs no special case: mirror naturally wraps to 0,
//      since Z has period N/2, and the formula degenerates
//      correctly on its own.)
//
//   3. Recombine via the standard radix-2 butterfly to get the
//      bin of the FULL N-point transform:
//        X[k] = Even[k] + W_N^k * Odd[k],   W_N^k = e^(-2*pi*i*k/N)
//
// Steps 2-3 only need to run up to the highest bin any band
// actually reads (treble's upper edge) — nothing past that is
// ever used, so the unpack loop is bounded well below N/2 too.
//
// The lutTwRe/lutTwIm table built above for LUT_FFT_N already
// contains every stage-size entry a HALF_N-point FFT needs
// (buildTwiddles fills every power-of-two stage up to its
// argument), so no second stage-twiddle table is needed — only
// the small per-bin unpack table below is new.
function analyzeFrameJs(frameIndex, analysis) {
    const { samples, sampleCount, hannWindow, fftSize, hopSize, halfSize, packedBuffer,
            twiddleReal, twiddleImag, unpackReal, unpackImag, maxNeededBin, bands, profile } = analysis;
    const frameStart = frameIndex * hopSize - fftSize / 2;

    // Pack even samples into the real part and odd samples into the imaginary part
    for (let n = 0; n < halfSize; n++) {
        const evenIndex = frameStart + n * 2;
        const oddIndex = evenIndex + 1;
        const evenSample = (evenIndex >= 0 && evenIndex < sampleCount) ? samples[evenIndex] : 0;
        const oddSample  = (oddIndex  >= 0 && oddIndex  < sampleCount) ? samples[oddIndex]  : 0;
        packedBuffer[n * 2]     = evenSample * hannWindow[n * 2];
        packedBuffer[n * 2 + 1] = oddSample  * hannWindow[n * 2 + 1];
    }

    const fftStart = performance.now();
    fft(packedBuffer, twiddleReal, twiddleImag);
    profile.fftMs += performance.now() - fftStart;

    let vocalPower = 0, treblePower = 0, bassPower = 0;
    for (let k = 0; k <= maxNeededBin; k++) {
        const mirrorIndex = (halfSize - k) % halfSize;           // k = 0 wraps to 0 (the transform has period halfSize)

        const zRe = packedBuffer[k * 2],           zIm = packedBuffer[k * 2 + 1];
        const mRe = packedBuffer[mirrorIndex * 2], mIm = packedBuffer[mirrorIndex * 2 + 1];

        // Separate the even/odd sub-spectra that the packing step mixed together
        const evenRe = (zRe + mRe) / 2, evenIm = (zIm - mIm) / 2;
        const oddRe  = (zIm + mIm) / 2, oddIm  = (mRe - zRe) / 2;

        // Recombine into bin k of the full-length transform
        const twiddleRe = unpackReal[k], twiddleIm = unpackImag[k];
        const binRe = evenRe + (twiddleRe * oddRe - twiddleIm * oddIm);
        const binIm = evenIm + (twiddleRe * oddIm + twiddleIm * oddRe);
        const binPower = binRe * binRe + binIm * binIm;

        if (k >= bands.vocalStart  && k < bands.vocalEnd)  vocalPower  += binPower;
        if (k >= bands.trebleStart && k < bands.trebleEnd) treblePower += binPower;
        if (k >= bands.bassStart   && k < bands.bassEnd)   bassPower   += binPower;
    }

    analysis.vocalEnergy[frameIndex]  = Math.sqrt(vocalPower  / (bands.vocalEnd  - bands.vocalStart));
    analysis.trebleEnergy[frameIndex] = Math.sqrt(treblePower / (bands.trebleEnd - bands.trebleStart));
    analysis.bassEnergy[frameIndex]   = Math.sqrt(bassPower   / (bands.bassEnd   - bands.bassStart));
}


// Fills the frames skipped by frameStride with a straight line between the
// analyzed frames on either side. With frameStride = 1 this does nothing.
// The final frame must already be analyzed so the last segment is never
// extrapolated.
function interpolateBetweenAnalyzedFrames(values, frameStride, frameCount) {
    const lastFrame = frameCount - 1;
    for (let left = 0; left < lastFrame; left += frameStride) {
        const right = Math.min(left + frameStride, lastFrame);
        const span = right - left;
        for (let frame = left + 1; frame < right; frame++) {
            values[frame] = values[left] + (values[right] - values[left]) * ((frame - left) / span);
        }
    }
}

// Runs the per-frame analysis over the whole track, analyzing every
// frameStride-th frame (plus always the last one) and interpolating the rest.
// Returns how many frames were actually analyzed.
function runAnalysisLoop(analysis, frameCount, frameStride, onProgress) {
    const analyzeFrame = analysis.pffft ? analyzeFrameWasm : analyzeFrameJs;
    const analyzedFrameCount = Math.ceil(frameCount / frameStride);
    const progressEvery = Math.max(1, Math.floor(analyzedFrameCount / 50));

    for (let analyzedIndex = 0; analyzedIndex < analyzedFrameCount; analyzedIndex++) {
        analyzeFrame(analyzedIndex * frameStride, analysis);
        if (analyzedIndex % progressEvery === 0) onProgress(analyzedIndex, analyzedFrameCount);
    }

    const lastFrame = frameCount - 1;
    if (frameCount > 0 && lastFrame % frameStride !== 0) analyzeFrame(lastFrame, analysis);

    interpolateBetweenAnalyzedFrames(analysis.vocalEnergy, frameStride, frameCount);
    interpolateBetweenAnalyzedFrames(analysis.trebleEnergy, frameStride, frameCount);
    interpolateBetweenAnalyzedFrames(analysis.bassEnergy, frameStride, frameCount);
    return analyzedFrameCount;
}  

// ── Main onmessage ────────────────────────────────────────────────
// Worker message handler receives audio samples and analysis parameters
// Sends progress updates and a final result back to the main thread
// ─────────────────────────────────────────────────────────────────
self.onmessage = async function(e) {
    const messageType = e.data.type || 'analyze'; // setting defaults so payload works unmodified
    
    if (messageType === 'load-samples') {
        // sent once when the Design view's preview worker starts up.
        // Transferred in, so this worker now owns the buffer — the main
        // thread's own copy of this particular Float32Array is gone, but
        // it was a throwaway copy made specifically for this transfer
        // (see DesignStep.startKickPreviewWorker below), not state.mono.
        cachedSampleDataForPreview = e.data.samples;
        return;
    }

    if (messageType === 'kick-preview') {
        // lightweight path for live slider dragging — computes only
        // the kick channel and returns immediately. Never reaches the FFT
        // loop below, so vocal/treble are untouched.
        if (!cachedSampleDataForPreview) return; // guards a preview request racing ahead of load-samples
        try {
            const { sr: sampleRate, stepMs, kickLp: kickLowpassHz, kickRej: kickSustainRejection } = e.data;
            const envelope = getKickEnvelope(cachedSampleDataForPreview, sampleRate, stepMs, kickLowpassHz);
            const kickChannel = shapeKickChannel(envelope, stepMs, kickSustainRejection);
            console.log('kick-preview invoked');
            self.postMessage({
                type: 'kick-preview-done',
                beats: Array.from(kickChannel, roundToThousandths),
                onsets: detectOnsets(kickChannel, stepMs),
                bpm: bpmFromEnv(kickChannel, stepMs),
            });
        } catch (error) {
            self.postMessage({ type: 'error', message: String(error) });   // an async handler's throw would otherwise never reach worker.onerror
        }
        return;
    }

    //'analyze' full-track path,
    // engine: 'lut' (default) | others come from PARAMS config 
    // on main thread via postMessage payload.
    const {
        samples,
        sr,
        kickLp: kickLowpassHz = ANALYSIS.kick.lp,
        kickRej: kickSustainRejection = ANALYSIS.kick.rej,
        kickBass = false,
        turbo   = true,       // false for 'js' (safe) | true for 'wasm'
        engine   = 'lut',
        fftStride = 2,       
    } = e.data;

    // Helper to post a progress message
    const prog = (p, l) => self.postMessage({ type: 'progress', pct: p, label: l });
    
    // Reset waveform before every run — engines fill it lazily,
    // so stale data from a previous run must be cleared.
    waveform.fill(0);

    // full path performance logging
    const analyzeStart = performance.now();

    if (engine === 'lut') {
        const HOP = ANALYSIS.hop;                         // hop size in samples
        const stepMs = HOP / sr * 1000;                   // hop size in milliseconds
        const sampleCount = samples.length;               // total input sample count
        const frameCount = Math.floor(sampleCount / HOP); // independent of kickBass
  
        // Kick envelope extraction
        prog(3, 'KICK CHANNEL');
        
        const kickChannel = extractKick(samples, sr, stepMs, kickLowpassHz, kickSustainRejection);

        // Populate waveform   
        const nb = kickChannel.length; // number of analysis frames
        const colStep = nb / WAVEFORM_COLS;
        for (let k = 0; k < nb; k++) {
            const col = Math.min(WAVEFORM_COLS - 1, Math.floor(k / colStep));
            const amp = kickChannel[k]; // extractKick already returns [0,1]-ish values
            if (amp > waveform[col]) waveform[col] = amp;
        }
   
        // separate FFT size for the continuous LUT engine — parity with
        // ex_beats.py's N_FFT, independent of other engines onset detector's tuning.
        const LUT_FFT_N = 16384;

        // size of the real-input sub-FFT, see note below
        const HALF_N = LUT_FFT_N / 2;

        let pffft = null;
        if (turbo && WASM_AVAILABLE) {
            const t0 = performance.now();
            try {
                pffft = await getPffftEngine(LUT_FFT_N);
                prog(8, pffft.usingSimd ? 'WASM FFT (SIMD)' : 'WASM FFT');
                const t1 = performance.now();
                console.log('[worker] PFFFT init:', (t1 - t0).toFixed(1), 'ms |', pffft.usingSimd ? 'SIMD' : 'nosimd');
            } catch (err) {
                // falls back to the JS path rather than failing the whole
                // analysis run — a WASM instantiation failure (old engine, CSP,
                // out-of-memory) shouldn't take down extraction entirely.
                prog(8, 'WASM FFT unavailable, using JS');
                console.error('[worker] PFFFT init failed:', err);
                pffft = null;
            }
        }
        console.log('[worker] fftEngine requested:', turbo, '| pffft after init:', pffft ? 'wasm' : 'js');

        // FFT twiddle table (lazily built once, cached on the worker global)
        if (!lutTwRe) ({ tRe: lutTwRe, tIm: lutTwIm } = buildTwiddles(LUT_FFT_N));

        const LN = LUT_FFT_N;   // FFT size
        const binHz = sr / LN;  // Hz per FFT bin
        const analBd = ANALYSIS.bands;

        // Frequency bin ranges
        // +1 makes the range inclusive of 
        // the end bins (ranges overlap at binHz)
        const b0 = Math.floor(analBd.bass.lo / binHz);                // bass band start
        const b1 = Math.floor(analBd.bass.hi / binHz + 1);            // bass band end
        const v0 = Math.floor(analBd.vocal.lo / binHz);               // vocal band start
        const v1 = Math.floor(analBd.vocal.hi / binHz) + 1;           // vocal band end
        const t0 = Math.floor(analBd.treble.lo / binHz);              // treble band start
        const t1 = Math.floor(analBd.treble.hi / binHz) + 1;          // treble band end

        // Real-input FFT (rFFT)
        const maxNeededBin = Math.max(b1, v1, t1);

        if (!unpackTwRe || unpackTwRe.length <= maxNeededBin) {
            unpackTwRe = new Float64Array(maxNeededBin + 1); // using 64-bit avoid compound rounding errors across the stages.
            unpackTwIm = new Float64Array(maxNeededBin + 1);
            for (let k = 0; k <= maxNeededBin; k++) {
                const theta = -2 * Math.PI * k / LN;
                unpackTwRe[k] = Math.cos(theta);
                unpackTwIm[k] = Math.sin(theta);
            }
        }

        // Output envelopes for each band
        const ve = new Float32Array(frameCount); // tiny rounding errors in the 6th decimal place, will vanish through the logarithmic scaling function
        const te = new Float32Array(frameCount);
        const be = new Float32Array(frameCount);

        // Scratch buffers reused across all frames
        const win = new Float32Array(LN);                // Hann window

        // Precompute Hann window (denominator LN-1 = symmetric Hann)
        // TODO: switch to periodic (LN instead of LN-1)?
        for (let i = 0; i < LN; i++) {
            win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (LN - 1)));
        }

        // half the size
        const packedBuffer = new Float32Array(HALF_N * 2);
        const frameStride = Math.max(1, Math.floor(fftStride));

        // One context object holds everything the per-frame functions need. Every
        // field exists for both paths (null when unused) so the object keeps a
        // single shape.
        const analysis = {
            samples, sampleCount,
            hannWindow: win,
            fftSize: LN, hopSize: HOP, halfSize: HALF_N,
            bands: { bassStart: b0, bassEnd: b1, vocalStart: v0, vocalEnd: v1, trebleStart: t0, trebleEnd: t1 },
            vocalEnergy: ve, trebleEnergy: te, bassEnergy: be,
            profile: { fftMs: 0 },                                       // diagnostic only
            // WASM path
            pffft,
            windowedFrame: pffft ? new Float32Array(LN) : null,
            // JS path
            packedBuffer,
            twiddleReal: lutTwRe, twiddleImag: lutTwIm,
            unpackReal: unpackTwRe, unpackImag: unpackTwIm, maxNeededBin,
        };

        const loopStart = performance.now();
        const analyzedFrameCount = runAnalysisLoop(analysis, frameCount, frameStride, (done, total) => {
            prog(10 + Math.round(done / total * 85), 'Extracting Bands');
        });
        const loopMs = performance.now() - loopStart;

        console.log('[worker] frame loop:', loopMs.toFixed(1), 'ms |', analyzedFrameCount, 'of', frameCount,
                    'frames analyzed (stride ' + frameStride + ') |', (loopMs / analyzedFrameCount).toFixed(3),
                    'ms per analyzed frame | engine:', pffft ? 'wasm' : 'js');
        console.log('[worker] FFT-only time:', analysis.profile.fftMs.toFixed(1), 'ms |',
                    (analysis.profile.fftMs / analyzedFrameCount).toFixed(3), 'ms per analyzed frame');

        // Convert linear amplitude array to decibels (with small epsilon to avoid log(0))
        const db = x => {
            const len = x.length;
            const o = new Float32Array(len);
            for (let i = 0; i < len; i++) {
                o[i] = 20 * Math.log10(x[i] + 1e-6);
            }
            return o;
        };
        
        // Envelope post-processing: normalize + asymmetric smoothing
        const fps = sr / HOP; // frames per second
        const vocal  = smoothAsymmetric(windowedNormalize(db(ve), fps), analBd.vocal.att, analBd.vocal.rel);
        const treble = smoothAsymmetric(windowedNormalize(db(te), fps), analBd.treble.att, analBd.treble.rel);
        const bass   = smoothAsymmetric(windowedNormalize(db(be), fps), analBd.bass.att, analBd.bass.rel);

        // pick the active candidate for export, keep the other purely
        // for the Studio's comparison overlay — it never leaves the Studio.
        const activeBassEnvelope = kickBass ? kickChannel : bass;
        const comparisonBassEnvelope = kickBass ? bass : kickChannel;

        console.log('[worker] analyze total:', (performance.now() - analyzeStart).toFixed(1), 'ms | engine:', pffft ? 'wasm' : 'js');

        // Paired posts: waveform first, then done. Order matters — the main
        // thread's 'done' handler assumes waveform is already populated.
        // Do not insert anything between these that could throw and skip the
        // second post; the main thread would hang waiting for 'done'.
        self.postMessage({ type: 'waveform', data: waveform }, [waveform.buffer]);
        self.postMessage({
            type: 'done',
            step_ms: Math.round(stepMs * 1e4) / 1e4,                                        // step in ms, rounded to 4 decimals
            beats: Array.from(activeBassEnvelope, roundToThousandths),                      // Float32 data arrays map smoothly to arrays
            bass_comparison_env: Array.from(comparisonBassEnvelope, roundToThousandths),    // Studio-only, never exported
            vocal_env: Array.from(vocal, roundToThousandths),
            treble_env: Array.from(treble, roundToThousandths),
            vocal_onsets: detectOnsets(vocal, stepMs),         // TODO: wiring path, thinking of dropping onsets entirely
            onsets: detectOnsets(activeBassEnvelope, stepMs),
            bpm: bpmFromEnv(activeBassEnvelope, stepMs),
            onsets_comparison: detectOnsets(comparisonBassEnvelope, stepMs),
            bpm_comparison: bpmFromEnv(comparisonBassEnvelope, stepMs),
            kick_bass: kickBass
        });

        return;
    }

    // // ── Other Engine paths ───────────────────────────────────────
    // if (engine === 'engine_name') {

    // } else {

    // }
};
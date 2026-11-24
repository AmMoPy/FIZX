// ══════════════════════════════════════════════════════════════════════════════════════
// Live path used in rendering template for instant start, no analysis, no decode memory.
// Suit different job than LUT path: casual playback vs authoring and export.
//
// Note: ANALYSIS is injected global
// ══════════════════════════════════════════════════════════════════════════════════════
const LiveBands = (() => {
    const HOP_MS = ANALYSIS.hop / 44100 * 1000;                         // nominal hop the per-hop coefficients were defined at (~11.6 ms)
    const tau = (a) => -HOP_MS / Math.log(1 - a);                       // per-hop coefficient -> time constant (ms)
    const BANDS = ['bass', 'vocal', 'treble'].map((key) => {
        const b = ANALYSIS.bands[key];
        return { key, hp: b.lo, lp: b.hi, att: tau(b.att), rel: tau(b.rel) };
    });
    // Kick channel = causal version of the worker's extractKick: same filters, hop-sized mean-square envelope + 2-point average,
    // same sustain subtraction. minCeil/seedCeil stand in for the worker's look-ahead (global max) at cold start: tune them with LiveBands.dbg.
    const KICK = { ...ANALYSIS.kick, fft: 2048, headroom: 0.85, seedCeil: 0.10, minCeil: 0.04, floorFrac: 0.15, ceilRelMs: 6000, peakRelMs: 60000 };
    const FFT_SIZE = 2048;
    const DB_MIN = -80, HEADROOM_DB = 2, MIN_SPAN_DB = 10;
    const TRACK_UP_MS = 150, TRACK_BACK_MS = 6000;                      // no warm-up on the slow side: a cold start must not auto-gain a vocal intro
    const out = { bass: 0, vocal: 0, treble: 0, kick: 0 };
    const dbg = { env: 0, slow: 0, transient: 0, ceil: 0, peakMax: 0 };
    let source = null, sr = 44100, chains = [], kickChain = null, buf = null, kickBuf = null;

    const biquad = (ac, type, hz) => {
        const n = ac.createBiquadFilter();
        n.type = type; n.frequency.value = hz;
        n.Q.value = -3.0103;                                            // Butterworth (Q = 0.707); Q is in dB on lowpass/highpass nodes
        return n;
    };
    const wire = (src, nodes) => {
        src.connect(nodes[0]);
        for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    };
    const analyserNode = (ac, size) => {
        const a = ac.createAnalyser();
        a.fftSize = size; a.smoothingTimeConstant = 0;
        return a;
    };
    function clearOutputs() { out.bass = out.vocal = out.treble = out.kick = 0; }
    function seed() {                                                   // hard reset: levels back to the cold-start prior (attach does this)
        for (const c of chains) { c.floor = -60; c.ceil = -20; c.value = 0; }
        if (kickChain) { kickChain.slow = 0; kickChain.prevMs = 0; kickChain.ceil = KICK.seedCeil; kickChain.peakMax = KICK.seedCeil; }
        clearOutputs();
    }
    function reset() {                                                  // new track: clear per-track state but KEEP the learned levels
        for (const c of chains) c.value = 0;
        if (kickChain) { kickChain.slow = 0; kickChain.prevMs = 0; }
        clearOutputs();
    }
    function detach() {
        for (const c of [...chains, kickChain]) {
            if (!c) continue;
            try { source.disconnect(c.nodes[0]); } catch (_) {}
            for (const n of c.nodes) n.disconnect();
        }
        chains = []; kickChain = null; source = null;
    }
    function attach(ac, src) {
        if (source) detach();
        source = src; sr = ac.sampleRate;
        buf = new Float32Array(FFT_SIZE);
        kickBuf = new Float32Array(KICK.fft);
        const nyq = sr * 0.45;
        chains = BANDS.map((b) => {
            const lp = Math.min(b.lp, nyq);
            // two identical Butterworth biquads per edge = Linkwitz-Riley 4th order
            const nodes = [biquad(ac, 'highpass', b.hp), biquad(ac, 'highpass', b.hp), biquad(ac, 'lowpass', lp), biquad(ac, 'lowpass', lp), analyserNode(ac, FFT_SIZE)];
            wire(src, nodes);
            return { ...b, nodes, analyser: nodes[nodes.length - 1], floor: -60, ceil: -20, value: 0 };
        });
        const kLp = Math.min(KICK.lp, nyq);
        const kNodes = [biquad(ac, 'highpass', KICK.hp), biquad(ac, 'lowpass', kLp), biquad(ac, 'lowpass', kLp), analyserNode(ac, KICK.fft)];
        wire(src, kNodes);
        kickChain = { nodes: kNodes, analyser: kNodes[kNodes.length - 1], slow: 0, prevMs: 0, ceil: KICK.seedCeil, peakMax: KICK.seedCeil };
        seed();
    }
    function read(dtMs) {
        if (!chains.length) return out;
        const k = (tauMs) => 1 - Math.exp(-dtMs / tauMs);
        for (const c of chains) {                                       // band energies: causal stand-in for windowedNormalize
            c.analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const db = Math.max(DB_MIN, 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-6));
            c.ceil  += (db - c.ceil)  * k(db > c.ceil  ? TRACK_UP_MS : TRACK_BACK_MS);
            c.floor += (db - c.floor) * k(db < c.floor ? TRACK_UP_MS : TRACK_BACK_MS);
            const span = Math.max(c.ceil - HEADROOM_DB - c.floor, MIN_SPAN_DB);
            const raw = Math.min(1, Math.max(0, (db - c.floor) / span));
            c.value += (raw - c.value) * k(raw > c.value ? c.att : c.rel);
            out[c.key] = c.value;
        }
        const kc = kickChain;                                           // kick channel
        kc.analyser.getFloatTimeDomainData(kickBuf);
        const n = Math.min(KICK.fft, Math.max(ANALYSIS.hop, Math.round(dtMs * 0.001 * sr)));   // everything since the last read, at least one worker hop
        let sum = 0;
        for (let i = KICK.fft - n; i < KICK.fft; i++) sum += kickBuf[i] * kickBuf[i];
        const ms = sum / n;
        const env = Math.sqrt((ms + kc.prevMs) * 0.5);                  // worker: sqrt of a 2-point average of mean-squares
        kc.prevMs = ms;
        kc.slow += (env - kc.slow) * k(env > kc.slow ? KICK.slowAttMs : KICK.slowRelMs);
        const transient = Math.max(0, env - KICK.rej * kc.slow);
        kc.peakMax = Math.max(transient, kc.peakMax * Math.exp(-dtMs / KICK.peakRelMs));
        kc.ceil    = Math.max(transient, kc.ceil    * Math.exp(-dtMs / KICK.ceilRelMs));
        const ceil = Math.max(kc.ceil, KICK.floorFrac * kc.peakMax, KICK.minCeil) * KICK.headroom;
        out.kick = Math.min(1, transient / ceil);
        dbg.env = env; dbg.slow = kc.slow; dbg.transient = transient; dbg.ceil = ceil; dbg.peakMax = kc.peakMax;
        return out;
    }
    // One "feel" knob for the live kick channel: 0 = only strong kicks, 1 = softer beats too.
    function setSensitivity(s) {
        s = Math.min(1, Math.max(0, +s || 0));
        KICK.rej = 1.2 - 0.8 * s;                // sustain rejection
        KICK.floorFrac = 0.50 - 0.40 * s;        // ceiling floor relative to the learned peak (genre/loudness independent)
        KICK.minCeil = 0.12 - 0.10 * s;          // absolute floor for the cold start
    }
    setSensitivity(0.5);    
    return { attach, detach, reset, seed, read, KICK, dbg, setSensitivity, kickMode: true };
})();
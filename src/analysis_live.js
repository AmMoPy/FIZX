// ANALYSIS is injected global
const LiveBands = (() => {
    const HOP_MS = ANALYSIS.hop / 44100 * 1000;                         // nominal hop the per-hop coefficients were defined at (~11.6 ms)
    const tau = (a) => -HOP_MS / Math.log(1 - a);                       // per-hop coefficient -> time constant (ms)
    const BANDS = ['bass', 'vocal', 'treble'].map((key) => {
        const b = ANALYSIS.bands[key];
        return { key, hp: b.lo, lp: b.hi, att: tau(b.att), rel: tau(b.rel) };
    });
    const KICK = { ...ANALYSIS.kick, fft: 2048, sub: 128, headroom: 0.85, seedCeil: 0.02, floorFrac: 0.15, ceilRelMs: 6000, peakRelMs: 60000 };
    const FFT_SIZE = 2048;
    const DB_MIN = -80, HEADROOM_DB = 2, MIN_SPAN_DB = 10;
    const TRACK_UP_MS = 150, TRACK_BACK_MS = 6000, WARM_MS = 4000;
    const out = { bass: 0, vocal: 0, treble: 0, kick: 0 };
    let source = null, chains = [], kickChain = null, buf = null, kickBuf = null, elapsedMs = 0;

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
    function reset() {
        elapsedMs = 0;
        for (const c of chains) { c.floor = -60; c.ceil = -20; c.value = 0; }
        if (kickChain) { kickChain.slow = 0; kickChain.ceil = KICK.seedCeil; kickChain.peakMax = KICK.seedCeil; }
        out.bass = out.vocal = out.treble = out.kick = 0;
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
        source = src;
        buf = new Float32Array(FFT_SIZE);
        kickBuf = new Float32Array(KICK.fft);
        const nyq = ac.sampleRate * 0.45;
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
        kickChain = { nodes: kNodes, analyser: kNodes[kNodes.length - 1], slow: 0, ceil: KICK.seedCeil, peakMax: KICK.seedCeil };
        reset();
    }
    // Causal stand-in for windowedNormalize: floor/ceiling followers in dB (fast to move outward, slow to come back).
    function read(dtMs) {
        if (!chains.length) return out;
        elapsedMs += dtMs;
        const warm = 0.25 + 0.75 * Math.min(1, elapsedMs / WARM_MS);       // adapts faster during the first seconds of a track
        const k = (tauMs) => 1 - Math.exp(-dtMs / tauMs);
        for (const c of chains) {
            c.analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const db = Math.max(DB_MIN, 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-6));
            c.ceil  += (db - c.ceil)  * k(db > c.ceil  ? TRACK_UP_MS : TRACK_BACK_MS * warm);
            c.floor += (db - c.floor) * k(db < c.floor ? TRACK_UP_MS : TRACK_BACK_MS * warm);
            const span = Math.max(c.ceil - HEADROOM_DB - c.floor, MIN_SPAN_DB);
            const raw = Math.min(1, Math.max(0, (db - c.floor) / span));
            c.value += (raw - c.value) * k(raw > c.value ? c.att : c.rel);
            out[c.key] = c.value;
        }
        // Kick channel: causal version of the worker's extractKick (band-pass -> envelope -> minus slow level -> ceiling)
        const kc = kickChain;
        kc.analyser.getFloatTimeDomainData(kickBuf);
        let peak = 0;                                                       // peak-hold over short sub-blocks: sharp attack, and no missed transients if frames drop
        for (let s = 0; s < KICK.fft; s += KICK.sub) {
            let sum = 0;
            for (let i = s; i < s + KICK.sub; i++) sum += kickBuf[i] * kickBuf[i];
            if (sum > peak) peak = sum;
        }
        const env = Math.sqrt(peak / KICK.sub);
        kc.slow += (env - kc.slow) * k(env > kc.slow ? KICK.slowAttMs : KICK.slowRelMs);
        const transient = Math.max(0, env - KICK.rej * kc.slow);
        kc.peakMax = Math.max(transient, kc.peakMax * Math.exp(-dtMs / KICK.peakRelMs));
        kc.ceil    = Math.max(transient, kc.ceil    * Math.exp(-dtMs / (KICK.ceilRelMs * warm)));
        const ceil = Math.max(kc.ceil, KICK.floorFrac * kc.peakMax, 1e-9) * KICK.headroom;
        out.kick = Math.min(1, transient / ceil);
        return out;
    }
    return { attach, detach, reset, read, KICK, kickMode: true };
})();
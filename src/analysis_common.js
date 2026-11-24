// Shared by the studio's analysis worker and the template's live path (LiveBands).
// Band edges and smoothing live here only. att/rel are per-hop coefficients at HOP samples.
const ANALYSIS = {
    hop: 512,
    bands: {
        bass:   { lo: 43,   hi: 258,   att: 0.60, rel: 0.25 },
        vocal:  { lo: 300,  hi: 4000,  att: 0.14, rel: 0.10 },
        treble: { lo: 4000, hi: 11000, att: 0.20, rel: 0.12 },
    },
    kick: { hp: 35, lp: 120, rej: 1.0, slowAttMs: 120, slowRelMs: 250 },
};
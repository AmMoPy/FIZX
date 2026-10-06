#!/usr/bin/env python3
"""
Onset and lyrics extractor for FIZX visualizer
writes beats.json and lyrics.json next to this script, 
consumed by compile.py when generating the final output.

Usage (full exctraction):
    python3 ex_beats.py <audio_file> [options]

    <audio_file>        Path to audio file (MP3/WAV/OGG).

OPTIONS:
    --beats             Extract beats from the full mix (librosa).
                        Writes / updates beats.json.

    --lyrics            Triggers forced lyrics alignment. Reads LYRICS_RAW
                        from lyrics.json, writes LYRICS back.

    --both              --beats + --lyrics in one audio pass.

    --onnx              ONNX forced alignment: Spleeter for vocal separation 
                        and wav2vec2 CTC. Default is DTW via aeneas on the full mix.

    --force             Re-extract even if beats/lyrics data is fresh

LYRICS.JSON SCHEMA:
    {
        "LYRICS_RAW": ["line one", "line two", ...],   # input — edit by hand
        "LYRICS":     [{"text": "line one", "start": 1.0, "end": 2.0}, ...]  # output — aligned
    }
    end = next segment's start (sticky behaviour — line stays until next starts).

Output:
    beats.json   ->  { "beats": [...], "bpm": 129, "source": "filename.mp3" }
    lyrics.json  ->  { "LYRICS_RAW": [...], "LYRICS": [{...}] }

Design notes:
    Current implementation offers two options:
        - DTW forced alignment: Aeneas (default) balanced speed/accuracy
            for legacy hardware.
        - ONNX forced alignment: Sherpa-ONNX Spleeter -> wav2vec2 CTC, easier 
            installation and scalable performance.
"""

import sys
import json
import logging
import argparse
from pathlib import Path
from typing import Optional, Any

# Logging
log_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(
    level=getattr(logging, "INFO"),
    format=log_format
)
logger = logging.getLogger("EXTRACTOR")


# spleeter and ctc models
MODELS_DIR = Path(__file__).parent.parent / "models"

class Extractor:
    """
    Single-pass class for beats and/or lyric alignment from one audio file.

    Parameters
    ----------
    audio_path  : Path — input audio file
    beats_path  : Path — output beats.json
    lyrics_path : Path — lyrics.json (read LYRICS_RAW, write LYRICS)
    """

    def __init__(self, audio_path: Path, beats_path: Path, lyrics_path: Path):
        self.audio_path  = audio_path
        self.beats_path  = beats_path
        self.lyrics_path = lyrics_path
        self._y_full     = None  # full mix, loaded lazily
        self._sr         = None  # native sample rate
        self._vocals     = None  # vocal stem (mono float32), populated by _separate()
        self._vocal_sr   = None

    # ── Private helpers ───────────────────────────────────────────

    def _load_full_mix(self, sr: int = None, mono: bool = True):
        """
        Load and cache full mix
        
        Note: cache is per-run only (single Extractor instance, single script
        invocation) — extract_beats() is the only call site, and both modes now
        request sr=None, so there's no live path where this gets called twice
        with different sr values. If that ever changes, this silently returns
        audio resampled for the first caller — worth a real guard at that point,
        not before.
        """
        if self._y_full is not None:
            return self._y_full, self._sr
        import librosa
        logger.info("Loading audio…")
        self._y_full, self._sr = librosa.load(str(self.audio_path), sr=sr, mono=mono)
        logger.info(f" Loaded: {self.audio_path.name} SR={self._sr}Hz  duration={self._y_full.shape[-1]/self._sr:.1f}s")
        return self._y_full, self._sr
    
    # ── ONNX route ───────────────────────────────────────────

    def _load_stereo_44k(self) -> Any:
        """
        Load audio as stereo float32 at 44100Hz for Spleeter.
        Separate from _load_full_mix to avoid polluting the mono cache.
        Returns shape (2, num_samples) — always stereo even if source is mono
        (duplicate channel rather than faking L-R cancellation).
        """
        import soundfile as sf
        import librosa
        import numpy as np

        y, sr = sf.read(str(self.audio_path), dtype='float32', always_2d=True)
        # soundfile returns (samples, channels) → transpose to (channels, samples)
        y = y.T

        # If mono source, duplicate to stereo — avoids L-R=0 cancellation
        # while still feeding the stereo model correctly
        if y.shape[0] == 1:
            y = np.vstack([y, y])

        # Resample to 44100Hz if needed — Spleeter model expects 44100Hz input.
        if sr != 44100:
            logger.info(f"Resampling {sr}Hz → 44100Hz for Spleeter…")
            y = np.array([librosa.resample(ch, orig_sr=sr, target_sr=44100) for ch in y], dtype='float32')

        assert y.dtype == np.float32,   f"Expect np.float32 as dtype. Given: {y.dtype}"
        assert y.shape[0] < y.shape[1], f"Expected (channels, samples), got {y.shape}"
        # Ensure memory is contiguous for the C++ backend
        return np.ascontiguousarray(y)

    def _separate(self):
        """
        Pure ONNX vocal separation via Sherpa-ONNX Spleeter.

        Output structure from C++ header:
          output.stems[stem_index].samples[channel_index] → list[float]
          output.sample_rate → int (Spleeter always outputs 44100Hz)

        Stem index 0 = vocals, index 1 = accompaniment (Spleeter convention).
        We take vocals only, downmix L+R to mono, then resample to 16kHz
        for the CTC forced aligner which expects 16kHz input.
        """
        if self._vocals is not None:
            return

        import numpy as np
        import librosa

        try:
            import sherpa_onnx
        except ImportError:
            logger.error("sherpa-onnx not installed: pip install sherpa-onnx")
            sys.exit(1)

        # Load as stereo
        logger.info("Loading audio as stereo for separation…")
        y_stereo = self._load_stereo_44k()

        # Create offline source separation, official pre-trained Spleeter models:
        # https://k2-fsa.github.io/sherpa/onnx/source-separation/models.html
        # INT8 > fp16 for constrained RAM, however may cause partial attenuation 
        # rather than clean separattion.
        config = sherpa_onnx.OfflineSourceSeparationConfig(
            model=sherpa_onnx.OfflineSourceSeparationModelConfig(
                spleeter=sherpa_onnx.OfflineSourceSeparationSpleeterModelConfig(
                    vocals=str(MODELS_DIR / "spleeter" / "vocals.int8.onnx"),
                    accompaniment=str(MODELS_DIR / "spleeter" / "accompaniment.int8.onnx"),
                ),
                num_threads=1,  # leave one core free on 2-core CPU
                debug=False,
            )
        )

        if not config.validate():
            raise ValueError("Please check sherpa_onnx configs.")

        logger.info("Running Sherpa-ONNX Spleeter separation…")
        output = sherpa_onnx.OfflineSourceSeparation(config).process(44100, y_stereo)
       
        vocal_stem = output.stems[0].data      # shape: (samples, channels)
        # non_vocal_stem = output.stems[1].data

        vocal_stem = np.transpose(vocal_stem)
        # non_vocal_stem = np.transpose(non_vocal_stem)

        vocals_44k = vocal_stem.mean(axis=1)   # shape: (samples,) mono

        # Normalize before resampling. If the model attenuates certain sections, 
        # the waveform amplitude is non-uniform. The CTC aligner uses amplitude 
        # as a confidence proxy — low amplitude sections get lower confidence scores 
        # and the aligner compresses them. Normalizing to a consistent RMS level removes this bias
        rms = np.sqrt(np.mean(vocals_44k ** 2))
        if rms > 0:
            vocals_44k *= (0.1 / rms)  # normalize to RMS=0.1

        # Resample to 16kHz — CTC forced aligner expects 16kHz input.
        # Doing this here rather than at alignment time keeps the stored
        # array small (~3x smaller than 44100Hz).
        self._vocals   = librosa.resample(
            vocals_44k, 
            orig_sr=44100, 
            target_sr=16000,
            res_type='soxr_hq'  # high-quality anti-aliased resampling
            )
        self._vocal_sr = 16000

        # Release large arrays immediately
        del y_stereo, output, vocal_stem, vocals_44k
        logger.info(
            f"  Vocal stem ready: mono 16kHz, "
            f"{len(self._vocals) / self._vocal_sr:.1f}s"
        )

    def extract_lyrics_ctc(self) -> list[dict]:
        """
        ONNX forced alignment: Sherpa-ONNX Spleeter -> wav2vec2 CTC.
        Feeds the aligner 16kHz mono vocal stem, written to a temp WAV 
        (required by aligner API), then cleaned up immediately after parsing.
        """
        try:
            from ctc_forced_aligner import AlignmentSingleton
        except ImportError:
            logger.error(
                "ctc_forced_aligner not installed.\n"
                "  pip install ctc_forced_aligner"
            )
            sys.exit(1)

        if not self.lyrics_path.exists():
            logger.error(f"lyrics json not found at {self.lyrics_path}")
            sys.exit(1)

        import os
        import tempfile
        import soundfile as sf
        import onnxruntime as ort

        # Ensure vocals are ready, _separate() is idempotent
        if self._vocals is None:
            self._separate() # Should result in 16kHz mono self._vocals array

        lyrics_data = json.loads(self.lyrics_path.read_text())
        raw_lines   = lyrics_data.get('LYRICS_RAW', [])
        if not raw_lines:
            logger.warning("LYRICS_RAW is empty — nothing to align")
            return []   
        
        # Deskpai's ONNX API requires file paths, using a single
        # temp directory so all three temp files share the same
        # filesystem path prefix, avoids cross-device rename issues on cleanup
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio_path = os.path.join(tmp_dir, 'vocals.wav')
            text_path  = os.path.join(tmp_dir, 'lyrics.txt')
            srt_path   = os.path.join(tmp_dir, 'output.srt')

            sf.write(audio_path, self._vocals, self._vocal_sr, subtype='PCM_16')
            # PCM_16 instead of PCM_32 — aligner doesn't need float precision,
            # halves write size, faster I/O on slow disks

            with open(text_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(raw_lines))

            # Suppress ONNX Runtime graph optimization logs (verbose by default)
            # 0 = Verbose, 1 = Info, 2 = Warning, 3 = Error, 4 = Fatal
            ort.set_default_logger_severity(3)

            # Initialize the ONNX Singleton
            # This automatically loads the ONNX version of the model
            # the initial loading phase takes some time because the 
            # ONNX Runtime performs graph optimizations specifically 
            # for the CPU architecture before it even starts the alignment
            # default download model path: /home/user/ctc_forced_aligner/model.onnx
            aligner = AlignmentSingleton(
                    # pre-download smaller models for legacy cpu
                    model_path = str(MODELS_DIR / "ctc" / "wav_960h" / "model.onnx"),
                    vocab_path = str(MODELS_DIR / "ctc" / "wav_960h" / "vocab.json"),
                    device="cpu"
                )
            
            logger.info("Running CTC forced alignment…")

            # Generate temporary SRT to extract timestamps
            success = aligner.generate_srt(audio_path, text_path, srt_path)
            
            if not success:
                logger.error("CTC alignment returned False")
                return []

            # Parse the generated SRT back into your dictionary format
            result = self._parse_srt_to_dict(srt_path)
            # TemporaryDirectory context manager handles cleanup atomically regardless of exceptions

        logger.info(f"  Aligned {len(result)} of {len(raw_lines)} lines")
        return result

    def _parse_srt_to_dict(self, srt_path):
        import re
        results = []
        with open(srt_path, 'r', encoding='utf-8') as f:
            content = f.read().split('\n\n')
            for block in content:
                lines = block.split('\n')
                if len(lines) >= 3:
                    times = re.findall(r"(\d{2}:\d{2}:\d{2},\d{3})", lines[1])
                    if len(times) == 2:
                        results.append({
                            "start": self._srt_time_to_seconds(times[0]),
                            "end": self._srt_time_to_seconds(times[1]),
                            "text": " ".join(lines[2:])
                        })
        return results

    def _srt_time_to_seconds(self, srt_time):
        h, m, s = srt_time.split(':')
        s, ms = s.split(',')
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

    # ── Aeneas route ───────────────────────────────────────────

    def extract_lyrics_aeneas(self) -> list[dict]:
        """
        Align LYRICS_RAW lines to audio using aeneas forced alignment.

        aeneas uses DTW on MFCC features — no vocal separation needed.
        Runs on the full mix directly; the backing track is largely ignored
        because DTW matches phoneme structure, not amplitude.

        Accuracy: typically within 200-500ms of manual timestamps on clear
        vocal recordings. Dense arrangements may drift more but remain
        usable as a starting point for slider-based correction in the studio.
    
        This is the fastest, legacy friendly method having decent accuracy 
        compared to ONNX path and whisper alternative

        To install on python 3.5+:
          Aeneas requires ffmpeg and espeak on PATH:
            Linux: apt install ffmpeg espeak libespeak-dev
          Then:
            pip install numpy==1.23.5 # "bridge" version supporting aeneas's, librosa and scikit-learn requirements
            pip install aeneas --no-build-isolation # forces aeneas to use the NumPy 1.23.5
            pip install "scipy>=1.8.0,<1.11.0" "scikit-learn>=1.1.0,<1.4.0"
            pip install "librosa<=0.11.0"
        """
        try:
            from aeneas.executetask import ExecuteTask
            from aeneas.task import Task
        except ImportError:
            logger.error(
                "aeneas not installed.\n"
                "  Linux: apt install ffmpeg espeak libespeak-dev\n"
                "  pip install numpy==1.23 aeneas"
            )
            sys.exit(1)

        if not self.lyrics_path.exists():
            logger.error(f"lyrics json not found at {self.lyrics_path}")
            sys.exit(1)

        lyrics_data = json.loads(self.lyrics_path.read_text())
        raw_lines   = lyrics_data.get('LYRICS_RAW', [])
        if not raw_lines:
            logger.warning("LYRICS_RAW is empty — nothing to align")
            return []

        # aeneas expects a plain text file, one fragment per line.
        # We write to a temp file and clean up after.
        import tempfile, os
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.txt', delete=False, encoding='utf-8'
        ) as tf:
            tf.write('\n'.join(raw_lines))
            txt_path = tf.name

        out_json = Path(txt_path).with_suffix('.json')

        try:
            # task_language: BCP-47 language code. 'eng' works for English rap/pop.
            # For other languages change this — aeneas supports 30+ languages via espeak.
            # is_text_type=plain: one fragment per line, no markup.
            # os_task_file_format=json: output format we parse below.
            # is_audio_file_detect_head_max=10: auto-detects up to 10s of silence/music
            # before vocals start, preventing the alignment from drifting on intros.
            # Without it, if the track has a 4-second intro beat before the first word, 
            # aeneas will incorrectly anchor the first line at 0s. Set this value to however 
            # long your typical intro is — 30s if you have long intros. Same logic applies 
            # to detect_tail_max for outros.
            config_str = (
                "task_language=eng"
                "|is_text_type=plain"
                "|os_task_file_format=json"
                "|is_audio_file_detect_head_max=10"
                "|is_audio_file_detect_tail_max=10"
            )
            task = Task(config_string=config_str)
            task.audio_file_path_absolute    = str(self.audio_path)
            task.text_file_path_absolute     = txt_path
            task.sync_map_file_path_absolute = str(out_json)

            logger.info("Running aeneas DTW alignment…")
            ExecuteTask(task).execute()
            task.output_sync_map_file()

            # aeneas JSON output format:
            # {"fragments": [{"id": "f001", "begin": "1.234", "end": "2.345",
            #                 "lines": ["lyric text"]}, ...]}
            result    = json.loads(out_json.read_text())
            fragments = result.get('fragments', [])

            logger.info(f"  aeneas: {len(fragments)} fragments for {len(raw_lines)} lines")

            lyrics = []
            for i, frag in enumerate(fragments):
                start = round(float(frag['begin']), 3)
                # Sticky end: use next fragment's begin so each line stays visible
                # until the next one starts. Last line uses aeneas end time.
                if i + 1 < len(fragments):
                    end = round(float(fragments[i + 1]['begin']), 3)
                else:
                    end = round(float(frag['end']), 3)

                # aeneas preserves fragment order but text comes from its
                # internal TTS phoneme matching — use our original LYRICS_RAW
                # text rather than frag['lines'] to avoid encoding artifacts.
                lyrics.append({
                    "start": start,
                    "end":   end,
                    "text":  raw_lines[i] if i < len(raw_lines) else frag['lines'][0]
                })

        finally:
            # Always clean up temp files
            for p in [txt_path, str(out_json)]:
                try:
                    os.unlink(p)
                except FileNotFoundError:
                    pass

        return lyrics

    # ── Shared methods ─────────────────────────────────

    def extract_lyrics(self, default: bool) -> list[dict]:
        """Lyrics extractor selector"""
        if default:
            lyrics_list = self.extract_lyrics_aeneas()
        else:
            lyrics_list = self.extract_lyrics_ctc()

        return lyrics_list

    def extract_beats(self, bass_mode: str = 'fft') -> dict:
        """
        Continuous bass/vocal automation envelope — single streaming pass.
          - native SR (sr=None), not forced 44100; bin boundaries below are 
            computed from whatever sr actually comes back, so correctness 
            doesn't depend on hitting 44100.
          - frame-by-frame streaming FFT instead of librosa.stft's full matrix 
            which at n_fft=16384 was allocate over a GB before slicing on a
            4-minute track. Non-centered (starts at t=0), unlike librosa's
            default centered STFT — deliberate, avoids padding overhead.
          - windowed (block + interpolated) percentile normalization instead of
            one global floor/ceiling — a quiet verse no longer reads as flat
            silence next to a loud chorus. WINDOW_SEC must match the JS worker's
            equivalent constant for cross-path parity.
          - asymmetric attack/release smoothing instead of one symmetric factor —
            preserves the sharp edge of a transient in the exported data itself.
            Fixes the compounding-flatten problem: Sharp Drum Hit -> symmetric
            Python smoothing -> JSON -> symmetric JS LERP -> soft animation. With
            fast attack here AND instant-snap-on-rise at render time (see
            template.html), the transient survives both stages.
        """

        import numpy as np
        import os
        from scipy import fft # numpy has no native API controls and must manage threads via environment variables
        
        # Noise tracking parameters
        KICK_LP  = 120.0
        KICK_HP  = 35.0
        KICK_REJ = 1.0
        # The Short-Time Fourier Transform: instead of analyzing an entire 4-minute 
        # song all at once; we look at it through a magnifying glass, moving forward 
        # a few milliseconds at a time. 
        # N_FFT "Window Size": tells the code to grab a tiny chunks/buckets of n (e.g.: 1,024) 
        # audio samples to analyze at any given single moment (~46 milliseconds of sound for 1,024 FFT window at 48kHz - SR/N_FFT) 
        # higher values (e.g.: 2,048) provides better low-end frequency resolution than lower ones (e.g.: 1,024).
        # Inside that "Window Size", the FFT mathematical calculation executes acting like a prism separating a 
        # beam of light. It takes a messy chunk of audio and separates it into individual pitches/frequencies. 
        # for an FFT 1024, it splits the audio into 512 distinct "frequency buckets" (N/2) 
        # spanning from 0 Hz (lowest possible bass) to 11,025 Hz (highest possible treble). To clean up the data,
        # we group those 512 pitch buckets into fewer, n channels (beats/vocals/treble) that form the core of 
        # visualizer animations
        # Limitation: The 16384-point window is a bleed and merge source. 
        # It spans about 371ms, and every LUT value is a Hann-weighted 
        # average over that span. Kicks 250ms apart merge into one hump, 
        # and any sustained bass note or low instrument adds a slow hump of its own.
        # this is addressed via hybrid approach _kick_channel to keep the visualizer
        # truly audio generic and low-end device friendly compared to a multi-resolution engine
        N_FFT = 16384
        # HOP "step size": Instead of moving over by a whole n samples (e.g.: 1,024), 
        # the window slides forward by only n HOP samples (e.g.: 256) to analyze the next chunk. 
        # Because the HOP is smaller than N_FFT, the analysis windows heavily overlap. This ensures
        # that a fast drum hi-hat landing right on the edge of a window doesn't get missed.
        # 512 HOP at 48kHz results in 10.7ms frames where code checks for audio changes
        # every (ms) resulting from this calculation (nyquist bins), If a drum hit landed between frames
        # being checked, the timestamp could be off by up to (ms) causing noticable delays
        # 256 HOP at 48kHz cuts frame size to ~5.3ms (256/48k) while 512 HOP ~10.6ms
        # double the timing resolution. Visual sync does not require ~5.3ms. 
        # Doubling the hop length halves the RAM and CPU cost.
        HOP = 512 # balanced extraction time and accuracy, lower for more checks but slower costly extraction
        WINDOW_SEC = 8.0 # keep in sync with LUT_WINDOW_SEC in the JS worker
        CHUNK_FRAMES = 256  # bounds peak memory to ~CHUNK_FRAMES*N_FFT*8 bytes (~33MB), regardless of track length Without touching N_FFT
        N_CORES = max(1, os.cpu_count() or 1) # for scipy real fft multi-threading

        # Sampling Rate (sr): slice up every 1 second of audio into n (e.g.: 22,050)  
        # tiny measurement points. Higher numbers mean smoother audio but require 
        # more memory. "None" preserves the original sampling frequency of the input 
        # file, prevents 48kHz timestamp drift
        y, sr = self._load_full_mix(sr=None, mono=True)
        logger.info(f"Extracting audio channels from full mix. Mode: {bass_mode}")

        step_ms = HOP / sr * 1000 # timeline drift solved, step_ms uses the true sr.
        # Number of blocks/frames, the total window steps across the timeline.
        nb = len(y) // HOP if len(y) >= N_FFT else 0 #  only works with center-paded array (y_pad)
        if nb <= 0:
            logger.warning("Audio shorter than one FFT window, no envelope produced")
            return {"step_ms": round(step_ms, 4), "beats": [], "vocal_env": [], "treble_env": [], 
                    "onsets": [], "vocal_onsets": [], "bass_mode": bass_mode, "bpm": 0, "source": self.audio_path.name}
        
        # Physical upper structural limits of a Real FFT matrix transformation pass
        bin_hz = sr / N_FFT # bin boundaries from the actual sr, one-time computation, not a per-frame cost.

        # Channels to for different animation interactions with Secure boundary points 
        # to completely rule out Subscript Index Out of Range crashes with higher sr (96kHz)
        # FFT already computes the entire spectrum every frame regardless of how many 
        # narrow bands we slice out of it afterward — bass, vocal, treble aren't three 
        # separate FFT passes, they're two slices of one. So adding bands costs a couple 
        # more summation loops over data we already have, not another FFT.
        bass_start, bass_end = int(43/bin_hz), int(258/bin_hz) + 1 # only read when bass_mode=='fft', # 30Hz–110Hz
        vocal_start, vocal_end = int(300/bin_hz), int(4000/bin_hz) + 1 # 500Hz–3500Hz
        treble_start, treble_end = int(4000/bin_hz), int(11000/bin_hz) + 1

        # copies the entire array to add center padding, not just the edges for a 4-minute track that's a
        # second ~84MB copy sitting in memory alongside y itself. A version that only zero-fills the 
        # handful of frames near the very start/end would avoid that, but the code gets meaningfully 
        # messier (special-casing edge frames outside the vectorized sliding-window path) to save memory 
        # that was never actually close to being a problem at ~168MB total. worth revisiting only if there  
        # were noticable memory pressure.
        y_pad = np.pad(y, (N_FFT//2, N_FFT//2))

        win = np.hanning(N_FFT)
        bass_energy = np.empty(nb, dtype=np.float64) if bass_mode == 'fft' else None  # only allocated when needed
        vocal_energy = np.empty(nb, dtype=np.float64)
        treble_energy = np.empty(nb, dtype=np.float64)

        # chunked, batched FFT — one rfft() call per CHUNK_FRAMES instead
        # of one per frame (~81 calls instead of ~20,672 on a 4-min track), plus
        # multi-threading via scipy's workers= param. sliding_window_view builds
        # each chunk's frames as a zero-copy strided view of y; only the
        # windowed copy (~33MB @ 256 frames) is ever materialized.        
        with fft.set_workers(N_CORES):
            for chunk_start in range(0, nb, CHUNK_FRAMES):
                chunk_end = min(chunk_start + CHUNK_FRAMES, nb)
                n_in_chunk = chunk_end - chunk_start
                sample_start = chunk_start * HOP

                frames_view = np.lib.stride_tricks.sliding_window_view(
                    y_pad[sample_start : sample_start + (n_in_chunk-1) * HOP + N_FFT], N_FFT)[::HOP][:n_in_chunk]

                windowed = frames_view * win            # (n_in_chunk, N_FFT), the only real allocation
                spectrum = fft.rfft(windowed, axis=1)   # no np.abs(), see below
                
                if bass_mode == 'fft': # same spectrum, one more slice, near-free.
                    bass_slice = spectrum[:, bass_start:bass_end]
                    # skip abs(), work with power (re²+im²) directly,
                    # only on the slices we use (not all 8193 bins).
                    bass_energy[chunk_start:chunk_end] = np.sqrt(np.mean(bass_slice.real**2 + bass_slice.imag**2, axis=1))
                
                vocal_slice  = spectrum[:, vocal_start:vocal_end]
                treble_slice = spectrum[:, treble_start:treble_end]
                vocal_energy[chunk_start:chunk_end] = np.sqrt(np.mean(vocal_slice.real**2 + vocal_slice.imag**2, axis=1))
                treble_energy[chunk_start:chunk_end] = np.sqrt(np.mean(treble_slice.real**2 + treble_slice.imag**2, axis=1))

        fps = sr / HOP
        vocal_db = 20 * np.log10(vocal_energy + 1e-6)
        treble_db = 20 * np.log10(treble_energy + 1e-6)

        if bass_mode == 'kick':
            bass_env = self._kick_channel(y, sr, KICK_LP, KICK_HP, KICK_REJ, HOP) # returns array only, see below
        else:
            bass_db = 20 * np.log10(bass_energy + 1e-6)
            bass_env = self._windowed_normalize_and_smooth(bass_db, fps, WINDOW_SEC, 0.6, 0.25)

        vocal_env  = self._windowed_normalize_and_smooth(vocal_db, fps, WINDOW_SEC, 0.14, 0.10)
        treble_env = self._windowed_normalize_and_smooth(treble_db, fps, WINDOW_SEC, 0.20, 0.12)
        bass_out   = [round(float(x), 3) for x in bass_env]  # works whether bass_env is ndarray (kick) or list (fft)
        
        # BPM for reference (not used by the scheduler but useful
        # for manually checking if the extraction looks reasonable)
        bpm = self._bpm(bass_env, step_ms)

        # Onsets currently only needed in studio for lyrics snapping
        # not wired in python path, maybe later, who knows!
        onsets = self._onsets(bass_env, step_ms, 0.06)
        vocal_onsets = self._onsets(vocal_env, step_ms, 0.08, 0.15, 150)

        return {
            "step_ms": round(step_ms, 4),
            "beats": bass_out, 
            "vocal_env": vocal_env,
            "treble_env": treble_env,
            "onsets": onsets,
            "vocal_onsets": vocal_onsets,
            "bpm": bpm,
            "bass_mode": bass_mode,
            "source": self.audio_path.name
        }
    
    def _windowed_normalize_and_smooth(self, db_array, frames_per_sec, window_sec, attack, release):
        # 5th/95th percentile floor/ceiling per block, linearly interpolated
        # between block centers — smooths block-boundary seams without the
        # cost of a true sliding-window percentile.
        import numpy as np
        
        n = len(db_array)
        block = max(1, int(window_sec * frames_per_sec))
        n_blocks = int(np.ceil(n / block))
        b_floor = np.empty(n_blocks)
        b_ceil = np.empty(n_blocks)

        for b in range(n_blocks):
            seg = db_array[b * block: min((b + 1) * block, n)]
            b_floor[b] = np.percentile(seg, 5)
            b_ceil[b] = np.percentile(seg, 95)
        
        centers = (np.arange(n_blocks) + 0.5) * block
        idx = np.arange(n)
        floor_db = np.interp(idx, centers, b_floor)
        ceil_db = np.interp(idx, centers, b_ceil)
        span = np.maximum(ceil_db - floor_db, 1e-6)
        env = np.clip((db_array - floor_db) / span, 0.0, 1.0)
        
        # Envelope follower with separate attack/release time constants
        # fast attack preserves the transient edge in the exported data;
        # slower release keeps the decay clean.
        out = np.empty_like(env)
        current = env[0]
        
        for i, v in enumerate(env):
            current += (v - current) * (attack if v > current else release)
            out[i] = current

        return np.round(out, 3).tolist()

    def _onsets(self, env, step_ms, thr, floor=0.15, cd_ms=70):
        out = [] 
        prev = 0.0 
        cd = 0.0

        for i, v in enumerate(env):
            cd = max(0.0, cd - step_ms) 
            r = v - prev 
            prev = v
            if r > thr and v > floor and cd <= 0:
                out.append(round(i * step_ms / 1000, 3)) 
                cd = cd_ms

        return out  # monotonic by construction

    def _bpm(self, env, step_ms): # 60-200 range + log-gaussian prior @120, no upward octave bump
        import numpy as np
        
        fr = 1000.0 / step_ms 
        x = np.asarray(env) - np.mean(env)
        best = None 
        bs = -1e18

        for lag in range(int(fr*60/200), min(int(np.ceil(fr*60/60)), len(x)-1) + 1):
            c = float(np.dot(x[:-lag], x[lag:])) / (len(x) - lag)
            bpm = fr * 60 / lag 
            s = c * np.exp(-0.5 * (np.log2(bpm/120)) ** 2)
            if s > bs: 
                bs = s
                best = bpm
        while best > 175: best /= 2
        while best < 70:  best *= 2
        
        return round(best)

    def _kick_channel(self, y, sr, kick_lp, kick_hp, kick_rej, hop):
        """
        Hybrid time-Domain Kick Extractor for bleeds in N_FFT
        processing raw audio samples sequentially through sharp 
        Infinite Impulse Response (IIR) filters (butter, sosfilt)
        """
        import numpy as np
        # from scipy.signal import butter, sosfilt
        from scipy.signal import sosfilt

        # z = sosfilt(butter(4, kick_lp, 'lp', fs=sr, output='sos'), sosfilt(butter(2, kick_hp, 'hp', fs=sr, output='sos'), y))
        sos = np.array([self._rbj_sos('hp', kick_hp, sr), self._rbj_sos('lp', kick_lp, sr), self._rbj_sos('lp', kick_lp, sr)])
        z = sosfilt(sos, y.astype(np.float64)) # identical topology/coefficients to the JS side

        nb = len(z) // hop
        step_ms = hop / sr * 1000
        blk = (z[:nb*hop].astype(np.float64) ** 2).reshape(nb, hop).mean(axis=1) # downsamples the timeline
        env = np.sqrt((blk + np.concatenate(([blk[0]], blk[:-1]))) / 2)
        aA = 1 - np.exp(-step_ms/120) 
        aR = 1 - np.exp(-step_ms/250)
        tr = np.empty(nb)
        
        # Adaptive envelope tracking
        slow = 0.0
        for i in range(nb): # sustained bass raises `slow` too -> cancelled; a kick spikes above it
            e = env[i]
            slow += (e - slow) * (aA if e > slow else aR)
            tr[i] = max(0.0, e - kick_rej * slow) # subtract out long, sustained background hum in the slow tracker
        W = max(1, int(round(8000 / step_ms)))
        nB = -(-nb // W)
        gmax = float(tr.max()) if nb else 0.0
        # ce = np.array([max(np.percentile(tr[k * W:(k + 1) * W], 97), gmax * 0.15, 1e-9) for k in range(nB)])
        ce = np.array([max(self._p97(tr[k * W:(k + 1) * W]), gmax * 0.15, 1e-9) for k in range(nB)])
        ceil = np.interp(np.arange(nb), (np.arange(nB) + .5) * W, ce)
        
        return np.clip(tr / ceil, 0, 1)

    # same RBJ biquad as the JS worker's bq()
    def _rbj_sos(self, kind, f0, sr, Q = 0.707):
        import numpy as np
        
        w = 2 * np.pi * f0 / sr 
        co, a = np.cos(w), np.sin(w) / (2 * Q)
        b = ((1 - co) / 2, 1 - co, (1 - co) / 2) if kind == 'lp' else ((1 + co) / 2, -(1 + co), (1 + co) /2)
        a0 = 1 + a

        return [b[0] / a0, b[1] / a0, b[2] / a0, 1.0, -2 * co / a0, (1 - a) / a0]

    # JS uses sorted[floor(len*.97)], not numpy's interpolated percentile
    def _p97(self, seg):
        import numpy as np

        s = np.sort(seg)

        return s[int(len(s) * .97)]

    def run(self, do_beats: bool, do_lyrics: bool, default: bool, bass_mode: str = 'fft') -> tuple[dict, list]:
        """
        Execute requested extraction in a single audio pass. _separate()
        runs at most once even when both beats and lyrics are requested
        - do_beats: librosa onset detection on full mix → beats.json
        - do_lyrics: Sherpa-ONNX separation → ctc-forced-aligner → lyrics.json
        
        Returns (beats_data, lyrics_list); either may be empty if not requested.
        """
        beats_data, lyrics_list = {}, []

        # Separate vocals first if lyrics are needed so _load_full_mix
        # and _separate share the cold-start cost when --both is used.
        # applicable only for ONNX path, TODO: both?
        if do_lyrics and not default:
            self._separate()

        if do_beats:
            beats_data = self.extract_beats(bass_mode=bass_mode)
            self.beats_path.write_text(json.dumps(beats_data))
            logger.info(f"  Beats → {self.beats_path.name}")

        if do_lyrics:
            lyrics_list = self.extract_lyrics(default)
            # Merge into existing lyrics.json, preserving LYRICS_RAW
            existing = {}
            if self.lyrics_path.exists():
                try:
                    existing = json.loads(self.lyrics_path.read_text())
                except json.JSONDecodeError:
                    pass
            existing['LYRICS'] = lyrics_list
            self.lyrics_path.write_text(json.dumps(existing, indent=2))
            logger.info(f"  Lyrics → {self.lyrics_path.name}")

        return beats_data, lyrics_list

# ═══════════════════════════════════════════════════════════════════
# RUNTIME HELPERS
# ═══════════════════════════════════════════════════════════════════

def needs_extraction(mode: str, src_path: Path, audio_path: Optional[Path] = None) -> tuple[bool, dict]:
    """
    Returns (should_extract, existing_data).
    mode='beats'  : stale if source filename changed or file missing.
    mode='lyrics' : stale if LYRICS array is empty or file missing.
    """
    if not src_path.exists():
        return True, {}
    try:
        data = json.loads(src_path.read_text())
    except json.JSONDecodeError:
        return True, {}
    if mode == 'beats':
        stale = data.get('source') != (audio_path.name if audio_path else "")
    else:
        stale = len(data.get('LYRICS', [])) == 0
    return stale, data

# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main(cli_args=None, **kwargs):
    # global changes the logger for the entire module
    # acceptable for current scope of a single class operation, 
    # otherwise simply pass the logger into the class constructor
    # to keep global clean
    global logger
    if 'logger' in kwargs:
        # If the caller provides a logger, use it instead
        logger = kwargs['logger']

    # Use kwarg if provided, otherwise fall back to defaults
    ROOT = Path(__file__).parent
    beats_json  = kwargs.get('beats_json',  ROOT / "beats.json")
    lyrics_json = kwargs.get('lyrics_json', ROOT / "lyrics.json")

    # parse args
    parser = argparse.ArgumentParser(description="FIZX Beats/Lyrics Extractor script")
    parser.add_argument("audio",              
                        help="Path to audio file")
    parser.add_argument("--beats",    "-b",      action="store_true",
                        help="Extract beats from full mix → beats.json")
    parser.add_argument("--lyrics",   "-l",      action="store_true",
                        help="Align lyrics via Spleeter + Whisper → lyrics.json")
    parser.add_argument("--both",     "-a",      action="store_true",
                        help="--beats + --lyrics in one audio pass")
    parser.add_argument("--onnx",     "-o",      action="store_true",
                        help="ONNX forced alignment(lyrics): Spleeter and wav2vec2 CTC"
                             "default is DTW via aeneas on the full mix.")
    parser.add_argument("--force",    "-f",      action="store_true",
                        help="Re-extract even if beats/lyrics data is fresh")
    parser.add_argument("--bass-mode", "-bm", choices=["kick", "fft"], default="fft",
                        help="'kick' isolates percussive transients via time-domain " 
                             "filtering (sharper, less bleed). "
                             "'fft' slices from the same spectrum as vocal/treble " 
                             "(more bleed-prone.")

    # cli_args accept list of strings from caller
    args = parser.parse_args(cli_args)

    audio_path = Path(args.audio).resolve()
    if not audio_path.exists():
        logger.error(f"Audio file not found: {audio_path}")
        sys.exit(1)

    # Force is used as a modifier, ensuring calls like --beats --force,
    # doesn't trigger lengthy --lyrics process just because "force" was on.
    do_beats  = args.beats or args.both
    do_lyrics = args.lyrics or args.both

    # lyrics extraction method
    default = not args.onnx

    # ── Staleness checks — skip extraction if data is already fresh AND not forced ─
    if do_beats and not args.force:
        stale, _ = needs_extraction('beats', beats_json, audio_path)
        if not stale:
            logger.info("beats.json is fresh — skipping (--force to override)")
            do_beats = False

    if do_lyrics and not args.force:
        stale, _ = needs_extraction('lyrics', lyrics_json)
        if not stale:
            logger.info("lyrics.json is populated — skipping (--force to override)")
            do_lyrics = False

    # ── Run extraction ────────────────────────────────────────────
    if do_beats or do_lyrics:
        extractor = Extractor(audio_path, beats_json, lyrics_json)
        # writes files + return dict/list
        beats_data, lyrics_data = extractor.run(do_beats=do_beats, do_lyrics=do_lyrics, default=default, bass_mode=args.bass_mode)
  
    # ── Load data (fresh or pre-existing) ────────────────────────
    _, beats_data  = needs_extraction('beats',  beats_json,  audio_path)
    _, lyrics_data = needs_extraction('lyrics', lyrics_json)

    logger.info(
        f"Extraction Complete\n"
        f"{'*'*20}\n- beats array length: {len(beats_data['beats'])}\n" # poly
        f"- Estimated BPM: {beats_data['bpm']}\n"
        f"- Lyrics Count: {len(lyrics_data['LYRICS'])}\n{'*'*20}"
    )

    # Ignored from __main__, captured by callers
    return beats_data, lyrics_data

if __name__ == "__main__":
    main()
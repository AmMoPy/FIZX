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
        """Load and cache full mix"""
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

    def extract_beats(self) -> dict:
        """
        Extract onsets from the full mix.
        Returns dict matching beats.json schema: { beats, bpm, source }.

        Design notes:
          sr=None       : native SR prevents 48kHz timestamp drift
          aggregate=median: robust median smooths rap transients
          backtrack=True: timestamps land on attack transient, not peak
          delta=0.07    : threshold above local mean; tune if needed
          wait=8        : ~85ms minimum gap at 48kHz/512-hop
          MIN_GAP=0.12  : secondary 120ms de-dupe pass on timestamps
          BPM           : autocorrelation (NOT inter-onset median which
                          returns ~2x BPM on rap due to hi-hat density)
        """
        import librosa
        import numpy as np

        # sr=None: native SR prevents 48kHz timestamp drift
        y, sr = self._load_full_mix(sr=None, mono=True)
        logger.info("Extracting beats from full mix…")
        # Use a combined spectral flux onset envelope.
        # aggregate=np.median smooths out noise better than np.mean for rap
        # which has dense percussive transients that can cause false positives.
        onset_env    = librosa.onset.onset_strength(y=y, sr=sr, aggregate=np.median)
        # onset_detect with backtrack=True snaps each detected onset back to
        # the nearest preceding local minimum in the envelope — this aligns
        # the timestamp to the actual attack transient rather than the peak.
        onset_frames = librosa.onset.onset_detect(
            onset_envelope=onset_env, 
            sr=sr,
            backtrack=True, 
            # delta controls sensitivity. 0.07 is a reasonable starting point
            # for rap mixes; increase if you get too many false positives,
            # decrease if strong hits are being missed.
            delta=0.07, 
            # wait: minimum gap between onsets in frames (~512 samples each).
            # 8 frames at 48kHz ≈ 85ms — prevents double-triggers on a single hit.
            wait=8,
        )
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)

        # Secondary 120ms de-dupe — catches edge cases the frame-based
        # wait parameter misses after non-maximum suppression.
        MIN_GAP, filtered = 0.12, []
        for t in onset_times:
            if not filtered or (t - filtered[-1]) >= MIN_GAP:
                filtered.append(round(float(t), 3))

        # Also pull BPM for reference (not used by the scheduler but useful
        # for manually checking if the extraction looks reasonable).
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo))

        return {"beats": filtered, "bpm": bpm, "source": self.audio_path.name}

    def run(self, do_beats: bool, do_lyrics: bool, default: bool) -> tuple[dict, list]:
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
            beats_data = self.extract_beats()
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
        beats_data, lyrics_data = extractor.run(do_beats=do_beats, do_lyrics=do_lyrics, default=default)
  
    # ── Load data (fresh or pre-existing) ────────────────────────
    _, beats_data  = needs_extraction('beats',  beats_json,  audio_path)
    _, lyrics_data = needs_extraction('lyrics', lyrics_json)

    logger.info(
        f"Extraction Complete\n"
        f"{'*'*20}\n- Onsets (filtered): {len(beats_data['beats'])}\n"
        f"- Estimated BPM: {beats_data['bpm']}\n"
        f"- Lyrics Count: {len(lyrics_data['LYRICS'])}\n{'*'*20}"
    )

    # Ignored from __main__, captured by callers
    return beats_data, lyrics_data

if __name__ == "__main__":
    main()
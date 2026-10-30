"""Optional local voice: faster-whisper (speech-to-text) + Piper (text-to-speech).

Models are loaded ONLY from data/voice/ (prepared once with scripts/prepare_voice.py).
If packages or models are missing, voice is reported as unavailable and typing keeps working.
"""
import io
import threading
import time
import wave
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parent.parent / "data" / "voice"
WHISPER_DIR = VOICE_DIR / "whisper-base.en"
PIPER_MODEL = VOICE_DIR / "en_US-lessac-medium.onnx"

_lock = threading.Lock()
_stt = None
_tts = None


def status() -> dict:
    stt_ok = tts_ok = False
    try:
        import faster_whisper  # noqa: F401
        stt_ok = (WHISPER_DIR / "model.bin").exists()
    except Exception:
        pass
    try:
        import piper  # noqa: F401
        tts_ok = PIPER_MODEL.exists() and PIPER_MODEL.with_suffix(".onnx.json").exists()
    except Exception:
        pass
    return {"stt": stt_ok, "tts": tts_ok, "stt_engine": "faster-whisper base.en" if stt_ok else None,
            "tts_engine": "Piper en_US-lessac-medium" if tts_ok else None}


def _get_stt():
    global _stt
    with _lock:
        if _stt is None:
            from faster_whisper import WhisperModel
            _stt = WhisperModel(str(WHISPER_DIR), device="cpu", compute_type="int8", local_files_only=True)
        return _stt


def _get_tts():
    global _tts
    with _lock:
        if _tts is None:
            from piper import PiperVoice
            _tts = PiperVoice.load(str(PIPER_MODEL))
        return _tts


def transcribe(audio_bytes: bytes) -> dict:
    t0 = time.perf_counter()
    segments, _info = _get_stt().transcribe(io.BytesIO(audio_bytes), language="en", beam_size=1, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "ms": round((time.perf_counter() - t0) * 1000), "engine": "faster-whisper"}


def synthesize(text: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        _get_tts().synthesize_wav(text, wav)
    return buf.getvalue()

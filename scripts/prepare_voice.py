"""
One-time (online) preparation of the optional local voice models into data/voice/.
  python scripts/prepare_voice.py
Downloads: faster-whisper base.en (~145 MB) and Piper en_US-lessac-medium (~63 MB).
After this, speech-to-text and text-to-speech run fully offline.
"""
import urllib.request
from pathlib import Path

VOICE = Path(__file__).resolve().parent.parent / "data" / "voice"
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/"


def main():
    VOICE.mkdir(parents=True, exist_ok=True)
    from faster_whisper import download_model
    print("Downloading faster-whisper base.en ...")
    download_model("base.en", output_dir=str(VOICE / "whisper-base.en"))
    for name in ("en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx.json"):
        target = VOICE / name
        if not target.exists():
            print(f"Downloading {name} ...")
            urllib.request.urlretrieve(PIPER_BASE + name, target)
    print("Voice models ready in", VOICE)


if __name__ == "__main__":
    main()

"""Transcribe a bounded PCM WAV with an explicitly installed local Chinese model."""
import array
import io
import json
import re
import sys
import wave

from vosk import KaldiRecognizer, Model, SetLogLevel


def main():
    SetLogLevel(-1)
    audio = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(audio) > 8 * 1024 * 1024:
        return 1
    with wave.open(io.BytesIO(audio), "rb") as stream:
        rate, channels = stream.getframerate(), stream.getnchannels()
        if stream.getsampwidth() != 2 or channels not in (1, 2) or not 8000 <= rate <= 48000:
            return 1
        samples = array.array("h", stream.readframes(stream.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    if channels == 2:
        samples = array.array("h", ((a + b) // 2 for a, b in zip(samples[::2], samples[1::2])))
    if rate < 16000:
        # Kaldi handles downsampling; small-cn expects at least 16 kHz.
        out = array.array("h")
        for i in range(len(samples) * 16000 // rate):
            pos, frac = divmod(i * rate, 16000)
            a = samples[pos]
            b = samples[min(pos + 1, len(samples) - 1)]
            out.append(a + (b - a) * frac // 16000)
        rate, samples = 16000, out
    if sys.byteorder != "little":
        samples.byteswap()
    pcm = samples.tobytes()
    recognizer = KaldiRecognizer(Model(sys.argv[1]), rate)
    recognizer.SetWords(True)
    parts = []
    for offset in range(0, len(pcm), 8000):
        if recognizer.AcceptWaveform(pcm[offset:offset + 8000]):
            parts.append(json.loads(recognizer.Result()))
    parts.append(json.loads(recognizer.FinalResult()))
    text = " ".join(part.get("text", "") for part in parts).strip()
    if not text:
        return 4
    words = [word for part in parts for word in part.get("result", [])]
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    result = {"text": text, "confidence": min((w["conf"] for w in words), default=0)}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

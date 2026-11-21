# faster-whisper se word-level transcript (CPU, int8). Use: whisper.py audio.wav model lang out.json duration
# Audio hum ffmpeg se khud decode karke numpy array dete hain, taaki PyAV (av.open) ke version ki dikkat na aaye.
import sys, json, subprocess
import numpy as np

audio_path, model_name, lang, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
total = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0

def versions():
    v = []
    for m in ("faster_whisper", "av", "ctranslate2"):
        try:
            mod = __import__(m)
            v.append("%s=%s" % (m, getattr(mod, "__version__", "?")))
        except Exception as e:
            v.append("%s=ERR(%s)" % (m, str(e)[:40]))
    print("VER " + " ".join(v), flush=True)

versions()
from faster_whisper import WhisperModel

p = subprocess.run(["ffmpeg", "-v", "error", "-i", audio_path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                   capture_output=True, check=True)
audio = np.frombuffer(p.stdout, dtype=np.float32)
if audio.size < 16000:
    raise SystemExit("audio bahut chhota ya khali hai")

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segs, info = model.transcribe(audio, word_timestamps=True, vad_filter=True, beam_size=1,
                              language=None if lang in ("", "auto") else lang)
words, last = [], -1
for s in segs:
    for w in (s.words or []):
        t = w.word.strip()
        if t:
            words.append({"w": t, "s": round(w.start, 2), "e": round(w.end, 2)})
    if total:
        pct = int(min(99, s.end / total * 100))
        if pct != last:
            print("PCT", pct, flush=True); last = pct
with open(out, "w", encoding="utf-8") as f:
    json.dump({"lang": info.language, "words": words}, f, ensure_ascii=False)

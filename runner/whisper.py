# faster-whisper se word-level transcript (CPU, int8). Use: whisper.py audio.wav model lang out.json duration
import sys, json
from faster_whisper import WhisperModel

audio, model_name, lang, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
total = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
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

# Compasso 1 automático: acha onde o Guitar Pro começa no MP3 casando os ataques do baixo separado
# (ou da bateria, se não tiver baixo) com as notas do mesmo instrumento no GP.
# Uso (o app chama sozinho): python scripts/align.py <pasta das faixas> <onsets.json>
# Responde uma linha JSON: {"ok": bool, "offset_ms": int|null, "detail": str}
import json
import sys

import numpy as np
import soundfile as sf

HOP = 0.01          # resolução: 10 ms
MAX_LAG = 3.0       # o MP3 pode começar até 3 s depois do GP
TOLERANCE = 0.06    # os 3 trechos têm que concordar em ±60 ms


def onset_curve(file: str) -> np.ndarray:
    """Onde a energia sobe de repente (ataque de nota), a cada 10 ms."""
    x, sr = sf.read(file, dtype="float32", always_2d=True)
    m = x.mean(1)
    h = int(sr * HOP)
    n = len(m) // h
    e = np.sqrt((m[: n * h].reshape(n, h) ** 2).mean(1))
    return np.maximum(0, np.diff(np.log(e + 1e-4), prepend=0))


def best_lag(flux: np.ndarray, times: list[float], start: float, end: float) -> float | None:
    g = np.zeros(len(flux))
    for t in times:
        i = int(t / HOP)
        if 0 <= i < len(g):
            g[i] = 1
    g = np.convolve(g, np.ones(3), "same")
    lo, hi = int(start / HOP), int(end / HOP)
    span = int(MAX_LAG / HOP)
    if hi + span >= len(flux) or g[lo:hi].sum() < 8:
        return None
    scores = [float(np.dot(g[lo:hi], flux[lo + lag : hi + lag])) for lag in range(span)]
    return int(np.argmax(scores)) * HOP


def main() -> None:
    stems, onsets_file = sys.argv[1], sys.argv[2]
    onsets = json.load(open(onsets_file, encoding="utf-8"))
    for name in ("bass", "drums"):
        times = onsets.get(name) or []
        if len(times) < 24:
            continue
        flux = onset_curve(f"{stems}/{name}.flac")
        first, last = times[0], min(times[-1], len(flux) * HOP - MAX_LAG - 1)
        if last - first < 30:
            continue
        third = (last - first) / 3
        lags = [best_lag(flux, times, first + k * third, first + (k + 1) * third) for k in range(3)]
        lags = [l for l in lags if l is not None]
        label = "baixo" if name == "bass" else "bateria"
        shown = " / ".join(f"{l:.2f}".replace(".", ",") for l in lags)
        if len(lags) == 3 and max(lags) - min(lags) <= TOLERANCE:
            off = float(np.median(lags))
            print(json.dumps({"ok": True, "offset_ms": round(off * 1000), "detail": f"{label} do MP3 vs Guitar Pro ({shown} s no começo, meio e fim)"}))
            return
        if name == "bass" and lags:
            # Baixo não concordou: tenta a bateria antes de desistir.
            continue
    print(json.dumps({"ok": False, "offset_ms": None, "detail": "não deu pra casar o MP3 com o Guitar Pro com segurança; ajusta na mão"}))


if __name__ == "__main__":
    main()

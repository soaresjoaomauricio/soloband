# Separação ao vivo (S15): o som do YouTube chega em pedaços pelo stdin e as 6 faixas saem pelo stdout, na hora.
# Nada vai pro disco: o áudio fica só na memória, e só os últimos segundos (o contexto).
#
# Entrada, por pedaço: int32 início (índice da amostra), int32 n, float32[2n] estéreo intercalado a 44,1 kHz.
#   n = -1 é "recomeça daqui" (o João pulou ou pausou): esquece o contexto e espera o áudio a partir de `início`.
# Saída, por pedaço: int32 início, int32 n, int32 ms de GPU, float32[6*2*n] (faixa por faixa, canal por canal).
#
# Passo de 1 s, 6 s de contexto antes e 1,5 s depois, emenda de 50 ms: medido na Snow, fica a 18–23 dB da
# separação da música inteira e leva ~0,3 s por passo na RTX 2070 SUPER (o som sai ~3,5 s depois do vídeo).
import struct
import sys
import time

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.hf import get_hf_model
from huggingface_hub import constants as hf_constants


def say(msg: str) -> None:
    print(f"[soloband] {msg}", file=sys.stderr, flush=True)


if not torch.cuda.is_available():
    say("Erro: separar ao vivo precisa de placa de vídeo NVIDIA (no processador não acompanha a música).")
    sys.exit(3)

hf_constants.HF_HUB_OFFLINE = True
try:
    model = get_hf_model("htdemucs_6s").eval().to("cuda")
except Exception as exc:
    say(f"Erro: não achei o modelo de separação no cache ({exc!r}). Instala o separador de novo (Configurações).")
    sys.exit(2)
SR = model.samplerate
H, L, R, F = int(1.0 * SR), int(6 * SR), int(1.5 * SR), int(0.05 * SR)
with torch.no_grad():  # aquece a GPU: o 1º passo frio levava 0,6 s
    apply_model(model, torch.zeros(1, 2, L + H + R + F).cuda(), device="cuda", shifts=0, split=True, overlap=0.25, progress=False)
say(f"pronto {torch.cuda.get_device_name(0)} {','.join(model.sources)}")

inp, out = sys.stdin.buffer, sys.stdout.buffer
ramp = np.linspace(0, 1, F, dtype=np.float32)


def read_exact(n: int) -> bytes:
    b = bytearray()
    while len(b) < n:
        c = inp.read(n - len(b))
        if not c:
            sys.exit(0)
        b += c
    return bytes(b)


buf = np.zeros((2, 0), np.float32)  # áudio ainda útil como contexto
base = 0  # índice da 1ª amostra de buf
done = 0  # até onde já saiu separado
first = 0  # onde começou o trecho atual (sem contexto antes disso)
tail = None  # últimos F de cada faixa, pra emendar

while True:
    start, n = struct.unpack("<ii", read_exact(8))
    if n < 0:  # recomeça: o que veio antes era de outro ponto da música
        buf, base, done, first, tail = np.zeros((2, 0), np.float32), start, start, start, None
        continue
    x = np.frombuffer(read_exact(8 * n), np.float32).reshape(-1, 2).T
    if start != base + buf.shape[1]:  # buraco ou repetição: trata como recomeço
        buf, base, done, first, tail = np.zeros((2, 0), np.float32), start, start, start, None
    buf = np.concatenate([buf, x], 1)
    while base + buf.shape[1] >= done + H + R + F:
        a = max(base, first, done - L)
        chunk = torch.from_numpy(buf[:, a - base : done + H + R + F - base].copy())
        mean, std = chunk.mean(), chunk.std() + 1e-5
        t0 = time.perf_counter()
        with torch.no_grad():
            y = apply_model(model, ((chunk - mean) / std)[None].cuda(), device="cuda", shifts=0, split=True, overlap=0.25, progress=False)[0]
        y = (y * std + mean).cpu().numpy()
        ms = int((time.perf_counter() - t0) * 1000)
        seg = y[:, :, done - a : done - a + H + F].copy()
        if tail is not None:
            seg[:, :, :F] = tail * (1 - ramp) + seg[:, :, :F] * ramp
        tail = seg[:, :, H:].copy()
        out.write(struct.pack("<iii", done, H, ms) + np.ascontiguousarray(seg[:, :, :H], np.float32).tobytes())
        out.flush()
        done += H
        keep = done - L - base
        if keep > 0:
            buf, base = buf[:, keep:], base + keep

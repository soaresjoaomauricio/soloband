# Separa uma música em faixas com o Demucs (htdemucs_6s): voz, bateria, baixo, guitarra, piano e outros.
# Uso (o servidor chama sozinho): python scripts/separate.py <áudio de entrada> <pasta de saída>
# Lê e grava com o soundfile (mp3/wav/flac/ogg), sem precisar de ffmpeg. Usa a GPU se tiver.
import json
import os
import sys

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.audio import convert_audio
from demucs.pretrained import get_model
from huggingface_hub import constants as hf_constants


def step(msg: str) -> None:
    # Etapa pra tela (o servidor reconhece pelo prefixo); o resto do stderr vai pro log como veio.
    print(f"[soloband] {msg}", file=sys.stderr, flush=True)


def load_model():
    # 1º do cache, sem rede (offline não espera timeout); se não tem, baixa mostrando a barra.
    from demucs.hf import get_hf_model

    hf_constants.HF_HUB_OFFLINE = True
    try:
        return get_hf_model("htdemucs_6s")
    except Exception:
        hf_constants.HF_HUB_OFFLINE = False
    step("Baixando o modelo de separação (só na 1ª vez, uns 55 MB)…")
    os.environ["TQDM_POSITION"] = "-1"  # o huggingface_hub esconde a barra quando não é terminal
    try:
        return get_model("htdemucs_6s")
    except Exception as exc:
        print(repr(exc), file=sys.stderr, flush=True)
        step("Erro: não consegui baixar o modelo de separação. Na primeira vez precisa de internet; confere a conexão e tenta de novo.")
        sys.exit(2)


def estimate_bpm(drums: torch.Tensor, sr: int) -> float | None:
    # Ataques da bateria (fluxo espectral) -> autocorrelação -> período mais forte entre 50 e 220 BPM, com leve
    # preferência por ~120 pra não cair no dobro/metade. Testado: Ela Vai Voltar 105,1 (GP: 105); Snow 105,6 (105).
    mono = drums.float().mean(0).cpu()
    hop = 512
    spec = torch.stft(mono, n_fft=2048, hop_length=hop, window=torch.hann_window(2048), return_complex=True).abs()
    spec = torch.log1p(100 * spec)
    flux = torch.clamp(spec[:, 1:] - spec[:, :-1], min=0).sum(0).numpy()
    if flux.size < 100 or not flux.any():
        return None
    flux = flux - flux.mean()
    fps = sr / hop
    n = 1 << int(np.ceil(np.log2(2 * flux.size)))
    f = np.fft.rfft(flux, n)
    ac = np.fft.irfft(f * np.conj(f))[: flux.size]
    lags = np.arange(int(fps * 60 / 220), int(fps * 60 / 50) + 1)
    bpms = 60 * fps / lags
    score = ac[lags] * np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
    i = int(np.argmax(score))
    if 0 < i < len(lags) - 1:  # refina entre dois quadros
        a, b, c = ac[lags[i] - 1], ac[lags[i]], ac[lags[i] + 1]
        den = a - 2 * b + c
        return 60 * fps / (lags[i] + (0.5 * (a - c) / den if den else 0))
    return float(bpms[i])


def main() -> None:
    src, out_dir = sys.argv[1], sys.argv[2]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    step("Carregando o modelo…")
    model = load_model()
    model.eval()

    step("Lendo o áudio…")
    wav, sr = sf.read(src, dtype="float32", always_2d=True)  # (amostras, canais)
    x = convert_audio(torch.from_numpy(wav.T.copy()), sr, model.samplerate, model.audio_channels)
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    where = f"na placa {torch.cuda.get_device_name(0)}" if device == "cuda" else "no processador (demora mais)"
    step(f"Separando {where}…")
    with torch.no_grad():
        # progress=True escreve a barra do tqdm no stderr; o servidor lê o "%" de lá.
        stems = apply_model(model, ((x - mean) / std)[None], device=device, shifts=1, split=True, overlap=0.25, progress=True)[0]
    stems = stems * std + mean

    for name, stem in zip(model.sources, stems):
        step(f"Salvando a faixa {name}…")
        sf.write(f"{out_dir}/{name}.flac", stem.cpu().numpy().T, model.samplerate, subtype="PCM_16")

    bpm = None
    if "drums" in model.sources:
        step("Calculando o BPM pela bateria…")
        try:
            est = estimate_bpm(stems[model.sources.index("drums")], model.samplerate)
            bpm = round(est) if est else None
        except Exception as exc:  # BPM é só um palpite: não pode derrubar a separação
            print(f"BPM: {exc!r}", file=sys.stderr, flush=True)
        if bpm:
            step(f"BPM estimado: {bpm}")
    print(json.dumps({"stems": list(model.sources), "samplerate": model.samplerate, "device": device, "bpm": bpm}))


if __name__ == "__main__":
    main()

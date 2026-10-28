# Separa uma música em faixas com o Demucs (htdemucs_6s): voz, bateria, baixo, guitarra, piano e outros.
# Uso (o servidor chama sozinho): python scripts/separate.py <áudio de entrada> <pasta de saída>
# Lê e grava com o soundfile (mp3/wav/flac/ogg), sem precisar de ffmpeg. Usa a GPU se tiver.
import json
import os
import sys

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
    print(json.dumps({"stems": list(model.sources), "samplerate": model.samplerate, "device": device}))


if __name__ == "__main__":
    main()

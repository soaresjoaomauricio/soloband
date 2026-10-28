# Separa uma música em faixas com o Demucs (htdemucs_6s): voz, bateria, baixo, guitarra, piano e outros.
# Uso (o servidor chama sozinho): python scripts/separate.py <áudio de entrada> <pasta de saída>
# Lê e grava com o soundfile (mp3/wav/flac/ogg), sem precisar de ffmpeg. Usa a GPU se tiver.
import json
import sys

import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.audio import convert_audio
from demucs.pretrained import get_model


def main() -> None:
    src, out_dir = sys.argv[1], sys.argv[2]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = get_model("htdemucs_6s")
    model.eval()

    wav, sr = sf.read(src, dtype="float32", always_2d=True)  # (amostras, canais)
    x = convert_audio(torch.from_numpy(wav.T.copy()), sr, model.samplerate, model.audio_channels)
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        # progress=True escreve a barra do tqdm no stderr; o servidor lê o "%" de lá.
        stems = apply_model(model, ((x - mean) / std)[None], device=device, shifts=1, split=True, overlap=0.25, progress=True)[0]
    stems = stems * std + mean

    for name, stem in zip(model.sources, stems):
        sf.write(f"{out_dir}/{name}.flac", stem.cpu().numpy().T, model.samplerate, subtype="PCM_16")
    print(json.dumps({"stems": list(model.sources), "samplerate": model.samplerate, "device": device}))


if __name__ == "__main__":
    main()

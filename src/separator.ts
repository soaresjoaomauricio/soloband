import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Paths } from './paths';

/**
 * Separador opcional (S07): o app baixa o `uv` (versão fixa, release oficial no GitHub) e com ele monta,
 * dentro de %APPDATA%\SoloBand\separador, um Python 3.12 com PyTorch (CUDA se tem placa NVIDIA, senão CPU)
 * + Demucs + soundfile. Tudo numa pasta só: apagar a pasta desinstala.
 */
const UV_VERSION = '0.8.0';
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;

export interface SeparatorStatus {
  installed: boolean;
  installing: boolean;
  step: string | null;
  error: string | null;
  gpu: boolean | null;
  log: string;
}

const state: SeparatorStatus = { installed: false, installing: false, step: null, error: null, gpu: null, log: '' };

const venvPy = (p: Paths) => path.join(p.separator, 'venv', 'Scripts', 'python.exe');
const okFile = (p: Paths) => path.join(p.separator, 'instalado.json');

/** Python que roda o separador: SOLOBAND_PYTHON (dev/testes) ou o instalado pelo app. */
export function separatorPython(p: Paths): string | null {
  if (process.env.SOLOBAND_PYTHON) return fs.existsSync(process.env.SOLOBAND_PYTHON) ? process.env.SOLOBAND_PYTHON : null;
  return fs.existsSync(okFile(p)) && fs.existsSync(venvPy(p)) ? venvPy(p) : null;
}

let gpuCheck: Promise<boolean> | null = null;

export function separatorStatus(p: Paths): SeparatorStatus {
  // Descobre a placa uma vez (em segundo plano) pra tela dizer se vai usar a NVIDIA ou o processador.
  gpuCheck ??= hasNvidia().then((g) => (state.gpu ??= g));
  let gpu: boolean | null = state.gpu;
  try {
    gpu = (JSON.parse(fs.readFileSync(okFile(p), 'utf8')) as { gpu: boolean }).gpu;
  } catch {}
  return { ...state, installed: separatorPython(p) !== null, gpu };
}

function hasNvidia(): Promise<boolean> {
  return new Promise((ok) => execFile('nvidia-smi', ['-L'], { windowsHide: true }, (err, out) => ok(!err && /GPU/i.test(String(out)))));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...env } });
    const add = (d: Buffer) => (state.log = (state.log + d.toString()).slice(-4000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${path.basename(cmd)} saiu com código ${code}`))));
  });
}

/** Instala em segundo plano; a tela pergunta o status. */
export function installSeparator(p: Paths): SeparatorStatus {
  if (state.installing) return separatorStatus(p);
  Object.assign(state, { installing: true, error: null, log: '', step: 'Começando…' });
  void (async () => {
    try {
      fs.mkdirSync(p.separator, { recursive: true });
      const uvDir = path.join(p.separator, 'uv');
      const uv = path.join(uvDir, 'uv.exe');
      if (!fs.existsSync(uv)) {
        state.step = 'Baixando o uv (instalador do Python)…';
        const zip = path.join(p.separator, 'uv.zip');
        const res = await fetch(UV_URL);
        if (!res.ok || !res.body) throw new Error(`não consegui baixar o uv (${res.status})`);
        await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(zip));
        fs.mkdirSync(uvDir, { recursive: true });
        await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${uvDir}'`], {});
        fs.rmSync(zip, { force: true });
      }
      // Python, cache e pacotes ficam todos dentro de separador\ (nada espalhado pelo PC).
      const env = { UV_CACHE_DIR: path.join(p.separator, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(p.separator, 'python'), UV_PYTHON_PREFERENCE: 'only-managed' };
      const venv = path.join(p.separator, 'venv');
      state.step = 'Instalando o Python 3.12…';
      await run(uv, ['venv', '--python', '3.12', venv], env);
      // SOLOBAND_FORCE_CPU=1: instala a versão só-processador (menor; usada pra testar a instalação).
      state.gpu = process.env.SOLOBAND_FORCE_CPU === '1' ? false : await hasNvidia();
      const index = state.gpu ? 'https://download.pytorch.org/whl/cu126' : 'https://download.pytorch.org/whl/cpu';
      state.step = state.gpu ? 'Baixando o PyTorch com suporte à placa NVIDIA (uns 3 GB, demora)…' : 'Baixando o PyTorch (só processador, uns 800 MB)…';
      await run(uv, ['pip', 'install', '--python', venvPy(p), 'torch', 'torchaudio', '--index-url', index], env);
      state.step = 'Instalando o Demucs…';
      await run(uv, ['pip', 'install', '--python', venvPy(p), 'demucs', 'soundfile', 'numpy'], env);
      state.step = 'Limpando o que sobrou do download…';
      await run(uv, ['cache', 'clean'], env);
      state.step = 'Testando…';
      await run(venvPy(p), ['-c', 'import torch, demucs, soundfile; print(torch.cuda.is_available())'], {});
      fs.writeFileSync(okFile(p), JSON.stringify({ gpu: state.gpu, uv: UV_VERSION, at: new Date().toISOString() }));
      state.step = 'Pronto!';
    } catch (e) {
      state.error = `A instalação parou: ${(e as Error).message}. Dá pra tentar de novo.`;
      state.step = null;
    } finally {
      state.installing = false;
    }
  })();
  return separatorStatus(p);
}

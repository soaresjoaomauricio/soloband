import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Paths } from './paths';
import { separatorPython } from './separator';
import { AppError, getSong, loadScore, now, retire, saveSong, songDir, stamp, tabPath, tabTracks, type Song, type TakeKind } from './songs';

/** O Estúdio (vindo do Vida de Jão, D53): áudio da música, faixas separadas pelo Demucs e gravações. */
export const STEMS = ['vocals', 'guitar', 'bass', 'drums', 'piano', 'other'] as const;
const AUDIO_EXT = ['.mp3', '.wav', '.flac', '.ogg'];

/** Recebe o áudio da música (a cópia de quem usa). O anterior e as faixas antigas vão pra "antigas". */
export async function saveOriginal(p: Paths, id: string, filename: string, body: Readable): Promise<Song> {
  const song = getSong(p, id);
  const ext = path.extname(filename).toLowerCase();
  if (!AUDIO_EXT.includes(ext)) throw new AppError(400, `Formato ${ext || '(sem extensão)'} não dá. Use mp3, wav, flac ou ogg.`);
  if (song.separation.status === 'running') throw new AppError(409, 'Ainda tô separando as faixas dessa música. Espera terminar.');
  const dir = songDir(p, id);
  if (song.original) retire(path.join(dir, song.original));
  for (const s of song.stems) retire(path.join(dir, 'faixas', `${s}.flac`));
  const tmp = path.join(dir, `.upload${ext}`);
  await pipeline(body, fs.createWriteStream(tmp));
  const name = `original${ext}`;
  fs.renameSync(tmp, path.join(dir, name));
  return saveSong(p, { ...getSong(p, id), original: name, stems: [], separation: { status: 'none', progress: 0, error: null, device: null, updated_at: now() } });
}

const running = new Set<string>();

/** Etapa e últimas linhas do separador, por música (só em memória: é pra tela acompanhar). */
export interface SeparationLog {
  step: string | null;
  lines: string[];
}
const logs = new Map<string, SeparationLog>();
const LOG_LINES = 40;

export function separationLog(id: string): SeparationLog | null {
  return logs.get(id) ?? null;
}

/**
 * Lê o stderr do separate.py linha a linha (o tqdm reescreve a linha com \r). Linhas "[soloband] ..." são a
 * etapa; a barra do tqdm vira o progresso, contado só depois de "Separando" pra a barra de download do modelo
 * não parecer a separação. No log, a barra fica numa linha só, atualizada.
 */
export function separationReader(log: SeparationLog, onProgress: (pct: number) => void) {
  let partial = '';
  let separating = false;
  return (chunk: string) => {
    const parts = (partial + chunk).split(/\r\n|\r|\n/);
    partial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const step = line.match(/^\[soloband\] (.*)$/)?.[1];
      const pct = line.match(/(\d{1,3})%\|/)?.[1];
      if (step) {
        log.step = step;
        separating = step.startsWith('Separando');
        log.lines.push(step);
      } else if (pct) {
        const bar = `${separating ? 'Separando' : 'Baixando'}: ${pct}%`;
        if (/^(Separando|Baixando): \d+%$/.test(log.lines.at(-1) ?? '')) log.lines[log.lines.length - 1] = bar;
        else log.lines.push(bar);
        if (separating) onProgress(Number(pct));
      } else {
        log.lines.push(line);
      }
    }
    log.lines.splice(0, Math.max(0, log.lines.length - LOG_LINES));
  };
}

function runPython(p: Paths, script: string, args: string[]): ReturnType<typeof spawn> | null {
  const py = separatorPython(p);
  if (!py) return null;
  return spawn(py, [path.join(p.scriptsDir, script), ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
}

/** Roda o Demucs em segundo plano; o progresso vai pro musica.json e a tela fica perguntando. */
export function startSeparation(p: Paths, id: string, log: (msg: string) => void = () => {}): Song {
  const song = getSong(p, id);
  if (!song.original) throw new AppError(400, 'Põe o áudio da música primeiro.');
  if (running.has(id)) return song;
  const out = path.join(songDir(p, id), 'faixas');
  fs.mkdirSync(out, { recursive: true });
  const save = (sep: Partial<Song['separation']>, extra: Partial<Song> = {}): Song | null => {
    // Roda nos eventos do processo filho: se a música sumiu, não pode virar exceção solta no Electron.
    try {
      const cur = getSong(p, id);
      return saveSong(p, { ...cur, ...extra, separation: { ...cur.separation, ...sep, updated_at: now() } });
    } catch {
      return null;
    }
  };
  const child = runPython(p, 'separate.py', [path.join(songDir(p, id), song.original), out]);
  if (!child) return save({ status: 'error', error: 'O separador não tá instalado. Instala em Configurações, ou usa o som do Guitar Pro.' })!;
  running.add(id);
  const sepLog: SeparationLog = { step: 'Abrindo o separador…', lines: ['Abrindo o separador…'] };
  logs.set(id, sepLog);
  let stdout = '';
  let lastErr = '';
  let lastPct = -1;
  const read = separationReader(sepLog, (pct) => {
    if (pct === lastPct) return;
    lastPct = pct;
    save({ progress: pct });
  });
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d: Buffer) => {
    const text = d.toString();
    lastErr = (lastErr + text).slice(-2000);
    read(text);
  });
  child.on('close', (code) => {
    running.delete(id);
    read('\n');
    sepLog.step = code === 0 ? 'Pronto!' : null;
    sepLog.lines.push(code === 0 ? 'Pronto!' : `O separador parou (código ${code}).`);
    if (code === 0) {
      let info: { device?: string; bpm?: number | null } = {};
      try {
        info = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
      } catch {}
      const stems = STEMS.filter((s) => fs.existsSync(path.join(out, `${s}.flac`)));
      // BPM estimado pela bateria só entra se a música ainda não tem (o digitado ou o do Guitar Pro manda).
      const guess = typeof info.bpm === 'number' && info.bpm >= 20 && info.bpm <= 300 ? info.bpm : null;
      const extra: Partial<Song> = { stems };
      try {
        if (guess && getSong(p, id).bpm == null) extra.bpm = guess;
      } catch {}
      const done = save({ status: 'done', progress: 100, error: null, device: info.device ?? null }, extra);
      log(`faixas separadas: ${id} (${info.device})`);
      // Já tenta achar sozinho onde a tab começa no MP3.
      if (done?.tab_file) void autoAlign(p, id).catch(() => {});
    } else {
      // O separate.py avisa "Erro: ..." em português quando sabe o motivo; senão vai a última linha técnica.
      const known = sepLog.lines.findLast((l) => l.startsWith('Erro: '))?.slice(6);
      const reason = known ?? lastErr.trim().split(/\r?\n/).filter(Boolean).pop() ?? `código ${code}`;
      save({ status: 'error', error: known ? `A separação falhou: ${known}` : `A separação falhou: ${reason}` });
      log(`separação falhou (${id}): ${lastErr}`);
    }
  });
  child.on('error', (e) => {
    running.delete(id);
    sepLog.step = null;
    sepLog.lines.push(`Não consegui abrir o separador: ${e.message}`);
    save({ status: 'error', error: `Não consegui rodar o separador: ${e.message}` });
  });
  return save({ status: 'running', progress: 0, error: null })!;
}

export function isSeparating(id: string): boolean {
  return running.has(id);
}

/** Se o app fechou no meio de uma separação, ela não tá mais rodando. */
export function fixStale(p: Paths, id: string): Song {
  const song = getSong(p, id);
  if (song.separation.status === 'running' && !running.has(id)) {
    return saveSong(p, { ...song, separation: { ...song.separation, status: 'error', error: 'A separação parou no meio (o app fechou). Manda separar de novo.' } });
  }
  return song;
}

/** Ataques (notas) das faixas de baixo e bateria do Guitar Pro, em segundos, pro alinhamento. */
function tabOnsets(file: string): Record<'bass' | 'drums', number[]> {
  const score = loadScore(file);
  const out = { bass: [] as number[], drums: [] as number[] };
  for (const t of tabTracks(score)) {
    if (t.instrument !== 'bass' && t.instrument !== 'drums') continue;
    for (const bar of score.tracks[t.index]!.staves[0]!.bars) {
      for (const b of bar.voices[0]!.beats) if (!b.isRest && b.notes.length) out[t.instrument].push((b.absolutePlaybackStart / 960) * (60 / score.tempo));
    }
  }
  return out;
}

/**
 * Compasso 1 automático (S08): casa os ataques do baixo (ou da bateria) separado com os do Guitar Pro
 * em 3 trechos. Se os 3 batem (±60 ms), salva; senão avisa e deixa no manual.
 */
export async function autoAlign(p: Paths, id: string): Promise<{ ok: boolean; offset_ms: number | null; detail: string; song: Song }> {
  const song = getSong(p, id);
  const tab = tabPath(p, song);
  if (!tab || !song.stems.length) throw new AppError(400, 'Precisa do Guitar Pro e do MP3 separado pra achar sozinho.');
  const onsets = tabOnsets(tab);
  const json = path.join(songDir(p, id), '.onsets.json');
  fs.writeFileSync(json, JSON.stringify(onsets));
  const child = runPython(p, 'align.py', [path.join(songDir(p, id), 'faixas'), json]);
  if (!child) throw new AppError(400, 'O separador não tá instalado.');
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  const code = await new Promise<number>((ok) => child.on('close', (c) => ok(c ?? 1)));
  fs.rmSync(json, { force: true });
  const res = code === 0 ? (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { ok: boolean; offset_ms: number | null; detail: string }) : { ok: false, offset_ms: null, detail: 'o alinhamento deu erro' };
  if (res.ok && res.offset_ms != null) {
    return { ...res, song: saveSong(p, { ...getSong(p, id), tab_offset_ms: res.offset_ms, tab_offset_note: `achado sozinho: ${res.detail}` }) };
  }
  return { ...res, song: getSong(p, id) };
}

/** Salva a gravação como o "Ensaio Atual" daquele instrumento. A anterior vai pra "antigas". */
export async function saveTake(p: Paths, id: string, kind: TakeKind, offsetMs: number, body: Readable): Promise<Song> {
  const song = getSong(p, id);
  const dir = path.join(songDir(p, id), 'gravacoes');
  fs.mkdirSync(dir, { recursive: true });
  const old = song.takes[kind];
  if (old) retire(path.join(dir, old.file));
  const file = `${kind}-${stamp()}.wav`;
  await pipeline(body, fs.createWriteStream(path.join(dir, file)));
  return saveSong(p, { ...getSong(p, id), takes: { ...song.takes, [kind]: { file, offset_ms: Math.round(offsetMs), nudge_ms: 0, created_at: now() } } });
}

export function nudgeTake(p: Paths, id: string, kind: TakeKind, nudgeMs: number): Song {
  const song = getSong(p, id);
  const take = song.takes[kind];
  if (!take) throw new AppError(404, 'Não tem gravação desse tipo no Ensaio Atual.');
  return saveSong(p, { ...song, takes: { ...song.takes, [kind]: { ...take, nudge_ms: Math.round(nudgeMs) } } });
}

/** "Resetar": tira a gravação do Ensaio Atual (o arquivo vai pra "antigas"). */
export function resetTake(p: Paths, id: string, kind: TakeKind): Song {
  const song = getSong(p, id);
  const take = song.takes[kind];
  if (take) retire(path.join(songDir(p, id), 'gravacoes', take.file));
  return saveSong(p, { ...song, takes: { ...song.takes, [kind]: null } });
}

/** Caminho de um arquivo servível, sem sair da pasta da música. */
export function songAsset(p: Paths, id: string, rel: string): string {
  const song = getSong(p, id);
  const ok = /^(faixas\/[a-z]+\.flac|gravacoes\/[\w-]+\.wav|original\.(mp3|wav|flac|ogg))$/.test(rel) || rel === song.tab_file;
  const file = path.join(songDir(p, id), rel);
  if (!ok || !fs.existsSync(file)) throw new AppError(404, 'Arquivo não encontrado.');
  return file;
}

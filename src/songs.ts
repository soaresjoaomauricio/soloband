import * as alphaTab from '@coderline/alphatab';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Paths } from './paths';

/** Uma música do SoloBand. Fica em musicas/<id>/musica.json, junto com os arquivos dela. */
export interface Take {
  file: string;
  /** Onde a gravação começa na música, em ms (já com a compensação de atraso). */
  offset_ms: number;
  /** Ajuste fino na tela, somado ao offset. */
  nudge_ms: number;
  created_at: string;
}

export const TAKE_KINDS = ['guitar', 'bass', 'vocal'] as const;
export type TakeKind = (typeof TAKE_KINDS)[number];

export interface Song {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  tab_file: string | null;
  original: string | null;
  separation: { status: 'none' | 'running' | 'done' | 'error'; progress: number; error: string | null; device: string | null; updated_at: string | null };
  stems: string[];
  takes: Partial<Record<TakeKind, Take | null>>;
  /** Onde o compasso 1 do Guitar Pro cai no MP3 (ms). */
  tab_offset_ms: number;
  tab_offset_note: string | null;
  created_at: string;
  updated_at: string;
}

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const Text = z.string().trim().min(1);
export const CreateSong = z.object({ title: Text, artist: Text.default('Desconhecido'), bpm: z.number().int().min(20).max(300).nullable().optional() });
export const UpdateSong = z
  .object({
    title: Text,
    artist: Text,
    bpm: z.number().int().min(20).max(300).nullable(),
    tab_offset_ms: z.number().min(-60000).max(600000),
    tab_offset_note: Text.nullable(),
  })
  .partial();

export const now = () => new Date().toISOString();
export const stamp = () => now().replace(/[:.]/g, '-');

/** "Ela Vai Voltar" → "ela-vai-voltar". */
export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const songDir = (p: Paths, id: string) => path.join(p.songs, id);
const songFile = (p: Paths, id: string) => path.join(songDir(p, id), 'musica.json');

/** Move pra <pasta>/antigas/ em vez de apagar: nada some de verdade. */
export function retire(file: string): void {
  if (!fs.existsSync(file)) return;
  const dest = path.join(path.dirname(file), 'antigas', `${stamp()}-${path.basename(file)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(file, dest);
}

export function getSong(p: Paths, id: string): Song {
  if (!/^[a-z0-9-]+$/.test(id)) throw new AppError(404, 'Música não encontrada.');
  try {
    return JSON.parse(fs.readFileSync(songFile(p, id), 'utf8')) as Song;
  } catch {
    throw new AppError(404, 'Música não encontrada.');
  }
}

export function saveSong(p: Paths, song: Song): Song {
  fs.mkdirSync(songDir(p, song.id), { recursive: true });
  const next = { ...song, updated_at: now() };
  fs.writeFileSync(songFile(p, song.id), JSON.stringify(next, null, 2));
  return next;
}

export function listSongs(p: Paths): Song[] {
  if (!fs.existsSync(p.songs)) return [];
  return fs
    .readdirSync(p.songs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'antigas' && fs.existsSync(songFile(p, d.name)))
    .map((d) => getSong(p, d.name))
    .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
}

export function createSong(p: Paths, input: z.infer<typeof CreateSong>): Song {
  const base = slug(input.title) || 'musica';
  let id = base;
  for (let i = 2; fs.existsSync(songDir(p, id)); i++) id = `${base}-${i}`;
  const t = now();
  return saveSong(p, {
    id,
    title: input.title,
    artist: input.artist,
    bpm: input.bpm ?? null,
    tab_file: null,
    original: null,
    separation: { status: 'none', progress: 0, error: null, device: null, updated_at: null },
    stems: [],
    takes: {},
    tab_offset_ms: 0,
    tab_offset_note: null,
    created_at: t,
    updated_at: t,
  });
}

export function updateSong(p: Paths, id: string, input: z.infer<typeof UpdateSong>): Song {
  return saveSong(p, { ...getSong(p, id), ...input });
}

/** "Apagar" a música = a pasta inteira vai pra musicas/antigas/ (dá pra trazer de volta). */
export function retireSong(p: Paths, id: string): void {
  getSong(p, id);
  const dest = path.join(p.songs, 'antigas', `${stamp()}-${id}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(songDir(p, id), dest);
}

// ---------- tab (Guitar Pro) ----------

export const TAB_RE = /\.(gp|gp3|gp4|gp5|gpx|gp7)$/i;

export function loadScore(file: string): alphaTab.model.Score {
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(file)), new alphaTab.Settings());
}

export const tabPath = (p: Paths, song: Song) => (song.tab_file ? path.join(songDir(p, song.id), song.tab_file) : null);

export interface TabTrack {
  index: number;
  name: string;
  instrument: 'guitar' | 'bass' | 'drums' | 'other';
}

/** Faixas da tab e o instrumento de cada uma (pelo programa MIDI e pelo nome). */
export function tabTracks(score: alphaTab.model.Score): TabTrack[] {
  return score.tracks.map((t, index) => {
    const prog = t.playbackInfo.program;
    const name = t.name.trim() || `Faixa ${index + 1}`;
    const n = name.toLowerCase();
    const instrument = t.staves[0]?.isPercussion || /drum|bateria/.test(n)
      ? 'drums'
      : (prog >= 32 && prog <= 39) || /bass|baixo/.test(n)
        ? 'bass'
        : (prog >= 24 && prog <= 31) || /guitar|guitarra|viol/.test(n)
          ? 'guitar'
          : 'other';
    return { index, name, instrument };
  });
}

/** Guarda o .gp da música (o anterior vai pra antigas) e preenche o BPM se estiver vazio. */
export function attachTab(p: Paths, id: string, from: string, { move = false } = {}): Song {
  const song = getSong(p, id);
  const ext = path.extname(from).toLowerCase();
  if (!TAB_RE.test(ext)) throw new AppError(400, 'Arquivo de tab tem que ser Guitar Pro (.gp, .gp5, .gpx…).');
  const score = loadScore(from); // falha aqui se o arquivo não for tab de verdade
  if (song.tab_file) retire(path.join(songDir(p, id), song.tab_file));
  const target = `tab${ext}`;
  fs.mkdirSync(songDir(p, id), { recursive: true });
  if (move) {
    try {
      fs.renameSync(from, path.join(songDir(p, id), target));
    } catch {
      fs.copyFileSync(from, path.join(songDir(p, id), target));
      fs.unlinkSync(from);
    }
  } else fs.copyFileSync(from, path.join(songDir(p, id), target));
  return saveSong(p, { ...getSong(p, id), tab_file: target, bpm: song.bpm ?? (score.tempo > 0 ? Math.round(score.tempo) : null) });
}

// ---------- pasta vigiada ----------

export const DEFAULT_WATCH = path.join(os.homedir(), 'Downloads');

/** Chegou um .gp na pasta vigiada: liga na música pelo título (ou cria) e move pra pasta dela. */
export function importTabFile(p: Paths, file: string): { song: Song; created: boolean } {
  const score = loadScore(file);
  const title = score.title.trim() || path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ');
  const songs = listSongs(p);
  const s = slug(title);
  const found = songs.find((x) => slug(x.title) === s) ?? songs.find((x) => s.length > 3 && slug(x.title).includes(s));
  const song = found ?? createSong(p, { title, artist: score.artist.trim() || 'Desconhecido' });
  return { song: attachTab(p, song.id, file, { move: true }), created: !found };
}

async function waitStable(file: string): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!fs.existsSync(file)) return false;
    const size = fs.statSync(file).size;
    if (size > 0 && size === last) return true;
    last = size;
  }
  return false;
}

/** Vigia a pasta (padrão: Downloads). Só arquivos novos; o que já estava lá fica onde está. */
export function watchFolder(p: Paths, dir: string, log: (msg: string) => void): () => void {
  if (!dir || !fs.existsSync(dir)) return () => {};
  const busy = new Set<string>();
  const watcher = fs.watch(dir, (_e, name) => {
    if (!name || !TAB_RE.test(name) || busy.has(name)) return;
    busy.add(name);
    const file = path.join(dir, name);
    void waitStable(file)
      .then((ok) => {
        if (!ok) return;
        const { song, created } = importTabFile(p, file);
        log(`Tab da pasta vigiada: ${name} → ${song.title}${created ? ' (música nova)' : ''}`);
      })
      .catch((e) => log(`Não consegui importar ${name}: ${(e as Error).message}`))
      .finally(() => setTimeout(() => busy.delete(name), 5000));
  });
  return () => watcher.close();
}

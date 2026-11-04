import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z, ZodError } from 'zod';
import { readConfig, writeConfig } from './config';
import type { Paths } from './paths';
import { installSeparator, removeSeparator, separatorStatus } from './separator';
import { AppError, attachTab, CreateSong, createSong, getSong, listSongs, loadScore, retireSong, TAB_RE, tabPath, tabTracks, TAKE_KINDS, TAKE_SOURCES, updateSong, UpdateSong } from './songs';
import { youtubeId, youtubeInfo } from './youtube';
import { live } from './live';
import { autoAlign, fixStale, isSeparating, nudgeTake, resetTake, saveOriginal, saveTake, separationLog, songAsset, startSeparation } from './studio';

z.config(z.locales.pt());

/** O que o processo principal do Electron oferece pro servidor (atualização, abrir pasta). */
export interface Host {
  version: string;
  update?: { status: () => unknown; check: () => Promise<unknown>; install: () => void };
  openFolder?: (dir: string) => void;
  /** Abre o desinstalador do Windows e fecha o app (os dados ficam). */
  uninstall?: () => boolean;
  onConfigChange?: () => void;
}

const IdParam = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });
const KindParam = IdParam.extend({ kind: z.enum(TAKE_KINDS, 'Instrumento da gravação: guitar, bass ou vocal') });
const TYPES: Record<string, string> = { '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };

export async function buildServer(p: Paths, host: Host = { version: '0.0.0' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'dados'}: ${i.message}`).join('; ') });
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    return reply.code(500).send({ error: `Deu ruim: ${(err as Error).message}` });
  });

  // Arquivo chega cru no corpo e vai direto pro disco.
  app.addContentTypeParser(['application/octet-stream', 'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/x-wav'], (_req, payload, done) => done(null, payload));

  // Separar ao vivo (S15): o Demucs na GPU recebe o som do YouTube em pedaços e devolve as faixas na hora.
  // Nada vai pro disco: o áudio passa só pela memória.
  live.setPaths(p);
  app.get('/api/live', async () => live.status());
  app.post('/api/live/start', async () => live.start());
  app.post('/api/live/stop', async () => live.stop());
  app.get('/api/live/out', async (req, reply) => {
    const out = live.openOut();
    req.raw.on('close', () => live.closeOut(out));
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store').send(out);
  });
  app.post('/api/live/in', async (req) => {
    const start = z.coerce.number().int().min(0).parse(req.headers['x-start']);
    if (req.headers['x-reset']) {
      live.reset(start);
      return { ok: true };
    }
    const parts: Buffer[] = [];
    for await (const c of req.body as Readable) parts.push(c as Buffer);
    live.write(start, Buffer.concat(parts));
    return { ok: true };
  });

  const songView = (id: string) => {
    const song = fixStale(p, id);
    const file = tabPath(p, song);
    const tracks = file && fs.existsSync(file) ? tabTracks(loadScore(file)) : [];
    return { song, tab_available: tracks.length > 0, tab_tracks: tracks, separation_log: separationLog(id) };
  };

  app.get('/api/songs', async () => listSongs(p).map((s) => (s.separation.status === 'running' ? fixStale(p, s.id) : s)));
  app.post('/api/songs', async (req, reply) => reply.code(201).send(createSong(p, CreateSong.parse(req.body))));
  app.get('/api/songs/:id', async (req) => songView(IdParam.parse(req.params).id));
  // "Nova música pelo YouTube" (S14): título e canal do vídeo pelo oEmbed, pra preencher o formulário.
  app.post('/api/youtube-info', async (req) => {
    const { url } = z.object({ url: z.string().trim().min(1, 'Cola o link do vídeo') }).parse(req.body);
    if (!youtubeId(url)) throw new AppError(400, 'Esse link não é de um vídeo do YouTube. Copia o link do vídeo (youtube.com/watch?v=… ou youtu.be/…).');
    return youtubeInfo(url);
  });
  app.patch('/api/songs/:id', async (req) => updateSong(p, IdParam.parse(req.params).id, UpdateSong.parse(req.body)));
  app.delete('/api/songs/:id', async (req) => {
    const { id } = IdParam.parse(req.params);
    if (isSeparating(id)) throw new AppError(409, 'Ainda tô separando as faixas dessa música. Espera terminar pra tirar da lista.');
    retireSong(p, id);
    return { ok: true };
  });

  // Guitar Pro: chega cru (o nome vem no cabeçalho) e vai pra pasta da música.
  app.put('/api/songs/:id/tab', async (req) => {
    const { id } = IdParam.parse(req.params);
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
    if (!TAB_RE.test(name)) throw new AppError(400, 'Arquivo de tab tem que ser Guitar Pro (.gp, .gp5, .gpx…).');
    const tmp = path.join(os.tmpdir(), `soloband-${Date.now()}${path.extname(name)}`);
    await pipeline(req.body as Readable, fs.createWriteStream(tmp));
    try {
      attachTab(p, id, tmp, { move: true });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return songView(id);
  });

  app.get('/api/songs/:id/tab', async (req, reply) => {
    const song = getSong(p, IdParam.parse(req.params).id);
    const file = tabPath(p, song);
    if (!file || !fs.existsSync(file)) throw new AppError(404, 'Essa música não tem arquivo Guitar Pro.');
    return reply.type('application/octet-stream').send(fs.createReadStream(file));
  });

  app.put('/api/songs/:id/audio', async (req) => {
    const { id } = IdParam.parse(req.params);
    await saveOriginal(p, id, decodeURIComponent(String(req.headers['x-filename'] ?? '')), req.body as Readable);
    return startSeparation(p, id);
  });
  app.post('/api/songs/:id/separate', async (req) => startSeparation(p, IdParam.parse(req.params).id));
  app.post('/api/songs/:id/align', async (req) => autoAlign(p, IdParam.parse(req.params).id));

  app.get('/api/songs/:id/files/*', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const file = songAsset(p, id, (req.params as Record<string, string>)['*'] ?? '');
    return reply.type(TYPES[path.extname(file)] ?? 'application/octet-stream').send(fs.createReadStream(file));
  });

  app.put('/api/songs/:id/takes/:kind', async (req) => {
    const { id, kind } = KindParam.parse(req.params);
    const offset = z.coerce.number().min(-600000).max(3600000).parse(req.headers['x-offset-ms'] ?? 0);
    const source = z.enum(TAKE_SOURCES, 'Fonte da gravação: audio ou youtube').parse(req.headers['x-source'] ?? 'audio');
    return saveTake(p, id, kind, offset, req.body as Readable, source);
  });
  app.patch('/api/songs/:id/takes/:kind', async (req) => {
    const { id, kind } = KindParam.parse(req.params);
    return nudgeTake(p, id, kind, z.object({ nudge_ms: z.number().min(-2000).max(2000) }).parse(req.body).nudge_ms);
  });
  app.delete('/api/songs/:id/takes/:kind', async (req) => {
    const { id, kind } = KindParam.parse(req.params);
    return resetTake(p, id, kind);
  });

  app.get('/api/separator', async () => separatorStatus(p));
  app.post('/api/separator/install', async () => installSeparator(p));
  app.post('/api/separator/remove', async () => {
    try {
      return removeSeparator(p);
    } catch (e) {
      throw new AppError(409, (e as Error).message);
    }
  });
  app.post('/api/uninstall', async () => {
    if (!host.uninstall?.()) throw new AppError(400, 'Aqui não tem desinstalador (modo de desenvolvimento). Usa "Adicionar ou remover programas" do Windows.');
    return { ok: true };
  });

  app.get('/api/config', async () => ({ ...readConfig(p), data_dir: p.data, version: host.version }));
  app.put('/api/config', async (req) => {
    const next = writeConfig(p, z.object({ watch_dir: z.string() }).partial().parse(req.body));
    host.onConfigChange?.();
    return next;
  });
  app.post('/api/open-folder', async (req) => {
    const { which } = z.object({ which: z.enum(['data', 'watch']) }).parse(req.body);
    host.openFolder?.(which === 'data' ? p.data : readConfig(p).watch_dir);
    return { ok: true };
  });

  app.get('/api/update', async () => host.update?.status() ?? { state: 'dev' });
  app.post('/api/update/check', async () => (host.update ? host.update.check() : { state: 'dev' }));
  app.post('/api/update/install', async () => {
    host.update?.install();
    return { ok: true };
  });

  await app.register(fastifyStatic, { root: path.join(p.appDir, 'public'), wildcard: false });
  await app.register(fastifyStatic, {
    root: path.join(p.appDir, 'node_modules', '@coderline', 'alphatab', 'dist'),
    prefix: '/vendor/alphatab/',
    decorateReply: false,
  });
  return app;
}

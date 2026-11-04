import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makePaths } from '../src/paths';
import { buildServer } from '../src/server';
import { guessSongFromVideo, normalizeYoutubeUrl, youtubeId, youtubeInfo } from '../src/youtube';

describe('link do YouTube (S14)', () => {
  it('acha o id em todo formato de link e recusa o que não é vídeo', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(youtubeId(url), url).toBe('dQw4w9WgXcQ');
      expect(normalizeYoutubeUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    }
    for (const bad of ['https://www.youtube.com/@canal', 'https://vimeo.com/123', 'https://www.youtube.com/watch?v=curto', 'nada']) expect(youtubeId(bad), bad).toBeNull();
  });

  it('tira artista e título do nome do vídeo', () => {
    expect(guessSongFromVideo('Red Hot Chili Peppers - Snow (Hey Oh) (Official Music Video) [4K Upgrade]', 'Red Hot Chili Peppers')).toEqual({ artist: 'Red Hot Chili Peppers', title: 'Snow (Hey Oh)' });
    expect(guessSongFromVideo('Ela Vai Voltar', 'Charlie Brown Jr. - Topic')).toEqual({ artist: 'Charlie Brown Jr.', title: 'Ela Vai Voltar' });
  });

  it('nome do vídeo pelo oEmbed; sem internet, volta sem nome em vez de quebrar', async () => {
    const ok = (async () => new Response(JSON.stringify({ title: 'Artista - Som (Official Audio)', author_name: 'Artista' }))) as unknown as typeof fetch;
    expect(await youtubeInfo('https://youtu.be/dQw4w9WgXcQ', ok)).toMatchObject({ id: 'dQw4w9WgXcQ', title: 'Som', artist: 'Artista' });
    const off = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await youtubeInfo('https://youtu.be/dQw4w9WgXcQ', off)).toMatchObject({ id: 'dQw4w9WgXcQ', title: null, artist: null });
  });
});

describe('YouTube na música', () => {
  let app: FastifyInstance;
  let dir: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloband-yt-'));
    app = await buildServer(makePaths(dir, path.resolve(import.meta.dirname, '..')), { version: '9.9.9' });
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cadastra com o link normalizado, troca, recusa link errado e tira', async () => {
    const s = (await app.inject({ method: 'POST', url: '/api/songs', payload: { title: 'Snow', youtube_url: 'https://youtu.be/dQw4w9WgXcQ?si=x' } })).json();
    expect(s).toMatchObject({ id: 'snow', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', youtube_offset_ms: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/songs/snow' })).json().song.youtube_url).toContain('dQw4w9WgXcQ');
    const bad = await app.inject({ method: 'PATCH', url: '/api/songs/snow', payload: { youtube_url: 'https://vimeo.com/1' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/não é de um vídeo do YouTube/);
    const off = await app.inject({ method: 'PATCH', url: '/api/songs/snow', payload: { youtube_offset_ms: 4321.4, youtube_offset_note: 'marcado na mão' } });
    expect(off.json()).toMatchObject({ youtube_offset_ms: 4321.4, youtube_offset_note: 'marcado na mão', tab_offset_ms: 0 });
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/snow', payload: { youtube_url: null } })).json().youtube_url).toBeNull();
  });

  it('a gravação guarda em cima de qual som foi feita', async () => {
    await app.inject({ method: 'POST', url: '/api/songs', payload: { title: 'Snow' } });
    const wav = Buffer.from('RIFF....WAVE');
    let r = await app.inject({ method: 'PUT', url: '/api/songs/snow/takes/vocal', payload: wav, headers: { 'content-type': 'audio/wav', 'x-offset-ms': '1500', 'x-source': 'youtube' } });
    expect(r.json().takes.vocal).toMatchObject({ offset_ms: 1500, source: 'youtube' });
    r = await app.inject({ method: 'PUT', url: '/api/songs/snow/takes/bass', payload: wav, headers: { 'content-type': 'audio/wav' } });
    expect(r.json().takes.bass).toMatchObject({ source: 'audio' });
    r = await app.inject({ method: 'PUT', url: '/api/songs/snow/takes/bass', payload: wav, headers: { 'content-type': 'audio/wav', 'x-source': 'spotify' } });
    expect(r.statusCode).toBe(400);
  });

  it('"Nova música pelo YouTube" recusa link que não é de vídeo', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/youtube-info', payload: { url: 'https://vimeo.com/1' } })).statusCode).toBe(400);
  });
});

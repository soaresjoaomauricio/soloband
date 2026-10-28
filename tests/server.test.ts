import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makePaths } from '../src/paths';
import { buildServer } from '../src/server';

let app: FastifyInstance;
let dir: string;
const ROOT = path.resolve(import.meta.dirname, '..');
// Um .gp de verdade pra testar a parte de tab (se tiver no PC do João; senão esses testes pulam).
const SAMPLE_GP = path.join(os.homedir(), 'Documents', 'Workspace', 'vida-de-jao', 'data', 'tabs', 'charlie_brown_jr_ela_vai_voltar.gp');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloband-'));
  process.env.SOLOBAND_PYTHON = path.join(dir, 'sem-python.exe'); // sem separador: tem que cair no aviso
  app = await buildServer(makePaths(dir, ROOT), { version: '9.9.9' });
});
afterEach(async () => {
  await app.close();
  delete process.env.SOLOBAND_PYTHON;
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = (method: 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown) => app.inject({ method, url, payload: payload as object });
const raw = (url: string, body: Buffer, headers: Record<string, string>) => app.inject({ method: 'PUT', url, payload: body, headers });

describe('músicas', () => {
  it('cadastra, lista, edita e "apaga" guardando a pasta em antigas', async () => {
    const a = (await json('POST', '/api/songs', { title: 'Ela Vai Voltar', artist: 'Charlie Brown Jr.', bpm: 105 })).json();
    expect(a).toMatchObject({ id: 'ela-vai-voltar', bpm: 105, stems: [], tab_file: null });
    const b = (await json('POST', '/api/songs', { title: 'Ela Vai Voltar' })).json();
    expect(b.id).toBe('ela-vai-voltar-2');
    expect((await app.inject({ method: 'GET', url: '/api/songs' })).json()).toHaveLength(2);
    expect((await json('PATCH', '/api/songs/ela-vai-voltar', { tab_offset_ms: 930, tab_offset_note: 'teste' })).json().tab_offset_ms).toBe(930);
    await app.inject({ method: 'DELETE', url: '/api/songs/ela-vai-voltar-2' });
    expect((await app.inject({ method: 'GET', url: '/api/songs' })).json()).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'musicas', 'antigas'))).toHaveLength(1);
  });

  it('não deixa sair da pasta pelo id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/songs/..%2F..%2Fetc' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/songs/nao-existe' })).statusCode).toBe(404);
  });
});

describe('estúdio', () => {
  it('recebe o MP3 e, sem separador, avisa pra instalar ou usar o Guitar Pro', async () => {
    await json('POST', '/api/songs', { title: 'Teste' });
    const r = await raw('/api/songs/teste/audio', Buffer.from('ID3 falso'), { 'content-type': 'application/octet-stream', 'x-filename': 'teste.mp3' });
    expect(r.json()).toMatchObject({ original: 'original.mp3', separation: { status: 'error' } });
    expect(r.json().separation.error).toContain('Configurações');
    expect((await raw('/api/songs/teste/audio', Buffer.from('x'), { 'content-type': 'application/octet-stream', 'x-filename': 'a.m4a' })).statusCode).toBe(400);
  });

  it('grava Ensaio Atual de guitarra, baixo e voz; ajusta; reseta guardando o arquivo', async () => {
    await json('POST', '/api/songs', { title: 'Teste' });
    const wav = Buffer.from('RIFF....WAVE');
    for (const kind of ['guitar', 'bass', 'vocal']) {
      expect((await raw(`/api/songs/teste/takes/${kind}`, wav, { 'content-type': 'audio/wav', 'x-offset-ms': '1500' })).json().takes[kind].offset_ms).toBe(1500);
    }
    const song = (await json('PATCH', '/api/songs/teste/takes/bass', { nudge_ms: 20 })).json();
    expect(song.takes.bass.nudge_ms).toBe(20);
    expect((await app.inject({ method: 'GET', url: `/api/songs/teste/files/gravacoes/${song.takes.bass.file}` })).body).toBe('RIFF....WAVE');
    expect((await app.inject({ method: 'DELETE', url: '/api/songs/teste/takes/bass' })).json().takes.bass).toBeNull();
    expect(fs.readdirSync(path.join(dir, 'musicas', 'teste', 'gravacoes', 'antigas'))).toHaveLength(1);
    expect((await raw('/api/songs/teste/takes/bateria', wav, { 'content-type': 'audio/wav' })).statusCode).toBe(400);
  });

  it('só serve arquivo da música, nunca o musica.json nem fora da pasta', async () => {
    await json('POST', '/api/songs', { title: 'Teste' });
    expect((await app.inject({ method: 'GET', url: '/api/songs/teste/files/musica.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/songs/teste/files/..%2F..%2Fconfig.json' })).statusCode).toBe(404);
  });

  it('remover o separador apaga só a pasta dele, nunca as músicas', async () => {
    await json('POST', '/api/songs', { title: 'Teste' });
    fs.mkdirSync(path.join(dir, 'separador', 'venv'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'separador', 'instalado.json'), '{}');
    expect((await app.inject({ method: 'POST', url: '/api/separator/remove' })).json()).toMatchObject({ installed: false });
    expect(fs.existsSync(path.join(dir, 'separador'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'musicas', 'teste', 'musica.json'))).toBe(true);
  });

  it('desinstalar no modo dev explica que não tem desinstalador', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/uninstall' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('Adicionar ou remover programas');
  });

  it('separador: sem instalar, diz que não tá instalado', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/separator' })).json()).toMatchObject({ installed: false, installing: false });
  });
});

describe('separação que parou no meio', () => {
  it('a lista não fica "separando…" pra sempre se o app fechou no meio', async () => {
    const song = (await json('POST', '/api/songs', { title: 'Meio' })).json();
    const file = path.join(dir, 'musicas', song.id, 'musica.json');
    fs.writeFileSync(file, JSON.stringify({ ...song, separation: { ...song.separation, status: 'running', progress: 40 } }));
    const listed = (await app.inject({ method: 'GET', url: '/api/songs' })).json();
    expect(listed[0].separation).toMatchObject({ status: 'error', error: expect.stringContaining('parou no meio') });
  });
});

describe.skipIf(!fs.existsSync(SAMPLE_GP))('Guitar Pro', () => {
  it('põe o .gp na música, preenche o BPM e mostra as faixas com o instrumento de cada uma', async () => {
    await json('POST', '/api/songs', { title: 'Ela Vai Voltar' });
    const r = await raw('/api/songs/ela-vai-voltar/tab', fs.readFileSync(SAMPLE_GP), { 'content-type': 'application/octet-stream', 'x-filename': 'ela.gp' });
    expect(r.statusCode).toBe(200);
    expect(r.json().song).toMatchObject({ tab_file: 'tab.gp', bpm: 105 });
    expect(r.json().tab_tracks.map((t: { instrument: string }) => t.instrument)).toEqual(['drums', 'guitar', 'guitar', 'bass']);
    expect((await app.inject({ method: 'GET', url: '/api/songs/ela-vai-voltar/tab' })).rawPayload.length).toBe(fs.statSync(SAMPLE_GP).size);
  });
});

describe('configurações', () => {
  it('guarda a pasta vigiada e mostra onde ficam os dados', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({ data_dir: dir, version: '9.9.9' });
    expect((await json('PUT', '/api/config', { watch_dir: 'C:\\Musicas' })).json().watch_dir).toBe('C:\\Musicas');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).watch_dir).toBe('C:\\Musicas');
  });
});

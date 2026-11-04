import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { live } from '../src/live';
import { makePaths } from '../src/paths';
import { buildServer } from '../src/server';

let app: FastifyInstance;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloband-live-'));
  process.env.LIVE_SEP_CMD = JSON.stringify([process.execPath, path.join(import.meta.dirname, 'fixtures', 'fake-live-sep.mjs')]);
  app = await buildServer(makePaths(dir, path.resolve(import.meta.dirname, '..')), { version: '9.9.9' });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  live.stop();
  app.server.closeAllConnections(); // o fluxo das faixas fica aberto (keep-alive) e seguraria o close
  await app.close();
  delete process.env.LIVE_SEP_CMD;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('separar ao vivo (S15)', () => {
  it('liga o separador, manda o som em pedaços e recebe as 6 faixas na ordem', async () => {
    expect(await (await fetch(`${base}/api/live`)).json()).toMatchObject({ available: true, running: false });
    expect(await (await fetch(`${base}/api/live/start`, { method: 'POST' })).json()).toMatchObject({ ready: true, gpu: 'Placa de Teste' });
    const reader = (await fetch(`${base}/api/live/out`)).body!.getReader();
    const send = (start: number, samples: number[]) =>
      fetch(`${base}/api/live/in`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-start': String(start) }, body: Buffer.from(new Float32Array(samples).buffer) });
    expect((await send(0, [0.1, -0.1, 0.2, -0.2])).status).toBe(200);
    expect((await send(2, [0.3, -0.3])).status).toBe(200);
    let got = Buffer.alloc(0);
    let magic = false;
    const frames: Array<{ start: number; n: number; first: number[] }> = [];
    while (frames.length < 2) {
      const { value } = await reader.read();
      got = Buffer.concat([got, Buffer.from(value!)]);
      if (!magic && got.length >= 4) {
        expect(got.subarray(0, 4).toString()).toBe('VDJL');
        got = got.subarray(4);
        magic = true;
      }
      while (got.length >= 12) {
        const n = got.readInt32LE(4);
        const size = 12 + 6 * 2 * n * 4;
        if (got.length < size) break;
        const f = new Float32Array(got.buffer.slice(got.byteOffset + 12, got.byteOffset + size));
        frames.push({ start: got.readInt32LE(0), n, first: [f[0]!, f[2 * n]!, f[5 * 2 * n]!].map((v) => Math.round(v * 100) / 100) });
        got = got.subarray(size);
      }
    }
    await reader.cancel();
    expect(frames).toEqual([
      { start: 0, n: 2, first: [0.1, 0.2, 0.6] },
      { start: 2, n: 1, first: [0.3, 0.6, 1.8] },
    ]);
  });

  it('sem separador ligado, recusa o som', async () => {
    live.stop();
    const off = await fetch(`${base}/api/live/in`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-start': '0' }, body: Buffer.alloc(8) });
    expect(off.status).toBe(409);
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Paths } from './paths';
import { separatorPython, separatorStatus } from './separator';
import { AppError } from './songs';

/**
 * Separação ao vivo (S15, o D74 do Vida de Jão): o Demucs fica carregado na GPU (`scripts/live_separate.py`) enquanto o Estúdio toca o
 * YouTube. A tela manda o som do vídeo em pedaços (`POST /api/live/in`) e lê as faixas separadas num fluxo só
 * (`GET /api/live/out`). **Nada vai pro disco nem pro log**: o áudio passa só pela memória.
 * Um separador por vez (é a GPU do PC). Sem uso por 2 min, ele fecha e solta a memória da placa.
 */

export interface LiveStatus {
  /** Tem o separador instalado e placa NVIDIA (no processador não acompanha a música). */
  available: boolean;
  running: boolean;
  ready: boolean;
  gpu: string | null;
  error: string | null;
}

const IDLE_MS = 120_000;
/** Primeiros 4 bytes do fluxo de saída (a tela pula). */
export const LIVE_MAGIC = Buffer.from('VDJL');
const START_TIMEOUT_MS = 120_000;

/** Comando do separador: `LIVE_SEP_CMD` (JSON, nos testes) ou o Python do separador instalado com o script. */
function command(p: Paths): string[] | null {
  if (process.env.LIVE_SEP_CMD) return JSON.parse(process.env.LIVE_SEP_CMD) as string[];
  const py = separatorPython(p);
  return py ? [py, path.join(p.scriptsDir, 'live_separate.py')] : null;
}

class LiveSeparator {
  private child: ChildProcess | null = null;
  private starting: Promise<LiveStatus> | null = null;
  private ready = false;
  private gpu: string | null = null;
  private error: string | null = null;
  private out: PassThrough | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private idle: NodeJS.Timeout | null = null;

  constructor(private p: Paths | null = null) {}

  setPaths(p: Paths): void {
    this.p = p;
  }

  status(): LiveStatus {
    const ok = this.p !== null && command(this.p) !== null && (process.env.LIVE_SEP_CMD ? true : separatorStatus(this.p).gpu !== false);
    return { available: ok, running: this.child !== null, ready: this.ready, gpu: this.gpu, error: this.error };
  }

  /** Sobe o separador (se ainda não tá) e espera o modelo carregar na GPU. */
  start(log: (msg: string) => void = () => {}): Promise<LiveStatus> {
    if (this.ready && this.child) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    const cmd = this.p ? command(this.p) : null;
    if (!cmd) throw new AppError(400, 'Separar ao vivo precisa do separador instalado (Configurações → Baixar o separador).');
    this.error = null;
    this.starting = new Promise<LiveStatus>((resolve, reject) => {
      const child = spawn(cmd[0]!, cmd.slice(1), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.child = child;
      let errText = '';
      const fail = (msg: string) => {
        this.error = msg;
        this.starting = null;
        reject(new AppError(503, msg));
      };
      const timer = setTimeout(() => {
        fail('O separador demorou demais pra carregar.');
        this.stop();
      }, START_TIMEOUT_MS);
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d: string) => {
        errText = (errText + d).slice(-2000);
        for (const line of d.split(/\r?\n/)) {
          const msg = line.match(/^\[soloband\] (.*)$/)?.[1];
          if (!msg) continue;
          if (msg.startsWith('pronto')) {
            clearTimeout(timer);
            this.ready = true;
            this.gpu = msg.split(' ').slice(1, -1).join(' ') || null;
            this.starting = null;
            log(`ao vivo: separador pronto (${this.gpu})`);
            this.touch();
            resolve(this.status());
          } else if (msg.startsWith('Erro: ')) this.error = msg.slice(6);
        }
      });
      child.stdout!.on('data', (d: Buffer) => this.forward(d));
      child.stdin!.on('error', () => {}); // o processo pode sair no meio de uma escrita
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.ready = false;
          this.out?.end();
          this.out = null;
        }
        if (this.starting) fail(this.error ?? `O separador parou ao abrir (código ${code}). ${errText.trim().split(/\r?\n/).pop() ?? ''}`.trim());
        log(`ao vivo: separador fechou (código ${code})`);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(`Não consegui abrir o separador: ${e.message}`);
      });
    });
    return this.starting;
  }

  /** Só passa pedaços inteiros (12 bytes de cabeçalho + 6 faixas × 2 canais × n amostras) pra quem tá lendo. */
  private forward(d: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
    for (;;) {
      if (this.pending.length < 12) return;
      const n = this.pending.readInt32LE(4);
      const size = 12 + 6 * 2 * n * 4;
      if (this.pending.length < size) return;
      const frame = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      if (this.out && !this.out.destroyed) this.out.write(Buffer.from(frame));
    }
  }

  /** Abre o fluxo das faixas separadas. Só um leitor: abrir outro fecha o anterior. */
  openOut(): PassThrough {
    this.out?.end();
    const out = new PassThrough();
    // Marca de 4 bytes no começo: sem nenhum byte o Node segura os cabeçalhos, e a tela fica esperando a resposta
    // enquanto o servidor espera o som que ela ainda não mandou.
    out.write(LIVE_MAGIC);
    this.out = out;
    out.on('close', () => this.out === out && (this.out = null));
    return out;
  }

  closeOut(out: PassThrough): void {
    if (this.out === out) this.out = null;
    out.end();
  }

  /** Um pedaço do som do vídeo (float32 estéreo intercalado, 44,1 kHz), começando na amostra `start`. */
  write(start: number, pcm: Buffer): void {
    if (!this.child || !this.ready) throw new AppError(409, 'O separador ao vivo não tá ligado.');
    if (pcm.length % 8) throw new AppError(400, 'Áudio quebrado (tem que ser float32 estéreo).');
    const head = Buffer.alloc(8);
    head.writeInt32LE(start, 0);
    head.writeInt32LE(pcm.length / 8, 4);
    this.child.stdin!.write(Buffer.concat([head, pcm]));
    this.touch();
  }

  /** Pulou ou pausou: o que vier a partir de `start` é outro trecho (o contexto antigo não serve mais). */
  reset(start: number): void {
    if (!this.child || !this.ready) return;
    const head = Buffer.alloc(8);
    head.writeInt32LE(start, 0);
    head.writeInt32LE(-1, 4);
    this.child.stdin!.write(head);
    this.touch();
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
  }

  stop(): LiveStatus {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.out?.end();
    this.out = null;
    this.pending = Buffer.alloc(0);
    if (child && child.exitCode === null) child.kill();
    return this.status();
  }
}

export const live = new LiveSeparator();

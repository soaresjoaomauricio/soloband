// Separador falso pros testes (no lugar do scripts/live_separate.py): devolve na hora 6 "faixas" iguais ao que
// entrou × (1..6), sem atraso. Mesmo protocolo de entrada e saída.
process.stderr.write('[soloband] pronto Placa de Teste drums,bass,other,vocals,guitar,piano\n');
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 8) return;
    const start = buf.readInt32LE(0);
    const n = buf.readInt32LE(4);
    if (n < 0) {
      buf = buf.subarray(8);
      continue;
    }
    if (buf.length < 8 + n * 8) return;
    const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + n * 8));
    buf = buf.subarray(8 + n * 8);
    const out = new Float32Array(6 * 2 * n);
    for (let s = 0; s < 6; s++) for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[(s * 2 + c) * n + i] = pcm[i * 2 + c] * (s + 1);
    const head = Buffer.alloc(12);
    head.writeInt32LE(start, 0);
    head.writeInt32LE(n, 4);
    head.writeInt32LE(1, 8);
    process.stdout.write(Buffer.concat([head, Buffer.from(out.buffer)]));
  }
});

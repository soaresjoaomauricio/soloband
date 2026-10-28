// Testa a instalação do separador de ponta a ponta numa pasta temporária (só-processador, pra baixar menos).
// Uso: npx tsx scripts/check-install.ts <pasta>
import path from 'node:path';
import { makePaths } from '../src/paths';
import { installSeparator, separatorPython, separatorStatus } from '../src/separator';

const dir = process.argv[2]!;
process.env.SOLOBAND_FORCE_CPU = '1';
delete process.env.SOLOBAND_PYTHON;
const p = makePaths(dir, path.resolve(import.meta.dirname, '..'));
installSeparator(p);
let last = '';
const t0 = Date.now();
for (;;) {
  await new Promise((ok) => setTimeout(ok, 3000));
  const st = separatorStatus(p);
  if (st.step && st.step !== last) console.log(`${Math.round((Date.now() - t0) / 1000)}s ${st.step}`);
  last = st.step ?? last;
  if (!st.installing) {
    console.log(st.error ? `ERRO: ${st.error}\n${st.log.slice(-1500)}` : `instalado: ${st.installed}, python: ${separatorPython(p)}`);
    break;
  }
}

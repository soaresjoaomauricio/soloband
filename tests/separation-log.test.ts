import { describe, expect, it } from 'vitest';
import { separationReader, type SeparationLog } from '../src/studio';

describe('leitor do stderr do separador', () => {
  it('pega etapa e progresso mesmo com o pedaço cortado no meio, e a barra de download não vira progresso', () => {
    const log: SeparationLog = { step: null, lines: [] };
    const seen: number[] = [];
    const read = separationReader(log, (pct) => seen.push(pct));
    read('[soloband] Carregando o modelo…\nhtdemucs_6s.th:  40%|████  | 22M/55M\rhtdemucs_6s.th: 100%|██████| 55M/55M\n');
    read('[soloband] Separando na placa X…\n  0%|          | 0.0/339.3 [00:00<?]\r  1');
    read('9%|██        | 64.3/339.3 [00:02<00:07]\r 52%|█████     | 176/339.3');
    read(' [00:04<00:04]\r100%|██████████| 339.3/339.3\n[soloband] Salvando a faixa drums…\n');
    expect(seen).toEqual([0, 19, 52, 100]);
    expect(log.step).toBe('Salvando a faixa drums…');
    expect(log.lines).toEqual(['Carregando o modelo…', 'Baixando: 100%', 'Separando na placa X…', 'Separando: 100%', 'Salvando a faixa drums…']);
  });
});

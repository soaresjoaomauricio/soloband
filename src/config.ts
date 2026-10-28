import fs from 'node:fs';
import { z } from 'zod';
import type { Paths } from './paths';
import { DEFAULT_WATCH } from './songs';

export const Config = z.object({
  /** Pasta vigiada: .gp que chegar aqui entra sozinho na música certa. Vazio = não vigia. */
  watch_dir: z.string().default(DEFAULT_WATCH),
});
export type ConfigT = z.infer<typeof Config>;

export function readConfig(p: Paths): ConfigT {
  try {
    return Config.parse(JSON.parse(fs.readFileSync(p.config, 'utf8')));
  } catch {
    return Config.parse({});
  }
}

export function writeConfig(p: Paths, patch: Partial<ConfigT>): ConfigT {
  const next = Config.parse({ ...readConfig(p), ...patch });
  fs.mkdirSync(p.data, { recursive: true });
  fs.writeFileSync(p.config, JSON.stringify(next, null, 2));
  return next;
}

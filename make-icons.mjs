// Gera o PNG do ícone (app e instalador) a partir do public/icon.svg.
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const svg = fs.readFileSync(path.join(here, 'public', 'icon.svg'));
fs.mkdirSync(path.join(here, 'assets'), { recursive: true });
fs.writeFileSync(path.join(here, 'assets', 'icon.png'), new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng());
console.log('assets/icon.png (512px)');

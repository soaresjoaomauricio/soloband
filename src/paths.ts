import path from 'node:path';

/**
 * Onde o SoloBand guarda tudo: %APPDATA%\SoloBand (o main passa) ou SOLOBAND_DATA nos testes.
 * `appDir` = onde está o app (public/, scripts/): a pasta do projeto no dev, `resources\app` instalado.
 */
export interface Paths {
  data: string;
  songs: string;
  separator: string;
  config: string;
  appDir: string;
  /** Scripts Python ficam fora do .asar (o Python não lê dentro dele). */
  scriptsDir: string;
}

export function makePaths(data: string, appDir: string): Paths {
  return {
    data,
    songs: path.join(data, 'musicas'),
    separator: path.join(data, 'separador'),
    config: path.join(data, 'config.json'),
    appDir,
    scriptsDir: path.join(appDir.replace(/app\.asar$/, 'app.asar.unpacked'), 'scripts'),
  };
}

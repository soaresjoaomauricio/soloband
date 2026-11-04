// SoloBand: o processo principal. Sobe o servidor dentro do próprio app (S05) numa porta livre de 127.0.0.1,
// abre a janela nele, vigia a pasta de tabs e cuida da atualização pelo GitHub Releases.
import { app, BrowserWindow, nativeTheme, session, shell, webContents } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { readConfig } from './config';
import { makePaths } from './paths';
import { live } from './live';
import { buildServer } from './server';
import { watchFolder } from './songs';

// SOLOBAND_DATA = outra pasta de dados (testar sem mexer na de verdade).
const paths = makePaths(process.env.SOLOBAND_DATA ?? app.getPath('userData'), app.getAppPath());
const LOG = path.join(paths.data, 'soloband.log');
let win: BrowserWindow | null = null;
let stopWatch: () => void = () => {};

function log(msg: string): void {
  try {
    fs.mkdirSync(paths.data, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});
nativeTheme.themeSource = 'dark';

// ---------- atualização ----------

type UpdateState = { state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error' | 'dev'; version?: string; percent?: number; error?: string };
let update: UpdateState = { state: app.isPackaged ? 'idle' : 'dev' };

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('checking-for-update', () => (update = { state: 'checking' }));
autoUpdater.on('update-available', (i) => (update = { state: 'downloading', version: i.version, percent: 0 }));
autoUpdater.on('download-progress', (pr) => (update = { ...update, state: 'downloading', percent: Math.round(pr.percent) }));
autoUpdater.on('update-downloaded', (i) => (update = { state: 'ready', version: i.version }));
autoUpdater.on('update-not-available', () => (update = { state: 'none' }));
autoUpdater.on('error', (e) => {
  const first = e.message.split('\n')[0] ?? e.message; // o erro do GitHub vem com os cabeçalhos inteiros
  update = { state: 'error', error: first };
  log(`atualização: ${first}`);
});

async function checkUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) return update;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    update = { state: 'error', error: (e as Error).message };
  }
  return update;
}

// ---------- início ----------

function startWatch(): void {
  stopWatch();
  stopWatch = watchFolder(paths, readConfig(paths).watch_dir, log);
}

async function boot(): Promise<void> {
  const server = await buildServer(paths, {
    version: app.getVersion(),
    update: { status: () => update, check: checkUpdate, install: () => autoUpdater.quitAndInstall() },
    openFolder: (dir) => void shell.openPath(dir),
    // O desinstalador do NSIS fica do lado do .exe. Não apaga %APPDATA%\SoloBand: músicas e gravações ficam.
    uninstall: () => {
      const exe = path.join(path.dirname(process.execPath), 'Uninstall SoloBand.exe');
      if (!app.isPackaged || !fs.existsSync(exe)) return false;
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 300);
      return true;
    },
    onConfigChange: startWatch,
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  // A janela abre em "localhost" (o servidor continua só no 127.0.0.1): o player do YouTube embutido (S14)
  // recusa tocar (erro 150) numa página aberta pelo número 127.0.0.1.
  const base = `http://localhost:${(server.server.address() as AddressInfo).port}`;
  log(`SoloBand ${app.getVersion()} em ${base}`);
  startWatch();

  // Microfone, área de transferência e a captura do player (separar ao vivo) liberados só pras telas do próprio app.
  const ALLOWED = ['media', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    done(wc.getURL().startsWith(base) && ALLOWED.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => origin.startsWith(base) && ALLOWED.includes(permission));
  // Separar ao vivo (S15): o player do YouTube roda num <webview> dentro da tela; a tela pede getDisplayMedia e
  // recebe só o som dele (que fica mudo nas caixas), sem mutar o resto (as faixas separadas, a gravação).
  const player = `${base}/yt-player.html`;
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const host = req.frame ? webContents.fromFrame(req.frame) : undefined;
    const ok = host && host.getURL().startsWith(base);
    const guest = ok ? webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.hostWebContents?.id === host.id && w.getURL().startsWith(player)) : undefined;
    if (!guest) return cb({});
    cb({ video: guest.mainFrame, audio: guest.mainFrame });
  });
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (url.startsWith(player)) return;
      e.preventDefault();
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    });
  });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'SoloBand',
    icon: path.join(paths.appDir, 'assets', 'icon.png'),
    backgroundColor: '#121211',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { webviewTag: true },
  });
  // O <webview> só pode abrir o player do próprio app, sem Node e sem preload.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    if (!String(params.src).startsWith(player)) return e.preventDefault();
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(base)) return;
    e.preventDefault();
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) win?.webContents.reload();
    if (input.key === 'F12') win?.webContents.toggleDevTools();
  });
  win.once('ready-to-show', () => win?.show());
  await win.loadURL(`${base}/`);
  setTimeout(() => void checkUpdate(), 5000);
}

app.whenReady().then(boot).catch((e) => {
  log(`erro ao abrir: ${(e as Error).stack}`);
  app.quit();
});
app.on('window-all-closed', () => {
  stopWatch();
  live.stop(); // solta a placa de vídeo
  app.quit();
});

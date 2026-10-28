// SoloBand: telas. Tudo roda no PC de quem usa; o servidor é o do próprio app.
const view = document.getElementById('view');

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data;
};
const send = (path, method, body) => api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function loadAlphaTab() {
  if (window.alphaTab) return Promise.resolve(window.alphaTab);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/alphatab/alphaTab.min.js';
    s.onload = () => resolve(window.alphaTab);
    s.onerror = () => reject(new Error('Não consegui carregar o leitor de tablatura.'));
    document.head.appendChild(s);
  });
}

/** A resposta do SoloBand (música com tudo dentro) no formato que a tela do Estúdio usa. */
function studioData(raw) {
  const s = raw.song;
  const guitar = raw.tab_tracks.find((t) => t.instrument === 'guitar') ?? raw.tab_tracks.find((t) => t.instrument !== 'drums') ?? raw.tab_tracks[0];
  return {
    song: { ...s, url_slug: s.id },
    tab_available: raw.tab_available,
    tab_tracks: raw.tab_tracks.map((t) => t.name),
    tab_track: guitar?.index ?? 0,
    state: s,
    sep_log: raw.separation_log,
  };
}

// ---------- Músicas ----------

let listPoll = null; // a lista se atualiza sozinha enquanto alguma música tá separando

async function songsView() {
  const songs = await api('/api/songs');
  clearInterval(listPoll);
  if (songs.some((s) => s.separation.status === 'running')) {
    const here = location.hash;
    const poll = (listPoll = setInterval(async () => {
      if (location.hash !== here) return clearInterval(poll);
      const now = await api('/api/songs');
      if (!now.some((s) => s.separation.status === 'running')) {
        clearInterval(poll);
        render();
      }
    }, 3000));
  }
  const row = (s) => {
    const sound = s.stems.length ? '🎧 MP3 separado' : s.separation.status === 'running' ? 'separando…' : s.original ? 'MP3 sem separar' : 'sem MP3';
    const takes = Object.entries(s.takes)
      .filter(([, t]) => t)
      .map(([k]) => TAKE_LABEL[k])
      .join(' · ');
    return `<a class="setlist-item" href="#/musica/${esc(s.id)}"><span class="what"><b>${esc(s.title)}</b>
      <span class="muted">${esc(s.artist)}${s.bpm ? ` · ${s.bpm} bpm` : ''} · ${sound}${s.tab_file ? ' · 🎼 Guitar Pro' : ''}${takes ? ` · Ensaio Atual: ${esc(takes)}` : ''}</span></span></a>`;
  };
  setTimeout(() => {
    document.getElementById('new-song').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const song = await send('/api/songs', 'POST', {
          title: f.get('title'),
          artist: f.get('artist') || undefined,
          bpm: f.get('bpm') ? Number(f.get('bpm')) : undefined,
        });
        location.hash = `#/musica/${song.id}`;
      } catch (err) {
        toast(err.message);
      }
    };
  }, 0);
  return `
    <h1>Músicas</h1>
    <p class="muted">Põe o MP3 (a tua cópia) e, se tiver, o Guitar Pro. O app separa voz, guitarras, baixo e bateria, e tu toca junto sem a tua parte.</p>
    ${songs.length ? `<div class="setlist">${songs.map(row).join('')}</div>` : '<div class="card first-time"><b>Primeira vez aqui?</b> Dá uma olhada no <a href="#/ajuda">Como usar</a>: são 3 passos.</div>'}
    <h2>Nova música</h2>
    <form id="new-song" class="card new-song">
      <input name="title" placeholder="Título" required>
      <input name="artist" placeholder="Artista">
      <input name="bpm" type="number" min="20" max="300" placeholder="BPM">
      <button class="btn primary">Adicionar</button>
    </form>`;
}

// ---------- Como usar ----------

async function helpView() {
  const sep = await api('/api/separator').catch(() => ({ installed: false }));
  const step = (n, title, body) => `<div class="card help-step"><span class="help-n">${n}</span><div><h3>${title}</h3>${body}</div></div>`;
  return `
    <h1>Como usar</h1>
    <p class="muted">O SoloBand toca a música <b>sem a tua parte</b> pra tu tocar junto, e grava por cima pra tu ouvir como ficou. Tudo fica no teu PC.</p>

    <h2>Antes de tudo (uma vez só)</h2>
    ${step('0', 'Baixar o separador de faixas', `
      <p>É ele que separa o MP3 em <b>voz, guitarras, baixo e bateria</b>. ${sep.installed ? '<b class="good">✅ Já tá instalado.</b>' : '<b>Ainda não tá instalado.</b>'}</p>
      <ul>
        <li>Vai em <a href="#/config">Configurações</a> → <b>Baixar o separador</b> e espera terminar.</li>
        <li>Com placa de vídeo NVIDIA, separa uma música em uns 20 segundos. Sem, em 1 a 3 minutos.</li>
        <li>Não quer baixar? Dá pra usar só o som do Guitar Pro (sem voz, som de teclado).</li>
      </ul>`)}

    <h2>Pra cada música</h2>
    ${step('1', 'Cadastrar a música', `
      <p>Em <a href="#/">Músicas</a>, escreve o <b>título</b> (o artista e o BPM são opcionais) e clica em <b>Adicionar</b>.</p>`)}
    ${step('2', 'Subir os arquivos', `
      <table class="help-files">
        <tr><th>Arquivo</th><th>Precisa?</th><th>Pra quê</th></tr>
        <tr><td>🎧 <b>MP3</b> da música<br><span class="muted">também vale m4a, wav, flac, ogg</span></td><td><b>Sim</b> (ou o Guitar Pro)</td><td>A música de verdade, separada em faixas. Clica em <b>Escolher arquivo</b> e espera a barrinha "Separando…".</td></tr>
        <tr><td>🎼 <b>Guitar Pro</b> (.gp, .gp5, .gpx)</td><td>Opcional</td><td>Mostra a <b>tab andando</b> junto com a música e serve de som reserva. Clica em <b>Pôr o Guitar Pro</b>, ou baixa na pasta <b>Downloads</b> que ele entra sozinho na música de mesmo nome.</td></tr>
      </table>
      <p class="muted">O SoloBand não baixa música nem tab: usa a tua cópia.</p>`)}
    ${step('3', 'Tocar junto', `
      <ul>
        <li>Clica no teu instrumento: <b>🎸 Vou tocar guitarra</b>, <b>🎸 baixo</b>, <b>🥁 bateria</b> ou <b>🎤 Vou cantar</b>. A tua parte fica bem baixinha; o resto toca normal.</li>
        <li>Marca <b>🥢 4 baquetadas</b> pra ter a contagem antes de entrar.</li>
        <li><b>▶ Tocar.</b> Quer mudar alguma faixa? Usa o volume ou o 🔊 dela no <b>Mixer</b>.</li>
        <li>A <b>🎼 Tab acompanhando</b> anda junto. Se estiver fora do tempo, clica em <b>Achar sozinho</b> ou usa o − / +.</li>
      </ul>`)}
    ${step('4', 'Gravar por cima (se quiser)', `
      <ol>
        <li>Em <b>Gravar por cima</b>, escolhe <b>o quê</b> (guitarra, baixo ou voz) e a <b>entrada</b> (tua placa de som, interface ou pedaleira).</li>
        <li><b>⏺ Gravar</b> → toca → <b>⏹ Parar gravação</b>.</li>
        <li><b>▶ Ouvir junto.</b> Gostou? <b>💾 Salvar como Ensaio Atual</b>. Não gostou? <b>Descartar</b> e grava de novo.</li>
        <li>Pra cantar em cima da tua guitarra gravada: <b>🎤 Vou cantar</b>. A tua gravação entra no lugar da original.</li>
      </ol>`)}

    <h2>Se algo ficar estranho</h2>
    <div class="card">
      <p><b>Gravação um pouco atrasada ou adiantada?</b> Usa o − / + na linha dela. Se acontece sempre, ajusta o <b>Sync</b> (na parte de gravar) uma vez.</p>
      <p><b>Me ouço atrasado no fone?</b> Passando pelo PC sempre tem um atrasinho. Pra zero atraso, liga o fone direto na tua pedaleira/interface e deixa o <b>🎧 Me ouvir</b> desligado.</p>
      <p><b>Pediu permissão de microfone?</b> Pode permitir: é pra gravar. Nada sai do teu PC.</p>
      <p><b>Tirei uma música ou gravação sem querer.</b> O app nunca apaga: tá na pasta <b>antigas</b> (Configurações → Teus dados → Abrir a pasta).</p>
    </div>`;
}

// ---------- Novidades ----------

// O que mudou em cada versão (public/novidades.json). Aparece uma vez quando abre uma versão nova.
const bold = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const notesHtml = (n) => `<p class="muted">Versão ${esc(n.version)} · ${esc(n.date.split('-').reverse().join('/'))}</p><ul>${n.items.map((i) => `<li>${bold(i)}</li>`).join('')}</ul>`;

async function showWhatsNew() {
  let seen = null;
  try {
    seen = localStorage.getItem('soloband.seenVersion');
  } catch {}
  const [{ version }, notes] = await Promise.all([api('/api/config'), fetch('/novidades.json').then((r) => r.json())]);
  const markSeen = () => {
    try {
      localStorage.setItem('soloband.seenVersion', version);
    } catch {}
  };
  // Primeira vez no app: nada de novidade (é tudo novo); só lembra a versão.
  if (!seen) return markSeen();
  if (seen === version) return;
  const news = notes.filter((n) => n.version.localeCompare(seen, undefined, { numeric: true }) > 0);
  markSeen();
  if (!news.length) return;
  const box = document.createElement('div');
  box.className = 'whats-new';
  box.innerHTML = `<div class="card"><h2>🎉 Novidades da ${esc(version)}</h2>${news.map(notesHtml).join('')}<button class="btn primary">Beleza</button></div>`;
  box.querySelector('button').onclick = () => box.remove();
  box.onclick = (e) => e.target === box && box.remove();
  document.body.appendChild(box);
}

// ---------- Configurações ----------

async function settingsView() {
  const [cfg, sep, upd, notes] = await Promise.all([api('/api/config'), api('/api/separator'), api('/api/update'), fetch('/novidades.json').then((r) => r.json())]);
  const sepHtml = (st) =>
    st.installed
      ? `<p>✅ Separador instalado${st.gpu === true ? ' (usando a placa NVIDIA)' : st.gpu === false ? ' (usando o processador: separa em 1–3 min por música)' : ''}.</p>
         <button id="sep-remove" class="btn">Remover o separador</button>
         <p class="muted">Libera de 1 a 3 GB. As músicas que já foram separadas continuam funcionando; só não separa MP3 novo até baixar de novo.</p>`
      : st.installing
        ? `<p><b>Instalando…</b> ${esc(st.step ?? '')}</p><pre class="log">${esc(st.log.split('\n').slice(-6).join('\n'))}</pre>`
        : `<p>Sem o separador, o app usa o som do Guitar Pro. Com ele, separa o MP3 de verdade.</p>
           ${st.error ? `<p class="bad">${esc(st.error)}</p>` : ''}
           <button id="sep-install" class="btn primary">Baixar o separador</button>
           <p class="muted">Com placa NVIDIA: uns 3 GB. Sem: uns 800 MB. Fica tudo dentro da pasta de dados do SoloBand.</p>`;
  // Download diferencial (só o que mudou) pode não mandar porcentagem: aí mostra só "Baixando…".
  const updText = (u) =>
    ({
      dev: 'Modo de desenvolvimento: sem atualização.',
      idle: '',
      checking: 'Procurando…',
      none: 'Tá na versão mais nova.',
      downloading: `Baixando a versão ${u.version ?? ''}…${u.percent ? ` ${u.percent}%` : ''}`,
      ready: `Versão ${u.version ?? ''} pronta.`,
      error: `Não deu pra procurar: ${u.error ?? ''}`,
    })[u.state] ?? '';
  setTimeout(() => {
    document.getElementById('cfg-form').onsubmit = async (e) => {
      e.preventDefault();
      await send('/api/config', 'PUT', { watch_dir: new FormData(e.target).get('watch_dir') });
      toast('Salvo.');
    };
    for (const b of document.querySelectorAll('[data-open]')) b.onclick = () => send('/api/open-folder', 'POST', { which: b.dataset.open });
    document.getElementById('sep-install')?.addEventListener('click', async () => {
      await send('/api/separator/install', 'POST');
      render();
    });
    if (sep.installing) {
      const poll = setInterval(async () => {
        if (location.hash !== '#/config') return clearInterval(poll);
        const st = await api('/api/separator');
        document.getElementById('sep-box').innerHTML = sepHtml(st);
        if (!st.installing) {
          clearInterval(poll);
          render();
        }
      }, 2000);
    }
    document.getElementById('sep-remove')?.addEventListener('click', async () => {
      if (!confirm('Remover o separador? Libera de 1 a 3 GB. As músicas já separadas continuam funcionando, e dá pra baixar de novo quando quiser.')) return;
      try {
        await send('/api/separator/remove', 'POST');
        toast('Separador removido.');
        render();
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('app-uninstall')?.addEventListener('click', async () => {
      if (!confirm(`Desinstalar o SoloBand?

Tuas músicas e gravações NÃO são apagadas: ficam em ${cfg.data_dir}. Se instalar de novo, tá tudo lá.`)) return;
      try {
        await send('/api/uninstall', 'POST');
      } catch (err) {
        toast(err.message);
      }
    });
    document.getElementById('upd-check')?.addEventListener('click', async () => {
      await send('/api/update/check', 'POST');
      render();
    });
    // Procurando/baixando: acompanha até terminar e aí redesenha (aparece o "Reiniciar e atualizar").
    if (upd.state === 'checking' || upd.state === 'downloading') {
      const poll = setInterval(async () => {
        if (location.hash !== '#/config') return clearInterval(poll);
        const st = await api('/api/update');
        const el = document.getElementById('upd-text');
        if (el) el.textContent = updText(st);
        if (st.state !== 'checking' && st.state !== 'downloading') {
          clearInterval(poll);
          render();
        }
      }, 1500);
    }
    document.getElementById('upd-install')?.addEventListener('click', () => send('/api/update/install', 'POST'));
  }, 0);
  return `
    <h1>Configurações</h1>
    <h2>Pasta vigiada</h2>
    <form id="cfg-form" class="card cfg-row">
      <p class="muted">Arquivo Guitar Pro (.gp) que chegar nessa pasta entra sozinho na música com o mesmo título (ou vira música nova).</p>
      <input name="watch_dir" value="${esc(cfg.watch_dir)}" placeholder="Ex.: C:\\Users\\voce\\Downloads (vazio = não vigia)">
      <div><button class="btn primary">Salvar</button> <button type="button" class="btn" data-open="watch">Abrir a pasta</button></div>
    </form>
    <h2>Separador de faixas</h2>
    <div class="card" id="sep-box">${sepHtml(sep)}</div>
    <h2>Teus dados</h2>
    <div class="card cfg-row"><p class="muted">Músicas, faixas e gravações ficam só neste PC: <code>${esc(cfg.data_dir)}</code></p>
      <div><button class="btn" data-open="data">Abrir a pasta</button></div></div>
    <h2>Versão</h2>
    <div class="card cfg-row"><p>SoloBand ${esc(cfg.version)} <span class="muted" id="upd-text">${esc(updText(upd))}</span></p>
      <div>${upd.state === 'ready' ? '<button id="upd-install" class="btn primary">Reiniciar e atualizar</button>' : upd.state === 'dev' ? '' : '<button id="upd-check" class="btn">Procurar atualização</button>'}</div></div>
    <h2>O que mudou</h2>
    <div class="card changelog">${notes.map(notesHtml).join('')}</div>
    <h2>Desinstalar</h2>
    <div class="card cfg-row"><p class="muted">Tira o SoloBand do PC. Tuas músicas e gravações ficam guardadas na pasta de dados (dá pra apagar na mão depois, se quiser). Pra liberar espaço sem desinstalar, remove só o separador aqui em cima.</p>
      <div><button id="app-uninstall" class="btn">Desinstalar o SoloBand</button></div></div>`;
}

// ---------- Estúdio (vindo do Vida de Jão): mixer, separação, tab acompanhando e gravar por cima. ----------

const STEM_LABEL = { vocals: '🎤 Voz', guitar: '🎸 Guitarras (violão + guitarra)', bass: 'Baixo', drums: 'Bateria', piano: 'Teclado', other: 'Outros' };
const TAKE_LABEL = { guitar: '🎸 Minha guitarra/violão', bass: '🎸 Meu baixo', vocal: '🎤 Minha voz' };

/** Toca várias faixas juntas, cada uma com volume, mudo e um início próprio (gravação começa no meio da música). */
class Mixer {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.tracks = new Map(); // id → { buffer, gain, offset, volume, muted }
    this.sources = [];
    this.playing = false;
    this.startPos = 0; // posição na música (s) quando deu play
    this.startedAt = 0; // relógio do AudioContext quando o som sai
    this.onEnd = null;
  }
  add(id, buffer, { offset = 0, volume = 1, muted = false } = {}) {
    this.remove(id);
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    this.tracks.set(id, { buffer, gain, offset, volume, muted });
    this.apply(id);
    if (this.playing) this.seek(this.position());
  }
  remove(id) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.gain.disconnect();
    this.tracks.delete(id);
  }
  apply(id) {
    const t = this.tracks.get(id);
    if (t) t.gain.gain.setTargetAtTime(t.muted ? 0 : t.volume, this.ctx.currentTime, 0.02);
  }
  set(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.apply(id);
    if ('offset' in patch && this.playing) this.seek(this.position());
  }
  duration() {
    return Math.max(0, ...[...this.tracks.values()].map((t) => t.offset + t.buffer.duration));
  }
  position() {
    return this.playing ? Math.max(0, this.startPos + (this.ctx.currentTime - this.startedAt)) : this.startPos;
  }
  /**
   * Começa a tocar em `pos` e devolve o instante (relógio do AudioContext) em que a música sai.
   * `countIn` = { beats, bpm }: antes, as baquetadas no tempo da música (a música entra no tempo seguinte).
   */
  play(pos = this.position(), countIn = null) {
    this.stopSources();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const first = this.ctx.currentTime + 0.12;
    const beat = countIn ? 60 / countIn.bpm : 0;
    for (let i = 0; i < (countIn?.beats ?? 0); i++) this.sources.push(this.stick(first + i * beat));
    const when = first + (countIn?.beats ?? 0) * beat;
    for (const t of this.tracks.values()) {
      const rel = pos - t.offset;
      if (rel >= t.buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      src.start(when + Math.max(0, -rel), Math.max(0, rel));
      this.sources.push(src);
    }
    this.playing = true;
    this.startPos = pos;
    this.startedAt = when;
    this.onPlay?.(pos, when);
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.playing && this.position() >= this.duration() - 0.05 && (this.pause(), this.onEnd?.()), (when - this.ctx.currentTime + this.duration() - pos) * 1000 + 300);
    return when;
  }
  /** Uma baquetada: estalo curto de ruído, agudo, sem precisar de arquivo de som. */
  stick(at) {
    this.stickBuf ??= (() => {
      const b = this.ctx.createBuffer(1, Math.round(this.ctx.sampleRate * 0.05), this.ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.006));
      return b;
    })();
    const src = this.ctx.createBufferSource();
    src.buffer = this.stickBuf;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2800;
    band.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.value = 1.6;
    src.connect(band).connect(g).connect(this.ctx.destination);
    src.start(at);
    return src;
  }
  pause() {
    this.startPos = Math.min(this.position(), this.duration());
    this.playing = false;
    this.stopSources();
    this.onPause?.();
  }
  seek(pos) {
    if (this.playing) this.play(pos);
    else this.startPos = pos;
  }
  stopSources() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources = [];
  }
  /** Atraso da saída: o que o João ouve sai do alto-falante/fone este tanto depois. */
  outputLatency() {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }
  close() {
    this.stopSources();
    this.ctx.close();
  }
}

// Gravador dentro do mesmo AudioContext (AudioWorklet): cada pedaço chega com o horário exato do relógio,
// então dá pra saber onde a gravação cai na música, descontando o atraso de entrada e de saída.
const REC_WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data === 'start'; }; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      let peak = 0;
      for (const c of ch) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
      this.port.postMessage({ t: currentTime, peak, data: this.on ? ch.map((c) => c.slice(0)) : null });
    }
    return true;
  }
}
registerProcessor('vida-rec', Rec);`;

class Recorder {
  constructor(mixer) {
    this.mixer = mixer;
    this.chunks = [];
    this.firstT = null;
    this.channel = 'mix';
    this.onLevel = null;
  }
  async open(deviceId) {
    this.close();
    const ctx = this.mixer.ctx;
    if (!Recorder.loaded?.has(ctx)) {
      const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      (Recorder.loaded ??= new WeakSet()).add(ctx);
    }
    this.deviceId = deviceId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'vida-rec', { channelCount: 2, channelCountMode: 'explicit' });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0; // só pra manter o gravador rodando
    this.src.connect(this.node).connect(this.sink).connect(ctx.destination);
    // "Me ouvir": o canal escolhido, em mono nos dois ouvidos, com volume próprio (passa pelo PC: tem atraso).
    this.splitter = ctx.createChannelSplitter(2);
    this.mono = ctx.createGain();
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.src.connect(this.splitter);
    this.mono.connect(this.monitor).connect(ctx.destination);
    this.routeMonitor();
    this.setMonitor(this.monitorOn, this.monitorVol);
    this.node.port.onmessage = (e) => {
      const { t, peak, data } = e.data;
      this.onLevel?.(peak);
      if (!data) return;
      if (this.firstT === null) this.firstT = t;
      this.chunks.push(data);
    };
  }
  /** Liga o canal escolhido (1, 2 ou a média dos dois) no "Me ouvir". */
  routeMonitor() {
    if (!this.splitter) return;
    this.splitter.disconnect();
    for (const g of this.monoTaps ?? []) g.disconnect();
    const taps = this.channel === '1' ? [0] : this.channel === '2' ? [1] : [0, 1];
    this.monoTaps = taps.map((ch) => {
      const g = this.mixer.ctx.createGain();
      g.gain.value = 1 / taps.length;
      this.splitter.connect(g, ch);
      g.connect(this.mono);
      return g;
    });
  }
  setMonitor(on, volume = 1) {
    this.monitorOn = on;
    this.monitorVol = volume;
    this.monitor?.gain.setTargetAtTime(on ? volume : 0, this.mixer.ctx.currentTime, 0.02);
  }
  isOpen(deviceId) {
    return Boolean(this.stream && this.stream.active && this.deviceId === deviceId);
  }
  /** Atraso da entrada (placa de som → navegador), quando o navegador informa. */
  inputLatency() {
    return this.stream?.getAudioTracks()[0]?.getSettings().latency || 0;
  }
  start() {
    this.chunks = [];
    this.firstT = null;
    this.node.port.postMessage('start');
  }
  stop() {
    this.node.port.postMessage('stop');
    const len = this.chunks.reduce((n, c) => n + c[0].length, 0);
    const mono = new Float32Array(len);
    let at = 0;
    for (const c of this.chunks) {
      const a = c[0];
      const b = c[1] ?? a;
      for (let i = 0; i < a.length; i++) mono[at + i] = this.channel === '1' ? a[i] : this.channel === '2' ? b[i] : (a[i] + b[i]) / 2;
      at += a.length;
    }
    return { samples: mono, firstT: this.firstT, sampleRate: this.mixer.ctx.sampleRate };
  }
  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.src?.disconnect();
    this.node?.disconnect();
    this.monitor?.disconnect();
    this.stream = null;
    this.splitter = this.monitor = null;
  }
}

/** WAV 16 bits. `channels` = um Float32Array por canal (1 = mono, 2 = estéreo). */
function wavBlob(samples, sampleRate, channels = [samples]) {
  const n = channels[0].length;
  const ch = channels.length;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * ch * 2, true);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, channels[c][i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Reserva (D53): sem faixas separadas, cada faixa do Guitar Pro vira áudio pelo sintetizador do alphaTab. */
async function midiStems(songId, ctx, onProgress) {
  const at = await loadAlphaTab();
  const res = await fetch(`/api/songs/${songId}/tab`);
  if (!res.ok) throw new Error('Sem arquivo de tab pra usar o som do Guitar Pro.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:-9999px;width:800px;height:10px;overflow:hidden';
  document.body.appendChild(box);
  const api = new at.AlphaTabApi(box, {
    core: { fontDirectory: '/vendor/alphatab/font/', scriptFile: new URL('/vendor/alphatab/alphaTab.min.js', location.href).href, useWorkers: true },
    display: { staveProfile: at.StaveProfile.Tab },
    player: { playerMode: at.PlayerMode.EnabledSynthesizer, soundFont: '/vendor/alphatab/soundfont/sonivox.sf2' },
  });
  try {
    const ready = new Promise((ok) => api.playerReady.on(ok));
    const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings);
    api.renderScore(score, score.tracks.map((t) => t.index));
    await ready;
    const out = [];
    for (const track of score.tracks) {
      onProgress?.(`Gerando ${track.name}…`);
      const opts = new at.synth.AudioExportOptions();
      opts.sampleRate = ctx.sampleRate;
      opts.trackVolume = new Map(score.tracks.map((t) => [t.index, t.index === track.index ? 1 : 0]));
      const exporter = await api.exportAudio(opts);
      const parts = [];
      let lastMs = 0;
      let total = 0;
      for (;;) {
        const chunk = await exporter.render(2000);
        if (!chunk) break;
        // Estéreo intercalado (E, D, E, D…) ou mono: descobre pelo tamanho do pedaço.
        const ms = chunk.currentTime - lastMs || 2000;
        lastMs = chunk.currentTime;
        const stereo = chunk.samples.length / ((ms / 1000) * ctx.sampleRate) > 1.5;
        parts.push({ s: chunk.samples, stereo });
        total += stereo ? chunk.samples.length / 2 : chunk.samples.length;
      }
      exporter.destroy?.();
      const buf = ctx.createBuffer(2, Math.max(1, total), ctx.sampleRate);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      let i = 0;
      for (const { s, stereo } of parts) {
        if (stereo) for (let k = 0; k < s.length; k += 2, i++) (L[i] = s[k]), (R[i] = s[k + 1]);
        else for (let k = 0; k < s.length; k++, i++) L[i] = R[i] = s[k];
      }
      out.push({ id: `midi:${track.index}`, label: `${track.staves[0]?.isPercussion ? '🥁' : '🎼'} ${track.name}`, buffer: buf });
    }
    return out;
  } finally {
    api.destroy();
    box.remove();
  }
}

/**
 * Tab do Guitar Pro com cursor, MUDA, andando junto com o mixer do Estúdio.
 * O compasso 1 cai em `getOffset()` segundos do MP3 (Ela Vai Voltar: 0,91 s). O player do alphaTab toca com
 * volume zero só pra mexer o cursor; a cada 2 s confere com o relógio do mixer e corrige se escorregar.
 */
async function mountStudioTab(songId, box, mixer, getOffset, trackIndex) {
  const at = await loadAlphaTab();
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const tabApi = new at.AlphaTabApi(box, {
    core: { fontDirectory: '/vendor/alphatab/font/', scriptFile: new URL('/vendor/alphatab/alphaTab.min.js', location.href).href, useWorkers: true },
    display: {
      staveProfile: at.StaveProfile.Tab,
      scale: 0.85,
      resources: {
        staffLineColor: '#55534d',
        barSeparatorColor: '#8a877f',
        barNumberColor: color('--accent'),
        mainGlyphColor: color('--text'),
        secondaryGlyphColor: 'rgba(236,235,231,0.45)',
        scoreInfoColor: color('--text'),
      },
    },
    player: {
      playerMode: at.PlayerMode.EnabledSynthesizer,
      soundFont: '/vendor/alphatab/soundfont/sonivox.sf2',
      enableCursor: true,
      enableAnimatedBeatCursor: true,
      enableUserInteraction: false,
      scrollMode: at.ScrollMode.Continuous,
      scrollElement: box,
    },
  });
  const res = await fetch(`/api/songs/${songId}/tab`);
  if (!res.ok) throw new Error('Não consegui abrir o arquivo da tab.');
  const score = at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await res.arrayBuffer()), tabApi.settings);
  const ready = new Promise((ok) => tabApi.playerReady.on(ok));
  tabApi.renderScore(score, [trackIndex]);
  await ready;
  tabApi.masterVolume = 0; // só o cursor: o som é o do mixer
  let startTimer = 0;
  let settleTimer = 0;
  const gpMs = () => (mixer.position() - getOffset()) * 1000;
  // O alphaTab leva uns 70 ms pra arrancar depois do play(): a tab já sai esse tanto na frente.
  const START_LAG_MS = 70;
  // Pausar e mandar pular logo em seguida faz o alphaTab voltar pro começo: espera ele assentar antes de pular.
  const SETTLE_MS = 160;
  const sync = (pos, when) => {
    clearTimeout(startTimer);
    clearTimeout(settleTimer);
    tabApi.pause();
    const gp = (pos - getOffset()) * 1000;
    // Espera o som sair (0,12 s + baquetadas) e, se ainda não chegou no compasso 1, mais o que falta.
    const wait = Math.max(SETTLE_MS, Math.max(0, when - mixer.ctx.currentTime) * 1000 + Math.max(0, -gp) - START_LAG_MS);
    startTimer = setTimeout(() => {
      if (!mixer.playing) return;
      tabApi.timePosition = Math.max(0, gpMs() + START_LAG_MS);
      tabApi.play();
    }, wait);
  };
  mixer.onPlay = sync;
  mixer.onPause = () => {
    clearTimeout(startTimer);
    tabApi.pause();
    settleTimer = setTimeout(() => (tabApi.timePosition = Math.max(0, gpMs())), SETTLE_MS);
  };
  // Confere com o relógio do mixer; escorregou mais de 40 ms, acerta (pulando enquanto toca, que não dá problema).
  const drift = setInterval(() => {
    if (!mixer.playing || gpMs() < 0 || tabApi.playerState !== 1) return;
    if (Math.abs(tabApi.timePosition - gpMs()) > 40) tabApi.timePosition = gpMs();
  }, 1000);
  return {
    api: tabApi,
    setTrack: (i) => tabApi.renderScore(score, [i]),
    resync: () => (mixer.playing ? sync(mixer.position(), mixer.ctx.currentTime) : mixer.onPause()),
    destroy: () => {
      clearTimeout(startTimer);
      clearTimeout(settleTimer);
      clearInterval(drift);
      mixer.onPlay = mixer.onPause = null;
      tabApi.destroy();
    },
  };
}

let studioSession = null; // { mixer, recorder, slug } da tela aberta; fecha ao sair
let sepPoll = null; // acompanhamento da separação: um só, mesmo se a tela redesenhar no meio

function closeStudio() {
  clearInterval(sepPoll);
  if (!studioSession) return;
  clearInterval(studioSession.timer);
  studioSession.tab?.destroy();
  studioSession.recorder?.close();
  studioSession.mixer?.close();
  studioSession = null;
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// "Sync": atraso extra do headset do João, descontado de toda gravação nova (vale pra todas as músicas).
const STUDIO_SYNC_KEY = 'soloband.studio.syncMs';
function loadStudioSync() {
  try {
    return Number(localStorage.getItem(STUDIO_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

// Volumes e a fonte escolhida (Guitar Pro ou MP3), por música, só neste navegador.
function studioPrefs(slug) {
  try {
    return JSON.parse(localStorage.getItem(`soloband.studio.${slug}`) ?? '{}');
  } catch {
    return {};
  }
}
function saveStudioPrefs(slug, prefs) {
  try {
    localStorage.setItem(`soloband.studio.${slug}`, JSON.stringify(prefs));
  } catch {}
}

async function studioSongView(ref) {
  closeStudio();
  const d = studioData(await api(`/api/songs/${encodeURIComponent(ref)}`));
  const { song: s, state } = d;
  const sep = state.separation;
  // Qual som da banda: o que o João escolheu; senão o MP3 se já tá separado; senão o Guitar Pro.
  const has = { gp: d.tab_available, mp3: state.stems.length > 0 };
  const wanted = studioPrefs(s.url_slug).source;
  const source = has[wanted] ? wanted : has.mp3 ? 'mp3' : has.gp ? 'gp' : null;
  const fileInput = '<input id="st-file" type="file" accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*" hidden>';
  // Log do separador (o que ele tá fazendo, ou onde parou), fechado por padrão.
  const sepLog = d.sep_log?.lines.length
    ? `<details class="sep-log"><summary>Ver log</summary><pre class="log" id="st-log">${esc(d.sep_log.lines.join('\n'))}</pre></details>`
    : '';
  const mp3Card = !state.original
    ? `<div class="card studio-source">
         <p><b>Põe o MP3 da música</b> (ou m4a do iTunes, wav, flac: a tua cópia). O app separa voz, guitarras, baixo e bateria sozinho, em menos de 1 minuto.</p>
         <label class="btn primary file-btn">Escolher arquivo${fileInput}</label>
       </div>`
    : sep.status === 'running'
      ? `<div class="card studio-source"><p><b>Separando as faixas do MP3…</b> <span id="st-progress">${sep.progress}%</span></p><div class="bar"><span id="st-bar" style="width:${sep.progress}%"></span></div>
           <p class="muted sep-step" id="st-step">${esc(d.sep_log?.step ?? 'Abrindo o separador…')}</p>${sepLog || '<details class="sep-log"><summary>Ver log</summary><pre class="log" id="st-log"></pre></details>'}</div>`
      : sep.status === 'error'
        ? `<div class="card studio-source"><p><b>Não deu pra separar o MP3.</b> ${esc(sep.error ?? '')}</p>
             <p><button id="st-retry" class="btn">Tentar de novo</button> <label class="btn file-btn">Trocar o MP3${fileInput}</label></p>${sepLog}</div>`
        : `<p class="muted studio-src-line">MP3 separado em faixas pelo Demucs${sep.device === 'cuda' ? ' (GPU)' : ''}. <label class="link-btn file-btn">Trocar o MP3${fileInput}</label></p>`;
  const sourcePicker = `
    <div class="seg" role="group" aria-label="Som da banda">
      <button class="${source === 'gp' ? 'active' : ''}" data-src="gp" ${has.gp ? '' : 'disabled'}>🎼 Usar Guitar Pro<span>${has.gp ? 'som do arquivo da tab, sem voz' : 'essa música não tem arquivo Guitar Pro'}</span></button>
      <button class="${source === 'mp3' ? 'active' : ''}" data-src="mp3" ${has.mp3 ? '' : 'disabled'}>🎧 Usar MP3<span>${has.mp3 ? 'a música de verdade, separada' : sep.status === 'running' ? 'separando…' : 'ainda sem MP3'}</span></button>
    </div>`;
  setTimeout(() => {
    for (const b of document.querySelectorAll('[data-src]')) {
      b.onclick = () => {
        saveStudioPrefs(s.url_slug, { ...studioPrefs(s.url_slug), source: b.dataset.src });
        render();
      };
    }
    wireStudioSource(d);
    if (source) mountStudio(d, source).catch((e) => toast(e.message));
  }, 0);
  return `
    <p class="song-top"><a href="#/">← Músicas</a> <button id="st-del" class="btn small">Tirar da lista</button></p>
    <h1>${esc(s.title)}</h1>
    <div class="muted">${esc(s.artist)}${s.tuning && s.tuning !== 'E padrão' ? ` · ${esc(s.tuning)}` : ''}${s.bpm ? ` · ${s.bpm} bpm` : ''}</div>
    <h2>Som da banda</h2>
    ${sourcePicker}
    ${mp3Card}
    <p class="muted studio-src-line">${d.tab_available ? 'Guitar Pro na música.' : 'Sem Guitar Pro.'} <label class="link-btn file-btn">${d.tab_available ? 'Trocar o Guitar Pro' : 'Pôr o Guitar Pro (.gp)'}<input id="st-gp" type="file" accept=".gp,.gp3,.gp4,.gp5,.gpx,.gp7" hidden></label> <span class="muted">· ou baixa na pasta vigiada que ele entra sozinho</span></p>
    <div id="st-main" class="studio-main">${source ? '<p class="muted" id="st-loading">Carregando as faixas…</p>' : '<p class="empty">Sem som da banda ainda: põe o MP3 aí em cima.</p>'}</div>`;
}

/** Upload do MP3 e acompanhamento da separação. */
function wireStudioSource(d) {
  const slug = d.song.url_slug;
  document.getElementById('st-file')?.addEventListener('change', async (e) => {
    let file = e.target.files[0];
    if (!file) return;
    // m4a/aac (iTunes) e afins: o separador não lê, então o navegador converte pra WAV antes de mandar.
    if (!/\.(mp3|wav|flac|ogg)$/i.test(file.name)) {
      toast(`Convertendo ${file.name}…`);
      try {
        const ctx = new OfflineAudioContext(2, 1, 44100);
        const audio = await ctx.decodeAudioData(await file.arrayBuffer());
        const chans = [audio.getChannelData(0), audio.getChannelData(audio.numberOfChannels > 1 ? 1 : 0)];
        file = new File([wavBlob(null, audio.sampleRate, chans)], file.name.replace(/\.[^.]+$/, '') + '.wav');
      } catch {
        return toast('Não consegui ler esse arquivo. Tenta mp3, m4a, wav ou flac.');
      }
    }
    toast(`Enviando ${file.name}…`);
    const res = await fetch(`/api/songs/${encodeURIComponent(slug)}/audio`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file });
    const data = await res.json();
    if (!res.ok) return toast(data.error);
    saveStudioPrefs(slug, { ...studioPrefs(slug), source: 'mp3' });
    render();
  });
  document.getElementById('st-gp')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = await fetch(`/api/songs/${encodeURIComponent(slug)}/tab`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file });
    const data = await res.json();
    if (!res.ok) return toast(data.error);
    toast('Guitar Pro na música.');
    render();
  });
  document.getElementById('st-del')?.addEventListener('click', async () => {
    if (!confirm(`Tirar "${d.song.title}" da lista? Os arquivos ficam guardados na pasta de antigas.`)) return;
    await fetch(`/api/songs/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    location.hash = '#/';
  });
  document.getElementById('st-retry')?.addEventListener('click', async () => {
    await fetch(`/api/songs/${encodeURIComponent(slug)}/separate`, { method: 'POST' });
    render();
  });
  clearInterval(sepPoll);
  if (d.state.separation.status === 'running') {
    const poll = (sepPoll = setInterval(async () => {
      if (location.hash !== `#/musica/${slug}`) return clearInterval(poll);
      const now = studioData(await api(`/api/songs/${encodeURIComponent(slug)}`));
      const st = now.state;
      const p = document.getElementById('st-progress');
      if (p) p.textContent = `${st.separation.progress}%`;
      const b = document.getElementById('st-bar');
      if (b) b.style.width = `${st.separation.progress}%`;
      const stepEl = document.getElementById('st-step');
      if (stepEl && now.sep_log?.step) stepEl.textContent = now.sep_log.step;
      const logEl = document.getElementById('st-log');
      if (logEl && now.sep_log) {
        // Só desce sozinho se a pessoa já tava lendo o fim do log.
        const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
        logEl.textContent = now.sep_log.lines.join('\n');
        if (atEnd) logEl.scrollTop = logEl.scrollHeight;
      }
      if (st.separation.status !== 'running') {
        clearInterval(poll);
        render();
      }
    }, 1500));
  }
}

async function mountStudio(d, source) {
  const { song: s, state } = d;
  const main = document.getElementById('st-main');
  if (!main) return;
  const slug = s.url_slug;
  const mixer = new Mixer();
  const session = (studioSession = { mixer, recorder: null, slug });
  const prefs = studioPrefs(slug);
  // Volume é por fonte: "guitarras" do MP3 e as faixas do Guitar Pro não se misturam.
  prefs[source] ??= {};
  const vols = prefs[source];
  const savePrefs = () => saveStudioPrefs(slug, prefs);
  // Faixas: as separadas do MP3, ou cada faixa do Guitar Pro virada em áudio.
  const decode = async (url) => mixer.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const base = `/api/songs/${encodeURIComponent(slug)}/files`;
  const loading = (msg) => {
    const l = document.getElementById('st-loading');
    if (l) l.textContent = msg;
  };
  const tracks =
    source === 'mp3'
      ? await Promise.all(
          state.stems.map(async (id) => {
            const buffer = await decode(`${base}/faixas/${id}.flac`);
            loading(`Carregando ${STEM_LABEL[id] ?? id}…`);
            return { id, label: STEM_LABEL[id] ?? id, buffer };
          }),
        )
      : await midiStems(s.id, mixer.ctx, loading);
  if (studioSession !== session) return mixer.close();
  const vol = (id, def = 1) => vols[id]?.v ?? def;
  const muted = (id) => vols[id]?.m ?? false;
  for (const t of tracks) mixer.add(t.id, t.buffer, { volume: vol(t.id), muted: muted(t.id) });
  const takes = {};
  for (const kind of ['guitar', 'bass', 'vocal']) {
    const tk = state.takes[kind];
    if (!tk) continue;
    takes[kind] = tk;
    mixer.add(`take:${kind}`, await decode(`${base}/gravacoes/${tk.file}`), { offset: (tk.offset_ms + tk.nudge_ms) / 1000, volume: vol(`take:${kind}`), muted: muted(`take:${kind}`) });
  }
  if (studioSession !== session) return mixer.close();

  const rowHtml = (id, label, extra = '') => {
    const t = mixer.tracks.get(id);
    return `<div class="mix-row" data-id="${esc(id)}">
        <button class="mute ${t.muted ? 'on' : ''}" data-mute aria-pressed="${t.muted}" title="Tirar/voltar">${t.muted ? '🔇' : '🔊'}</button>
        <span class="mix-name">${esc(label)}</span>
        <input type="range" min="0" max="150" step="5" value="${Math.round(t.volume * 100)}" data-vol aria-label="Volume ${esc(label)}">
        <b class="mix-val">${Math.round(t.volume * 100)}%</b>${extra}
      </div>`;
  };
  const takeRows = () =>
    Object.entries(takes)
      .map(
        ([kind, tk]) =>
          rowHtml(
            `take:${kind}`,
            TAKE_LABEL[kind],
            `<span class="nudge" title="Se a tua gravação tá atrasada, diminui; se tá adiantada, aumenta">
               <button data-nudge="-10" data-kind="${kind}">−</button><b data-nudge-v="${kind}">${tk.nudge_ms} ms</b><button data-nudge="10" data-kind="${kind}">+</button></span>
             <button class="btn small" data-reset="${kind}" title="Tira do Ensaio Atual (o arquivo fica guardado)">Resetar</button>`,
          ),
      )
      .join('');
  // Sem permissão o navegador esconde o nome das entradas (e aí não dá pra achar a tua interface).
  // Não pede ao abrir a tela: só no "Mostrar entradas" ou no ⏺ Gravar. Já liberado = não pergunta nada.
  const listInputs = async () => (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((x) => x.kind === 'audioinput');
  const devices = await listInputs();
  const named = () => devices.some((x) => x.label);
  window.__studio = session; // pra depurar no console

  main.innerHTML = `
    <div class="card transport">
      <button id="st-play" class="btn primary">▶ Tocar</button>
      <button id="st-stop" class="btn">⏹</button>
      <input id="st-seek" type="range" min="0" max="${Math.ceil(mixer.duration())}" step="0.1" value="0" aria-label="Posição">
      <span id="st-time" class="mono">0:00 / ${fmtTime(mixer.duration())}</span>
      <label class="countin" title="4 batidas no tempo da música antes de entrar (no play e no gravar)">
        <input type="checkbox" id="st-count" ${prefs.countIn ? 'checked' : ''}> 🥢 4 baquetadas
        <input type="number" id="st-bpm" min="40" max="240" value="${prefs.bpm ?? s.bpm ?? 100}" aria-label="BPM"> bpm
      </label>
    </div>
    ${d.tab_available ? `
    <details class="card studio-tab" ${prefs.tabOpen === false ? '' : 'open'}>
      <summary><b>🎼 Tab acompanhando</b> <span class="muted">· muda, anda junto com a música</span></summary>
      <div class="studio-tab-bar">
        <label>Faixa <select id="st-tab-track">${d.tab_tracks.map((n, i) => `<option value="${i}" ${i === (prefs.tabTrack ?? d.tab_track) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        ${source === 'mp3' ? `<span class="nudge" title="Onde o compasso 1 da tab cai no MP3">Compasso 1 em <button data-tab-off="-50">−</button><b id="st-tab-off">${(state.tab_offset_ms / 1000).toFixed(2).replace('.', ',')} s</b><button data-tab-off="50">+</button></span>` : ''}
        ${source === 'mp3' ? '<button id="st-align" class="btn small">Achar sozinho</button>' : ''}
        <span class="muted note">${source === 'mp3' && state.tab_offset_note ? esc(state.tab_offset_note) : ''}</span>
      </div>
      <div id="st-tab" class="tab-box studio-tab-box"></div>
    </details>` : ''}
    <div class="chips studio-presets">
      <button class="chip" data-preset="guitar">🎸 Vou tocar guitarra/violão</button>
      <button class="chip" data-preset="bass">🎸 Vou tocar baixo</button>
      <button class="chip" data-preset="drums">🥁 Vou tocar bateria</button>
      <button class="chip" data-preset="vocal">🎤 Vou cantar</button>
      <button class="chip" data-preset="all">Tudo normal</button>
    </div>
    <h2>Mixer <span class="muted">· ${source === 'gp' ? '🎼 som do Guitar Pro' : '🎧 MP3 separado'}</span></h2>
    <div class="card mixer-card">
      ${tracks.map((t) => rowHtml(t.id, t.label)).join('')}
      <div id="st-take-rows">${takeRows()}</div>
      <div id="st-new-row"></div>
    </div>
    <h2>Gravar por cima</h2>
    <div class="card rec-card">
      <div class="rec-line">
        <label>O quê <select id="st-kind"><option value="guitar">🎸 Guitarra/violão</option><option value="bass">🎸 Baixo</option><option value="vocal">🎤 Voz</option></select></label>
        <label>Entrada <select id="st-dev">${devices.map((x) => `<option value="${esc(x.deviceId)}">${esc(x.label || 'Entrada de áudio')}</option>`).join('') || '<option value="">Padrão</option>'}</select></label>
        <label>Canal <select id="st-ch"><option value="mix">1+2</option><option value="1">1</option><option value="2">2</option></select></label>
        ${named() ? '' : '<button id="st-unlock" class="btn small">🎙️ Mostrar entradas</button>'}
      </div>
      <div class="rec-line">
        <button id="st-mon" class="btn" aria-pressed="false">🎧 Me ouvir: desligado</button>
        <input id="st-mon-vol" type="range" min="0" max="150" step="5" value="${Math.round((prefs.monitorVol ?? 1) * 100)}" aria-label="Volume do me ouvir">
        <span id="st-mon-info" class="muted">Passa pelo PC (tem um atrasinho). Usa fone, senão microfone e caixa de som fazem microfonia.</span>
      </div>
      <div class="rec-line">
        <span class="nudge sync-ms" title="Calibra o atraso do teu headset uma vez: se as gravações novas ficam atrasadas, aumenta; se ficam adiantadas, diminui">
          Sync <button data-sync-ms="-5" aria-label="Menos 5 ms">−</button><b id="st-sync-ms">${loadStudioSync()} ms</b><button data-sync-ms="5" aria-label="Mais 5 ms">+</button>
        </span>
        <span class="muted">Vale pra todas as gravações novas, em qualquer música. Ajuste de cada gravação: o − / + na linha dela.</span>
      </div>
      <div class="rec-line">
        <button id="st-rec" class="btn rec">⏺ Gravar</button>
        <span class="meter"><span id="st-meter"></span></span>
        <span id="st-rec-status" class="muted">Grava a partir de onde a música tá. Pra ouvir teu instrumento sem atraso, usa o fone da tua pedaleira/interface.</span>
      </div>
    </div>`;

  // Tab acompanhando: no MP3 começa depois da espera da música; no Guitar Pro, junto (é o mesmo arquivo).
  let tabOffset = source === 'mp3' ? state.tab_offset_ms / 1000 : 0;
  const tabBox = document.getElementById('st-tab');
  if (tabBox) {
    mountStudioTab(s.id, tabBox, mixer, () => tabOffset, prefs.tabTrack ?? d.tab_track ?? 0)
      .then((t) => {
        if (studioSession !== session) return t.destroy();
        session.tab = t;
      })
      .catch((err) => (tabBox.textContent = err.message));
    document.getElementById('st-align')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await fetch(`/api/songs/${encodeURIComponent(slug)}/align`, { method: 'POST' });
      const data = await res.json();
      btn.disabled = false;
      if (!res.ok) return toast(data.error);
      if (!data.ok) return toast(data.detail);
      tabOffset = data.offset_ms / 1000;
      document.getElementById('st-tab-off').textContent = `${tabOffset.toFixed(2).replace('.', ',')} s`;
      main.querySelector('.studio-tab-bar .note').textContent = data.song.tab_offset_note;
      session.tab?.resync();
      toast(`Compasso 1 em ${tabOffset.toFixed(2).replace('.', ',')} s.`);
    });
    document.getElementById('st-tab-track').onchange = (e) => {
      prefs.tabTrack = Number(e.target.value);
      savePrefs();
      session.tab?.setTrack(prefs.tabTrack);
    };
    main.querySelector('.studio-tab').addEventListener('toggle', (e) => {
      prefs.tabOpen = e.target.open;
      savePrefs();
    });
    main.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab-off]');
      if (!b) return;
      tabOffset = Math.max(0, tabOffset + Number(b.dataset.tabOff) / 1000);
      document.getElementById('st-tab-off').textContent = `${tabOffset.toFixed(2).replace('.', ',')} s`;
      session.tab?.resync();
      clearTimeout(session.offTimer);
      session.offTimer = setTimeout(
        () =>
          fetch(`/api/songs/${encodeURIComponent(slug)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab_offset_ms: Math.round(tabOffset * 1000), tab_offset_note: 'ajustado à mão' }),
          }),
        600,
      );
    });
  }

  // Volumes, mudo, presets.
  const setTrack = (id, patch) => {
    mixer.set(id, patch);
    vols[id] = { v: mixer.tracks.get(id).volume, m: mixer.tracks.get(id).muted };
    savePrefs();
    const row = main.querySelector(`.mix-row[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const t = mixer.tracks.get(id);
    row.querySelector('[data-vol]').value = Math.round(t.volume * 100);
    row.querySelector('.mix-val').textContent = `${Math.round(t.volume * 100)}%`;
    const m = row.querySelector('[data-mute]');
    m.classList.toggle('on', t.muted);
    m.textContent = t.muted ? '🔇' : '🔊';
  };
  main.addEventListener('input', (e) => {
    const row = e.target.closest('.mix-row');
    if (row && e.target.matches('[data-vol]')) setTrack(row.dataset.id, { volume: Number(e.target.value) / 100 });
  });
  main.addEventListener('click', async (e) => {
    const row = e.target.closest('.mix-row');
    if (row && e.target.closest('[data-mute]')) setTrack(row.dataset.id, { muted: !mixer.tracks.get(row.dataset.id).muted });
    const preset = e.target.closest('[data-preset]')?.dataset.preset;
    if (preset) {
      // "Vou tocar X": a faixa de X fica bem baixinho (guia) e a minha gravação de X sai.
      // "Vou cantar": voz original bem baixinho; o que eu já gravei de guitarra/baixo entra no lugar.
      const STEM_OF = { guitar: 'guitar', bass: 'bass', drums: 'drums', vocal: 'vocals' };
      const MIDI_OF = { guitar: /guitar|viol|ac/i, bass: /bass|baixo/i, drums: /drum|bateria|🥁/i, vocal: /$^/ };
      for (const id of mixer.tracks.keys()) {
        let v = 1;
        let m = false;
        if (preset !== 'all') {
          const label = tracks.find((t) => t.id === id)?.label ?? '';
          if (id === STEM_OF[preset] || (/^midi:/.test(id) && MIDI_OF[preset].test(label))) v = 0.1;
          if (id === `take:${preset}`) m = true;
          if (preset === 'vocal' && ((id === 'guitar' && takes.guitar) || (id === 'bass' && takes.bass))) m = true;
        }
        setTrack(id, { volume: v, muted: m });
      }
      if (preset !== 'all' && preset !== 'drums') document.getElementById('st-kind').value = preset;
      pickDevice();
    }
    const syncBtn = e.target.closest('[data-sync-ms]');
    if (syncBtn) {
      const v = Math.max(-500, Math.min(1000, loadStudioSync() + Number(syncBtn.dataset.syncMs)));
      try {
        localStorage.setItem(STUDIO_SYNC_KEY, String(v));
      } catch {}
      document.getElementById('st-sync-ms').textContent = `${v} ms`;
    }
    const nudge = e.target.closest('[data-nudge]');
    if (nudge) {
      const kind = nudge.dataset.kind;
      takes[kind].nudge_ms += Number(nudge.dataset.nudge);
      main.querySelector(`[data-nudge-v="${kind}"]`).textContent = `${takes[kind].nudge_ms} ms`;
      mixer.set(`take:${kind}`, { offset: (takes[kind].offset_ms + takes[kind].nudge_ms) / 1000 });
      clearTimeout(session.nudgeTimer);
      session.nudgeTimer = setTimeout(() => fetch(`/api/songs/${encodeURIComponent(slug)}/takes/${kind}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nudge_ms: takes[kind].nudge_ms }) }), 600);
    }
    const reset = e.target.closest('[data-reset]')?.dataset.reset;
    if (reset && confirm(`Tirar "${TAKE_LABEL[reset]}" do Ensaio Atual? O arquivo fica guardado na pasta de antigas.`)) {
      await fetch(`/api/songs/${encodeURIComponent(slug)}/takes/${reset}`, { method: 'DELETE' });
      toast('Ensaio Atual resetado.');
      render();
    }
  });

  // Tocar, parar, posição.
  const play = document.getElementById('st-play');
  const seek = document.getElementById('st-seek');
  const time = document.getElementById('st-time');
  const showPlay = () => (play.textContent = mixer.playing ? '⏸ Pausar' : '▶ Tocar');
  const countSel = document.getElementById('st-count');
  const bpmSel = document.getElementById('st-bpm');
  const countIn = () => (countSel.checked ? { beats: 4, bpm: Math.min(240, Math.max(40, Number(bpmSel.value) || 100)) } : null);
  countSel.onchange = bpmSel.onchange = () => {
    prefs.countIn = countSel.checked;
    prefs.bpm = Number(bpmSel.value) || undefined;
    savePrefs();
  };
  play.onclick = () => {
    if (session.recording) return;
    if (mixer.playing) mixer.pause();
    else mixer.play(mixer.position(), countIn());
    showPlay();
  };
  document.getElementById('st-stop').onclick = () => {
    if (session.recording) return stopRecording();
    mixer.pause();
    mixer.seek(0);
    showPlay();
  };
  seek.oninput = () => !session.recording && mixer.seek(Number(seek.value));
  mixer.onEnd = () => (session.recording ? stopRecording() : showPlay());
  session.timer = setInterval(() => {
    const p = mixer.position();
    if (document.activeElement !== seek) seek.value = p;
    time.textContent = `${fmtTime(p)} / ${fmtTime(mixer.duration())}`;
  }, 200);

  // Gravação.
  const kindSel = document.getElementById('st-kind');
  const devSel = document.getElementById('st-dev');
  const chSel = document.getElementById('st-ch');
  const recBtn = document.getElementById('st-rec');
  const status = document.getElementById('st-rec-status');
  const meter = document.getElementById('st-meter');
  // Cada instrumento lembra a última entrada e canal usados (salvo neste PC).
  function pickDevice() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(`soloband.input.${kindSel.value}`) ?? '{}');
    } catch {}
    if (saved.device && [...devSel.options].some((o) => o.value === saved.device)) devSel.value = saved.device;
    if (saved.channel) chSel.value = saved.channel;
  }
  const rememberDevice = () => {
    try {
      localStorage.setItem(`soloband.input.${kindSel.value}`, JSON.stringify({ device: devSel.value, channel: chSel.value }));
    } catch {}
  };
  devSel.addEventListener('change', rememberDevice);
  chSel.addEventListener('change', rememberDevice);
  kindSel.onchange = () => {
    pickDevice();
    if (session.recorder?.monitorOn) openInput();
  };
  pickDevice();

  /** Pede o microfone uma vez (o navegador pergunta só se ainda não foi liberado) e mostra o nome das entradas. */
  async function unlockInputs() {
    if (named()) return true;
    try {
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    } catch {
      toast('Sem permissão de microfone. Libera no cadeado da barra de endereço (ou nas configurações de privacidade do Windows).');
      return false;
    }
    devices.splice(0, devices.length, ...(await listInputs()));
    devSel.innerHTML = devices.map((x) => `<option value="${esc(x.deviceId)}">${esc(x.label || 'Entrada de áudio')}</option>`).join('');
    document.getElementById('st-unlock')?.remove();
    pickDevice();
    return true;
  }
  document.getElementById('st-unlock')?.addEventListener('click', unlockInputs);

  /** Abre a entrada escolhida (se já não tá aberta) com o canal certo. Serve pra gravar e pro "Me ouvir". */
  async function openInput() {
    try {
      session.recorder ??= new Recorder(mixer);
      const dev = devSel.value || undefined;
      session.recorder.channel = chSel.value;
      if (!session.recorder.isOpen(dev)) await session.recorder.open(dev);
      else session.recorder.routeMonitor();
      return true;
    } catch (err) {
      toast(`Não consegui abrir a entrada: ${err.message}`);
      return false;
    }
  }

  // "Me ouvir": liga/desliga a entrada no fone, por cima da banda.
  const monBtn = document.getElementById('st-mon');
  const monVol = document.getElementById('st-mon-vol');
  const monInfo = document.getElementById('st-mon-info');
  const showMon = () => {
    const on = Boolean(session.recorder?.monitorOn);
    monBtn.textContent = on ? '🎧 Me ouvir: ligado' : '🎧 Me ouvir: desligado';
    monBtn.classList.toggle('primary', on);
    monBtn.setAttribute('aria-pressed', String(on));
  };
  monBtn.onclick = async () => {
    const on = !session.recorder?.monitorOn;
    if (on && !((await unlockInputs()) && (await openInput()))) return;
    session.recorder.setMonitor(on, Number(monVol.value) / 100);
    if (on) monInfo.textContent = `Atraso de ida e volta: ~${Math.round((mixer.outputLatency() + session.recorder.inputLatency()) * 1000)} ms. Usa fone, senão dá microfonia.`;
    showMon();
  };
  monVol.oninput = () => {
    prefs.monitorVol = Number(monVol.value) / 100;
    savePrefs();
    if (session.recorder?.monitorOn) session.recorder.setMonitor(true, prefs.monitorVol);
  };
  // Trocou entrada ou canal com o "Me ouvir" ligado: reabre já no novo.
  for (const el of [devSel, chSel]) el.addEventListener('change', () => session.recorder?.monitorOn && openInput());

  async function startRecording() {
    if (!(await unlockInputs())) return;
    if (!(await openInput())) return;
    session.recorder.onLevel = (peak) => (meter.style.width = `${Math.min(100, peak * 100)}%`);
    const kind = kindSel.value;
    if (takes[kind]) setTrack(`take:${kind}`, { muted: true }); // não grava ouvindo a gravação antiga da mesma coisa
    mixer.remove('new');
    document.getElementById('st-new-row').innerHTML = '';
    session.recording = { kind, startPos: mixer.position() };
    session.recorder.start();
    session.recording.when = mixer.play(session.recording.startPos, countIn());
    recBtn.textContent = '⏹ Parar gravação';
    recBtn.classList.add('on');
    status.textContent = '⏺ Gravando…';
    showPlay();
  }

  function stopRecording() {
    const rec = session.recording;
    session.recording = null;
    mixer.pause();
    showPlay();
    recBtn.textContent = '⏺ Gravar';
    recBtn.classList.remove('on');
    const { samples, firstT, sampleRate } = session.recorder.stop();
    session.recorder.onLevel = null;
    meter.style.width = '0';
    if (!samples.length || firstT === null) return (status.textContent = 'Não chegou som nenhum da entrada.');
    // Onde a 1ª amostra cai na música: o que o João ouviu saiu atrasado (saída) e o que ele tocou chegou atrasado (entrada).
    // + o "Sync" que o João calibrou pro headset dele (o navegador nem sempre sabe o atraso certo).
    const latency = mixer.outputLatency() + session.recorder.inputLatency() + loadStudioSync() / 1000;
    const offset = rec.startPos + (firstT - rec.when) - latency;
    const buffer = mixer.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    mixer.add('new', buffer, { offset });
    session.newTake = { kind: rec.kind, samples, sampleRate, offset };
    status.textContent = `Gravado: ${fmtTime(samples.length / sampleRate)}. Atraso descontado: ${Math.round(latency * 1000)} ms.`;
    document.getElementById('st-new-row').innerHTML = `${rowHtml('new', `⏺ Gravação nova (${{ guitar: 'guitarra', bass: 'baixo', vocal: 'voz' }[rec.kind]}, não salva)`)}
      <div class="new-actions">
        <button id="st-listen" class="btn">▶ Ouvir junto</button>
        <button id="st-save" class="btn primary">💾 Salvar como Ensaio Atual</button>
        <button id="st-discard" class="btn">Descartar</button>
      </div>`;
    document.getElementById('st-listen').onclick = () => {
      mixer.play(Math.max(0, offset));
      showPlay();
    };
    document.getElementById('st-discard').onclick = () => {
      mixer.remove('new');
      session.newTake = null;
      document.getElementById('st-new-row').innerHTML = '';
      status.textContent = 'Descartado.';
    };
    document.getElementById('st-save').onclick = async (e) => {
      e.currentTarget.disabled = true;
      const t = session.newTake;
      const res = await fetch(`/api/songs/${encodeURIComponent(slug)}/takes/${t.kind}`, {
        method: 'PUT',
        headers: { 'content-type': 'audio/wav', 'x-offset-ms': String(Math.round(t.offset * 1000)) },
        body: wavBlob(t.samples, t.sampleRate),
      });
      if (!res.ok) {
        e.currentTarget.disabled = false;
        return toast((await res.json()).error);
      }
      toast(`${TAKE_LABEL[t.kind]} salvo como Ensaio Atual.`);
      render();
    };
  }

  recBtn.onclick = () => (session.recording ? stopRecording() : startRecording());
}


// ---------- rotas ----------

const routes = [
  [/^#?\/?$/, () => songsView(), 'musicas'],
  [/^#\/musica\/([a-z0-9-]+)$/, (m) => studioSongView(m[1]), 'musicas'],
  [/^#\/config$/, () => settingsView(), 'config'],
  [/^#\/ajuda$/, () => helpView(), 'ajuda'],
];

async function render() {
  const hash = location.hash || '#/';
  const route = routes.find(([re]) => re.test(hash)) ?? routes[0];
  const [re, fn, tab] = route;
  if (!/^#\/musica\//.test(hash)) closeStudio(); // saiu da música: para o som e solta a placa de som
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  view.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    view.innerHTML = await fn(hash.match(re) ?? []);
  } catch (err) {
    view.innerHTML = `<div class="card"><strong>Deu ruim:</strong> ${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
showWhatsNew().catch(() => {});

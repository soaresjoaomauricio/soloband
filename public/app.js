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

/**
 * Título, artista e BPM das tags do arquivo (ID3 do mp3, átomos do iTunes no m4a, Vorbis comment no flac),
 * lidos aqui mesmo, sem biblioteca. Sem tag, tenta o nome do arquivo ("Artista - Título"). BPM quase nunca vem.
 */
async function readSongTags(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const ascii = (o, n) => String.fromCharCode(...buf.subarray(o, o + n));
  const clean = (s) => (s ?? '').replace(/\0+$/g, '').replace(/\0/g, ' ').trim() || null;
  const tags = { title: null, artist: null, bpm: null };

  // ID3v2 (mp3): "ID3", versão, flags, tamanho "syncsafe" (7 bits por byte).
  if (ascii(0, 3) === 'ID3') {
    const ver = buf[3];
    const syncsafe = (o) => ((buf[o] & 127) << 21) | ((buf[o + 1] & 127) << 14) | ((buf[o + 2] & 127) << 7) | (buf[o + 3] & 127);
    const end = Math.min(buf.length, 10 + syncsafe(6));
    const text = (o, n) => {
      const enc = buf[o];
      const body = buf.subarray(o + 1, o + n);
      const dec = enc === 0 ? 'latin1' : enc === 3 ? 'utf-8' : enc === 2 ? 'utf-16be' : 'utf-16'; // 1 = UTF-16 com BOM
      return clean(new TextDecoder(dec).decode(body));
    };
    const ids = ver === 2 ? { TT2: 'title', TP1: 'artist', TBP: 'bpm' } : { TIT2: 'title', TPE1: 'artist', TBPM: 'bpm' };
    let o = 10 + (ver > 2 && buf[5] & 0x40 ? (ver === 4 ? syncsafe(10) : dv.getUint32(10) + 4) : 0); // pula o cabeçalho estendido
    while (o + (ver === 2 ? 6 : 10) <= end) {
      const id = ascii(o, ver === 2 ? 3 : 4);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const size = ver === 2 ? (buf[o + 3] << 16) | (buf[o + 4] << 8) | buf[o + 5] : ver === 4 ? syncsafe(o + 4) : dv.getUint32(o + 4);
      const head = ver === 2 ? 6 : 10;
      if (ids[id] && size > 1 && o + head + size <= end) tags[ids[id]] ??= text(o + head, size);
      o += head + size;
    }
  }
  // ID3v1 (fim do mp3): 128 bytes começando com "TAG".
  if (!tags.title && buf.length > 128 && ascii(buf.length - 128, 3) === 'TAG') {
    const latin = (o, n) => clean(new TextDecoder('latin1').decode(buf.subarray(o, o + n)));
    tags.title = latin(buf.length - 125, 30);
    tags.artist ??= latin(buf.length - 95, 30);
  }
  // m4a/mp4 (iTunes): moov > udta > meta > ilst > ©nam/©ART/tmpo > data.
  if (ascii(4, 4) === 'ftyp') {
    const walk = (start, end, path) => {
      for (let o = start; o + 8 <= end; ) {
        let size = dv.getUint32(o);
        const type = new TextDecoder('latin1').decode(buf.subarray(o + 4, o + 8));
        if (size === 1) size = Number(dv.getBigUint64(o + 8));
        if (size < 8 || o + size > end) break;
        if (['moov', 'udta', 'ilst'].includes(type)) walk(o + 8, o + size, [...path, type]);
        else if (type === 'meta') walk(o + 12, o + size, [...path, type]); // meta tem 4 bytes de versão/flags
        else if (path.at(-1) === 'ilst' && ['©nam', '©ART', 'tmpo'].includes(type) && ascii(o + 12, 4) === 'data') {
          const data = buf.subarray(o + 24, o + size);
          if (type === 'tmpo') tags.bpm ??= data.length >= 2 ? (data[0] << 8) | data[1] : null;
          else tags[type === '©nam' ? 'title' : 'artist'] ??= clean(new TextDecoder().decode(data));
        }
        o += size;
      }
    };
    walk(0, buf.length, []);
  }
  // flac: blocos de metadados; o 4 é o Vorbis comment ("TITLE=...", tamanhos em little-endian).
  if (ascii(0, 4) === 'fLaC') {
    for (let o = 4; o + 4 <= buf.length; ) {
      const last = buf[o] & 0x80;
      const type = buf[o] & 0x7f;
      const len = (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
      if (type === 4) {
        let p = o + 4;
        p += 4 + dv.getUint32(p, true); // fornecedor
        const count = dv.getUint32(p, true);
        p += 4;
        for (let i = 0; i < count && p + 4 <= o + 4 + len; i++) {
          const n = dv.getUint32(p, true);
          const [k, ...v] = new TextDecoder().decode(buf.subarray(p + 4, p + 4 + n)).split('=');
          const key = { TITLE: 'title', ARTIST: 'artist', BPM: 'bpm', TEMPO: 'bpm' }[k.toUpperCase()];
          if (key) tags[key] ??= clean(v.join('='));
          p += 4 + n;
        }
      }
      if (last) break;
      o += 4 + len;
    }
  }
  // Sem tag: "01 - Artista - Título.mp3" / "Artista - Título.mp3" / "Título.mp3". Tira o prefixo que site de
  // download põe ("AudioCleaner_Download_...", "y2mate.com - ...").
  if (!tags.title) {
    const base = file.name.replace(/\.[^.]+$/, '').replace(/^\S*?download_/i, '').replace(/^\S+\.(com|net|io|cc|to)\s*-\s*/i, '').replace(/^\d{1,3}[\s.\-_]+/, '');
    const parts = base.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    tags.title = parts.length > 1 ? parts.slice(1).join(' - ') : parts[0] ?? null;
    if (parts.length > 1) tags.artist ??= parts[0];
  }
  // "Snow (Hey Oh) - Remastered", "Música (Official Video)", "Música [Lyrics]": fica só o nome.
  tags.title &&= tags.title
    .replace(/\s*[([][^)\]]*\b(official|oficial|lyrics?|letra|audio|áudio|video|vídeo|clipe|hd|hq|remaster(ed)?)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|official|oficial|lyrics?|ao vivo|live)\b.*$/i, '')
    .trim() || tags.title;
  const bpm = Math.round(Number(String(tags.bpm ?? '').replace(',', '.')));
  tags.bpm = bpm >= 20 && bpm <= 300 ? bpm : null;
  return tags;
}

let listPoll = null; // a lista se atualiza sozinha enquanto alguma música tá separando

async function songsView() {
  const songs = await api('/api/songs');
  clearInterval(listPoll);
  if (songs.some((s) => s.separation.status === 'running')) {
    const here = location.hash;
    const poll = (listPoll = setInterval(async () => {
      if (location.hash !== here) return clearInterval(poll);
      const now = await api('/api/songs');
      // Troca só as linhas: redesenhar a tela apagaria o que a pessoa tá preenchendo em "Nova música".
      const list = document.getElementById('setlist');
      if (list) list.innerHTML = now.map(row).join('');
      if (!now.some((s) => s.separation.status === 'running')) clearInterval(poll);
    }, 3000));
  }
  const row = (s) => {
    const audio = s.stems.length ? '🎧 MP3 separado' : s.separation.status === 'running' ? 'separando…' : s.original ? 'MP3 sem separar' : null;
    const sound = [s.youtube_url ? '🎬 YouTube' : null, audio].filter(Boolean).join(' · ') || 'sem MP3';
    const takes = Object.entries(s.takes)
      .filter(([, t]) => t)
      .map(([k]) => TAKE_LABEL[k])
      .join(' · ');
    return `<a class="setlist-item" href="#/musica/${esc(s.id)}"><span class="what"><b>${esc(s.title)}</b>
      <span class="muted">${esc(s.artist)}${s.bpm ? ` · ${s.bpm} bpm` : ''} · ${sound}${s.tab_file ? ' · 🎼 Guitar Pro' : ''}${takes ? ` · Ensaio Atual: ${esc(takes)}` : ''}</span></span></a>`;
  };
  setTimeout(() => {
    wireNewYoutubeSong(songs);
    const form = document.getElementById('new-song');
    // Escolher o MP3 preenche título, artista e BPM pelas tags; no "Adicionar" ele já sobe e começa a separar.
    let audio = null;
    document.getElementById('new-audio').onchange = async (e) => {
      audio = e.target.files[0] ?? null;
      document.getElementById('new-audio-name').textContent = audio ? audio.name : '';
      if (!audio) return;
      const tags = await readSongTags(audio).catch(() => ({}));
      if (tags.title) form.title.value = tags.title;
      if (tags.artist) form.artist.value = tags.artist;
      if (tags.bpm) form.bpm.value = tags.bpm;
      form.title.focus();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const song = await send('/api/songs', 'POST', {
          title: f.get('title'),
          artist: f.get('artist') || undefined,
          bpm: f.get('bpm') ? Number(f.get('bpm')) : undefined,
        });
        if (audio) await uploadAudio(song.id, audio);
        location.hash = `#/musica/${song.id}`;
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  }, 0);
  return `
    <h1>Músicas</h1>
    <p class="muted">O jeito mais fácil: cola o link do <b>YouTube</b> e toca junto (não baixa nada). Pra tocar <b>sem a tua parte</b>, põe o MP3 (a tua cópia): o app separa voz, guitarras, baixo e bateria. O Guitar Pro, se tiver, mostra a tab andando.</p>
    ${songs.length ? `<div class="setlist" id="setlist">${songs.map(row).join('')}</div>` : '<div class="card first-time"><b>Primeira vez aqui?</b> Dá uma olhada no <a href="#/ajuda">Como usar</a>: são 3 passos.</div>'}
    <h2>Nova música pelo YouTube</h2>
    <form id="new-yt" class="card new-song">
      <input name="url" placeholder="Cola o link do vídeo (youtube.com/watch?v=… ou youtu.be/…)" required>
      <input name="title" placeholder="Título" required>
      <input name="artist" placeholder="Artista">
      <span class="muted" id="new-yt-info">o título e o artista vêm do nome do vídeo: confere antes de adicionar</span>
      <button class="btn primary">Adicionar</button>
    </form>
    <h2>Nova música pelo MP3</h2>
    <form id="new-song" class="card new-song">
      <div class="new-song-file"><label class="btn file-btn">🎧 Escolher MP3<input id="new-audio" type="file" accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*" hidden></label>
        <span class="muted" id="new-audio-name">preenche o nome e o artista sozinho; BPM vazio, ele calcula pela bateria</span></div>
      <input name="title" placeholder="Título" required>
      <input name="artist" placeholder="Artista">
      <input name="bpm" type="number" min="20" max="300" placeholder="BPM">
      <button class="btn primary">Adicionar</button>
    </form>`;
}

/**
 * Nova música pelo YouTube (S14): colar o link preenche título e artista pelo nome do vídeo (oEmbed, no servidor);
 * "Adicionar" usa a música que já existe (só põe o link) ou cadastra, e abre já no YouTube.
 */
function wireNewYoutubeSong(songs) {
  const form = document.getElementById('new-yt');
  if (!form) return;
  const info = document.getElementById('new-yt-info');
  let last = '';
  const lookup = async () => {
    const url = form.url.value.trim();
    if (!url || url === last) return;
    last = url;
    info.textContent = 'Lendo o nome do vídeo…';
    try {
      const d = await send('/api/youtube-info', 'POST', { url });
      form.url.value = d.url;
      last = d.url;
      if (d.title) form.title.value = d.title;
      if (d.artist) form.artist.value = d.artist;
      info.textContent = d.video_title ? `Vídeo: "${d.video_title}"${d.channel ? ` · ${d.channel}` : ''}. Confere o título e o artista.` : 'Não consegui ler o nome do vídeo (sem internet?): escreve o título e o artista.';
      (form.title.value ? form.artist : form.title).focus();
    } catch (err) {
      info.textContent = err.message;
    }
  };
  form.url.addEventListener('change', lookup);
  form.url.addEventListener('paste', () => setTimeout(lookup, 0));
  const norm = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const artist = f.get('artist') || 'Desconhecido';
      const existing = songs.find((x) => norm(x.title) === norm(f.get('title')) && norm(x.artist) === norm(artist));
      const song = existing
        ? await send(`/api/songs/${encodeURIComponent(existing.id)}`, 'PATCH', { youtube_url: f.get('url') })
        : await send('/api/songs', 'POST', { title: f.get('title'), artist, youtube_url: f.get('url') });
      saveStudioPrefs(song.id, { ...studioPrefs(song.id), source: 'youtube' });
      location.hash = `#/musica/${song.id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  };
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
      <p><b>Mais fácil:</b> em <a href="#/">Músicas</a>, cola o link do vídeo em <b>Nova música pelo YouTube</b> e clica em <b>Adicionar</b>. Toca na hora, sem baixar nada (precisa de internet). Dá pra tocar mais devagar (0,5× a 1×, sem mudar o tom) e repetir um trecho (A–B). Com placa NVIDIA e o separador instalado, a chave <b>✂️ Separar as faixas ao vivo</b> separa os instrumentos na hora (o som sai uns 3,5 s depois do vídeo) e dá pra tocar sem a tua parte. Sem NVIDIA, pra isso é o MP3.</p>
      <p><b>Pra tocar sem a tua parte:</b> em <a href="#/">Músicas</a>, clica em <b>🎧 Escolher MP3</b>: o título e o artista vêm do arquivo (confere e corrige se precisar). Clica em <b>Adicionar</b> e ele já começa a separar. O BPM, se tu não puser, ele calcula pela bateria.</p>
      <p class="muted">Sem o MP3 na mão? Escreve só o título e adiciona; o arquivo dá pra pôr depois, na música.</p>`)}
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
        <li>A <b>🎼 Tab acompanhando</b> anda junto. Se estiver fora do tempo, clica em <b>Achar sozinho</b> ou usa o − / +. No YouTube: dá play e aperta <b>👆 Marcar o 1</b> quando entrar a 1ª nota.</li>
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

// ---------- YouTube (S14, igual ao D73 do Vida de Jão): toca pelo player oficial embutido. O app guarda só o link e nunca baixa. ----------

const ytIdOf = (url) => (url ?? '').match(/[?&]v=([\w-]{11})/)?.[1] ?? null;
let ytApiPromise = null;
function loadYouTubeApi() {
  ytApiPromise ??= new Promise((ok, fail) => {
    if (window.YT?.Player) return ok(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      ok(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      ytApiPromise = null;
      s.remove();
      fail(new Error('Não consegui carregar o player do YouTube (tá sem internet?).'));
    };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

const YT_ERRORS = {
  2: 'O link do vídeo tá errado.',
  5: 'O player do YouTube deu erro com esse vídeo.',
  100: 'Esse vídeo não existe mais ou é privado.',
  101: 'Esse vídeo não deixa tocar fora do YouTube. Procura outro: o áudio oficial (canal "Artista - Topic") costuma deixar.',
  150: 'Esse vídeo não deixa tocar fora do YouTube. Procura outro: o áudio oficial (canal "Artista - Topic") costuma deixar.',
};

/**
 * O player do YouTube embutido. A posição vem do player só de vez em quando (e meio atrasada), então aqui ela é
 * estimada pelo relógio desde a última leitura e só é corrigida quando escorrega de verdade (> 0,12 s).
 */
class YtPlayer {
  static async create(box, videoId, { onState, onError } = {}) {
    const YT = await loadYouTubeApi();
    const me = new YtPlayer();
    me.onState = onState;
    me.onError = onError;
    const el = box.appendChild(document.createElement('div'));
    await new Promise((ok) => {
      me.p = new YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: ok,
          onStateChange: (e) => me.stateChanged(e.data),
          onError: (e) => {
            me.onError?.(YT_ERRORS[e.data] ?? `O YouTube deu erro (${e.data}).`);
            ok();
          },
        },
      });
    });
    me.timer = setInterval(() => me.refresh(), 250);
    return me;
  }
  constructor() {
    this.state = -1;
    this.rate = 1;
    this.anchor = { pos: 0, t: performance.now() };
  }
  get playing() {
    return this.state === 1;
  }
  stateChanged(st) {
    this.state = st;
    this.anchor = { pos: this.p.getCurrentTime?.() ?? this.anchor.pos, t: performance.now() };
    this.onState?.(st);
  }
  refresh() {
    if (!this.p?.getCurrentTime) return;
    const real = this.p.getCurrentTime();
    if (!this.playing || Math.abs(real - this.position()) > 0.12) this.anchor = { pos: real, t: performance.now() };
  }
  position() {
    return this.playing ? this.anchor.pos + ((performance.now() - this.anchor.t) / 1000) * this.rate : this.anchor.pos;
  }
  duration() {
    return this.p?.getDuration?.() || 0;
  }
  play() {
    this.p?.playVideo?.();
  }
  pause() {
    this.p?.pauseVideo?.();
  }
  seek(pos) {
    this.anchor = { pos, t: performance.now() };
    this.p?.seekTo?.(pos, true);
  }
  setRate(r) {
    this.anchor = { pos: this.position(), t: performance.now() };
    this.rate = r;
    this.p?.setPlaybackRate?.(r);
  }
  setVolume(v) {
    this.p?.setVolume?.(Math.round(Math.max(0, Math.min(1, v)) * 100));
  }
  destroy() {
    clearInterval(this.timer);
    try {
      this.p?.destroy();
    } catch {}
    this.p = null;
  }
}

/** Velocidade + repetir trecho (A–B), iguais no Estúdio e no Ensaio. */
const YT_RATES = [0.5, 0.75, 0.9, 1];
function ytPracticeHtml(rate = 1) {
  return `<div class="yt-practice">
      <span class="yt-rates" role="group" aria-label="Velocidade">${YT_RATES.map((r) => `<button class="chip ${r === rate ? 'active' : ''}" data-yt-rate="${r}">${String(r).replace('.', ',')}×</button>`).join('')}</span>
      <span class="yt-loop" title="Marca o começo (A) e o fim (B) do trecho; depois liga o repetir">
        <button class="chip" data-yt-a>A</button><button class="chip" data-yt-b>B</button><button class="chip" data-yt-loop>🔁 Repetir</button>
        <span class="muted" data-yt-loop-info>sem trecho</span>
      </span>
    </div>`;
}
/**
 * Liga os botões de velocidade e A–B. `ctl` = { position(), seek(pos), setRate(r), canRate?() }.
 * Devolve `tick()`, que tem que ser chamado umas 5× por segundo (é ele que volta pro A).
 */
function wireYtPractice(root, ctl) {
  const loop = { a: null, b: null, on: false };
  const info = root.querySelector('[data-yt-loop-info]');
  const loopBtn = root.querySelector('[data-yt-loop]');
  const show = () => {
    info.textContent = loop.a === null ? 'sem trecho' : `${fmtTime(loop.a)} → ${loop.b === null ? '…' : fmtTime(loop.b)}`;
    loopBtn.classList.toggle('active', loop.on);
  };
  root.addEventListener('click', (e) => {
    const rateBtn = e.target.closest('[data-yt-rate]');
    if (rateBtn) {
      if (ctl.canRate && !ctl.canRate()) return;
      ctl.setRate(Number(rateBtn.dataset.ytRate));
      root.querySelectorAll('[data-yt-rate]').forEach((b) => b.classList.toggle('active', b === rateBtn));
    }
    if (e.target.closest('[data-yt-a]')) {
      loop.a = ctl.position();
      if (loop.b !== null && loop.b <= loop.a) loop.b = null;
      show();
    }
    if (e.target.closest('[data-yt-b]')) {
      const p = ctl.position();
      if (loop.a === null || p <= loop.a + 0.5) return toast('Marca o A antes, e o B depois dele.');
      loop.b = p;
      loop.on = true;
      // Já volta pro A. No ao vivo o vídeo vai 3,5 s na frente e já passou do B: sem isso, a 1ª volta passava do ponto.
      ctl.seek(loop.a);
      show();
    }
    if (e.target.closest('[data-yt-loop]')) {
      if (loop.a === null || loop.b === null) return toast('Marca o A (começo) e o B (fim) do trecho primeiro.');
      loop.on = !loop.on;
      if (loop.on) ctl.seek(loop.a);
      show();
    }
  });
  show();
  return {
    tick: () => {
      if (loop.on && loop.b !== null && (ctl.loopPosition ?? ctl.position)() >= loop.b) (ctl.loopSeek ?? ctl.seek)(loop.a);
    },
  };
}

// ---------- Estúdio (vindo do Vida de Jão): mixer, separação, tab acompanhando e gravar por cima. ----------

const STEM_LABEL = { vocals: '🎤 Voz', guitar: '🎸 Guitarras (violão + guitarra)', bass: 'Baixo', drums: 'Bateria', piano: 'Teclado', other: 'Outros' };
const TAKE_LABEL = { guitar: '🎸 Minha guitarra/violão', bass: '🎸 Meu baixo', vocal: '🎤 Minha voz' };

/** Toca várias faixas juntas, cada uma com volume, mudo e um início próprio (gravação começa no meio da música). */
class Mixer {
  constructor(opts = {}) {
    this.ctx = new AudioContext({ latencyHint: 'interactive', ...opts });
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
    this.started = { pos, at: when }; // onde e quando a música saiu de verdade (a gravação conta daqui)
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
    if (this.closed) return; // a tela pode ter redesenhado no meio: fechar 2× não quebra
    this.closed = true;
    this.stopSources();
    this.ctx.close();
  }
}

/**
 * O mixer do Estúdio com o YouTube no lugar das faixas (S14). A música é o vídeo (não dá pra mexer no som dele,
 * só no volume); as gravações do João tocam no Web Audio, começando quando o YouTube começa de verdade.
 * Quem usa (tab, gravação) vê a mesma cara do Mixer: position(), playing, play(), pause(), seek(), started.
 */
class YtMixer extends Mixer {
  constructor(yt) {
    super();
    this.yt = yt;
    this.rate = 1;
    this.stalls = 0; // quantas vezes o YouTube parou pra carregar tocando (a gravação pode ter escorregado)
    yt.onState = (st) => this.ytState(st);
  }
  position() {
    return this.yt.position();
  }
  duration() {
    return this.yt.duration() || super.duration();
  }
  /** Pausa o vídeo no ponto, toca as baquetadas e solta o vídeo no tempo seguinte. Devolve quando ele deve sair. */
  play(pos = this.position(), countIn = null) {
    this.stopSources();
    clearTimeout(this.startTimer);
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const first = this.ctx.currentTime + 0.12;
    const beat = countIn ? 60 / countIn.bpm : 0;
    for (let i = 0; i < (countIn?.beats ?? 0); i++) this.sources.push(this.stick(first + i * beat));
    const when = first + (countIn?.beats ?? 0) * beat;
    this.playing = true;
    this.startPos = pos;
    this.started = null; // só vale quando o YouTube avisar que saiu
    if (countIn) {
      this.waiting = true; // contando: o "pausou" que o YouTube manda agora não é o João pausando
      this.yt.pause();
      this.yt.seek(pos);
      // O YouTube leva ~0,1 s pra sair depois do play: manda um tiquinho antes do tempo.
      this.startTimer = setTimeout(() => {
        this.waiting = false;
        if (this.playing) this.yt.play();
      }, Math.max(0, (when - this.ctx.currentTime - 0.1) * 1000));
    } else {
      this.waiting = false;
      if (Math.abs(this.yt.position() - pos) > 0.05) this.yt.seek(pos);
      this.yt.play();
    }
    return when;
  }
  ytState(st) {
    if (st === 1) {
      // Saiu: as gravações entram agora, do ponto em que o vídeo tá.
      const pos = this.yt.position();
      if (this.playing && this.started) this.stalls++;
      this.playing = true;
      this.startPos = pos;
      this.startedAt = this.ctx.currentTime;
      this.started = { pos, at: this.ctx.currentTime };
      this.startTakes(pos);
      this.onPlay?.(pos, this.ctx.currentTime);
    } else if (st === 3) {
      this.stopSources(); // carregando: as gravações esperam o vídeo voltar
    } else if (st === 2 && this.playing && !this.waiting) {
      // Pausou pelo próprio player (clique no vídeo) ou pelo nosso pause.
      if (this.yt.position() < this.duration() - 0.3) this.pause(true);
    } else if (st === 0 && this.playing) {
      this.pause(true);
      this.onEnd?.();
    }
  }
  startTakes(pos) {
    this.stopSources();
    if (this.rate !== 1) return; // em outra velocidade o YouTube toca mais devagar e a gravação não acompanha
    const when = this.ctx.currentTime + 0.01;
    for (const t of this.tracks.values()) {
      const rel = pos - t.offset;
      if (rel >= t.buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      src.start(when + Math.max(0, -rel), Math.max(0, rel));
      this.sources.push(src);
    }
  }
  pause(fromPlayer = false) {
    clearTimeout(this.startTimer);
    this.waiting = false;
    this.playing = false;
    this.startPos = this.position();
    this.stopSources();
    if (!fromPlayer) this.yt.pause();
    this.onPause?.();
  }
  seek(pos) {
    if (this.playing) return this.play(pos);
    this.startPos = pos;
    this.yt.seek(pos);
    this.onPause?.();
  }
  add(id, buffer, opts) {
    super.add(id, buffer, opts);
    if (this.playing && this.yt.playing) this.startTakes(this.position());
  }
  set(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.apply(id);
    if ('offset' in patch && this.playing && this.yt.playing) this.startTakes(this.position());
  }
  setRate(r) {
    this.rate = r;
    this.yt.setRate(r);
    if (this.playing && this.yt.playing) this.startTakes(this.position());
  }
  close() {
    clearTimeout(this.startTimer);
    super.close();
    this.yt.onState = null;
    this.yt.destroy();
  }
}

// ---------- Separar ao vivo (S15, igual ao D74 do Vida de Jão): o YouTube toca mudo num <webview> e o Demucs separa o som dele na hora. ----------

/** O SoloBand liga o <webview> (só ele consegue capturar o som do player sozinho). No navegador/celular, não. */
// Função (não constante): o Electron registra o <webview> depois que o script carrega.
const hasWebview = () => Boolean(window.customElements?.get('webview'));
const LIVE_DELAY = 3.5; // s entre o vídeo e o som separado (1 s novo + 1,5 s de "depois" + GPU + folga; medido na Snow)
const LIVE_SR = 44100;
const LIVE_STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']; // ordem que o separador devolve
const LIVE_WORKLET = `
class VidaCap extends AudioWorkletProcessor {
  process(inputs) {
    const c = inputs[0];
    if (c && c.length) this.port.postMessage({ t: currentTime, l: c[0].slice(0), r: (c[1] ?? c[0]).slice(0) });
    return true;
  }
}
registerProcessor('vida-cap', VidaCap);`;

/** O player do YouTube num <webview> (outro conteúdo): mesmo jeito do YtPlayer, controlado por executeJavaScript. */
class WebviewYt {
  static async create(box, videoId, { onError } = {}) {
    const me = new WebviewYt();
    const wv = (me.wv = document.createElement('webview'));
    wv.src = `${location.origin}/yt-player.html?v=${encodeURIComponent(videoId)}`;
    box.appendChild(wv);
    await new Promise((ok) => wv.addEventListener('dom-ready', ok, { once: true }));
    for (let i = 0; i < 100 && wv.isConnected; i++) {
      const [ready, err] = (await me.exec('[!!window.ytReady, window.ytError ?? null]')) ?? [false, null];
      if (err) {
        onError?.(YT_ERRORS[err] ?? `O YouTube deu erro (${err}).`);
        break;
      }
      if (ready) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    me.timer = setInterval(() => me.poll(), 100);
    return me;
  }
  constructor() {
    this.state = -1;
    this.rate = 1;
    this.dur = 0;
    this.anchor = { pos: 0, t: performance.now() };
  }
  get playing() {
    return this.state === 1;
  }
  /** executeJavaScript sem quebrar: com o webview fora da tela (redesenhou), só devolve null. */
  async exec(js) {
    try {
      return this.wv?.isConnected ? await this.wv.executeJavaScript(js) : null;
    } catch {
      return null;
    }
  }
  async poll() {
    if (this.busy || !this.wv?.isConnected) return;
    this.busy = true;
    try {
      const info = await this.exec('ytInfo()');
      if (!info) throw new Error('sem player');
      const [st, t, d, r] = info;
      const now = performance.now();
      const changed = st !== this.state || r !== this.rate;
      this.dur = d || this.dur;
      if (changed || !this.playing || Math.abs(t - this.position()) > 0.12) this.anchor = { pos: t, t: now };
      this.state = st;
      this.rate = r;
      this.onPoll?.(changed);
    } catch {}
    this.busy = false;
  }
  position() {
    return this.playing ? this.anchor.pos + ((performance.now() - this.anchor.t) / 1000) * this.rate : this.anchor.pos;
  }
  duration() {
    return this.dur;
  }
  run(js) {
    return this.exec(`void (${js})`);
  }
  play() {
    this.run('yt.playVideo()');
  }
  pause() {
    this.run('yt.pauseVideo()');
  }
  seek(pos) {
    this.anchor = { pos, t: performance.now() };
    this.run(`yt.seekTo(${Number(pos)}, true)`);
  }
  setRate(r) {
    this.anchor = { pos: this.position(), t: performance.now() };
    this.rate = r;
    this.run(`yt.setPlaybackRate(${Number(r)})`);
  }
  destroy() {
    clearInterval(this.timer);
    this.wv?.remove();
    this.wv = null;
  }
}

/**
 * Mixer do "separar ao vivo": o som do vídeo é capturado (o webview fica mudo), vai pro separador na GPU
 * (/api/live/*) e as 6 faixas voltam e tocam LIVE_DELAY segundos depois, cada uma com volume e mudo.
 * Pra tab, a contagem e a gravação, a posição é a do que o João OUVE (o vídeo menos o atraso), não a do vídeo.
 */
class LiveMixer extends Mixer {
  constructor(yt) {
    super({ sampleRate: LIVE_SR });
    this.yt = yt;
    this.rate = 1;
    this.stalls = 0;
    this.intent = false; // o João mandou tocar (o botão), mesmo que o som ainda não tenha chegado
    this.history = []; // { t (relógio do áudio), pos, playing, rate } do vídeo, a cada leitura
    this.flushAt = -Infinity; // som capturado antes disso não toca (pulou ou pausou)
    this.frozen = 0; // posição mostrada enquanto o som novo não chega
    this.heard = false;
    this.liveSources = new Set();
    this.stats = { late: 0, gpuMs: 0, chunks: 0 };
    this.sent = 0; // amostras de captura já mandadas
    this.sendQ = Promise.resolve();
    for (const id of LIVE_STEMS) {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      this.tracks.set(id, { buffer: null, gain, offset: 0, volume: 1, muted: false, live: true });
    }
    yt.onPoll = () => this.record();
    this.loop = setInterval(() => this.tick(), 40);
  }
  // `playing` = o som separado tá tocando (o Mixer escreve nele; aqui é calculado).
  get playing() {
    return this.heard;
  }
  set playing(_) {}

  /** Liga o separador e a captura. Joga erro com o motivo em português. */
  async startLive(onStep = () => {}) {
    onStep('Ligando o separador na placa de vídeo (na 1ª vez demora uns segundos)…');
    const gone = () => {
      if (!this.closed) return false;
      this.capture?.getTracks().forEach((t) => t.stop());
      return true;
    };
    const st = await send('/api/live/start', 'POST');
    if (gone()) throw new Error('fechou');
    this.gpu = st.gpu;
    // A captura só liga com a janela à vista (o Electron precisa de um quadro do vídeo pra começar; escondida dá
    // "Timeout starting video source"). Depois de ligada, pode ir pra outra janela que o som continua.
    const visible = async () => {
      if (document.visibilityState === 'visible') return;
      onStep('Volta pra janela do app pra ligar o separador…');
      await new Promise((ok) => document.addEventListener('visibilitychange', function f() {
        if (document.visibilityState === 'visible') document.removeEventListener('visibilitychange', f), ok();
      }));
      if (gone()) throw new Error('fechou');
    };
    const capture = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: { channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    await visible();
    onStep('Capturando o som do vídeo…');
    let stream;
    try {
      stream = await capture();
    } catch (err) {
      if (!/timeout/i.test(err.message)) throw err;
      await visible(); // escondeu no meio: tenta de novo quando voltar
      stream = await capture();
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('O app não conseguiu capturar o som do vídeo.');
    this.capture = stream;
    if (gone()) throw new Error('fechou');
    this.capLatency = track.getSettings().latency || 0;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([LIVE_WORKLET], { type: 'text/javascript' })));
    if (gone()) throw new Error('fechou');
    const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(this.ctx, 'vida-cap', { channelCount: 2, channelCountMode: 'explicit' });
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // só pra manter a captura rodando
    src.connect(node).connect(sink).connect(this.ctx.destination);
    this.capNodes = [src, node, sink];
    this.readOut();
    let pend = [];
    let pendN = 0;
    this.pushPending = () => {
      if (!pendN) return;
      const out = new Float32Array(pendN * 2);
      let k = 0;
      for (const p of pend) for (let i = 0; i < p.l.length; i++) (out[k++] = p.l[i]), (out[k++] = p.r[i]);
      const start = this.sent;
      this.sent += pendN;
      pend = [];
      pendN = 0;
      this.send({ 'x-start': String(start) }, out);
    };
    node.port.onmessage = ({ data }) => {
      this.t0 ??= data.t; // a amostra 0 da captura entrou neste instante do relógio
      pend.push(data);
      pendN += data.l.length;
      if (pendN >= 4410) this.pushPending(); // de 0,1 em 0,1 s
    };
  }
  /** Um envio por vez, na ordem (o separador recomeça se faltar um pedaço). */
  send(headers, body) {
    this.sendQ = this.sendQ.then(() =>
      fetch('/api/live/in', { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers }, body: body ?? undefined, signal: this.abort?.signal }).catch(() => {}),
    );
  }
  /** Lê as faixas separadas e agenda cada pedaço pra tocar LIVE_DELAY depois de quando ele foi capturado. */
  async readOut() {
    this.abort = new AbortController();
    const res = await fetch('/api/live/out', { signal: this.abort.signal });
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let skip = 4; // marca "VDJL" do começo
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
        if (skip) {
          if (buf.length < skip) continue;
          buf = buf.slice(skip);
          skip = 0;
        }
        while (buf.length >= 12) {
          const dv = new DataView(buf.buffer, buf.byteOffset, 12);
          const start = dv.getInt32(0, true);
          const n = dv.getInt32(4, true);
          const size = 12 + 6 * 2 * n * 4;
          if (buf.length < size) break;
          this.stats.gpuMs = dv.getInt32(8, true);
          this.schedule(start, n, new Float32Array(buf.slice(12, size).buffer));
          buf = buf.slice(size);
        }
      }
    } catch {}
  }
  schedule(start, n, pcm) {
    const captured = this.t0 + start / LIVE_SR;
    if (captured < this.flushAt) return; // som de antes de pular/pausar
    const when = captured + LIVE_DELAY;
    if (when < this.ctx.currentTime + 0.01) return void this.stats.late++;
    this.stats.chunks++;
    LIVE_STEMS.forEach((id, i) => {
      const b = this.ctx.createBuffer(2, n, LIVE_SR);
      b.copyToChannel(pcm.subarray(i * 2 * n, (i * 2 + 1) * n), 0);
      b.copyToChannel(pcm.subarray((i * 2 + 1) * n, (i * 2 + 2) * n), 1);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.tracks.get(id).gain);
      s.onended = () => this.liveSources.delete(s);
      this.liveSources.add(s);
      s.start(when);
    });
    this.onStats?.(this.stats);
  }

  /** Guarda onde o vídeo tava (no relógio do áudio). */
  record() {
    const y = this.yt;
    const t = this.ctx.currentTime;
    const playing = y.playing;
    const last = this.history.at(-1);
    if (playing && !last?.playing && this.countIn) this.scheduleSticks(t);
    // Pausou ou deu play pelo próprio vídeo (clique nele): vale como o botão.
    if (last && last.playing && !playing && y.state === 2 && this.intent) {
      this.intent = false;
      this.stopAtHeard();
    } else if (playing && !this.intent) this.intent = true;
    this.history.push({ t, pos: y.position(), playing, rate: y.rate });
    while (this.history.length > 2 && this.history[1].t < t - 30) this.history.shift();
    if (y.state === 0 && this.intent) this.ended = true;
  }
  /** O que o João ouve no instante `t` (relógio do áudio): onde o vídeo tava LIVE_DELAY antes. */
  heardAt(t) {
    const tau = t - LIVE_DELAY - (this.capLatency || 0);
    if (tau < this.flushAt) return { pos: this.frozen, playing: false };
    let s = null;
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].t <= tau) {
      s = this.history[i];
      break;
    }
    if (!s || s.t < this.flushAt) return { pos: this.frozen, playing: false };
    return { pos: s.pos + (s.playing ? (tau - s.t) * s.rate : 0), playing: s.playing };
  }
  position() {
    return Math.max(0, this.heardAt(this.ctx.currentTime).pos);
  }
  duration() {
    return this.yt.duration();
  }
  tick() {
    const now = this.ctx.currentTime;
    const h = this.heardAt(now);
    if (h.playing && !this.heard) {
      this.heard = true;
      this.startPos = h.pos;
      this.startedAt = now;
      this.started = { pos: h.pos, at: now };
      this.startTakes(h.pos);
      this.onPlay?.(h.pos, now);
    } else if (!h.playing && this.heard) {
      this.heard = false;
      this.stopSources();
      if (this.intent && !this.ended) this.stalls++; // o vídeo parou pra carregar (ninguém pausou)
      this.onPause?.();
      if (this.ended) {
        this.ended = false;
        this.intent = false;
        this.onEnd?.();
      }
    } else if (h.playing && Math.abs(h.pos - (this.lastHeard ?? h.pos)) > 0.3 + 0.04 * 2) {
      // Pulou sem cortar o som (o A–B voltando pro A): as gravações e a tab recomeçam do ponto novo.
      this.startTakes(h.pos);
      this.onPlay?.(h.pos, now);
    }
    this.lastHeard = h.playing ? h.pos + 0.04 * (this.history.at(-1)?.rate ?? 1) : null;
  }
  startTakes(pos) {
    this.stopSources();
    if (this.rate !== 1) return; // em outra velocidade a gravação não acompanha
    const when = this.ctx.currentTime + 0.01;
    for (const t of this.tracks.values()) {
      if (!t.buffer) continue;
      const rel = pos - t.offset;
      if (rel >= t.buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      src.start(when + Math.max(0, -rel), Math.max(0, rel));
      this.sources.push(src);
    }
  }
  /** Corta o som agora (pausou ou pulou): o que já tava na fila não toca, e o separador esquece o contexto. */
  flush(pos) {
    this.flushAt = this.ctx.currentTime;
    this.frozen = pos;
    for (const s of this.liveSources) {
      try {
        s.stop();
      } catch {}
    }
    this.liveSources.clear();
    this.stopSources();
    this.pushPending?.();
    this.send({ 'x-start': String(this.sent), 'x-reset': '1' });
    if (this.heard) {
      this.heard = false;
      this.onPause?.();
    }
  }
  /** Tocar: o vídeo sai já; o som separado chega LIVE_DELAY depois (a contagem cai bem antes dele). */
  play(pos = this.position(), countIn = null) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (Math.abs(this.yt.position() - pos) > 0.25) {
      this.flush(pos);
      this.yt.seek(pos);
    }
    this.intent = true;
    this.ended = false;
    clearTimeout(this.startTimer);
    const beat = countIn ? 60 / countIn.bpm : 0;
    const total = (countIn?.beats ?? 0) * beat;
    // Contagem mais longa que o atraso (música lenta): segura o vídeo um pouco, pra dar tempo das baquetadas.
    const wait = Math.max(0, total - LIVE_DELAY + 0.2);
    this.countIn = countIn ? { beats: countIn.beats, beat } : null;
    this.startTimer = setTimeout(() => this.intent && this.yt.play(), wait * 1000);
    return this.ctx.currentTime + wait + LIVE_DELAY;
  }
  /** As baquetadas: terminam bem quando o som separado começa (o vídeo saiu em `tv`). */
  scheduleSticks(tv) {
    const { beats, beat } = this.countIn;
    this.countIn = null;
    const first = tv + LIVE_DELAY + (this.capLatency || 0) - beats * beat;
    for (let i = 0; i < beats; i++) if (first + i * beat > this.ctx.currentTime) this.sources.push(this.stick(first + i * beat));
  }
  /**
   * Pausa no que o João OUVIU: o vídeo (que tava 3,5 s na frente) volta pra esse ponto. Sem isso, a posição
   * passava a ser a do vídeo uns segundos depois de pausar: a tab pulava pra frente e o play pulava esse trecho.
   */
  pause() {
    clearTimeout(this.startTimer);
    this.intent = false;
    this.countIn = null;
    this.stopAtHeard();
  }
  stopAtHeard() {
    const h = this.position();
    this.yt.pause();
    this.yt.seek(h);
    this.flush(h);
  }
  seek(pos) {
    this.flush(pos);
    this.yt.seek(pos);
    if (!this.intent) this.onPause?.();
  }
  /** A–B: volta pro A sem cortar o som (o atraso é igual pros dois lados, então emenda certinho). */
  loopTo(pos) {
    this.pushPending?.();
    this.yt.seek(pos);
    this.send({ 'x-start': String(this.sent), 'x-reset': '1' });
  }
  setRate(r) {
    this.rate = r;
    this.yt.setRate(r);
    if (this.heard) this.startTakes(this.position());
  }
  // Gravação nova / ajuste fino: as gravações recomeçam no ponto certo (no Mixer isso pularia, e aqui pular corta o som).
  add(id, buffer, opts) {
    const was = this.heard;
    this.heard = false;
    super.add(id, buffer, opts);
    this.heard = was;
    if (was) this.startTakes(this.position());
  }
  set(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.apply(id);
    if ('offset' in patch && this.heard) this.startTakes(this.position());
  }
  close() {
    if (this.closed) return;
    clearInterval(this.loop);
    clearTimeout(this.startTimer);
    this.abort?.abort();
    this.capture?.getTracks().forEach((t) => t.stop());
    for (const n of this.capNodes ?? []) n.disconnect();
    for (const s of this.liveSources) {
      try {
        s.stop();
      } catch {}
    }
    this.liveSources.clear();
    this.yt.onPoll = null;
    this.yt.destroy();
    super.close();
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
  // Fora de 1× (YouTube mais devagar) o player do alphaTab não acompanha a velocidade: aí ele fica parado e o
  // cursor é levado na mão, 12× por segundo, pro ponto em que o vídeo tá (e rola quando muda de compasso).
  let speed = 1;
  let follow = 0;
  const followVideo = () => {
    clearInterval(follow);
    let bar = '';
    follow = setInterval(() => {
      if (!mixer.playing || gpMs() < 0) return;
      tabApi.timePosition = gpMs();
      const now = box.querySelector('.at-cursor-bar')?.style.transform ?? '';
      if (now !== bar) {
        bar = now;
        tabApi.scrollToCursor();
      }
    }, 80);
  };
  const sync = (pos, when) => {
    clearTimeout(startTimer);
    clearTimeout(settleTimer);
    clearInterval(follow);
    tabApi.pause();
    if (speed !== 1) return void (settleTimer = setTimeout(followVideo, SETTLE_MS));
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
    clearInterval(follow);
    tabApi.pause();
    settleTimer = setTimeout(() => (tabApi.timePosition = Math.max(0, gpMs())), SETTLE_MS);
  };
  // Confere com o relógio do mixer; escorregou mais de 40 ms, acerta (pulando enquanto toca, que não dá problema).
  const drift = setInterval(() => {
    if (speed !== 1 || !mixer.playing || gpMs() < 0 || tabApi.playerState !== 1) return;
    if (Math.abs(tabApi.timePosition - gpMs()) > 40) tabApi.timePosition = gpMs();
  }, 1000);
  return {
    api: tabApi,
    setTrack: (i) => tabApi.renderScore(score, [i]),
    setSpeed: (r) => (speed = r),
    resync: () => (mixer.playing ? sync(mixer.position(), mixer.ctx.currentTime) : mixer.onPause()),
    destroy: () => {
      clearTimeout(startTimer);
      clearTimeout(settleTimer);
      clearInterval(drift);
      clearInterval(follow);
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
  const has = { gp: d.tab_available, mp3: state.stems.length > 0, youtube: Boolean(ytIdOf(s.youtube_url)) };
  const wanted = studioPrefs(s.url_slug).source;
  const source = has[wanted] ? wanted : has.mp3 ? 'mp3' : has.youtube ? 'youtube' : has.gp ? 'gp' : null;
  // Separar ao vivo (S15): com o separador instalado e placa NVIDIA.
  const liveSt = hasWebview() && has.youtube ? await api('/api/live').catch(() => null) : null;
  const canLive = Boolean(liveSt?.available);
  const liveOn = canLive && studioPrefs(s.url_slug).live !== false;
  d.live_on = source === 'youtube' && liveOn;
  const fileInput = '<input id="st-file" type="file" accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*" hidden>';
  // Log do separador (o que ele tá fazendo, ou onde parou), fechado por padrão.
  const sepLog = d.sep_log?.lines.length
    ? `<details class="sep-log"><summary>Ver log</summary><pre class="log" id="st-log">${esc(d.sep_log.lines.join('\n'))}</pre></details>`
    : '';
  const mp3Card = !state.original && has.youtube
    ? `<p class="muted studio-src-line">Quer tirar a tua parte (volume por instrumento)? Só com o MP3 separado: <label class="link-btn file-btn">pôr o MP3${fileInput}</label> (a tua cópia).</p>`
    : !state.original
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
      <button class="${source === 'youtube' ? 'active' : ''}" data-src="youtube" ${has.youtube ? '' : 'disabled'}>🎬 Usar YouTube<span>${!has.youtube ? 'cola o link do vídeo aqui embaixo' : canLive ? 'o vídeo, sem baixar nada, separado ao vivo' : 'o vídeo, sem baixar nada (precisa de internet)'}</span></button>
    </div>`;
  const ytLine = has.youtube
    ? `<p class="muted studio-src-line">🎬 <a href="${esc(s.youtube_url)}" target="_blank" rel="noopener">vídeo no YouTube ↗</a> <button class="link-btn" id="st-yt-edit">trocar o link</button></p>
       <form id="st-yt-form" class="yt-link-form" hidden><input name="url" placeholder="Link do vídeo no YouTube" value="${esc(s.youtube_url)}"><button class="btn small primary">Salvar</button><button type="button" class="btn small" id="st-yt-clear">Tirar</button></form>`
    : `<form id="st-yt-form" class="card yt-link-form"><b>🎬 Tocar pelo YouTube</b><input name="url" placeholder="Cola o link do vídeo (youtube.com/watch?v=… ou youtu.be/…)"><button class="btn small primary">Salvar</button></form>`;
  setTimeout(() => {
    for (const b of document.querySelectorAll('[data-src]')) {
      b.onclick = () => {
        saveStudioPrefs(s.url_slug, { ...studioPrefs(s.url_slug), source: b.dataset.src });
        render();
      };
    }
    wireStudioSource(d);
    wireYoutubeLink(d);
    document.getElementById('st-live')?.addEventListener('change', (e) => {
      saveStudioPrefs(s.url_slug, { ...studioPrefs(s.url_slug), live: e.target.checked });
      render();
    });
    if (source) mountStudio(d, source).catch((e) => toast(e.message));
  }, 0);
  return `
    <p class="song-top"><a href="#/">← Músicas</a> <button id="st-del" class="btn small">Tirar da lista</button></p>
    <h1>${esc(s.title)}</h1>
    <div class="muted">${esc(s.artist)}${s.tuning && s.tuning !== 'E padrão' ? ` · ${esc(s.tuning)}` : ''}${s.bpm ? ` · ${s.bpm} bpm` : ''}</div>
    <h2>Som da banda</h2>
    ${sourcePicker}
    ${ytLine}
    ${mp3Card}
    <p class="muted studio-src-line">${d.tab_available ? 'Guitar Pro na música.' : 'Sem Guitar Pro.'} <label class="link-btn file-btn">${d.tab_available ? 'Trocar o Guitar Pro' : 'Pôr o Guitar Pro (.gp)'}<input id="st-gp" type="file" accept=".gp,.gp3,.gp4,.gp5,.gpx,.gp7" hidden></label> <span class="muted">· ou baixa na pasta vigiada que ele entra sozinho</span></p>
    ${source === 'youtube' ? `<div class="card yt-card studio-yt"><div class="yt-frame" id="st-yt"></div><p class="muted yt-msg" id="st-yt-msg"></p>
      ${canLive ? `<label class="live-toggle"><input type="checkbox" id="st-live" ${liveOn ? 'checked' : ''}> ✂️ <b>Separar as faixas ao vivo</b> <span class="muted">na placa de vídeo: volume por instrumento, e o som sai uns ${String(LIVE_DELAY).replace('.', ',')} s depois do vídeo</span></label>` : ''}</div>` : ''}
    <div id="st-main" class="studio-main">${source ? `<p class="muted" id="st-loading">${source === 'youtube' ? 'Abrindo o YouTube…' : 'Carregando as faixas…'}</p>` : '<p class="empty">Sem som da banda ainda: cola o link do YouTube ou põe o MP3 aí em cima.</p>'}</div>`;
}

/** Manda o áudio da música (já começa a separar). Devolve false se deu erro (o aviso já apareceu). */
async function uploadAudio(slug, file) {
  // m4a/aac (iTunes) e afins: o separador não lê, então o navegador converte pra WAV antes de mandar.
  if (!/\.(mp3|wav|flac|ogg)$/i.test(file.name)) {
    toast(`Convertendo ${file.name}…`);
    try {
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const audio = await ctx.decodeAudioData(await file.arrayBuffer());
      const chans = [audio.getChannelData(0), audio.getChannelData(audio.numberOfChannels > 1 ? 1 : 0)];
      file = new File([wavBlob(null, audio.sampleRate, chans)], file.name.replace(/\.[^.]+$/, '') + '.wav');
    } catch {
      toast('Não consegui ler esse arquivo. Tenta mp3, m4a, wav ou flac.');
      return false;
    }
  }
  toast(`Enviando ${file.name}…`);
  const res = await fetch(`/api/songs/${encodeURIComponent(slug)}/audio`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error);
    return false;
  }
  saveStudioPrefs(slug, { ...studioPrefs(slug), source: 'mp3' });
  return true;
}

/** Link do YouTube da música: colar, trocar ou tirar. */
function wireYoutubeLink(d) {
  const form = document.getElementById('st-yt-form');
  if (!form) return;
  const save = async (url) => {
    try {
      await send(`/api/songs/${encodeURIComponent(d.song.url_slug)}`, 'PATCH', { youtube_url: url });
    } catch (err) {
      return toast(err.message);
    }
    if (url) saveStudioPrefs(d.song.url_slug, { ...studioPrefs(d.song.url_slug), source: 'youtube' });
    toast(url ? 'Link do YouTube salvo.' : 'Link do YouTube tirado.');
    render();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    if (url) save(url);
  };
  document.getElementById('st-yt-edit')?.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.url.select();
  });
  document.getElementById('st-yt-clear')?.addEventListener('click', () => save(null));
}

/** Upload do MP3 e acompanhamento da separação. */
function wireStudioSource(d) {
  const slug = d.song.url_slug;
  document.getElementById('st-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file && (await uploadAudio(slug, file))) render();
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
  const yt = source === 'youtube';
  const live = yt && d.live_on;
  const session = (studioSession = { mixer: null, recorder: null, slug });
  let mixer;
  if (live) {
    // Ao vivo (S15): o vídeo toca mudo num <webview> e o som dele é separado na GPU e volta pro mixer.
    const msg = document.getElementById('st-yt-msg');
    const player = await WebviewYt.create(document.getElementById('st-yt'), ytIdOf(s.youtube_url), { onError: (m) => (msg.textContent = m) });
    if (studioSession !== session) return player.destroy();
    mixer = session.mixer = new LiveMixer(player);
    try {
      await mixer.startLive((m) => {
        const l = document.getElementById('st-loading');
        if (l) l.textContent = m;
      });
    } catch (err) {
      if (studioSession !== session) return;
      main.innerHTML = `<div class="card"><p><b>Não deu pra separar ao vivo.</b> ${esc(err.message)}</p><p><button class="btn" id="st-live-off">Tocar o vídeo sem separar</button></p></div>`;
      document.getElementById('st-live-off').onclick = () => {
        saveStudioPrefs(slug, { ...studioPrefs(slug), live: false });
        render();
      };
      return;
    }
    if (studioSession !== session) return;
  } else if (yt) {
    // YouTube (S14): o vídeo é o som da banda; o player fica fora do #st-main (que é redesenhado aqui embaixo).
    const msg = document.getElementById('st-yt-msg');
    const player = await YtPlayer.create(document.getElementById('st-yt'), ytIdOf(s.youtube_url), { onError: (m) => (msg.textContent = m) });
    if (studioSession !== session) return player.destroy();
    mixer = new YtMixer(player);
  } else mixer = new Mixer();
  session.mixer = mixer;
  const prefs = studioPrefs(slug);
  // Volume é por fonte: "guitarras" do MP3 e as faixas do Guitar Pro não se misturam.
  const volKey = live ? 'liveStems' : source; // 'live' é a chave do "separar ao vivo"
  prefs[volKey] ??= {};
  const vols = prefs[volKey];
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
      : source === 'gp'
        ? await midiStems(s.id, mixer.ctx, loading)
        : [];
  if (studioSession !== session) return mixer.close();
  const vol = (id, def = 1) => vols[id]?.v ?? def;
  const muted = (id) => vols[id]?.m ?? false;
  for (const t of tracks) mixer.add(t.id, t.buffer, { volume: vol(t.id), muted: muted(t.id) });
  if (yt && !live) mixer.yt.setVolume(vol('yt'));
  if (live) for (const id of LIVE_STEMS) mixer.set(id, { volume: vol(id), muted: muted(id) });
  const rowTracks = live ? LIVE_STEMS.map((id) => ({ id, label: STEM_LABEL[id] ?? id })) : tracks;
  // Gravação feita em cima do YouTube só toca junto do YouTube (o tempo do vídeo não é o do MP3), e vice-versa.
  const takeSource = yt ? 'youtube' : 'audio';
  const takes = {};
  const otherTakes = [];
  for (const kind of ['guitar', 'bass', 'vocal']) {
    const tk = state.takes[kind];
    if (!tk) continue;
    if ((tk.source ?? 'audio') !== takeSource) {
      otherTakes.push(kind);
      continue;
    }
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
  if (studioSession !== session) return; // redesenhou enquanto listava as entradas
  const named = () => devices.some((x) => x.label);
  window.__studio = session; // pra depurar no console

  main.innerHTML = `
    <div class="card transport">
      <button id="st-play" class="btn primary">▶ Tocar</button>
      <button id="st-stop" class="btn">⏹</button>
      <input id="st-seek" type="range" min="0" max="${Math.ceil(mixer.duration())}" step="0.1" value="0" aria-label="Posição">
      <span id="st-time" class="mono">0:00 / ${fmtTime(mixer.duration())}</span>
      ${yt ? ytPracticeHtml() : ''}
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
        ${yt ? `<span class="nudge" title="Onde o compasso 1 da tab cai no vídeo">Compasso 1 em <button data-tab-off="-50">−</button><b id="st-tab-off">${((state.youtube_offset_ms ?? 0) / 1000).toFixed(2).replace('.', ',')} s</b><button data-tab-off="50">+</button></span>
          <button id="st-tap" class="btn small" title="Dá play e aperta bem quando entra a 1ª nota da música">👆 Marcar o 1</button>` : ''}
        <span class="muted note">${source === 'mp3' && state.tab_offset_note ? esc(state.tab_offset_note) : yt ? esc(state.youtube_offset_note ?? (state.youtube_offset_ms ? '' : 'dá play e aperta o 👆 na 1ª nota')) : ''}</span>
      </div>
      <div id="st-tab" class="tab-box studio-tab-box"></div>
    </details>` : ''}
    ${yt && !live ? '' : `<div class="chips studio-presets">
      <button class="chip" data-preset="guitar">🎸 Vou tocar guitarra/violão</button>
      <button class="chip" data-preset="bass">🎸 Vou tocar baixo</button>
      <button class="chip" data-preset="drums">🥁 Vou tocar bateria</button>
      <button class="chip" data-preset="vocal">🎤 Vou cantar</button>
      <button class="chip" data-preset="all">Tudo normal</button>
    </div>`}
    <h2>Mixer <span class="muted">· ${source === 'gp' ? '🎼 som do Guitar Pro' : live ? '🎬 YouTube separado ao vivo' : yt ? '🎬 YouTube' : '🎧 MP3 separado'}</span></h2>
    <div class="card mixer-card">
      ${live ? `<p class="muted mix-note" id="st-live-info">Separando ao vivo na ${esc(mixer.gpu ?? 'placa de vídeo')}. Dá play: o som chega uns ${String(LIVE_DELAY).replace('.', ',')} s depois do vídeo.</p>` : ''}
      ${yt && !live ? `<div class="mix-row" data-yt-row><span></span><span class="mix-name">🎬 Vídeo do YouTube</span>
          <input type="range" min="0" max="100" step="5" value="${Math.round(vol('yt') * 100)}" data-yt-vol aria-label="Volume do YouTube"><b class="mix-val" data-yt-val>${Math.round(vol('yt') * 100)}%</b></div>
        <p class="muted mix-note">No YouTube não dá pra separar os instrumentos: pra tirar a tua parte, usa o MP3.</p>` : ''}
      ${otherTakes.length ? `<p class="muted mix-note">${otherTakes.map((k) => TAKE_LABEL[k]).join(' e ')}: gravado em cima ${yt ? 'do MP3/Guitar Pro' : 'do YouTube'}, só toca junto ${yt ? 'deles' : 'dele'}. Gravar aqui substitui.</p>` : ''}
      ${rowTracks.map((t) => rowHtml(t.id, t.label)).join('')}
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
  let tabOffset = source === 'mp3' ? state.tab_offset_ms / 1000 : yt ? (state.youtube_offset_ms ?? 0) / 1000 : 0;
  const offsetField = yt ? 'youtube_offset' : 'tab_offset';
  const saveOffset = (note) => {
    clearTimeout(session.offTimer);
    session.offTimer = setTimeout(
      () =>
        fetch(`/api/songs/${encodeURIComponent(slug)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [`${offsetField}_ms`]: Math.round(tabOffset * 1000), [`${offsetField}_note`]: note }),
        }),
      600,
    );
  };
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
      saveOffset('ajustado à mão');
    });
    // YouTube: não dá pra analisar o áudio do vídeo, então a pessoa marca. Desconta uns 0,1 s do tempo de reação.
    document.getElementById('st-tap')?.addEventListener('click', () => {
      if (!mixer.playing) return toast('Dá play primeiro e aperta bem quando entrar a 1ª nota.');
      tabOffset = Math.max(0, mixer.position() - 0.1 * mixer.rate);
      document.getElementById('st-tab-off').textContent = `${tabOffset.toFixed(2).replace('.', ',')} s`;
      main.querySelector('.studio-tab-bar .note').textContent = 'marcado na mão (− / + pra acertar)';
      session.tab?.resync();
      saveOffset('marcado na mão');
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
    if (e.target.matches('[data-yt-vol]')) {
      const v = Number(e.target.value) / 100;
      mixer.yt.setVolume(v);
      vols.yt = { v, m: false };
      savePrefs();
      main.querySelector('[data-yt-val]').textContent = `${Math.round(v * 100)}%`;
      return;
    }
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
  // No ao vivo, o botão segue o que a pessoa mandou (o som ainda pode estar chegando).
  const isOn = () => mixer.intent ?? mixer.playing;
  const showPlay = () => (play.textContent = isOn() ? '⏸ Pausar' : '▶ Tocar');
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
    if (isOn()) mixer.pause();
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
  // YouTube: velocidade (o tom não muda) e repetir trecho. Em outra velocidade a gravação não acompanha.
  const practice = yt
    ? wireYtPractice(main.querySelector('.transport'), {
        position: () => mixer.position(),
        seek: (p) => !session.recording && mixer.seek(p),
        setRate: (r) => {
          mixer.setRate(r);
          session.tab?.setSpeed(r);
          session.tab?.resync();
        },
        canRate: () => (session.recording ? (toast('Gravando: a velocidade fica em 1×.'), false) : true),
        // Ao vivo: o A–B olha o vídeo (que vai na frente) e volta sem cortar o som.
        ...(live ? { loopPosition: () => mixer.yt.position(), loopSeek: (p) => mixer.loopTo(p) } : {}),
      })
    : null;
  if (live) {
    const info = document.getElementById('st-live-info');
    mixer.onStats = (st) => {
      if (info) info.textContent = `Separando ao vivo na ${mixer.gpu ?? 'placa de vídeo'} (~${st.gpuMs} ms por segundo de música). O som sai ${String(LIVE_DELAY).replace('.', ',')} s depois do vídeo.${st.late ? ` ${st.late} pedaço(s) chegaram tarde.` : ''}`;
    };
  }
  session.timer = setInterval(() => {
    practice?.tick();
    const p = mixer.position();
    const dur = mixer.duration();
    if (Number(seek.max) !== Math.ceil(dur)) seek.max = Math.ceil(dur);
    if (document.activeElement !== seek) seek.value = p;
    time.textContent = `${fmtTime(p)} / ${fmtTime(dur)}`;
    if (yt) showPlay(); // dá pra pausar/tocar pelo próprio vídeo
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
    if (yt && mixer.rate !== 1) return toast('Pra gravar, volta a velocidade pra 1×.');
    if (!(await unlockInputs())) return;
    if (!(await openInput())) return;
    session.recorder.onLevel = (peak) => (meter.style.width = `${Math.min(100, peak * 100)}%`);
    const kind = kindSel.value;
    if (takes[kind]) setTrack(`take:${kind}`, { muted: true }); // não grava ouvindo a gravação antiga da mesma coisa
    mixer.remove('new');
    document.getElementById('st-new-row').innerHTML = '';
    session.recording = { kind, startPos: mixer.position(), stalls: mixer.stalls ?? 0 };
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
    // `started` = onde e quando a música saiu de verdade (no YouTube, quando o vídeo avisou que começou).
    const st = mixer.started ?? { pos: rec.startPos, at: rec.when };
    const offset = st.pos + (firstT - st.at) - latency;
    const slipped = yt && (mixer.stalls ?? 0) > rec.stalls;
    const buffer = mixer.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    mixer.add('new', buffer, { offset });
    session.newTake = { kind: rec.kind, samples, sampleRate, offset };
    status.textContent = `Gravado: ${fmtTime(samples.length / sampleRate)}. Atraso descontado: ${Math.round(latency * 1000)} ms.${slipped ? ' ⚠️ O YouTube parou pra carregar no meio: depois desse ponto a gravação pode ter saído fora do tempo.' : ''}`;
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
        headers: { 'content-type': 'audio/wav', 'x-offset-ms': String(Math.round(t.offset * 1000)), 'x-source': takeSource },
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

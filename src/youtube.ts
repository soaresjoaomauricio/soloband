/**
 * YouTube (S14, igual ao D73 do Vida de Jão): a música guarda só o LINK do vídeo e o app toca pelo player oficial
 * do YouTube embutido na tela. Nunca baixa o áudio nem o vídeo.
 */

const ID_RE = /^[\w-]{11}$/;

/** Id do vídeo (11 caracteres) a partir de qualquer link do YouTube; null se não for link de vídeo. */
export function youtubeId(input: string): string | null {
  const raw = input.trim();
  if (ID_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/)?.[2] ?? null;
  }
  return id && ID_RE.test(id) ? id : null;
}

/** Link guardado: sempre no mesmo formato (sem playlist, sem tempo, sem rastreio). Chame só com link válido. */
export function normalizeYoutubeUrl(input: string): string {
  const id = youtubeId(input);
  if (!id) throw new Error('Esse link não é de um vídeo do YouTube.');
  return `https://www.youtube.com/watch?v=${id}`;
}

/** "Artista - Música (Official Video)" → { artist, title }. Sem " - ", o artista vem do canal (sem " - Topic"/"VEVO"). */
export function guessSongFromVideo(videoTitle: string, channel: string): { title: string; artist: string | null } {
  const tidy = (s: string) =>
    s
      .replace(/\s*[([][^)\]]*\b(official|oficial|lyrics?|letra|audio|áudio|video|vídeo|clipe|hd|hq|4k|remaster(ed)?|ao vivo|live|visualizer)\b[^)\]]*[)\]]/gi, '')
      .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|official|oficial|lyrics?|ao vivo|live)\b.*$/i, '')
      .replace(/\s*\|.*$/, '')
      .trim();
  const parts = videoTitle.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return { artist: tidy(parts[0]!), title: tidy(parts.slice(1).join(' - ')) || parts[1]! };
  const artist = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim() || null;
  return { title: tidy(videoTitle) || videoTitle, artist };
}

/** Nome do vídeo pelo oEmbed público do YouTube (só título e canal). Sem internet, volta sem nome. */
export async function youtubeInfo(
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ url: string; id: string; video_title: string | null; channel: string | null; title: string | null; artist: string | null }> {
  const url = normalizeYoutubeUrl(input);
  const id = youtubeId(url)!;
  const empty = { url, id, video_title: null, channel: null, title: null, artist: null };
  try {
    const res = await fetchFn(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return empty;
    const o = (await res.json()) as { title?: string; author_name?: string };
    const guess = guessSongFromVideo(o.title ?? '', o.author_name ?? '');
    return { url, id, video_title: o.title ?? null, channel: o.author_name ?? null, title: o.title ? guess.title : null, artist: guess.artist };
  } catch {
    return empty;
  }
}

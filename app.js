'use strict';
// Наизусть: вся логика приложения. Данные живут только в этом браузере (localStorage).

const STORE_KEY = 'naizust.v1';
const YT_KEY = 'naizust.ytkey';
const app = document.getElementById('app');

// ---------- Хранилище ----------

function loadData() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d && Array.isArray(d.songs)) return d;
  } catch (e) { /* испорченные данные: начинаем с пустого списка */ }
  return { version: 1, songs: [] };
}

let data = loadData();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch (e) { toast('Не получилось сохранить: браузер не даёт записать данные.'); }
}

function getKey() { try { return localStorage.getItem(YT_KEY) || ''; } catch (e) { return ''; } }
function setKey(k) {
  try { if (k) localStorage.setItem(YT_KEY, k); else localStorage.removeItem(YT_KEY); } catch (e) { /* без ключа тоже работаем */ }
}

const findSong = id => data.songs.find(s => s.id === id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Мелочи ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(sec) {
  sec = Math.round(sec || 0);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

// ---------- Текст песни: разбор и деление на фрагменты ----------

// Строка "[01:18.50] Текст" -> { t: 78.5, text: "Текст" }. Пустые метки времени тоже запоминаем:
// они показывают, где кончается строка перед проигрышем.
function parseLrc(text) {
  const lines = [];
  const stamps = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const body = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
    for (const m of tags) {
      const t = Number(m[1]) * 60 + parseFloat(m[2]);
      stamps.push(t);
      if (body) lines.push({ t, text: body });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  stamps.sort((a, b) => a - b);
  return { lines, stamps };
}

function parsePlain(text) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(t => ({ t: null, text: t }));
  return { lines, stamps: [] };
}

const norm = s => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// Повторяющиеся строки считаем припевом, неповторяющиеся куплетом (как в прототипе на Python)
function splitBlocks(lines) {
  const count = new Map();
  for (const l of lines) count.set(norm(l.text), (count.get(norm(l.text)) || 0) + 1);

  const segs = [];
  for (const l of lines) {
    const chorus = count.get(norm(l.text)) > 1;
    const last = segs[segs.length - 1];
    if (last && last.chorus === chorus) last.lines.push(l);
    else segs.push({ chorus, lines: [l] });
  }

  // Одиночные строки приклеиваем к соседу, соседей одного типа склеиваем
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    const i = segs.findIndex(s => s.lines.length < 2);
    if (i !== -1) {
      if (i > 0) segs[i - 1].lines.push(...segs[i].lines);
      else segs[1].lines.unshift(...segs[0].lines);
      segs.splice(i, 1);
      changed = true;
    }
    for (let k = 0; k < segs.length - 1;) {
      if (segs[k].chorus === segs[k + 1].chorus) {
        segs[k].lines.push(...segs[k + 1].lines);
        segs.splice(k + 1, 1);
      } else k++;
    }
  }
  return segs;
}

// Слишком длинный фрагмент не влезет на экран: режем на части по ~8 строк
function chunkLong(segs) {
  const out = [];
  for (const s of segs) {
    const n = s.lines.length;
    if (n <= 12) { out.push(s); continue; }
    const size = Math.ceil(n / Math.ceil(n / 8));
    for (let i = 0; i < n; i += size) out.push({ chorus: s.chorus, lines: s.lines.slice(i, i + size) });
  }
  return out;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// Фрагменты песни + «учебные единицы»: одинаковый припев учим один раз
function buildFragments(lines, stamps, duration) {
  const segs = chunkLong(splitBlocks(lines));
  const units = [];
  const sets = [];
  const fragments = [];

  segs.forEach((s, i) => {
    const kind = s.chorus ? 'Припев' : 'Куплет';
    const set = new Set(s.lines.map(l => norm(l.text)));
    let u = units.findIndex((un, j) => un.kind === kind && jaccard(sets[j], set) >= 0.75);
    const repeat = u !== -1;
    if (!repeat) {
      units.push({ kind, stage: 1, learned: false });
      sets.push(set);
      u = units.length - 1;
    }

    let start = null;
    let end = null;
    if (s.lines[0].t != null) {
      start = s.lines[0].t;
      const lastT = s.lines[s.lines.length - 1].t;
      const nextStart = segs[i + 1] ? segs[i + 1].lines[0].t : null;
      const nextStamp = stamps.find(t => t > lastT + 0.01);
      const cands = [nextStart, nextStamp, duration || null].filter(v => v != null);
      end = Math.min(cands.length ? Math.min(...cands) : lastT + 6, lastT + 8);
    }
    fragments.push({ kind, unit: u, repeat, start, end, stage: 1, learned: false, lines: s.lines.map(l => ({ t: l.t, text: l.text })) });
  });

  const total = { 'Куплет': 0, 'Припев': 0 };
  units.forEach(un => total[un.kind]++);
  const seen = { 'Куплет': 0, 'Припев': 0 };
  units.forEach(un => {
    seen[un.kind]++;
    un.label = total[un.kind] > 1 ? `${un.kind} ${seen[un.kind]}` : un.kind;
  });
  fragments.forEach(f => { f.label = units[f.unit].label + (f.repeat ? ' (повтор)' : ''); });
  fixEnds(fragments, duration);

  return { fragments, units };
}

// Разметка хранит только начало строки, конца нет. Если последняя строка фрагмента длинная
// («Ха, о-о-о, о-о-о, о-о»), она не успевает до начала следующего фрагмента и обрывается.
// Оцениваем длину строки по темпу этой песни (секунд на слог) плюс полсекунды на затухание
// и при нужде сдвигаем конец, но не дальше чем на 2,5 сек после начала следующего фрагмента.
const vowelsOf = s => (String(s).match(/[аеёиоуыэюяaeiouy]/gi) || []).length || 1;

function secPerSyllable(lines) {
  const rates = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const gap = lines[i + 1].t - lines[i].t;
    if (gap > 0.3 && gap < 8) rates.push(gap / vowelsOf(lines[i].text));
  }
  if (!rates.length) return 0.25;
  rates.sort((a, b) => a - b);
  // Берём быстрые строки (четверть самых быстрых): в медленные попадают паузы между строками
  return Math.min(0.6, Math.max(0.12, rates[Math.floor(rates.length * 0.25)]));
}

function fixEnds(fragments, duration) {
  const all = fragments.flatMap(f => f.lines).filter(l => l.t != null);
  if (!all.length) return;
  const rate = secPerSyllable(all);
  fragments.forEach((f, i) => {
    if (f.start == null || f.end == null) return;
    const last = f.lines[f.lines.length - 1];
    const need = last.t + vowelsOf(last.text) * rate + 0.5;
    const next = fragments[i + 1] ? fragments[i + 1].start : null;
    const cap = Math.min(next != null ? next + 2.5 : Infinity, duration || Infinity, last.t + 10);
    f.end = Math.round(Math.max(f.end, Math.min(need, cap)) * 100) / 100;
  });
}

// Прогресс хранится у каждого фрагмента песни (stage, learned), включая повторы припева:
// учёба идёт по всей песне подряд, чтобы было понятно, где какой припев звучит
function progress(song) {
  return { n: song.fragments.length, k: song.fragments.filter(f => f.learned).length };
}
const nextFrag = song => song.fragments.findIndex(f => !f.learned);

// ---------- База текстов LRCLIB ----------

async function lrclibSearch(q) {
  const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('lrclib ' + r.status);
  const list = await r.json();
  return list.filter(x => !x.instrumental && (x.syncedLyrics || x.plainLyrics));
}

// Лучшая версия: со временем строк, с чистым названием и обычной длиной (не весь альбом одним треком)
// Настоящая длина песни: самая частая среди копий (±1,5 сек). В базе много копий с мусорной длиной:
// обрезки, целые альбомы одним треком. При равенстве берём ближе к медиане.
function trueDuration(list) {
  const durs = list.filter(r => r.syncedLyrics).map(r => r.duration).filter(d => d >= 60 && d < 900);
  const all = durs.length ? durs : list.map(r => r.duration).filter(d => d >= 60 && d < 900);
  if (!all.length) return 0;
  const sorted = [...all].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let best = all[0];
  let bestCount = -1;
  for (const d of all) {
    const count = all.filter(x => Math.abs(x - d) <= 1.5).length;
    if (count > bestCount || (count === bestCount && Math.abs(d - median) < Math.abs(best - median))) { best = d; bestCount = count; }
  }
  return best;
}

function pickBest(list) {
  const dur = trueDuration(list);
  const score = r => (r.syncedLyrics ? 8 : 0)
    + (dur && Math.abs(r.duration - dur) <= 1.5 ? 4 : 0)
    + (/^\d+[.)]\s|\s[-–—]\s/.test(r.trackName || '') ? 0 : 2)
    + (r.duration && r.duration < 900 ? 1 : 0);
  let best = list[0];
  for (const r of list) if (score(r) > score(best)) best = r;
  return best;
}

// Исполнители из строки «VILLIAN, madk1d» или «9mice feat. Kai Angel»
const splitArtists = s => String(s || '').split(/\s*(?:,|&|•|;|\/|\bfeat\.?|\bft\.?|\bx\b)\s*/i).map(norm).filter(Boolean);
const wordsOf = s => norm(s).split(' ').filter(Boolean);

// Все слова хотя бы одного исполнителя и все слова названия есть в запросе
function matchesQuery(r, q) {
  const qw = new Set(wordsOf(q));
  const has = s => wordsOf(s).every(w => qw.has(w));
  const artistOk = splitArtists(r.artistName).some(a => has(a));
  return artistOk && has(cleanTitle(r.trackName, r.artistName));
}

// Группируем копии одной песни: первый исполнитель + чистое название
function groupResults(list) {
  const groups = new Map();
  for (const r of list) {
    const key = (splitArtists(r.artistName)[0] || '') + '|' + norm(cleanTitle(r.trackName, r.artistName));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()];
}

// «01. Кино - Группа крови» -> «Группа крови», «VILLIAN, madk1d — ДИНАСТИЯ» -> «ДИНАСТИЯ», «ДИНАСТИЯ 🅴» -> «ДИНАСТИЯ»
function cleanTitle(title, artist) {
  let t = String(title || '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (artist && m && norm(m[1]) === norm(artist)) t = m[2].trim();
  return t || String(title || '');
}

function songContentFromResult(res) {
  const synced = Boolean(res.syncedLyrics);
  const parsed = synced ? parseLrc(res.syncedLyrics) : parsePlain(res.plainLyrics || '');
  const duration = res.duration ? Math.round(res.duration) : null;
  const { fragments, units } = buildFragments(parsed.lines, parsed.stamps, duration);
  return {
    endsFixed: 1,
    artist: res.artistName || 'Без исполнителя',
    title: cleanTitle(res.trackName, res.artistName) || 'Без названия',
    duration, source: 'lrclib', lrclibId: res.id, synced, fragments, units,
  };
}

// ---------- Поиск музыки на YouTube (нужен ключ) ----------

const searching = new Set();

function isoDur(s) {
  const m = String(s).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

function ytApiError(err) {
  const reason = err && err.errors && err.errors[0] && err.errors[0].reason;
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return 'Дневной лимит поиска YouTube закончился. Вставь ссылку сам или попробуй завтра.';
  if (reason === 'keyInvalid' || (err && err.code === 400)) return 'Ключ YouTube не подошёл. Проверь его в разделе «Данные».';
  if (err && err.code === 403) return 'YouTube не принял ключ с этого адреса. Проверь ограничения ключа.';
  return 'YouTube не ответил. Вставь ссылку сам.';
}

async function autoFindVideo(songId) {
  const key = getKey();
  let song = findSong(songId);
  if (!key || !song || song.video || searching.has(songId)) return;
  searching.add(songId);
  refreshIfOn(songId);
  let note = '';
  let video = null;
  try {
    const q = `${song.artist} ${song.title}`;
    const base = 'https://www.googleapis.com/youtube/v3/';
    const sj = await (await fetch(`${base}search?part=snippet&type=video&videoEmbeddable=true&maxResults=15&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`)).json();
    if (sj.error) throw new Error(ytApiError(sj.error));
    const items = (sj.items || []).filter(i => i.id && i.id.videoId);
    if (!items.length) throw new Error('На YouTube ничего не нашлось. Вставь ссылку сам.');
    const channel = new Map(items.map(i => [i.id.videoId, (i.snippet && i.snippet.channelTitle) || '']));
    const vj = await (await fetch(`${base}videos?part=contentDetails&id=${[...channel.keys()].join(',')}&key=${encodeURIComponent(key)}`)).json();
    if (vj.error) throw new Error(ytApiError(vj.error));
    const cands = (vj.items || []).map(v => ({ id: v.id, dur: isoDur(v.contentDetails.duration), topic: /\s-\sTopic$/.test(channel.get(v.id) || '') }));
    song = findSong(songId);
    if (!song) return;
    if (song.duration) {
      // Лучше всего студийная версия с канала «Исполнитель - Topic» той же длины: под неё размечено время строк.
      // Потом любое видео той же длины (±3 сек).
      cands.forEach(c => { c.diff = Math.abs(c.dur - song.duration); });
      cands.sort((a, b) => (a.diff <= 3 && a.topic ? 0 : 1) - (b.diff <= 3 && b.topic ? 0 : 1) || a.diff - b.diff);
      const c = cands[0];
      if (c && c.diff <= 3) video = { id: c.id, auto: true, topic: c.topic, dur: c.dur };
      else note = 'Автопоиск не нашёл видео той же длины, что и текст. Найди песню в YouTube Music и вставь ссылку.';
    } else {
      video = { id: items[0].id.videoId, auto: true };
    }
  } catch (e) {
    note = e.message && /[а-я]/i.test(e.message) ? e.message : 'YouTube не ответил. Проверь интернет или VPN и вставь ссылку сам.';
  } finally {
    searching.delete(songId);
  }
  song = findSong(songId);
  if (!song) return;
  if (video) { song.video = video; song.videoNote = ''; toast('Музыка нашлась на YouTube.'); }
  else song.videoNote = note;
  save();
  refreshIfOn(songId);
}

function refreshIfOn(songId) {
  if (location.hash === '#/song/' + songId) route();
}

function parseYouTubeId(s) {
  s = String(s).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (/(^|\.)youtu\.be$/.test(u.hostname)) return u.pathname.slice(1, 12) || null;
    if (!/youtube\.com$/.test(u.hostname)) return null;
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}/.test(v)) return v.slice(0, 11);
    const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
    if (m) return m[2];
  } catch (e) { /* не ссылка */ }
  return null;
}

// ---------- Плеер YouTube: играет фрагмент по кругу ----------

let ytApiPromise = null;
function loadYT() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ytApiPromise = null; reject(new Error('timeout')); }, 12000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(timer); ytApiPromise = null; s.remove(); reject(new Error('load')); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

// Один плеер на всё приложение. Он живёт в отдельном «доке» поверх места под видео на экране
// и не пересоздаётся между фрагментами: Safari разрешает звук только плееру, которого уже касался
// пользователь, а новый плеер он молча оставляет на паузе. Заодно переход к фрагменту мгновенный.
const music = {
  player: null, videoId: null, ready: false, playing: false, failed: false,
  seg: null, onState: null, song: null, token: 0, pendingAt: 0, active: false, last: null,
};

const dock = document.createElement('div');
dock.id = 'player-dock';
dock.className = 'off';
document.body.appendChild(dock);

// Ставим док ровно поверх места под видео (#player-box) на текущем экране
function placeDock() {
  const slot = document.getElementById('player-box');
  const show = music.active && music.player && slot && slot.classList.contains('has-video') && slot.offsetParent !== null;
  dock.classList.toggle('off', !show);
  if (!show) return;
  const r = slot.getBoundingClientRect();
  Object.assign(dock.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
window.addEventListener('resize', placeDock);
const slotWatcher = new ResizeObserver(placeDock);
// Место под видео может сдвинуться без изменения размера (появилась подсказка), поэтому сверяемся каждый кадр
(function followSlot() { if (music.active) placeDock(); requestAnimationFrame(followSlot); })();

// Уходим с экрана с музыкой: ставим на паузу и прячем, но плеер не уничтожаем
function hideMusic() {
  music.token++;
  music.active = false;
  music.seg = null;
  music.onState = null;
  slotWatcher.disconnect();
  if (music.player && music.ready) { try { music.player.pauseVideo(); } catch (e) { /* плеер ещё не готов */ } }
  placeDock();
}

// Полностью убрать плеер: нужно только при смене видео или после ошибки
function destroyPlayer() {
  if (music.player) { try { music.player.destroy(); } catch (e) { /* плеер уже закрыт */ } }
  music.player = null;
  music.videoId = null;
  music.ready = false;
  music.playing = false;
  music.failed = false;
  dock.innerHTML = '';
}

function playerMsg(box, html) {
  box.classList.remove('has-video');
  box.classList.add('no-video');
  box.innerHTML = `<div class="msg">${html}</div>`;
  placeDock();
}

function ytPlayerError(code) {
  if (code === 101 || code === 150) return 'YouTube не дал включить видео. Либо владелец запретил показывать его на других сайтах (тогда вставь другую ссылку), либо YouTube просит войти в аккаунт: войди на youtube.com в этом браузере и нажми «Ещё раз».';
  if (code === 100) return 'Видео удалено или скрыто. Вставь другую ссылку.';
  if (code === 153) return 'Плеер YouTube не работает, когда приложение открыто как файл. Открой его по адресу (GitHub Pages или локальный сервер).';
  return 'Видео не запускается. Попробуй другую ссылку.';
}

function setPlayerNote(text) {
  const el = document.getElementById('player-note');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function setPlayerNoteHtml(html) {
  const el = document.getElementById('player-note');
  if (!el) return;
  el.innerHTML = html;
  el.hidden = !html;
}

// Длина видео против длины текста: запоминаем и, если не совпала и сдвиг не подстроен, предлагаем подстроить
function checkFit() {
  const song = music.song;
  const p = music.player;
  if (!song || !song.video || !p || !music.ready) return;
  const d = p.getDuration && p.getDuration();
  if (d && song.video.dur !== Math.round(d)) { song.video.dur = Math.round(d); save(); }
  const notTuned = song.video.offset == null;
  if (song.synced && notTuned && song.duration && d && Math.abs(d - song.duration) > 3 && !location.hash.startsWith('#/sync/')) {
    setPlayerNoteHtml(`Видео ${d > song.duration ? 'длиннее' : 'короче'} текста на ${Math.round(Math.abs(d - song.duration))} сек, фрагменты могут съехать. <a href="#/sync/${esc(song.id)}">Подстроить музыку</a>`);
  }
}

async function startMusic(box, song, seg, onState, from = 0) {
  const token = ++music.token;
  music.active = true;
  music.seg = seg;
  music.onState = onState;
  music.song = song;
  music.last = [box, song, seg, onState, from];
  music.pendingAt = seg ? seg.start : from;
  setPlayerNote('');
  box.classList.remove('no-video');
  box.classList.add('has-video');
  box.innerHTML = '';
  slotWatcher.disconnect();
  slotWatcher.observe(box);
  try { await loadYT(); }
  catch (e) { playerMsg(box, 'YouTube не загрузился. Проверь интернет или включи VPN.'); return; }
  if (token !== music.token || !document.body.contains(box)) return;

  // То же видео: плеер уже есть, просто перематываем на нужный фрагмент и играем
  if (music.player && music.videoId === song.video.id && !music.failed) {
    placeDock();
    if (music.ready) {
      music.player.seekTo(music.pendingAt, true);
      music.player.playVideo();
      if (music.onState) music.onState(music.playing);
      checkFit();
    }
    return;
  }

  destroyPlayer();
  music.videoId = song.video.id;
  dock.innerHTML = '<div id="yt-player"></div>';
  music.player = new window.YT.Player('yt-player', {
    videoId: song.video.id,
    width: '100%',
    height: '100%',
    playerVars: { playsinline: 1, rel: 0, autoplay: 1, start: Math.floor(music.pendingAt) },
    events: {
      onReady: e => {
        music.ready = true;
        if (!music.active) return;
        e.target.seekTo(music.seg ? music.seg.start : music.pendingAt, true);
        e.target.playVideo();
        checkFit();
      },
      onStateChange: e => {
        music.playing = e.data === window.YT.PlayerState.PLAYING;
        // Музыка заиграла, а экран уже другой: сразу на паузу
        if (music.playing && !music.active) { e.target.pauseVideo(); return; }
        if (e.data === window.YT.PlayerState.ENDED && music.seg) { e.target.seekTo(music.seg.start, true); e.target.playVideo(); }
        if (music.onState) music.onState(music.playing);
      },
      onError: e => {
        // Видео не играет: плеер оставляем видимым (в нём кнопка YouTube «Войти») и объясняем, что делать
        music.failed = true;
        setPlayerNote(`${ytPlayerError(e.data)} (код ${Number(e.data)})`);
      },
    },
  });
  placeDock();
}

// Следим за временем: дошли до конца фрагмента, возвращаемся к его началу
setInterval(() => {
  const p = music.player;
  if (!p || !music.ready || !music.active || !music.seg || music.failed || typeof p.getCurrentTime !== 'function') return;
  const t = p.getCurrentTime();
  if (t >= music.seg.end || t < music.seg.start - 1.5) p.seekTo(music.seg.start, true);
}, 200);

function musicAgain() {
  // После ошибки «Ещё раз» создаёт плеер заново: вдруг ты уже вошёл в YouTube
  if (music.failed && music.last && document.body.contains(music.last[0])) { destroyPlayer(); startMusic(...music.last); return; }
  if (!music.player || !music.ready) return;
  music.player.seekTo(music.seg ? music.seg.start : 0, true);
  music.player.playVideo();
}

function musicToggle() {
  if (!music.player || !music.ready) return;
  if (music.playing) music.player.pauseVideo(); else music.player.playVideo();
}

// Сдвиг музыки: насколько секунд пение в видео позже (+) или раньше (−), чем в разметке текста
const offsetOf = song => (song.video && Number(song.video.offset)) || 0;
const fmtOffset = s => (s > 0 ? '+' : s < 0 ? '−' : '') + Math.abs(s).toFixed(1).replace('.', ',') + ' сек';

// Границы фрагмента с ручной поправкой пользователя (adjStart, adjEnd в секундах)
const fragStart = f => f.start + (Number(f.adjStart) || 0);
const fragEnd = f => f.end + (Number(f.adjEnd) || 0);

function segFor(song, frag) {
  if (!song.synced || frag.start == null) return null;
  const off = offsetOf(song);
  return { start: Math.max(0, fragStart(frag) + off - 0.4), end: fragEnd(frag) + off };
}

// ---------- Экран 1: мои песни ----------

const EXAMPLES = ['Кино Группа крови', 'Макс Корж Малиновый закат', 'Баста Сансара'];

function songItem(s) {
  const { n, k } = progress(s);
  const cells = s.fragments.map(f => `<span class="mark-cell">${f.learned ? '5' : ''}</span>`).join('');
  return `<li class="song-item"><a href="#/song/${esc(s.id)}">
    <span class="t">${esc(s.title)}</span>
    <span class="a">${esc(s.artist)}</span>
    <span class="p"><span class="marks" aria-hidden="true">${cells}</span>
    <span>${s.wholeDone ? 'Выучена целиком' : `Выучено ${k} из ${n}`}</span></span>
  </a></li>`;
}

function viewHome() {
  const songs = data.songs;
  app.innerHTML = `
    <section class="home-head">
      <h1>Наизусть: учим песни</h1>
      <p>Напиши исполнителя и название. Приложение найдёт текст, разделит песню на куплеты и припевы и поможет выучить каждый под музыку.</p>
    </section>
    <form class="search" id="search-form" role="search">
      <label class="visually-hidden" for="q">Исполнитель и название</label>
      <input id="q" type="text" placeholder="Например: Кино Группа крови" autocomplete="off" enterkeyhint="search">
      <button class="btn btn-primary btn-big" type="submit" id="find-btn">Найти</button>
    </form>
    <div class="search-alt"><a href="#/paste">Песни нет в базе? Вставь текст сам</a></div>
    <div id="search-result" aria-live="polite"></div>
    ${songs.length
      ? `<h2 class="section-title">Мои песни</h2><ul class="songs">${songs.map(songItem).join('')}</ul>`
      : `<div class="empty">
          <h2>Здесь появятся песни, которые ты учишь</h2>
          <ol>
            <li>Напиши исполнителя и название и нажми «Найти».</li>
            <li>Приложение разделит песню на куплеты и припевы.</li>
            <li>Учи по фрагменту: текст понемногу исчезает, пока играет музыка.</li>
          </ol>
          <p class="muted">Попробуй с одной из этих:</p>
          <div class="chips">${EXAMPLES.map(q => `<button class="chip" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        </div>`}
    <section class="chart" id="chart" aria-live="polite"><p class="muted">Загружаю чарт…</p></section>
  `;
  const form = document.getElementById('search-form');
  const input = document.getElementById('q');
  form.addEventListener('submit', e => { e.preventDefault(); doSearch(input.value); });
  app.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.q; doSearch(b.dataset.q); }));
  renderChart();
}

// ---------- Чарт «Что сейчас слушают» ----------
// data.json раз в сутки обновляет GitHub (fetch.py + .github/workflows/update.yml).
// Загружаем один раз за открытие приложения; при ошибке пробуем снова при следующем показе.
let chartLoad = null;
const CHART_SHOWN = 10;

function loadChart() {
  if (!chartLoad) {
    chartLoad = fetch('data.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => { if (!d || !Array.isArray(d.songs) || !d.songs.length) throw new Error('пустой чарт'); return d; })
      .catch(e => { chartLoad = null; throw e; });
  }
  return chartLoad;
}

async function renderChart() {
  const box = document.getElementById('chart');
  if (!box) return;
  let d;
  try {
    d = await loadChart();
  } catch (e) {
    if (!box.isConnected) return;
    box.innerHTML = `<h2 class="section-title">Что сейчас слушают</h2>
      <div class="error-box"><p>Чарт сейчас не загрузился. Проверь интернет и обнови страницу. Поиск и твои песни работают как обычно.</p></div>`;
    return;
  }
  if (!box.isConnected) return; // пока грузили, человек ушёл на другой экран
  const item = s => `<li class="chart-item">
      <span class="n">${esc(s.position)}</span>
      <span class="ta"><span class="t">${esc(s.title)}</span><span class="a">${esc(s.artist)}</span></span>
      ${s.synced === false
        ? `<button class="btn btn-ghost chart-learn" type="button" data-q="${esc(s.query)}" title="В базе нет времени строк: музыка будет играть целиком">Найти</button>`
        : `<button class="btn btn-outline chart-learn" type="button" data-q="${esc(s.query)}">Учить</button>`}
    </li>`;
  const rest = d.songs.slice(CHART_SHOWN);
  box.innerHTML = `
    <h2 class="section-title">Что сейчас слушают</h2>
    <p class="chart-meta">${esc(d.source || 'Чарт')} · обновлено ${esc(d.updated_msk || '')} МСК</p>
    <ol class="chart-list">${d.songs.slice(0, CHART_SHOWN).map(item).join('')}</ol>
    ${rest.length ? `<details class="chart-more"><summary>Показать ещё ${rest.length}</summary>
      <ol class="chart-list">${rest.map(item).join('')}</ol></details>` : ''}
    ${d.songs.some(s => s.synced === false) ? `<p class="chart-meta chart-note">«Учить»: в базе текстов есть время строк, музыка нарежется по фрагментам. «Найти»: времени строк нет, текст может не найтись.</p>` : ''}`;
  box.querySelectorAll('.chart-learn').forEach(b => b.addEventListener('click', () => {
    const input = document.getElementById('q');
    input.value = b.dataset.q;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    doSearch(b.dataset.q);
  }));
}

async function doSearch(q) {
  q = q.trim();
  const out = document.getElementById('search-result');
  const btn = document.getElementById('find-btn');
  if (!q) { toast('Напиши исполнителя и название песни.'); document.getElementById('q').focus(); return; }
  btn.disabled = true;
  btn.textContent = 'Ищу…';
  out.innerHTML = '';
  try {
    const list = await lrclibSearch(q);
    if (!list.length) {
      const cyr = /[а-яё]/i.test(q)
        ? ' Если исполнитель пишется латиницей, напиши его латиницей: например, Kai Angel, а не Кай Энджел.'
        : ' Проверь написание: исполнитель и название без ошибок.';
      out.innerHTML = `<div class="error-box"><p>Песни «${esc(q)}» нет в базе текстов.${cyr} Или вставь текст сам.</p>
        <a class="btn btn-outline" href="#/paste?q=${encodeURIComponent(q)}">Вставить текст</a></div>`;
      return;
    }
    // Песню берём сама, только если в запросе есть и её исполнитель, и название. Иначе даём выбрать.
    const groups = groupResults(list);
    let sure = groups.filter(g => g.some(r => matchesQuery(r, q)));
    // Из совпавших оставляем версии со временем строк, если такие есть («Кино» против «Группа КИНО»)
    const syncedSure = sure.filter(g => g.some(r => r.syncedLyrics));
    if (syncedSure.length) sure = syncedSure;
    // Если совпало несколько групп, обычно это мусорные копии («Song • Макс Корж»): берём самую многочисленную
    const hits = g => g.filter(r => matchesQuery(r, q)).length;
    sure.sort((a, b) => hits(b) - hits(a));
    if (sure.length === 1 || (sure.length > 1 && hits(sure[0]) > hits(sure[1]))) {
      addSong(pickBest(sure[0].filter(r => matchesQuery(r, q))), q);
      return;
    }
    showChoices(out, sure.length ? sure : groups, q);
  } catch (e) {
    out.innerHTML = `<div class="error-box"><p>Не получилось связаться с базой текстов. Проверь интернет и нажми «Найти» ещё раз.</p></div>`;
  } finally {
    if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = 'Найти'; }
  }
}

function addSong(best, q) {
  const existing = data.songs.find(s => s.lrclibId === best.id
    || (norm(s.artist) === norm(best.artistName) && norm(s.title) === norm(cleanTitle(best.trackName, best.artistName))));
  if (existing) { toast('Эта песня уже есть в твоём списке.'); go('#/song/' + existing.id); return; }
  const song = { id: uid(), query: q, video: null, videoNote: '', wholeDone: false, createdAt: Date.now(), ...songContentFromResult(best) };
  if (!song.fragments.length) { toast('У этой версии нет текста. Выбери другую.'); return; }
  data.songs.unshift(song);
  save();
  go('#/song/' + song.id);
  autoFindVideo(song.id);
}

// Несколько разных песен по запросу: показываем список, выбирает человек
function showChoices(out, groups, q) {
  const items = groups.slice(0, 8).map(g => {
    const best = pickBest(g);
    const synced = g.some(r => r.syncedLyrics);
    return { best, html: `${esc(cleanTitle(best.trackName, best.artistName))}, ${esc(best.artistName)}
      <small>${fmt(best.duration)}, ${synced ? 'есть время строк' : 'только текст, музыка без нарезки'}</small>` };
  });
  out.innerHTML = `<div class="panel">
      <h2>Нашлось несколько песен. Выбери свою</h2>
      <p class="muted">Чтобы приложение сразу брало нужную, пиши исполнителя и название вместе: например, Kai Angel andy warhol.</p>
      <ul class="versions">${items.map((it, i) => `<li><button type="button" data-i="${i}">${it.html}</button></li>`).join('')}</ul>
    </div>`;
  out.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', async () => {
    const g = groups[Number(b.dataset.i)];
    const first = pickBest(g);
    const exactQ = `${first.artistName} ${cleanTitle(first.trackName, first.artistName)}`;
    let pool = g;
    b.disabled = true;
    // Дозапрашиваем все копии именно этой песни: по общему запросу база отдаёт лишь часть, и длина выходит неточной
    try {
      const more = (await lrclibSearch(exactQ)).filter(r => matchesQuery(r, exactQ));
      if (more.length) pool = more;
    } catch (e) { /* нет сети: берём то, что уже нашли */ }
    addSong(pickBest(pool), exactQ);
  }));
}

// ---------- Экран 2: песня ----------

function fragRow(song, f, i, next) {
  let state;
  let action = '';
  if (f.learned) {
    state = 'Выучен';
    action = `<a class="btn btn-ghost" href="#/learn/${esc(song.id)}/${i}">Повторить</a>`;
  } else if (i === next) {
    state = `Ступень ${f.stage || 1} из 4`;
    action = `<a class="btn btn-ghost" href="#/learn/${esc(song.id)}/${i}">Учить</a>`;
  } else {
    state = 'Откроется позже';
  }
  return `<li class="frag${f.repeat ? ' repeat' : ''}">
    <span class="grade${f.learned ? '' : ' empty-grade'}" aria-hidden="true">${f.learned ? '5' : '·'}</span>
    <span class="info"><span class="name">${esc(f.label)}</span><br><span class="first">${esc(f.lines[0].text)}</span></span>
    <span class="state">${esc(state)}${action ? '<br>' + action : ''}</span>
  </li>`;
}

function viewSong(song) {
  const { n, k } = progress(song);
  const next = nextFrag(song);
  const key = getKey();
  const yq = encodeURIComponent(`${song.artist} ${song.title}`);

  let musicText;
  if (song.video) {
    const off = song.video.offset != null ? ` Сдвиг музыки: ${fmtOffset(offsetOf(song))}.` : '';
    let fit = '';
    if (song.synced && song.video.dur && song.duration) {
      const diff = Math.round(song.video.dur - song.duration);
      fit = Math.abs(diff) <= 3
        ? ' Длина видео совпадает с текстом, музыка идёт в такт.'
        : ` Видео ${diff > 0 ? 'длиннее' : 'короче'} текста на ${Math.abs(diff)} сек: похоже на клип или другую версию. Подстрой музыку или возьми песню из YouTube Music.`;
    }
    musicText = `Видео подключено${song.video.auto ? (song.video.topic ? ' автоматически, студийная версия' : ' автоматически') : ''}.${fit}${off} <a href="https://www.youtube.com/watch?v=${esc(song.video.id)}" target="_blank" rel="noopener">Открыть на YouTube</a>`;
  } else if (searching.has(song.id)) {
    musicText = 'Ищу это видео на YouTube…';
  } else if (song.videoNote) {
    musicText = esc(song.videoNote);
  } else if (key) {
    musicText = 'Видео пока не подключено.';
  } else {
    musicText = 'Нажми «Найти в YouTube Music», открой там эту песню и скопируй ссылку сюда. Бери версию из раздела «Треки» с обложкой альбома, а не клип: тогда музыка совпадёт с текстом без подстройки. Чтобы приложение находило музыку само, добавь ключ YouTube в разделе «Данные».';
  }

  app.innerHTML = `
    <a class="btn btn-ghost back" href="#/">‹ Мои песни</a>
    <header class="song-head">
      <h1>${esc(song.title)}</h1>
      <p class="meta">${esc(song.artist)}${song.duration ? ', ' + fmt(song.duration) : ''}. Выучено ${k} из ${n}${song.wholeDone ? ', песня выучена целиком' : ''}.</p>
    </header>
    <div class="row song-actions">
      ${next === -1
        ? `<a class="btn btn-primary btn-big" href="#/whole/${esc(song.id)}">Прогнать всю песню</a>`
        : `<a class="btn btn-primary btn-big" href="#/learn/${esc(song.id)}/${next}">${k ? 'Учить дальше' : 'Учить'}</a>`}
      ${song.source === 'lrclib' ? `<a class="btn btn-outline" href="#/versions/${esc(song.id)}">Не та песня</a>` : ''}
    </div>
    <div class="row frags-head">
      <h2 class="section-title">Фрагменты: ${song.fragments.length}</h2>
      <a class="btn btn-ghost" href="#/split/${esc(song.id)}">Изменить деление</a>
    </div>
    <ol class="frags">${song.fragments.map((f, i) => fragRow(song, f, i, next)).join('')}</ol>

    <section class="panel" id="music-panel">
      <h2>Музыка</h2>
      <p class="${song.video ? '' : 'muted'}" id="music-status">${musicText}</p>
      ${!song.synced ? '<p class="muted">У этого текста нет времени строк, поэтому музыка играет целиком, без нарезки по фрагментам.</p>' : ''}
      <form class="row" id="video-form">
        <label class="visually-hidden" for="video-url">Ссылка на YouTube</label>
        <input id="video-url" type="url" inputmode="url" placeholder="Ссылка на видео YouTube" style="flex:1 1 220px">
        <button class="btn btn-outline" type="submit">Сохранить ссылку</button>
      </form>
      <div class="row">
        <a class="btn btn-outline" href="https://music.youtube.com/search?q=${yq}" target="_blank" rel="noopener">Найти в YouTube Music</a>
        ${key && !song.video && !searching.has(song.id) ? '<button class="btn btn-ghost" type="button" id="auto-video">Найти музыку автоматически</button>' : ''}
        ${song.video && song.synced ? `<a class="btn btn-outline" href="#/sync/${esc(song.id)}">Подстроить музыку</a>` : ''}
        ${song.video ? '<button class="btn btn-ghost" type="button" id="drop-video">Отключить видео</button>' : ''}
      </div>
    </section>

    <section class="panel">
      <div class="row">
        <button class="btn btn-outline" type="button" id="rename-toggle">Изменить название</button>
        <button class="btn btn-danger" type="button" id="del-toggle">Удалить песню</button>
      </div>
      <form id="rename-form" class="sheet" style="padding:0" hidden>
        <label class="field"><span>Исполнитель</span><input type="text" name="artist" value="${esc(song.artist)}" required></label>
        <label class="field"><span>Название</span><input type="text" name="title" value="${esc(song.title)}" required></label>
        <div class="row"><button class="btn btn-primary" type="submit">Сохранить название</button></div>
      </form>
      <div id="del-confirm" class="confirm" hidden>
        <p>Удалить «${esc(song.title)}»? Текст и прогресс пропадут из этого браузера. Если есть скачанная копия данных, песню можно вернуть из неё.</p>
        <div class="row">
          <button class="btn btn-danger" type="button" id="del-yes">Да, удалить</button>
          <button class="btn btn-ghost" type="button" id="del-no">Отмена</button>
        </div>
      </div>
    </section>
  `;

  document.getElementById('video-form').addEventListener('submit', e => {
    e.preventDefault();
    const id = parseYouTubeId(document.getElementById('video-url').value);
    if (!id) { toast('Это не похоже на ссылку YouTube. Скопируй адрес видео целиком.'); return; }
    song.video = { id, auto: false };
    song.videoNote = '';
    save();
    toast('Ссылка сохранена.');
    route();
  });
  const auto = document.getElementById('auto-video');
  if (auto) auto.addEventListener('click', () => { song.videoNote = ''; autoFindVideo(song.id); });
  const drop = document.getElementById('drop-video');
  if (drop) drop.addEventListener('click', () => { song.video = null; save(); toast('Видео отключено.'); route(); });

  const renameForm = document.getElementById('rename-form');
  const delBox = document.getElementById('del-confirm');
  document.getElementById('rename-toggle').addEventListener('click', () => {
    renameForm.hidden = !renameForm.hidden;
    delBox.hidden = true;
    if (!renameForm.hidden) renameForm.artist.focus();
  });
  renameForm.addEventListener('submit', e => {
    e.preventDefault();
    const artist = renameForm.artist.value.trim();
    const title = renameForm.title.value.trim();
    if (!artist || !title) { toast('Заполни исполнителя и название.'); return; }
    song.artist = artist;
    song.title = title;
    save();
    toast('Название сохранено.');
    route();
  });
  document.getElementById('del-toggle').addEventListener('click', () => {
    delBox.hidden = !delBox.hidden;
    renameForm.hidden = true;
  });
  document.getElementById('del-no').addEventListener('click', () => { delBox.hidden = true; });
  document.getElementById('del-yes').addEventListener('click', () => {
    data.songs = data.songs.filter(s => s.id !== song.id);
    save();
    toast(`Песня «${song.title}» удалена.`);
    go('#/');
  });
}

// ---------- «Не та песня»: другие версии из базы ----------

async function viewVersions(song) {
  app.innerHTML = `
    <a class="btn btn-ghost back" href="#/song/${esc(song.id)}">‹ К песне</a>
    <header class="song-head"><h1>Другие версии</h1>
    <p class="meta">Выбери нужную. Прогресс по песне начнётся заново.</p></header>
    <div id="versions" class="loading">Ищу версии в базе текстов…</div>`;
  const box = document.getElementById('versions');
  let list;
  try { list = await lrclibSearch(song.query || `${song.artist} ${song.title}`); }
  catch (e) { box.className = 'error-box'; box.textContent = 'Не получилось связаться с базой текстов. Проверь интернет и открой экран ещё раз.'; return; }
  if (!document.body.contains(box)) return;
  box.className = '';
  box.innerHTML = `<ul class="versions">${list.map((r, i) => `
    <li><button type="button" data-i="${i}" class="${r.id === song.lrclibId ? 'cur' : ''}">
      ${esc(r.trackName)}, ${esc(r.artistName)}${r.id === song.lrclibId ? ' (сейчас выбрана)' : ''}
      <small>${r.albumName ? esc(r.albumName) + ', ' : ''}${fmt(r.duration)}, ${r.syncedLyrics ? 'есть время строк' : 'только текст, музыка без нарезки'}</small>
    </button></li>`).join('')}</ul>`;
  box.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => {
    const r = list[Number(b.dataset.i)];
    if (r.id === song.lrclibId) { go('#/song/' + song.id); return; }
    const oldDur = song.duration;
    Object.assign(song, songContentFromResult(r), { wholeDone: false });
    if (song.video && (!song.video.auto || !oldDur || Math.abs((song.duration || 0) - oldDur) > 4)) {
      if (song.video.auto) song.video = null;
    }
    save();
    toast('Версия заменена.');
    go('#/song/' + song.id);
    if (!song.video) autoFindVideo(song.id);
  }));
}

// ---------- Песни нет в базе: вставить текст ----------

function viewPaste(q) {
  app.innerHTML = `
    <a class="btn btn-ghost back" href="#/">‹ Мои песни</a>
    <header class="song-head"><h1>Свой текст</h1>
    <p class="meta">Вставь текст песни целиком. Приложение разделит его на куплеты и припевы по повторам строк. Времени строк тут нет, поэтому музыка будет играть целиком.</p></header>
    <form id="paste-form" class="sheet" style="padding:0;margin-top:18px">
      <label class="field"><span>Исполнитель</span><input type="text" name="artist" required value="${esc(q.split(' ').slice(0, 1).join(' '))}"></label>
      <label class="field"><span>Название</span><input type="text" name="title" required value="${esc(q.split(' ').slice(1).join(' '))}"></label>
      <label class="field"><span>Текст песни</span><textarea name="text" required placeholder="Каждая строка песни с новой строки"></textarea></label>
      <div class="row"><button class="btn btn-primary btn-big" type="submit">Разделить на фрагменты</button></div>
    </form>`;
  const form = document.getElementById('paste-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const parsed = parsePlain(form.text.value);
    if (parsed.lines.length < 2) { toast('Вставь хотя бы две строки текста.'); return; }
    const { fragments, units } = buildFragments(parsed.lines, [], null);
    const song = {
      id: uid(), artist: form.artist.value.trim(), title: form.title.value.trim(), duration: null,
      source: 'text', lrclibId: null, query: '', synced: false, fragments, units,
      video: null, videoNote: '', wholeDone: false, createdAt: Date.now(),
    };
    data.songs.unshift(song);
    save();
    toast(`Готово: ${fragments.length} фрагм. Добавь ссылку на музыку.`);
    go('#/song/' + song.id);
  });
}

// ---------- Экран 3: учим фрагмент ----------

const STAGE_NOTE = {
  1: 'Ступень 1 из 4. Читай и подпевай.',
  2: 'Ступень 2 из 4. Половина слов спрятана.',
  3: 'Ступень 3 из 4. Остались первые буквы.',
  4: 'Ступень 4 из 4. Текст спрятан, пой по памяти.',
};

function lyricsHtml(lines, stage) {
  let wi = 0;
  return lines.map(l => '<p>' + l.text.split(/(\s+)/).map(tok => {
    if (!tok.trim()) return tok;
    if (stage === 4) return `<span class="w">${esc(tok)}</span>`;
    const m = tok.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}'’-]*)?(.*)$/u);
    const pre = m[1];
    const word = m[2] || '';
    const post = m[3];
    if (!word) return esc(tok);
    const i = wi++;
    if (stage === 2 && i % 2 === 1) return `${esc(pre)}<span class="w hide">${esc(word)}</span>${esc(post)}`;
    if (stage === 3) {
      const first = [...word][0];
      return `${esc(pre)}<span class="w first">${esc(first)}<span class="rest">${esc(word.slice(first.length))}</span></span>${esc(post)}`;
    }
    return `${esc(pre)}<span class="w">${esc(word)}</span>${esc(post)}`;
  }).join('') + '</p>').join('');
}

// Подбираем размер текста, чтобы фрагмент влез на экран без прокрутки
function fitLyrics() {
  const el = document.getElementById('lyrics');
  if (!el) return;
  const wrap = el.parentElement;
  let size = Math.max(18, Math.min(48, wrap.clientWidth / 14));
  el.style.fontSize = size + 'px';
  while (size > 13 && (el.scrollHeight > wrap.clientHeight - 16 || el.scrollWidth > wrap.clientWidth)) {
    size -= 1;
    el.style.fontSize = size + 'px';
  }
}
window.addEventListener('resize', fitLyrics);

function learnShell(song, subtitle, steps) {
  document.body.classList.add('learning');
  app.innerHTML = `
    <div class="learn">
      <div class="learn-top">
        <a class="btn btn-ghost" href="#/song/${esc(song.id)}">‹ Назад</a>
        <div class="title"><b>${esc(song.title)}</b><span id="subtitle">${esc(subtitle)}</span></div>
        ${steps ? '<div class="steps" id="steps" role="img"></div>' : ''}
      </div>
      <div class="lyrics-wrap"><div class="lyrics" id="lyrics"></div></div>
      <div class="learn-bottom" id="learn-bottom">
        <div class="player-box" id="player-box"></div>
        <div class="controls"><p class="player-note" id="player-note" role="status" hidden></p><div class="controls" id="controls"></div></div>
      </div>
    </div>`;
}

function setupPlayer(song, seg, pauseBtn) {
  const box = document.getElementById('player-box');
  if (!song.video) {
    playerMsg(box, `Музыка не подключена. <a href="#/song/${esc(song.id)}">Добавить ссылку</a>`);
    pauseBtn.disabled = true;
    return;
  }
  startMusic(box, song, seg, playing => { pauseBtn.textContent = playing ? 'Пауза' : 'Играть'; });
}

function showDone(song, title, buttons) {
  const { n, k } = progress(song);
  document.getElementById('learn-bottom').hidden = true;
  hideMusic();
  const steps = document.getElementById('steps');
  if (steps) steps.hidden = true;
  const boundsBtn = document.getElementById('bounds-toggle');
  if (boundsBtn) boundsBtn.hidden = true;
  const el = document.getElementById('lyrics');
  el.style.fontSize = '';
  el.className = 'lyrics';
  el.innerHTML = `<div class="done">
      <div class="five" aria-hidden="true">5</div>
      <h2>${esc(title)}</h2>
      <p class="muted">Выучено ${k} из ${n}${song.wholeDone ? ', песня целиком' : ''}.</p>
      <div class="row" style="justify-content:center">${buttons}</div>
    </div>`;
  const first = el.querySelector('.btn');
  if (first) first.focus();
}

function viewLearn(song, ui) {
  const frag = song.fragments[ui];
  const next = nextFrag(song);
  // Учить можно выученный (повторение) или следующий по порядку фрагмент
  if (!frag || (!frag.learned && ui !== next)) { location.replace('#/song/' + song.id); return; }
  const u = { label: frag.label };
  const practice = frag.learned;
  let stage = practice ? 1 : (frag.stage || 1);
  let peek = false;

  learnShell(song, u.label + (practice ? ', повторение' : ''), true);
  const canTune = Boolean(song.video && segFor(song, frag));
  if (canTune) {
    document.getElementById('steps').insertAdjacentHTML('beforebegin', '<button class="btn btn-ghost" type="button" id="bounds-toggle" aria-expanded="false">Границы</button>');
  }
  const controls = document.getElementById('controls');
  controls.innerHTML = `
    <div id="learn-controls" class="controls">
      <div class="row">
        <button class="btn btn-outline" type="button" id="peek">Подсмотреть</button>
        <button class="btn btn-outline" type="button" id="again">Ещё раз</button>
        <button class="btn btn-outline" type="button" id="pause">Пауза</button>
      </div>
      <button class="btn btn-primary btn-big" type="button" id="remember">Помню, дальше</button>
    </div>
    <div id="bounds" class="controls bounds" hidden>
      <p class="bounds-info" id="bounds-info" role="status"></p>
      <div class="row">
        <button class="btn btn-outline" type="button" data-b="start" data-d="-0.5">Начало раньше</button>
        <button class="btn btn-outline" type="button" data-b="start" data-d="0.5">Начало позже</button>
      </div>
      <div class="row">
        <button class="btn btn-outline" type="button" data-b="end" data-d="-0.5">Конец раньше</button>
        <button class="btn btn-outline" type="button" data-b="end" data-d="0.5">Конец позже</button>
      </div>
      <div class="row">
        <button class="btn btn-ghost" type="button" id="hear-end">Послушать конец</button>
        <button class="btn btn-ghost" type="button" id="bounds-reset">Сбросить</button>
        <a class="btn btn-ghost" href="#/split/${esc(song.id)}">Перенести строки</a>
        <button class="btn btn-primary" type="button" id="bounds-done">Готово</button>
      </div>
    </div>`;
  if (canTune) setupBounds(song, frag);
  const lyr = document.getElementById('lyrics');
  const peekBtn = document.getElementById('peek');
  const pauseBtn = document.getElementById('pause');

  function draw() {
    lyr.className = 'lyrics' + (stage === 4 ? ' all-hidden' : '') + (peek ? ' peek' : '');
    lyr.innerHTML = `<p class="stage-note">${STAGE_NOTE[stage]}</p>` + lyricsHtml(frag.lines, stage);
    const steps = document.getElementById('steps');
    steps.setAttribute('aria-label', `Ступень ${stage} из 4`);
    steps.innerHTML = [1, 2, 3, 4].map(i => `<i class="${i <= stage ? 'on' : ''}"></i>`).join('');
    peekBtn.disabled = stage === 1;
    peekBtn.textContent = peek ? 'Спрятать' : 'Подсмотреть';
    peekBtn.setAttribute('aria-pressed', String(peek));
    fitLyrics();
  }

  peekBtn.addEventListener('click', () => { peek = !peek; draw(); });
  document.getElementById('again').addEventListener('click', () => { peek = false; draw(); musicAgain(); });
  pauseBtn.addEventListener('click', musicToggle);
  document.getElementById('remember').addEventListener('click', () => {
    peek = false;
    if (stage < 4) {
      stage++;
      if (!practice) { frag.stage = stage; save(); }
      draw();
      return;
    }
    if (!practice) { frag.learned = true; frag.stage = 4; save(); }
    const nx = nextFrag(song);
    const buttons = nx === -1
      ? `<a class="btn btn-primary btn-big" href="#/whole/${esc(song.id)}">Прогнать всю песню</a><a class="btn btn-outline" href="#/song/${esc(song.id)}">К песне</a>`
      : `<a class="btn btn-primary btn-big" href="#/learn/${esc(song.id)}/${nx}">Следующий фрагмент</a><a class="btn btn-outline" href="#/song/${esc(song.id)}">К песне</a>`;
    showDone(song, practice ? `${u.label}: повторил` : `${u.label} выучен`, buttons);
  });

  draw();
  if (document.fonts) document.fonts.ready.then(fitLyrics);
  setupPlayer(song, segFor(song, frag), pauseBtn);
}

// Ручная поправка начала и конца фрагмента: шаг 0,5 сек, музыка сразу перематывается, чтобы услышать результат
function setupBounds(song, frag) {
  const panel = document.getElementById('bounds');
  const main = document.getElementById('learn-controls');
  const toggle = document.getElementById('bounds-toggle');
  const info = document.getElementById('bounds-info');
  const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;

  function show(open) {
    panel.hidden = !open;
    main.hidden = open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Скрыть' : 'Границы';
    drawInfo();
    fitLyrics();
  }
  function drawInfo() {
    const changed = Number(frag.adjStart) || Number(frag.adjEnd);
    info.textContent = `Фрагмент играет с ${fmtT(fragStart(frag))} до ${fmtT(fragEnd(frag))}${changed ? ', поправлено вручную' : ''}. Сдвигай начало и конец, пока фрагмент не зазвучит целиком.`;
  }
  // Перематываем: после правки начала слушаем начало, после правки конца слушаем последние 3 секунды
  function replay(which) {
    const seg = segFor(song, frag);
    music.seg = seg;
    if (music.last) music.last[2] = seg;
    if (music.player && music.ready) {
      music.player.seekTo(which === 'end' ? Math.max(seg.start, seg.end - 3) : seg.start, true);
      music.player.playVideo();
    }
  }

  toggle.addEventListener('click', () => show(panel.hidden));
  document.getElementById('bounds-done').addEventListener('click', () => show(false));
  panel.querySelectorAll('button[data-b]').forEach(b => b.addEventListener('click', () => {
    const d = Number(b.dataset.d);
    if (b.dataset.b === 'start') {
      const next = Math.round(((Number(frag.adjStart) || 0) + d) * 10) / 10;
      if (frag.start + next < 0 || frag.start + next > fragEnd(frag) - 1) { toast('Фрагмент не может быть короче секунды.'); return; }
      frag.adjStart = next;
    } else {
      const next = Math.round(((Number(frag.adjEnd) || 0) + d) * 10) / 10;
      if (frag.end + next < fragStart(frag) + 1) { toast('Фрагмент не может быть короче секунды.'); return; }
      frag.adjEnd = next;
    }
    save();
    drawInfo();
    replay(b.dataset.b);
  }));
  document.getElementById('hear-end').addEventListener('click', () => replay('end'));
  document.getElementById('bounds-reset').addEventListener('click', () => {
    delete frag.adjStart;
    delete frag.adjEnd;
    save();
    drawInfo();
    replay('start');
    toast('Границы фрагмента вернулись к автоматическим.');
  });
}

// ---------- Экран 4: вся песня ----------

function viewWhole(song) {
  if (nextFrag(song) !== -1) { location.replace('#/song/' + song.id); return; }
  let hint = false;
  learnShell(song, 'Вся песня', false);
  const controls = document.getElementById('controls');
  const repeatBtns = '<span>Повторить фрагмент:</span>' + song.fragments.map((f, i) => `<a class="btn btn-ghost" href="#/learn/${esc(song.id)}/${i}">${esc(f.label)}</a>`).join('');
  controls.innerHTML = `
    <div class="row">
      <button class="btn btn-outline" type="button" id="hint">Подсказка</button>
      <button class="btn btn-outline" type="button" id="pause">Пауза</button>
      <button class="btn btn-primary" type="button" id="whole-done">Выучил целиком</button>
    </div>
    <div class="row repeat">${repeatBtns}</div>`;
  const lyr = document.getElementById('lyrics');
  const hintBtn = document.getElementById('hint');
  const pauseBtn = document.getElementById('pause');
  let shownFrag = -1;

  // Какой фрагмент сейчас звучит (по времени плеера)
  function currentFrag() {
    if (!song.synced || !music.player || !music.ready) return -1;
    const t = music.player.getCurrentTime() - offsetOf(song);
    let idx = 0;
    song.fragments.forEach((f, i) => { if (f.start != null && t >= f.start - 0.5) idx = i; });
    return idx;
  }

  function draw() {
    hintBtn.textContent = hint ? 'Спрятать' : 'Подсказка';
    hintBtn.setAttribute('aria-pressed', String(hint));
    if (!hint) {
      shownFrag = -1;
      lyr.className = 'lyrics';
      lyr.innerHTML = '<p class="stage-note">Текст спрятан. Пой всю песню по памяти, а если забыл, нажми «Подсказка».</p>';
      fitLyrics();
      return;
    }
    const fi = currentFrag();
    shownFrag = fi;
    const lines = fi === -1 ? song.fragments.flatMap(f => f.lines) : song.fragments[fi].lines;
    const note = fi === -1 ? 'Весь текст.' : `Сейчас звучит: ${song.fragments[fi].label}.`;
    lyr.className = 'lyrics';
    lyr.innerHTML = `<p class="stage-note">${esc(note)}</p>` + lyricsHtml(lines, 1);
    fitLyrics();
  }

  const followTimer = setInterval(() => {
    if (!document.body.contains(lyr)) { clearInterval(followTimer); return; }
    if (hint && currentFrag() !== shownFrag) draw();
  }, 500);

  hintBtn.addEventListener('click', () => { hint = !hint; draw(); });
  pauseBtn.addEventListener('click', musicToggle);
  document.getElementById('whole-done').addEventListener('click', () => {
    song.wholeDone = true;
    save();
    showDone(song, 'Песня выучена целиком', `<a class="btn btn-primary btn-big" href="#/">К моим песням</a><a class="btn btn-outline" href="#/song/${esc(song.id)}">К песне</a>`);
  });

  draw();
  setupPlayer(song, null, pauseBtn);
}

// ---------- Деление на фрагменты: перенос строк между соседними фрагментами ----------

// Строки сдвинулись: заново считаем начало нижнего фрагмента и конец верхнего.
// Конец ставим на начало следующего (не дальше 8 сек после последней строки) и досчитываем длинную последнюю строку.
function retimeBoundary(song, i) {
  const up = song.fragments[i];
  const lo = song.fragments[i + 1];
  if (!song.synced || up.lines[0].t == null || lo.lines[0].t == null) return;
  up.start = up.lines[0].t;
  lo.start = lo.lines[0].t;
  up.end = Math.min(lo.start, up.lines[up.lines.length - 1].t + 8);
  fixEnds(song.fragments, song.duration);
}

// После объединений: убираем единицы без фрагментов, ставим их по порядку первого появления,
// первое появление каждой единицы — основное, остальные — повторы, подписи нумеруем заново
function normalizeUnits(song) {
  const order = [];
  for (const f of song.fragments) if (!order.includes(f.unit)) order.push(f.unit);
  const map = new Map(order.map((old, i) => [old, i]));
  song.units = order.map(old => song.units[old]);
  const seen = new Set();
  song.fragments.forEach(f => {
    f.unit = map.get(f.unit);
    f.repeat = seen.has(f.unit);
    seen.add(f.unit);
  });
  const total = { 'Куплет': 0, 'Припев': 0 };
  song.units.forEach(u => { total[u.kind] = (total[u.kind] || 0) + 1; });
  const count = { 'Куплет': 0, 'Припев': 0 };
  song.units.forEach(u => {
    count[u.kind] = (count[u.kind] || 0) + 1;
    u.label = total[u.kind] > 1 ? `${u.kind} ${count[u.kind]}` : u.kind;
  });
  song.fragments.forEach(f => { f.label = song.units[f.unit].label + (f.repeat ? ' (повтор)' : ''); });
}

// Склеиваем фрагмент k+1 в фрагмент k (одно появление). Конец и ручная поправка конца берутся у нижнего.
function mergeAt(song, k) {
  const up = song.fragments[k];
  const lo = song.fragments[k + 1];
  // Выученным остаётся, только если выучены обе части; ступень берём меньшую
  up.learned = Boolean(up.learned && lo.learned);
  up.stage = Math.min(up.stage || 1, lo.stage || 1);
  up.lines.push(...lo.lines);
  if (lo.end != null) up.end = lo.end;
  if (lo.adjEnd != null) up.adjEnd = lo.adjEnd; else delete up.adjEnd;
  song.fragments.splice(k + 1, 1);
}

function viewSplit(song) {
  let moved = null;   // какую строку подсветить после переноса: [фрагмент, строка]

  function render() {
    const y = window.scrollY;
    const fr = song.fragments;
    const blocks = fr.map((f, i) => {
      const lines = f.lines.map((l, j) => `<p class="${moved && moved[0] === i && moved[1] === j ? 'moved' : ''}">${esc(l.text)}</p>`).join('');
      const lo = fr[i + 1];
      const boundary = lo ? `
        <div class="boundary" role="group" aria-label="Граница между «${esc(f.label)}» и «${esc(lo.label)}»">
          <button class="btn btn-outline" type="button" data-up="${i}">${lo.lines.length < 2 ? `Последнюю строку вверх, «${esc(lo.label)}» исчезнет` : `Строку вверх, в «${esc(f.label)}»`}</button>
          <button class="btn btn-outline" type="button" data-down="${i}">${f.lines.length < 2 ? `Последнюю строку вниз, «${esc(f.label)}» исчезнет` : `Строку вниз, в «${esc(lo.label)}»`}</button>
          <button class="btn btn-ghost merge" type="button" data-merge="${i}">Объединить «${esc(f.label)}» и «${esc(lo.label)}» в один фрагмент</button>
        </div>` : '';
      return `<section class="split-frag"><h3>${esc(f.label)} <span class="muted">${f.lines.length} стр.</span></h3><div class="split-lines">${lines}</div></section>${boundary}`;
    }).join('');

    app.innerHTML = `
      <a class="btn btn-ghost back" href="#/song/${esc(song.id)}">‹ К песне</a>
      <header class="song-head"><h1>Деление на фрагменты</h1>
      <p class="meta">${esc(song.title)}, ${esc(song.artist)}. Перекидывай строки между соседними фрагментами кнопками на границах или объединяй фрагменты целиком. Время фрагментов пересчитается само.</p></header>
      <div class="split">${blocks}</div>
      <div class="row split-actions">
        <a class="btn btn-primary btn-big" href="#/song/${esc(song.id)}">Готово</a>
        ${song.autoSplit ? '<button class="btn btn-ghost" type="button" id="split-reset">Вернуть автоматическое деление</button>' : ''}
      </div>`;
    window.scrollTo(0, y);

    app.querySelectorAll('button[data-up]').forEach(b => b.addEventListener('click', () => move(Number(b.dataset.up), 'up')));
    app.querySelectorAll('button[data-down]').forEach(b => b.addEventListener('click', () => move(Number(b.dataset.down), 'down')));
    app.querySelectorAll('button[data-merge]').forEach(b => b.addEventListener('click', () => merge(Number(b.dataset.merge))));
    const reset = document.getElementById('split-reset');
    if (reset) reset.addEventListener('click', () => {
      // Старые копии хранили только фрагменты, новые хранят и учебные единицы
      if (Array.isArray(song.autoSplit)) song.fragments = JSON.parse(JSON.stringify(song.autoSplit));
      else { song.fragments = JSON.parse(JSON.stringify(song.autoSplit.fragments)); song.units = JSON.parse(JSON.stringify(song.autoSplit.units)); }
      delete song.autoSplit;
      moved = null;
      save();
      toast('Вернулось автоматическое деление.');
      render();
    });
  }

  // Перед первой ручной правкой запоминаем автоматическое деление, чтобы можно было вернуть
  function remember() {
    if (!song.autoSplit) song.autoSplit = JSON.parse(JSON.stringify({ fragments: song.fragments, units: song.units }));
  }

  // up: первая строка нижнего фрагмента уходит в конец верхнего; down: последняя строка верхнего уходит в начало нижнего.
  // Если фрагмент остаётся без строк, он исчезает: пустых фрагментов не бывает.
  function move(i, dir) {
    const fr = song.fragments;
    const up = fr[i];
    const lo = fr[i + 1];
    remember();
    // Последняя строка уходит, фрагмент исчезает: это то же, что объединить пару (вместе с повторами)
    if ((dir === 'up' && lo.lines.length < 2) || (dir === 'down' && up.lines.length < 2)) {
      merge(i, dir === 'up' ? lo.label : up.label);
      return;
    }
    // В фрагмент пришла строка из невыученного: он тоже становится невыученным, ступень меньшая
    const into = dir === 'up' ? up : lo;
    const from = dir === 'up' ? lo : up;
    into.learned = Boolean(into.learned && from.learned);
    into.stage = Math.min(into.stage || 1, from.stage || 1);
    if (dir === 'up') {
      up.lines.push(lo.lines.shift());
      moved = [i, up.lines.length - 1];
    } else {
      lo.lines.unshift(up.lines.pop());
      moved = [i + 1, 0];
    }
    retimeBoundary(song, i);
    done('');
  }

  // Объединяем пару целиком. Если эта пара фрагментов идёт подряд и в других местах песни (повтор припева),
  // склеиваем и там, иначе повтор всплыл бы отдельным фрагментом для заучивания.
  function merge(i, vanished) {
    remember();
    const fr = song.fragments;
    const a = fr[i].unit;
    const b = fr[i + 1].unit;
    const names = vanished ? `Фрагмент «${vanished}» объединён с соседним` : `«${fr[i].label}» и «${fr[i + 1].label}» объединены`;
    let times = 0;
    for (let k = fr.length - 2; k >= 0; k--) {
      if (k === i || (a !== b && fr[k].unit === a && fr[k + 1].unit === b)) { mergeAt(song, k); times++; }
    }
    normalizeUnits(song);
    moved = null;
    done(times > 1 ? `${names}, и в повторах тоже (мест: ${times}).` : `${names}.`);
  }

  function done(message) {
    fixEnds(song.fragments, song.duration);
    save();
    if (message) toast(message);
    render();
  }

  render();
}

// ---------- Подстройка музыки: одно нажатие, когда звучит первая строка ----------

function viewSync(song) {
  if (!song.video || !song.synced) { location.replace('#/song/' + song.id); return; }
  const frag = song.fragments[0];
  const first = frag.lines[0];
  // Если сдвиг уже подстроен, сразу крутим первый фрагмент, чтобы можно было поправить
  let tuned = song.video.offset != null;

  learnShell(song, 'Подстройка музыки', false);
  const lyr = document.getElementById('lyrics');
  const controls = document.getElementById('controls');
  controls.innerHTML = `
    <button class="btn btn-primary btn-big" type="button" id="mark">Поют эту строку</button>
    <div class="row">
      <button class="btn btn-outline" type="button" id="minus">Раньше на 0,5 сек</button>
      <button class="btn btn-outline" type="button" id="plus">Позже на 0,5 сек</button>
    </div>
    <div class="row">
      <button class="btn btn-ghost" type="button" id="from-zero">С самого начала</button>
      <a class="btn btn-ghost" href="#/song/${esc(song.id)}" id="sync-done">Готово</a>
    </div>`;

  function draw() {
    const off = offsetOf(song);
    lyr.className = 'lyrics';
    lyr.innerHTML = tuned
      ? `<p class="stage-note">Сдвиг ${fmtOffset(off)}. Сейчас по кругу играет «${esc(frag.label)}». Если пение начинается не с первой строки, поправь кнопками ниже.</p>` + lyricsHtml(frag.lines, 1)
      : `<p class="stage-note">Музыка играет. Нажми «Поют эту строку», как только услышишь:</p>` + lyricsHtml([first], 1);
    document.getElementById('minus').disabled = !tuned;
    document.getElementById('plus').disabled = !tuned;
    fitLyrics();
  }

  // Применяем новый сдвиг: сохраняем и сразу крутим первый фрагмент уже со сдвигом
  function apply(off) {
    song.video.offset = Math.round(off * 10) / 10;
    save();
    tuned = true;
    music.seg = segFor(song, frag);
    if (music.last) music.last[2] = music.seg;
    if (music.player && music.ready) { music.player.seekTo(music.seg.start, true); music.player.playVideo(); }
    draw();
  }

  document.getElementById('mark').addEventListener('click', () => {
    if (!music.player || !music.ready) { toast('Подожди, пока загрузится видео.'); return; }
    apply(music.player.getCurrentTime() - first.t);
  });
  document.getElementById('minus').addEventListener('click', () => apply(offsetOf(song) - 0.5));
  document.getElementById('plus').addEventListener('click', () => apply(offsetOf(song) + 0.5));
  document.getElementById('from-zero').addEventListener('click', () => {
    tuned = false;
    music.seg = null;
    if (music.player && music.ready) { music.player.seekTo(0, true); music.player.playVideo(); }
    draw();
  });

  draw();
  const box = document.getElementById('player-box');
  // Начинаем за 10 секунд до строки с учётом прошлого сдвига, чтобы не ждать всё вступление
  startMusic(box, song, tuned ? segFor(song, frag) : null, null, Math.max(0, first.t + offsetOf(song) - 10));
}

// ---------- Переходы между экранами ----------

function route() {
  hideMusic();
  document.body.classList.remove('learning');
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const [view, id, n] = path.split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  document.body.classList.toggle('home', !view);

  if (!view) return viewHome();
  if (view === 'paste') return viewPaste(new URLSearchParams(query || '').get('q') || '');
  const song = id ? findSong(id) : null;
  if (!song) { location.replace('#/'); return viewHome(); }
  if (view === 'song') return viewSong(song);
  if (view === 'versions') return viewVersions(song);
  if (view === 'learn') return viewLearn(song, Number(n) || 0);
  if (view === 'whole') return viewWhole(song);
  if (view === 'sync') return viewSync(song);
  if (view === 'split') return viewSplit(song);
  return viewHome();
}

window.addEventListener('hashchange', route);

// ---------- Окно «Данные»: копия и ключ ----------

const dialog = document.getElementById('data-dialog');
const keyInput = document.getElementById('yt-key');
const importFile = document.getElementById('import-file');

document.getElementById('open-data').addEventListener('click', () => {
  keyInput.value = getKey();
  dialog.showModal();
});

document.getElementById('export-btn').addEventListener('click', () => {
  const payload = { app: 'naizust', version: 1, exportedAt: new Date().toISOString(), songs: data.songs };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Наизусть копия ${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Копия скачана: песен ${data.songs.length}.`);
});

document.getElementById('import-btn').addEventListener('click', () => importFile.click());

function validSong(s) {
  return s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.artist === 'string'
    && Array.isArray(s.fragments) && Array.isArray(s.units) && s.fragments.length > 0
    && s.fragments.every(f => Array.isArray(f.lines) && Number.isInteger(f.unit) && s.units[f.unit]);
}

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || obj.app !== 'naizust' || !Array.isArray(obj.songs)) throw new Error('format');
    const songs = obj.songs.filter(validSong);
    if (!songs.length && obj.songs.length) throw new Error('format');
    // Совпадающие песни заменяем версией из копии, новые добавляем
    for (const s of songs) {
      const i = data.songs.findIndex(x => x.id === s.id);
      if (i === -1) data.songs.push(s); else data.songs[i] = s;
    }
    save();
    migrateEnds();
    migrateProgress();
    dialog.close();
    toast(`Загружено из копии: песен ${songs.length}.`);
    route();
  } catch (e) {
    toast('Это не копия данных «Наизусть». Выбери файл, который скачал кнопкой «Скачать копию данных».');
  }
});

document.getElementById('save-key').addEventListener('click', () => {
  const k = keyInput.value.trim();
  if (!k) { toast('Вставь ключ в поле.'); return; }
  setKey(k);
  toast('Ключ сохранён. Новые песни будут искать музыку сами.');
  dialog.close();
  route();
});

document.getElementById('clear-key').addEventListener('click', () => {
  setKey('');
  keyInput.value = '';
  toast('Ключ убран.');
  route();
});

// Песни, добавленные до 10.11.2026: досчитываем концы фрагментов по новому правилу
// Песни до 10.11.2026 хранили прогресс по уникальному тексту (units). Переносим на фрагменты:
// основной фрагмент получает прогресс своего текста, повторы припева начинаются заново
function migrateProgress() {
  let changed = false;
  for (const s of data.songs) {
    if (!Array.isArray(s.fragments) || s.fragments.every(f => f.stage != null)) continue;
    for (const f of s.fragments) {
      const u = (s.units || [])[f.unit] || {};
      f.learned = !f.repeat && Boolean(u.learned);
      f.stage = f.learned ? 4 : (!f.repeat && u.stage) || 1;
    }
    if (s.fragments.some(f => !f.learned)) s.wholeDone = false;
    changed = true;
  }
  if (changed) save();
}

function migrateEnds() {
  let changed = false;
  for (const s of data.songs) {
    if (s.synced && !s.endsFixed && Array.isArray(s.fragments)) {
      try { fixEnds(s.fragments, s.duration); s.endsFixed = 1; changed = true; } catch (e) { /* старые данные без времени */ }
    }
  }
  if (changed) save();
}
migrateEnds();
migrateProgress();

route();

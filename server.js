require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
// Ключ за замовчуванням — щоб проєкт працював одразу після клонування.
// У продакшені краще задати OMDB_API_KEY у змінних середовища.
const OMDB_KEY = process.env.OMDB_API_KEY || '665cf353';
const DECK_SIZE = 20,
  MIN_DECK = 10,
  MIN_GENRE = 5;
const ROOM_TTL = 24 * 60 * 60 * 1000;
// На Vercel файлова система доступна лише для читання, окрім /tmp.
const CACHE_FILE = process.env.VERCEL
  ? path.join(os.tmpdir(), 'omdb-cache.json')
  : path.join(__dirname, 'data/omdb-cache.json');

// require() замість fs.readFileSync: так бандлери (Vercel) гарантовано включають JSON у збірку.
const localData = require('./data/movies.json');
const imdbIdList = require('./data/imdb-ids.json');
const localMovies = localData.map((m) => ({
  ...m,
  genreList: m.genres.split(', '),
}));
const imdbIds = imdbIdList;

const GENRE_UA = {
  Action: 'Бойовик',
  Adventure: 'Пригоди',
  Animation: 'Анімація',
  Biography: 'Біографія',
  Comedy: 'Комедія',
  Crime: 'Кримінал',
  Documentary: 'Документальний',
  Drama: 'Драма',
  Family: 'Сімейний',
  Fantasy: 'Фентезі',
  History: 'Історичний',
  Horror: 'Жахи',
  Music: 'Музичний',
  Musical: 'Мюзикл',
  Mystery: 'Детектив',
  Romance: 'Мелодрама',
  'Sci-Fi': 'Фантастика',
  Sport: 'Спорт',
  Thriller: 'Трилер',
  War: 'Воєнний',
  Western: 'Вестерн',
};
const KNOWN_GENRES = new Set(Object.values(GENRE_UA));

const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clean = (s, n) =>
  String(s ?? '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, n);
const short = (t) => (t.length > 220 ? t.slice(0, 217) + '…' : t);

// ---------- OMDb каталог ----------
async function omdbMovie(id) {
  const r = await fetch(`https://www.omdbapi.com/?apikey=${OMDB_KEY}&i=${id}&plot=short`);
  const d = await r.json();
  if (d.Response !== 'True') {
    const e = new Error(d.Error || 'OMDb error');
    e.fatal = /api key|limit/i.test(d.Error || '');
    throw e;
  }
  const list = (d.Genre || '')
    .split(', ')
    .map((g) => GENRE_UA[g])
    .filter(Boolean);
  return {
    id: d.imdbID,
    title: d.Title,
    year: (d.Year || '').slice(0, 4),
    genres: list.slice(0, 2).join(', '),
    genreList: list,
    overview: short(d.Plot && d.Plot !== 'N/A' ? d.Plot : ''),
    poster: d.Poster && d.Poster !== 'N/A' ? d.Poster : null,
    rating: d.imdbRating && d.imdbRating !== 'N/A' ? Number(d.imdbRating) : null,
  };
}

// Один раз завантажуємо деталі всіх фільмів зі списку й кешуємо на диск (економимо ліміт OMDb).
async function buildCatalog() {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    // кешу ще немає — завантажимо все з OMDb
  }
  const todo = imdbIds.filter((id) => !cache[id]);
  let i = 0,
    fatal = null;
  const worker = async () => {
    while (i < todo.length && !fatal) {
      const id = todo[i++];
      try {
        cache[id] = await omdbMovie(id);
      } catch (e) {
        if (e.fatal) fatal = e.message;
        else console.warn(`OMDb ${id}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('Не вдалося записати кеш OMDb:', e.message);
  }
  const movies = imdbIds.map((id) => cache[id]).filter((m) => m && m.poster);
  if (movies.length < MIN_DECK) throw new Error(fatal || 'замало фільмів з OMDb');
  console.log(`OMDb працює: у каталозі ${movies.length} фільмів`);
  return { movies, source: 'OMDb', error: null };
}
const catalogReady = (
  OMDB_KEY ? buildCatalog() : Promise.reject(new Error('Немає OMDB_API_KEY'))
).catch((e) => {
  console.error('OMDb НЕ працює, використовую запасний список:', e.message);
  return { movies: localMovies, source: 'local', error: e.message };
});

function pickDeck(movies, genres) {
  if (!genres.length) return shuffle(movies).slice(0, DECK_SIZE);
  const score = (m) => genres.filter((g) => m.genreList.includes(g)).length;
  const pool = shuffle(movies);
  const matched = pool.filter((m) => score(m) > 0).sort((a, b) => score(b) - score(a));
  let deck = matched.slice(0, DECK_SIZE);
  if (deck.length < MIN_DECK)
    deck = deck.concat(pool.filter((m) => score(m) === 0).slice(0, MIN_DECK - deck.length));
  return shuffle(deck);
}

// ---------- кімнати ----------
const rooms = new Map();
const newCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  while (rooms.has(c));
  return c;
};
function summary(room) {
  const people = Object.values(room.votes);
  const total = people.length;
  const ranking = room.movies
    .map((m) => ({ movie: m, n: people.filter((p) => p.answers[m.id] === true).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 10)
    .map((x) => ({ ...x, match: total > 1 && x.n === total }));
  return {
    participants: people.map((p) => ({ name: p.name, seen: Object.keys(p.answers).length })),
    deckSize: room.movies.length,
    total,
    ranking,
  };
}
function broadcast(room) {
  const msg = `data: ${JSON.stringify(summary(room))}\n\n`;
  room.clients.forEach((res) => res.write(msg));
}
const getRoom = (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) res.status(404).json({ error: 'Кімнату не знайдено' });
  else room.touched = Date.now();
  return room;
};

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/genres', async (req, res) => {
  const { movies, source, error } = await catalogReady;
  const counts = {};
  movies.forEach((m) => m.genreList.forEach((g) => (counts[g] = (counts[g] || 0) + 1)));
  const genres = Object.entries(counts)
    .filter(([, n]) => n >= MIN_GENRE)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  res.json({ genres, source, error });
});

app.post('/api/rooms', async (req, res) => {
  const genres = (Array.isArray(req.body.genres) ? req.body.genres : [])
    .map(String)
    .filter((g) => KNOWN_GENRES.has(g))
    .slice(0, 8);
  const { movies, source, error } = await catalogReady;
  const code = newCode();
  rooms.set(code, {
    code,
    genres,
    source,
    error,
    movies: pickDeck(movies, genres),
    votes: {},
    clients: new Set(),
    touched: Date.now(),
  });
  res.json({ code });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const uid = clean(req.body.uid, 40),
    name = clean(req.body.name, 20);
  if (!uid || !name) return res.status(400).json({ error: 'Потрібні uid та ім’я' });
  const v = (room.votes[uid] ||= { name, answers: {} });
  v.name = name;
  broadcast(room);
  res.json({
    movies: room.movies,
    answers: v.answers,
    genres: room.genres,
    source: room.source,
    error: room.error,
  });
});

app.post('/api/rooms/:code/vote', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const v = room.votes[clean(req.body.uid, 40)];
  const movieId = String(req.body.movieId);
  if (!v || !room.movies.some((m) => m.id === movieId))
    return res.status(400).json({ error: 'Некоректний голос' });
  v.answers[movieId] = req.body.like === true;
  broadcast(room);
  res.json({ ok: true });
});

app.get('/api/rooms/:code/events', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(summary(room))}\n\n`);
  room.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    room.clients.delete(res);
  });
});

setInterval(
  () => {
    const now = Date.now();
    for (const [code, r] of rooms)
      if (now - r.touched > ROOM_TTL && r.clients.size === 0) rooms.delete(code);
  },
  60 * 60 * 1000,
).unref();

// Запуск сервера лише при `node server.js`; для serverless-платформ експортуємо app.
if (require.main === module) {
  app.listen(PORT, () => console.log(`КіноМатч: http://localhost:${PORT}`));
}

module.exports = app;

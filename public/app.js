// ---------- Допоміжне ----------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const store = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* сховище недоступне — не критично */
    }
  },
};

const SCREENS = ['join', 'genres', 'play', 'results'];
const DEFAULT_GRADIENT = '#3b4cca,#1b1f4b';
const DEFAULT_EMOJI = '🎬';

const uid =
  store.get('km_uid') ||
  (() => {
    const id = 'u' + Math.random().toString(36).slice(2, 12);
    store.set('km_uid', id);
    return id;
  })();

const state = { room: '', movies: [], answers: {}, index: 0, sourceLabel: '', events: null };
const pickedGenres = new Set();

async function api(path, body) {
  const response = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Помилка ' + response.status);
  return data;
}

const show = (id) =>
  SCREENS.forEach((name) => $(name).classList.toggle('screen--hidden', name !== id));
const isVisible = (id) => !$(id).classList.contains('screen--hidden');
const background = (movie) =>
  movie.poster
    ? `url("${esc(movie.poster)}")`
    : `linear-gradient(160deg,${movie.gradient || DEFAULT_GRADIENT})`;
const fail = (message) => {
  $('err').textContent = message;
  $('err').classList.remove('form__error--hidden');
};

// ---------- Вхід у кімнату ----------
async function enter(rawCode) {
  const name = $('name').value.trim();
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!name) return $('name').focus();
  if (code.length < 3) return $('code').focus();
  store.set('km_name', name);

  try {
    const data = await api(`/rooms/${code}/join`, { uid, name });
    Object.assign(state, {
      room: code,
      movies: data.movies,
      answers: data.answers,
      sourceLabel: data.source === 'local' ? 'запасний список ⚠️' : data.source,
    });
    if (data.error) console.warn('API недоступне:', data.error);
    $('gen').textContent = 'Жанри: ' + (data.genres?.length ? data.genres.join(', ') : 'будь-які');
    const next = state.movies.findIndex((movie) => !(movie.id in state.answers));
    state.index = next < 0 ? state.movies.length : next;
  } catch (error) {
    show('join');
    return fail(error.message);
  }

  history.replaceState(null, '', '#' + state.room);
  document.querySelectorAll('.topbar__room').forEach((el) => {
    el.textContent = `Кімната ${state.room} · ${state.sourceLabel}`;
  });
  $('bigCode').textContent = state.room;
  state.events?.close();
  state.events = new EventSource(`/api/rooms/${state.room}/events`);
  state.events.onmessage = (event) => renderResults(JSON.parse(event.data));
  show(state.index >= state.movies.length ? 'results' : 'play');
  drawDeck();
}

// ---------- Колода ----------
function cardHtml(movie) {
  return `
    ${movie.poster ? '' : `<div class="card__emoji">${esc(movie.emoji || DEFAULT_EMOJI)}</div>`}
    <div class="card__stamp card__stamp--yes">ХОЧУ</div>
    <div class="card__stamp card__stamp--no">ПАС</div>
    <div class="card__info">
      <h3 class="card__title">${esc(movie.title)} <span class="card__year">${esc(movie.year)}</span></h3>
      <p class="card__text">${esc(movie.genres)}${movie.rating ? ' · ⭐ ' + movie.rating : ''}</p>
      <p class="card__text">${esc(movie.overview)}</p>
    </div>`;
}

function drawDeck() {
  const deck = $('stack');
  deck.innerHTML = '';
  const { index, movies } = state;
  $('left').textContent =
    index < movies.length ? `Залишилось фільмів: ${movies.length - index}` : '';
  if (index >= movies.length) {
    deck.innerHTML = `<div class="panel deck__done"><h2 class="panel__title">Усе переглянуто 🎉</h2>
      <p class="text text--muted">Дивіться результати та чекайте друзів.</p></div>`;
    return;
  }
  [index + 1, index].forEach((position) => {
    const movie = movies[position];
    if (!movie) return;
    const card = document.createElement('div');
    card.className = position === index ? 'card' : 'card card--next';
    card.style.backgroundImage = background(movie);
    card.innerHTML = cardHtml(movie);
    deck.appendChild(card);
    if (position === index) attachDrag(card);
  });
}

function attachDrag(card) {
  let startX = 0;
  let deltaX = 0;
  let dragging = false;
  const yes = card.querySelector('.card__stamp--yes');
  const no = card.querySelector('.card__stamp--no');

  card.onpointerdown = (event) => {
    dragging = true;
    startX = event.clientX;
    card.style.transition = 'none';
    card.setPointerCapture(event.pointerId);
  };
  card.onpointermove = (event) => {
    if (!dragging) return;
    deltaX = event.clientX - startX;
    card.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 18}deg)`;
    yes.style.opacity = Math.max(0, deltaX / 100);
    no.style.opacity = Math.max(0, -deltaX / 100);
  };
  card.onpointerup = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    if (deltaX > 90) vote(true);
    else if (deltaX < -90) vote(false);
    else {
      card.style.transform = '';
      yes.style.opacity = no.style.opacity = 0;
    }
    deltaX = 0;
  };
}

function vote(like) {
  const { movies, room } = state;
  if (state.index >= movies.length) return;
  const movie = movies[state.index];
  const card = $('stack').lastElementChild;
  if (card?.classList.contains('card')) {
    card.style.transform = `translateX(${like ? 600 : -600}px) rotate(${like ? 30 : -30}deg)`;
    card.style.opacity = 0;
  }
  state.answers[movie.id] = like;
  state.index++;
  api(`/rooms/${room}/vote`, { uid, movieId: movie.id, like }).catch((error) =>
    console.error(error),
  );
  setTimeout(drawDeck, 220);
}

// ---------- Результати ----------
function rankingItemHtml({ movie, n, match }, total) {
  return `
    <div class="ranking__item">
      <div class="ranking__poster" style="background-image:${background(movie)}">${
        movie.poster ? '' : esc(movie.emoji || DEFAULT_EMOJI)
      }</div>
      <div class="ranking__body">
        <b>${esc(movie.title)}</b> <span class="text text--muted">${esc(movie.year)}</span>
        ${match ? '<span class="ranking__match">• МАТЧ!</span>' : ''}
        <div class="ranking__bar"><span class="ranking__bar-fill" style="width:${(n / total) * 100}%"></span></div>
      </div>
      <div class="ranking__votes">${n}/${total}</div>
    </div>`;
}

function renderResults(summary) {
  const people = summary.participants.map((p) => `${p.name} (${p.seen}/${summary.deckSize})`);
  $('who').textContent = 'Учасники: ' + people.join(', ');
  $('list').innerHTML = summary.ranking.length
    ? summary.ranking.map((item) => rankingItemHtml(item, summary.total)).join('')
    : '<p class="text text--muted">Поки що ніхто нічого не вподобав.</p>';
}

// ---------- Вибір жанрів ----------
async function openGenres() {
  if (!$('name').value.trim()) return $('name').focus();
  pickedGenres.clear();
  $('makeRoom').textContent = 'Створити: будь-які жанри';
  show('genres');
  $('chips').textContent = 'Завантажую жанри…';
  try {
    const { genres } = await api('/genres');
    $('chips').innerHTML = genres
      .map(
        (g) => `<button class="genre-chip" data-genre="${esc(g.name)}">${esc(g.name)}
          <span class="genre-chip__count">${g.count}</span></button>`,
      )
      .join('');
  } catch (error) {
    $('chips').textContent = error.message;
  }
}

function toggleGenre(event) {
  const chip = event.target.closest('.genre-chip');
  if (!chip) return;
  const genre = chip.dataset.genre;
  if (pickedGenres.has(genre)) pickedGenres.delete(genre);
  else pickedGenres.add(genre);
  chip.classList.toggle('genre-chip--active');
  $('makeRoom').textContent = pickedGenres.size
    ? `Створити кімнату (${pickedGenres.size})`
    : 'Створити: будь-які жанри';
}

async function createRoom() {
  try {
    const { code } = await api('/rooms', { genres: [...pickedGenres] });
    await enter(code);
  } catch (error) {
    show('join');
    fail(error.message);
  }
}

// ---------- Події ----------
$('enter').onclick = () => enter($('code').value);
$('create').onclick = openGenres;
$('chips').onclick = toggleGenre;
$('makeRoom').onclick = createRoom;
$('genBack').onclick = () => show('join');
$('yes').onclick = () => vote(true);
$('no').onclick = () => vote(false);
$('toRes').onclick = () => show('results');
$('back').onclick = () => show(state.index >= state.movies.length ? 'results' : 'play');
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/#${state.room}`);
    $('copy').textContent = 'Скопійовано ✓';
  } catch {
    $('copy').textContent = 'Код: ' + state.room;
  }
};
document.addEventListener('keydown', (event) => {
  if (!isVisible('play')) return;
  if (event.key === 'ArrowRight') vote(true);
  if (event.key === 'ArrowLeft') vote(false);
});

$('code').value = location.hash.slice(1);
$('name').value = store.get('km_name') || '';

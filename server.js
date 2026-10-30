// «Кто это?» — игра для компании. Два режима:
//   who  — каждый пишет о себе факты, остальные угадывают автора;
//   lie  — каждый пишет две правды и одну ложь, остальные ищут ложь.
// Без зависимостей: node server.js, порт из PORT (по умолчанию 8080).
// Клиенты опрашивают /api/state раз в секунду — надёжнее SSE на мобильном интернете и туннелях.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const SAVE = path.join(__dirname, 'data', 'rooms.json');

const ANSWER_SECONDS = 25;
const POINTS_CORRECT = 500;
const POINTS_SPEED = 500;     // максимум бонуса за скорость, тает к концу таймера
const POINTS_AUTHOR = 1000;   // автору — эта сумма, умноженная на долю не угадавших
const MAX_FACTS = 3;

// Рубрики режима «Кто это?»: подсказка игроку и примеры-заготовки.
const RUBRICS = {
  mix:    { title: 'Микс', prompt: 'Напиши о себе то, чего почти никто не знает' },
  fear:   { title: 'Страхи', prompt: 'Чего ты боишься?', examples: ['Я боюсь…', 'До сих пор боюсь…', 'В детстве жутко боялся(-ась)…'] },
  never:  { title: 'Ни разу не делал', prompt: 'Что ты ни разу в жизни не делал(а)?', examples: ['Я ни разу не…', 'Никогда в жизни не пробовал(а)…'] },
  talent: { title: 'Тайный талант', prompt: 'Что ты умеешь, о чём никто не догадывается?', examples: ['Я умею…', 'Когда-то занимался(-ась)…'] },
  habit:  { title: 'Странная привычка', prompt: 'Какая у тебя странная привычка или вкус?', examples: ['Я не ем…', 'Я всегда…', 'Терпеть не могу…'] },
};

let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(SAVE, 'utf8')); } catch { rooms = {}; }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(SAVE), { recursive: true });
    fs.writeFileSync(SAVE, JSON.stringify(rooms));
  }, 300);
}

const id = (n = 12) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const now = () => Date.now();

function newCode() {
  let code;
  do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms[code]);
  return code;
}

function touch(room) { room.version++; room.updated = now(); save(); }

// ---------- игровая логика ----------

// Что игрок уже написал в текущем режиме.
const factsOf = (room, pid) => room.facts.filter(f => f.authorId === pid && f.game === room.game);
const lieSetOf = (room, pid) => room.lies[pid];
const isReady = (room, pid) => room.game === 'lie' ? !!lieSetOf(room, pid) : factsOf(room, pid).length > 0;

function startGame(room) {
  if (Object.keys(room.players).length < 3) return 'Нужно хотя бы 3 игрока';
  let order;
  if (room.game === 'lie') {
    order = shuffle(Object.keys(room.lies).filter(pid => room.players[pid] && !room.used.includes('lie:' + pid)))
      .map(pid => ({ kind: 'lie', authorId: pid }));
  } else {
    // сначала по одному факту от каждого, потом остальные — чтобы при лимите спросили про всех
    const fresh = shuffle(room.facts.filter(f => f.game === 'who' && room.players[f.authorId] && !room.used.includes(f.id)));
    const first = [], rest = [], seen = new Set();
    for (const f of fresh) (seen.has(f.authorId) ? rest : (seen.add(f.authorId), first)).push(f);
    order = [...first, ...rest].map(f => ({ kind: 'who', factId: f.id }));
  }
  if (!order.length) return 'Новых фактов нет — всё уже сыграно';
  if (room.limit) order = order.slice(0, room.limit);
  room.order = shuffle(order);
  room.qIndex = -1;
  for (const p of Object.values(room.players)) p.score = 0;
  room.history = [];
  nextQuestion(room);
  return null;
}

function nextQuestion(room) {
  room.qIndex++;
  if (room.qIndex >= room.order.length) { room.phase = 'final'; room.q = null; return; }
  const item = room.order[room.qIndex];
  room.used.push(item.kind === 'lie' ? 'lie:' + item.authorId : item.factId);
  const base = { kind: item.kind, votes: {}, startedAt: now(), endsAt: now() + ANSWER_SECONDS * 1000 };
  if (item.kind === 'lie') {
    const set = room.lies[item.authorId];
    // варианты — индексы утверждений в перемешанном порядке
    room.q = { ...base, authorId: item.authorId, statements: set.statements, options: shuffle([0, 1, 2]), answer: set.lieIndex };
  } else {
    const fact = room.facts.find(f => f.id === item.factId);
    const others = shuffle(Object.keys(room.players).filter(pid => pid !== fact.authorId));
    const options = room.whoMode === 'all'
      ? Object.keys(room.players).sort((a, b) => room.players[a].name.localeCompare(room.players[b].name, 'ru'))
      : shuffle([fact.authorId, ...others.slice(0, 3)]);
    room.q = { ...base, authorId: fact.authorId, text: fact.text, rubric: fact.rubric, options, answer: fact.authorId };
  }
  room.phase = 'question';
}

function voters(room) { return Object.keys(room.players).filter(pid => pid !== room.q.authorId); }

function maybeFinishByTime(room) {
  if (room.phase === 'question' && now() >= room.q.endsAt) { reveal(room); touch(room); }
}

function reveal(room) {
  const q = room.q;
  const gained = {};
  let wrong = 0;
  for (const pid of voters(room)) {
    const v = q.votes[pid];
    if (v && v.choice === q.answer) {
      const left = Math.max(0, q.endsAt - v.at) / (ANSWER_SECONDS * 1000);
      gained[pid] = POINTS_CORRECT + Math.round(POINTS_SPEED * left);
    } else wrong++;
  }
  const total = voters(room).length;
  gained[q.authorId] = total ? Math.round(POINTS_AUTHOR * wrong / total) : 0;
  for (const [pid, pts] of Object.entries(gained)) if (room.players[pid]) room.players[pid].score += pts;
  q.gained = gained;
  room.history.push({ authorId: q.authorId, correct: voters(room).length - wrong, total: voters(room).length });
  room.phase = 'reveal';
}

// Тот, кого угадывали реже всех.
function mostMysterious(room) {
  const byAuthor = {};
  for (const h of room.history) {
    const a = byAuthor[h.authorId] ||= { correct: 0, total: 0 };
    a.correct += h.correct; a.total += h.total;
  }
  let best = null;
  for (const [pid, a] of Object.entries(byAuthor)) {
    if (!a.total || !room.players[pid]) continue;
    const r = a.correct / a.total;
    if (!best || r < best.ratio) best = { playerId: pid, name: room.players[pid].name, ratio: r };
  }
  return best;
}

// ---------- что видит клиент ----------

function publicState(room, viewer) {
  maybeFinishByTime(room);
  const players = Object.entries(room.players).map(([pid, p]) => ({
    id: pid, name: p.name, score: p.score, ready: isReady(room, pid),
    facts: room.game === 'lie' ? (lieSetOf(room, pid) ? 3 : 0) : factsOf(room, pid).length,
  }));
  const s = {
    code: room.code, phase: room.phase, game: room.game, whoMode: room.whoMode, rubric: room.rubric, limit: room.limit,
    unplayed: room.game === 'lie'
      ? Object.keys(room.lies).filter(pid => room.players[pid] && !room.used.includes('lie:' + pid)).length
      : room.facts.filter(f => f.game === 'who' && room.players[f.authorId] && !room.used.includes(f.id)).length,
    rubrics: RUBRICS, version: room.version, players, serverNow: now(), maxFacts: MAX_FACTS,
  };
  if (room.q) {
    const q = room.q;
    s.q = {
      kind: q.kind, number: room.qIndex + 1, count: room.order.length,
      endsAt: q.endsAt, answered: Object.keys(q.votes).length, voters: voters(room).length,
    };
    if (q.kind === 'lie') {
      s.q.authorName = room.players[q.authorId]?.name ?? '—';
      s.q.authorId = q.authorId;
      s.q.options = q.options.map(i => ({ id: i, name: q.statements[i] }));
    } else {
      s.q.text = q.text;
      s.q.rubric = RUBRICS[q.rubric]?.title;
      s.q.options = q.options.map(pid => ({ id: pid, name: room.players[pid]?.name ?? '—' }));
    }
    if (viewer.playerId) {
      s.q.isMine = q.authorId === viewer.playerId;
      s.q.myVote = q.votes[viewer.playerId]?.choice ?? null;
    }
    if (room.phase === 'reveal') {
      s.q.authorId = q.authorId;
      s.q.answer = q.answer;
      s.q.tally = Object.fromEntries(q.options.map(o => [o, Object.values(q.votes).filter(v => v.choice === o).length]));
      s.q.gained = q.gained;
    }
  }
  if (room.phase === 'final') s.mysterious = mostMysterious(room);
  if (viewer.playerId && room.players[viewer.playerId]) {
    s.me = {
      id: viewer.playerId, name: room.players[viewer.playerId].name,
      facts: factsOf(room, viewer.playerId).map(f => ({ id: f.id, text: f.text, rubric: RUBRICS[f.rubric]?.title })),
      lie: lieSetOf(room, viewer.playerId) || null,
    };
  }
  if (viewer.isHost) s.isHost = true;
  return s;
}

// ---------- HTTP ----------

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/play.html';
  if (pathname === '/host') pathname = '/host.html';
  if (/^\/\d{4}$/.test(pathname)) pathname = '/host.html';  // экран для ТВ: /1234, только показ
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const clean = (v, max) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, max);

async function api(req, res, pathname, query) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const code = String(body.code ?? query.get('code') ?? '').trim();

  if (pathname === '/api/create') {
    const c = newCode();
    rooms[c] = {
      code: c, hostToken: id(16), phase: 'lobby', game: 'who', whoMode: 'four', rubric: 'mix',
      limit: 20, players: {}, facts: [], lies: {}, used: [], order: [], qIndex: -1, q: null, history: [], version: 1, updated: now(),
    };
    save();
    return send(res, 200, { code: c, hostToken: rooms[c].hostToken });
  }

  const room = rooms[code];
  if (!room) return send(res, 404, { error: 'Комната не найдена' });
  const isHost = (body.hostToken || query.get('hostToken')) === room.hostToken;
  const playerId = String(body.playerId ?? query.get('playerId') ?? '');
  const player = room.players[playerId];

  if (pathname === '/api/state') {
    if (player) player.seen = now();
    return send(res, 200, publicState(room, { isHost, playerId: player ? playerId : null }));
  }

  if (pathname === '/api/join') {
    const name = clean(body.name, 24);
    if (!name) return send(res, 400, { error: 'Введите имя' });
    if (player) { player.name = name; touch(room); return send(res, 200, { playerId }); }
    if (Object.values(room.players).some(p => p.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'Такое имя уже есть — добавьте фамилию или букву' });
    if (room.phase !== 'lobby') return send(res, 400, { error: 'Игра уже идёт — дождитесь следующего раунда' });
    const pid = id();
    room.players[pid] = { name, score: 0, seen: now() };
    touch(room);
    return send(res, 200, { playerId: pid });
  }

  if (pathname === '/api/fact') {
    if (!player) return send(res, 403, { error: 'Сначала войдите' });
    if (room.phase !== 'lobby') return send(res, 400, { error: 'Игра уже началась' });
    if (body.removeId) {
      room.facts = room.facts.filter(f => !(f.id === body.removeId && f.authorId === playerId));
    } else {
      const text = clean(body.text, 160);
      if (text.length < 3) return send(res, 400, { error: 'Слишком коротко' });
      if (factsOf(room, playerId).length >= MAX_FACTS) return send(res, 400, { error: `Не больше ${MAX_FACTS} фактов` });
      // в «Миксе» рубрику выбирает игрок, иначе — ведущий
      const rubric = room.rubric === 'mix' ? (RUBRICS[body.rubric] && body.rubric !== 'mix' ? body.rubric : 'mix') : room.rubric;
      room.facts.push({ id: id(8), authorId: playerId, game: 'who', rubric, text });
    }
    touch(room);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/lie') {
    if (!player) return send(res, 403, { error: 'Сначала войдите' });
    if (room.phase !== 'lobby') return send(res, 400, { error: 'Игра уже началась' });
    if (body.remove) { delete room.lies[playerId]; touch(room); return send(res, 200, { ok: true }); }
    const statements = (Array.isArray(body.statements) ? body.statements : []).slice(0, 3).map(t => clean(t, 140));
    const lieIndex = Number(body.lieIndex);
    if (statements.length !== 3 || statements.some(t => t.length < 3)) return send(res, 400, { error: 'Нужно три утверждения' });
    if (![0, 1, 2].includes(lieIndex)) return send(res, 400, { error: 'Отметьте, какое из них — ложь' });
    room.lies[playerId] = { statements, lieIndex };
    touch(room);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/vote') {
    maybeFinishByTime(room);
    if (!player || room.phase !== 'question') return send(res, 400, { error: 'Сейчас голосовать нельзя' });
    if (room.q.authorId === playerId) return send(res, 400, { error: 'Это вопрос про вас' });
    if (room.q.votes[playerId]) return send(res, 400, { error: 'Вы уже ответили' });
    if (!room.q.options.includes(body.choice) || (room.q.kind === 'who' && body.choice === playerId)) return send(res, 400, { error: 'Нет такого варианта' });
    room.q.votes[playerId] = { choice: body.choice, at: now() };
    if (Object.keys(room.q.votes).length >= voters(room).length) reveal(room);
    touch(room);
    return send(res, 200, { ok: true });
  }

  // дальше — только ведущий
  if (!isHost) return send(res, 403, { error: 'Только ведущий' });

  if (pathname === '/api/host') {
    let err = null;
    const inLobby = room.phase === 'lobby';
    switch (body.action) {
      case 'settings':
        if (!inLobby) break;
        if (['who', 'lie'].includes(body.game)) room.game = body.game;
        if (['four', 'all'].includes(body.whoMode)) room.whoMode = body.whoMode;
        if (RUBRICS[body.rubric]) room.rubric = body.rubric;
        if ([0, 10, 20, 30].includes(body.limit)) room.limit = body.limit;
        break;
      case 'kick': if (inLobby) { delete room.players[body.playerId]; delete room.lies[body.playerId]; room.facts = room.facts.filter(f => f.authorId !== body.playerId); } break;
      case 'start': err = startGame(room); break;
      case 'reveal': if (room.phase === 'question') reveal(room); break;
      case 'next': if (room.phase === 'reveal') nextQuestion(room); break;
      case 'finish': if (room.phase === 'question') reveal(room); room.phase = 'final'; room.q = null; break;
      // новый раунд: в меню, очки и написанное в этом режиме обнуляются (уже сыгранное не повторится)
      case 'lobby':
        room.phase = 'lobby'; room.q = null; room.qIndex = -1;
        for (const p of Object.values(room.players)) p.score = 0;
        if (body.clear) { room.facts = []; room.lies = {}; room.used = []; }
        break;
      default: err = 'Неизвестное действие';
    }
    if (err) return send(res, 400, { error: err });
    touch(room);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url.pathname, url.searchParams).catch(e => { console.error(e); send(res, 500, { error: 'Ошибка сервера' }); });
  } else serveStatic(req, res, decodeURIComponent(url.pathname));
}).listen(PORT, () => console.log(`Кто это? — http://localhost:${PORT}  (ведущий: /host)`));

// старые комнаты (сутки без движения) убираем
setInterval(() => {
  for (const [c, r] of Object.entries(rooms)) if (now() - r.updated > 24 * 3600e3) delete rooms[c];
  save();
}, 3600e3);

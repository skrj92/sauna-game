// Общее для обоих экранов: запросы к серверу, опрос состояния, хранение.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка связи');
  return data;
}

// Опрос раз в секунду; render вызывается на каждый ответ (нужно для таймера).
function poll(getParams, render, onError) {
  let stopped = false, skew = 0;
  async function tick() {
    if (stopped) return;
    try {
      const p = getParams();
      if (p) {
        const r = await fetch('/api/state?' + new URLSearchParams(p), { cache: 'no-store' });
        const s = await r.json();
        if (!r.ok) throw new Error(s.error || 'Ошибка связи');
        skew = s.serverNow - Date.now();
        s.clientSkew = skew;
        render(s);
      }
    } catch (e) { onError && onError(e); }
    setTimeout(tick, document.hidden ? 3000 : 1000);
  }
  tick();
  return { stop() { stopped = true; }, now: () => Date.now() + skew };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = sel => document.querySelector(sel);
const secondsLeft = (endsAt, skew) => Math.max(0, Math.ceil((endsAt - (Date.now() + skew)) / 1000));

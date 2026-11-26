// Подсказка ротации поверх игры
const $ = (id) => document.getElementById(id);
let st = null;
let lastKey = '';
let offset = 0; // разница часов главного процесса и окна (на всякий случай)
let audio = null;

function beep(freq = 880, ms = 70) {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* звук необязателен */ }
}

const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });

function render() {
  const main = $('main');
  main.innerHTML = '';
  document.body.classList.toggle('unlocked', !st.locked);
  $('name').textContent = st.name || 'Нет ротации';
  $('counter').textContent = st.count > 1 ? `команда ${st.index + 1}/${st.count}` : '';

  if (!st.locked) {
    main.append(el('div', 'center', 'Перетащите подсказку куда удобно.\nЗатем нажмите «Закрепить» в меню.'));
    $('hint').textContent = '';
    $('fill').style.width = '0';
    return;
  }
  if (!st.running) {
    main.append(el('div', 'center', st.finished ? '✓ Ротация завершена' : (st.steps.length ? 'Готово к старту' : 'Нет шагов')));
    $('hint').innerHTML = st.toggleKey ? `Старт: <kbd>${st.toggleKey}</kbd>` : '';
    $('fill').style.width = '0';
    return;
  }

  const step = st.steps[st.s] || {};
  const hasNext = st.s + 1 < st.steps.length || st.loop;
  const next = st.steps[(st.s + 1) % st.steps.length];
  $('counter').textContent = `шаг ${st.s + 1}/${st.steps.length}` + (st.count > 1 ? ` · команда ${st.index + 1}/${st.count}` : '');

  const cap = el('div', 'cap', step.key || '•');
  const cur = el('div', '');
  cur.id = 'cur';
  const lab = el('div', '', step.label || '');
  lab.id = 'label';
  cur.append(lab);
  if (step.note) { const n = el('div', '', step.note); n.id = 'note'; cur.append(n); }
  main.append(cap, cur);

  if (hasNext && next) {
    const nx = el('div', '');
    nx.id = 'next';
    nx.append(el('span', '', 'далее'), document.createElement('br'), el('span', 'cap-s', next.key || '•'), el('span', 'lbl', next.label || ''));
    main.append(nx);
  }

  const id = `${st.start}:${st.s}`;
  if (id !== lastKey) {
    lastKey = id;
    cap.classList.add('pop');
    if (st.sound) beep(st.dur > 0 ? 880 : 660);
  }
  $('hint').innerHTML = st.dur > 0
    ? ''
    : (st.nextKey ? `Нажмите навык, затем <kbd>${st.nextKey}</kbd> — следующий шаг` : 'Ждёт следующего шага');
}

function tick() {
  if (st && st.running && st.locked && st.dur > 0) {
    const p = Math.min(1, (Date.now() - offset - st.start) / st.dur);
    $('fill').style.width = (p * 100).toFixed(1) + '%';
    $('fill').classList.toggle('soon', st.dur - (Date.now() - offset - st.start) < 500);
  } else if (st && st.running && st.dur === 0) {
    $('fill').style.width = '100%';
    $('fill').classList.remove('soon');
  }
  requestAnimationFrame(tick);
}

window.menu.on('rot:state', (s) => {
  offset = Date.now() - s.now;
  st = s;
  render();
});
requestAnimationFrame(tick);

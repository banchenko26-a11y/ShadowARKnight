// Интерфейс меню
const $ = (s) => document.querySelector(s);
const api = window.menu;

let state = null;          // { actions, defaults, config, bg, configPath }
let hotkeyErrors = {};     // action -> текст ошибки

// ---------- Вкладки ----------
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Уведомление внутри меню ----------
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- Перевод нажатия в формат Electron ("Ctrl+Shift+F5") ----------
const CODE_MAP = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', NumpadEnter: 'Enter',
  PrintScreen: 'PrintScreen', Pause: 'MediaPlayPause'
};
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
  return CODE_MAP[code] || null;
}
function toAccelerator(e) {
  const key = keyFromCode(e.code);
  if (!key) return null; // нажат только модификатор или неподдерживаемая клавиша
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}
const pretty = (accel) => accel ? accel.replace(/\+/g, ' + ') : 'не задана';

// ---------- Список горячих клавиш ----------
let listening = null; // action, для которого ждём комбинацию

function renderHotkeys() {
  const list = $('#hotkey-list');
  list.innerHTML = '';
  for (const [action, label] of Object.entries(state.actions)) {
    const accel = state.config.hotkeys[action];
    const row = document.createElement('div');
    row.className = 'hk' + (hotkeyErrors[action] ? ' error' : '');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;

    const kbd = document.createElement('kbd');
    if (listening === action) { kbd.className = 'listening'; kbd.textContent = 'Нажмите клавиши…'; }
    else { kbd.className = accel ? '' : 'empty'; kbd.textContent = pretty(accel); }

    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = listening === action ? 'Отмена' : 'Изменить';
    btn.addEventListener('click', () => listening === action ? stopListening() : startListening(action));

    row.append(name, kbd, btn);
    if (hotkeyErrors[action]) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = hotkeyErrors[action];
      row.append(err);
    }
    list.append(row);
  }
  renderQuick();
  if ($('#rot-keys')) renderRotKeys();
}

function startListening(action) {
  listening = action;
  api.suspendHotkeys();
  renderHotkeys();
}
function stopListening() {
  listening = null;
  api.resumeHotkeys();
  renderHotkeys();
}

window.addEventListener('keydown', async (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') return stopListening();

  let accel;
  if (e.code === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) accel = '';
  else accel = toAccelerator(e);
  if (accel === null) return; // ждём основную клавишу

  const action = listening;
  listening = null;
  const res = await api.setHotkey(action, accel); // главный процесс сам заново включит клавиши
  state.config.hotkeys = res.hotkeys;
  if (res.ok) delete hotkeyErrors[action];
  else hotkeyErrors[action] = res.error;
  renderHotkeys();
  if (res.ok) toast(accel ? `«${state.actions[action]}» → ${pretty(accel)}` : `Клавиша для «${state.actions[action]}» убрана`);
}, true);

$('#reset-hotkeys').addEventListener('click', async () => {
  state.config.hotkeys = await api.resetHotkeys();
  hotkeyErrors = {};
  renderHotkeys();
  toast('Горячие клавиши сброшены');
});

api.on('hotkeys:status', (failed) => {
  hotkeyErrors = {};
  for (const f of failed) hotkeyErrors[f.action] = `«${pretty(f.accel)}» занята другой программой — выберите другую`;
  if (state) renderHotkeys();
});

// ---------- Быстрые действия на главной ----------
function renderQuick() {
  const grid = $('#quick');
  grid.innerHTML = '';
  for (const [action, label] of Object.entries(state.actions)) {
    if (action === 'toggleMenu') continue;
    const b = document.createElement('button');
    b.className = 'tile';
    b.textContent = label;
    const k = document.createElement('kbd');
    const accel = state.config.hotkeys[action];
    k.className = accel ? '' : 'empty';
    k.textContent = pretty(accel);
    b.append(k);
    b.addEventListener('click', () => api.runAction(action));
    grid.append(b);
  }
}

// ---------- Таймер ----------
let timerLeft = 0, timerRunning = false, timerId = null;
const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
function timerDraw() {
  $('#timer-display').textContent = fmt(timerLeft);
  $('#timer-toggle').textContent = timerRunning ? 'Пауза' : 'Старт';
}
function timerReset() {
  clearInterval(timerId); timerRunning = false;
  timerLeft = Math.max(1, Number($('#timer-min').value) || 10) * 60;
  timerDraw();
}
function timerToggle() {
  if (timerRunning) { clearInterval(timerId); timerRunning = false; return timerDraw(); }
  if (timerLeft <= 0) timerReset();
  timerRunning = true;
  timerId = setInterval(() => {
    timerLeft--;
    if (timerLeft <= 0) {
      timerLeft = 0; clearInterval(timerId); timerRunning = false;
      api.notify('ShadowARK', 'Таймер завершён!');
      toast('⏰ Таймер завершён');
    }
    timerDraw();
  }, 1000);
  timerDraw();
  toast('Таймер запущен');
}
$('#timer-toggle').addEventListener('click', timerToggle);
$('#timer-reset').addEventListener('click', timerReset);
$('#timer-min').addEventListener('change', () => {
  api.patchConfig({ timerMinutes: Number($('#timer-min').value) || 10 });
  if (!timerRunning) timerReset();
});

// ---------- Заметки ----------
let notesTimer;
$('#notes').addEventListener('input', () => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => api.patchConfig({ notes: $('#notes').value }), 400);
});

// ---------- Настройки ----------
function drawOpacity(v) {
  $('#opacity').value = v;
  $('#opacity-val').textContent = Math.round(v * 100) + '%';
}
$('#opacity').addEventListener('input', (e) => api.setOpacity(e.target.value));
api.on('opacity', drawOpacity);

const setBg = (url) => { $('#bg').style.backgroundImage = url ? `url("${url}")` : ''; };
$('#bg-choose').addEventListener('click', async () => { const u = await api.chooseBg(); if (u) setBg(u); });
$('#bg-reset').addEventListener('click', async () => setBg(await api.resetBg()));

function renderLinks() {
  const box = $('#links');
  box.innerHTML = '';
  state.config.links.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'link-row';
    const name = Object.assign(document.createElement('input'), { value: l.name, placeholder: 'Название' });
    const url = Object.assign(document.createElement('input'), { value: l.url, placeholder: 'https://…' });
    const save = () => {
      state.config.links[i] = { name: name.value, url: url.value.trim() };
      api.patchConfig({ links: state.config.links });
    };
    name.addEventListener('change', save);
    url.addEventListener('change', save);
    row.append(name, url);
    box.append(row);
  });
}

// ---------- Карта и запуск с игрой ----------
function setupStartup() {
  const url = $('#map-url'), proc = $('#game-proc'), hide = $('#hide-console');
  url.value = state.config.mapUrl || state.defaultMapUrl;
  proc.value = state.config.gameProcess || '';
  hide.checked = state.config.hideConsole !== false;

  url.addEventListener('change', () => {
    const v = url.value.trim();
    if (!/^https?:\/\//i.test(v)) { toast('Ссылка должна начинаться с https://'); return; }
    api.patchConfig({ mapUrl: v });
    toast('Карта обновлена');
  });
  $('#map-default').addEventListener('click', () => {
    url.value = state.defaultMapUrl;
    api.patchConfig({ mapUrl: state.defaultMapUrl });
    toast('Вернул стандартную карту');
  });
  proc.addEventListener('change', () => {
    api.patchConfig({ gameProcess: proc.value.trim() });
    toast('Сохранено — сработает при следующем запуске');
  });
  hide.addEventListener('change', () => api.patchConfig({ hideConsole: hide.checked }));
}

// ---------- Ротации ----------
let rotations = [];
let rotActive = 0;
let rotLive = null;   // последнее состояние движка
let hudLocked = true;
let rotSaveTimer = null;

function rotSave(immediate) {
  clearTimeout(rotSaveTimer);
  const go = () => api.rotSave({ rotations, activeRotation: rotActive });
  if (immediate) go(); else rotSaveTimer = setTimeout(go, 300);
}
const curRot = () => rotations[rotActive];

function renderRotSelect() {
  const sel = $('#rot-select');
  sel.innerHTML = '';
  rotations.forEach((r, i) => sel.append(Object.assign(document.createElement('option'), { value: i, textContent: r.name || `Ротация ${i + 1}` })));
  sel.value = rotActive;
  const R = curRot();
  $('#rot-name').value = R ? R.name : '';
  $('#rot-loop').checked = !!(R && R.loop);
  ['#rot-name', '#rot-loop', '#rot-dup', '#rot-del', '#rot-step-add', '#rot-run'].forEach(s => $(s).disabled = !R);
}

function renderSteps() {
  const box = $('#rot-steps');
  box.innerHTML = '';
  const R = curRot();
  if (!R) { box.textContent = 'Нет ротаций — нажмите «+ Новая».'; return; }
  R.steps.forEach((st, i) => {
    const row = document.createElement('div');
    row.className = 'step' + (rotLive && rotLive.running && rotLive.index === rotActive && rotLive.s === i ? ' now' : '');
    const n = Object.assign(document.createElement('span'), { className: 'n', textContent: i + 1 });
    const mk = (field, attrs) => {
      const inp = Object.assign(document.createElement('input'), { value: st[field] ?? '', ...attrs });
      inp.addEventListener('input', () => {
        st[field] = field === 'wait' ? Math.max(0, Number(inp.value) || 0) : inp.value;
        rotSave();
      });
      return inp;
    };
    const key = mk('key', { className: 'key', placeholder: 'E', maxLength: 20 });
    const label = mk('label', { placeholder: 'Навык / комбо / ульта', maxLength: 60 });
    const wait = mk('wait', { type: 'number', min: 0, max: 120, step: 0.1 });
    const note = mk('note', { placeholder: 'необязательно', maxLength: 120 });
    const ops = Object.assign(document.createElement('div'), { className: 'ops' });
    const op = (txt, title, fn) => {
      const b = Object.assign(document.createElement('button'), { textContent: txt, title });
      b.addEventListener('click', () => { fn(); rotSave(true); renderSteps(); });
      ops.append(b);
    };
    op('↑', 'Выше', () => { if (i > 0) [R.steps[i - 1], R.steps[i]] = [R.steps[i], R.steps[i - 1]]; });
    op('↓', 'Ниже', () => { if (i < R.steps.length - 1) [R.steps[i + 1], R.steps[i]] = [R.steps[i], R.steps[i + 1]]; });
    op('✕', 'Удалить шаг', () => R.steps.splice(i, 1));
    row.append(n, key, label, wait, note, ops);
    box.append(row);
  });
}

function renderRotKeys() {
  const hk = state.config.hotkeys;
  const k = (a) => hk[a] ? pretty(hk[a]) : 'не задана';
  $('#rot-keys').textContent =
    `Клавиши: старт/стоп — ${k('rotToggle')}, следующий шаг — ${k('rotNext')}, назад — ${k('rotPrev')}, сменить команду — ${k('rotSwitch')}. ` +
    'Меняются во вкладке «Горячие клавиши». Не ставьте туда кнопки, которые нужны в игре: пока меню запущено, игра их не получит.';
}

function setupRotations() {
  rotations = structuredClone(state.config.rotations || []);
  rotActive = Math.min(state.config.activeRotation || 0, Math.max(0, rotations.length - 1));
  $('#rot-sound').checked = state.config.rotSound !== false;

  $('#rot-select').addEventListener('change', (e) => {
    rotActive = Number(e.target.value);
    rotSave(true); renderRotSelect(); renderSteps();
  });
  $('#rot-add').addEventListener('click', () => {
    rotations.push({ name: `Ротация ${rotations.length + 1}`, loop: true, steps: [{ key: '', label: '', wait: 1, note: '' }] });
    rotActive = rotations.length - 1;
    rotSave(true); renderRotSelect(); renderSteps();
    $('#rot-name').focus(); $('#rot-name').select();
  });
  $('#rot-dup').addEventListener('click', () => {
    const copy = structuredClone(curRot());
    copy.name = (copy.name || 'Ротация') + ' (копия)';
    rotations.splice(rotActive + 1, 0, copy);
    rotActive++;
    rotSave(true); renderRotSelect(); renderSteps();
  });
  $('#rot-del').addEventListener('click', () => {
    if (!curRot() || !confirmDelete()) return;
    rotations.splice(rotActive, 1);
    rotActive = Math.max(0, rotActive - 1);
    rotSave(true); renderRotSelect(); renderSteps();
  });
  $('#rot-name').addEventListener('input', (e) => {
    curRot().name = e.target.value;
    const opt = $('#rot-select').options[rotActive];
    if (opt) opt.textContent = e.target.value || `Ротация ${rotActive + 1}`;
    rotSave();
  });
  $('#rot-loop').addEventListener('change', (e) => { curRot().loop = e.target.checked; rotSave(true); });
  $('#rot-step-add').addEventListener('click', () => {
    curRot().steps.push({ key: '', label: '', wait: 1, note: '' });
    rotSave(true); renderSteps();
    const keys = document.querySelectorAll('#rot-steps .key');
    if (keys.length) keys[keys.length - 1].focus();
  });
  $('#rot-run').addEventListener('click', () => api.rotControl('rotToggle'));
  $('#rot-move').addEventListener('click', () => api.rotHudLock(!hudLocked));
  $('#rot-sound').addEventListener('change', (e) => api.rotSave({ rotSound: e.target.checked }));
  $('#rot-export').addEventListener('click', async () => {
    rotSave(true);
    const f = await api.rotExport();
    if (f) toast('Сохранено: ' + f);
  });
  $('#rot-import').addEventListener('click', async () => {
    const r = await api.rotImport();
    if (!r) return;
    if (!r.ok) return toast(r.error);
    rotations = r.rotations;
    rotActive = rotations.length - r.added;
    rotSave(true); renderRotSelect(); renderSteps();
    toast(`Добавлено ротаций: ${r.added}`);
  });

  renderRotSelect();
  renderSteps();
  renderRotKeys();
}

// Удаление без системного окна подтверждения: второй клик в течение 3 секунд
let delArmed = 0;
function confirmDelete() {
  if (Date.now() - delArmed < 3000) { delArmed = 0; $('#rot-del').textContent = 'Удалить'; return true; }
  delArmed = Date.now();
  $('#rot-del').textContent = 'Точно удалить?';
  setTimeout(() => { if (delArmed) $('#rot-del').textContent = 'Удалить'; }, 3000);
  return false;
}

api.on('rot:state', (s) => {
  rotLive = s;
  hudLocked = s.locked;
  $('#rot-run').textContent = s.running ? '■ Стоп' : '▶ Старт';
  $('#rot-move').textContent = s.locked ? 'Переместить подсказку' : '✓ Закрепить подсказку';
  if (s.index !== rotActive && !document.activeElement.closest?.('#tab-rotation')) {
    rotActive = s.index; renderRotSelect(); renderSteps();
  }
  // Подсвечиваем текущий шаг, не пересоздавая поля (чтобы не сбивать ввод)
  document.querySelectorAll('#rot-steps .step').forEach((row, i) =>
    row.classList.toggle('now', !!(s.running && s.index === rotActive && s.s === i)));
});

// ---------- Окно ----------
function setCompact(on) {
  state.config.compact = on;
  $('#app').classList.toggle('compact', on);
  api.patchConfig({ compact: on });
}
$('#btn-compact').addEventListener('click', () => setCompact(!state.config.compact));
$('#btn-hide').addEventListener('click', () => api.hide());
$('#btn-quit').addEventListener('click', () => api.quit());

// ---------- События от главного процесса ----------
api.on('action', (action) => {
  if (action === 'timerToggle') timerToggle();
  else if (action === 'timerReset') { timerReset(); toast('Таймер сброшен'); }
  else if (action === 'openNotes') { showTab('notes'); $('#notes').focus(); }
  else if (action === 'compactMode') setCompact(!state.config.compact);
});
api.on('toast', toast);
api.on('clickthrough', (on) => {
  $('#click-badge').classList.toggle('hidden', !on);
  toast(on ? 'Клики проходят сквозь меню в игру' : 'Меню снова кликабельно');
});
api.on('stats', (s) => {
  $('#cpu').textContent = `ЦП ${s.cpu}%`;
  $('#ram').textContent = `ОЗУ ${s.ramUsedGb}/${s.ramTotalGb} ГБ`;
});

// ---------- Старт ----------
(async () => {
  state = await api.init();
  setBg(state.bg);
  drawOpacity(state.config.opacity);
  $('#notes').value = state.config.notes || '';
  $('#timer-min').value = state.config.timerMinutes || 10;
  $('#app').classList.toggle('compact', !!state.config.compact);
  $('#config-path').textContent = 'Настройки хранятся в: ' + state.configPath;
  timerReset();
  renderLinks();
  setupStartup();
  setupRotations();
  renderHotkeys();
})();

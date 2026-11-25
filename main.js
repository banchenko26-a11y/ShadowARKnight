// Endfield Menu — главный процесс Electron.
// Отдельные окна поверх игры. В память игры и её файлы НЕ лезет:
// игру только «видит» по списку процессов Windows (как Диспетчер задач).
const {
  app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, screen,
  desktopCapturer, dialog, shell, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

// ---------- Действия, которые можно повесить на клавиши ----------
const ACTIONS = {
  toggleMenu:      { label: 'Показать / скрыть меню',          def: 'F8' },
  toggleMap:       { label: 'Интерактивная карта',             def: 'Ctrl+M' },
  toggleClick:     { label: 'Клики сквозь меню (вкл/выкл)',    def: 'F9' },
  screenshot:      { label: 'Скриншот экрана',                 def: 'F10' },
  timerToggle:     { label: 'Таймер: старт / пауза',           def: 'F6' },
  timerReset:      { label: 'Таймер: сброс',                   def: 'Shift+F6' },
  openNotes:       { label: 'Открыть заметки',                 def: 'F7' },
  openLink1:       { label: 'Открыть ссылку №1',               def: 'Ctrl+1' },
  openLink2:       { label: 'Открыть ссылку №2',               def: 'Ctrl+2' },
  opacityUp:       { label: 'Прозрачность окон −',             def: 'Ctrl+Up' },
  opacityDown:     { label: 'Прозрачность окон +',             def: 'Ctrl+Down' },
  compactMode:     { label: 'Компактный режим',                def: 'Ctrl+F8' }
};

const DEFAULT_MAP_URL = 'https://game8.co/games/Arknights-Endfield/archives/533176';

// ---------- Конфиг ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  hotkeys: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.def])),
  opacity: 0.95,
  bgPath: null,                    // null = стандартный фон из CSS
  notes: '',
  timerMinutes: 10,
  links: [
    { name: 'Ссылка 1', url: '' },
    { name: 'Ссылка 2', url: '' }
  ],
  mapUrl: DEFAULT_MAP_URL,
  gameProcess: '',                 // '' = искать автоматически (имя содержит «endfield»)
  hideConsole: true,               // прятать консоль, когда игра найдена
  bounds: null,
  mapBounds: null,
  compact: false
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG, ...raw,
      hotkeys: { ...DEFAULT_CONFIG.hotkeys, ...(raw.hotkeys || {}) }
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
let config = loadConfig();
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) { console.error('Не удалось сохранить конфиг:', e); }
  }, 300);
}

const PRELOAD = path.join(__dirname, 'preload.js');
const SECURE = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };

// ---------- Консоль-загрузчик ----------
let consoleWin = null;
const consoleLog = [];
function log(text, kind = 'info') {
  const line = { text, kind, time: new Date().toLocaleTimeString('ru-RU') };
  consoleLog.push(line);
  if (consoleLog.length > 300) consoleLog.shift();
  if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('console:line', line);
}

function createConsole() {
  consoleWin = new BrowserWindow({
    width: 680, height: 400, minWidth: 420, minHeight: 240,
    title: 'Endfield Menu — консоль',
    backgroundColor: '#0c0c0c',
    autoHideMenuBar: true,
    webPreferences: SECURE
  });
  consoleWin.setMenu(null);
  consoleWin.loadFile(path.join(__dirname, 'src', 'console.html'));
  // Закрыли консоль до запуска игры — выходим из программы целиком
  consoleWin.on('close', () => { if (!gamePid) app.quit(); });
}

// ---------- Меню ----------
let win = null;
let clickThrough = false;

function createMenu() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = config.bounds || { width: 900, height: 560, x: wa.x + 60, y: wa.y + 60 };

  win = new BrowserWindow({
    ...b,
    show: false,
    minWidth: 360, minHeight: 240,
    frame: false, transparent: true, resizable: true,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: SECURE
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(config.opacity);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  const remember = () => { if (!win.isDestroyed()) { config.bounds = win.getBounds(); saveConfig(); } };
  win.on('moved', remember);
  win.on('resized', remember);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Интерактивная карта ----------
// Окно = наша панель сверху (map.html) + сайт карты под ней (WebContentsView).
const MAP_BAR = 36;
let mapWin = null;
let mapView = null;

function layoutMap() {
  if (!mapWin || mapWin.isDestroyed()) return;
  const [w, h] = mapWin.getContentSize();
  mapView.setBounds({ x: 0, y: MAP_BAR, width: w, height: Math.max(0, h - MAP_BAR) });
}

function createMap() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = config.mapBounds || {
    width: Math.round(wa.width * 0.55), height: Math.round(wa.height * 0.7),
    x: wa.x + Math.round(wa.width * 0.4), y: wa.y + 40
  };
  mapWin = new BrowserWindow({
    ...b,
    show: false,
    minWidth: 360, minHeight: 260,
    frame: false, resizable: true,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#111311',
    webPreferences: SECURE
  });
  mapWin.setAlwaysOnTop(true, 'screen-saver');
  mapWin.setOpacity(config.opacity);
  mapWin.loadFile(path.join(__dirname, 'src', 'map.html'));

  mapView = new WebContentsView({
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: 'persist:map' // вход на сайте карты и отметки сохраняются
    }
  });
  mapWin.contentView.addChildView(mapView);
  layoutMap();
  mapWin.on('resize', layoutMap);

  const wc = mapView.webContents;
  // Ссылки «в новом окне» открываем прямо в карте
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  const status = () => {
    if (mapWin.isDestroyed()) return;
    mapWin.webContents.send('map:state', {
      url: wc.getURL(), title: wc.getTitle(),
      canBack: wc.navigationHistory.canGoBack(), loading: wc.isLoading()
    });
  };
  ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']
    .forEach(ev => wc.on(ev, status));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) mapWin.webContents.send('map:error', `Не удалось открыть карту (${desc}). Проверьте интернет или ссылку в «Настройках».`);
  });
  mapWin.webContents.on('did-finish-load', status);
  wc.loadURL(config.mapUrl || DEFAULT_MAP_URL);

  const remember = () => { if (!mapWin.isDestroyed()) { config.mapBounds = mapWin.getBounds(); saveConfig(); } };
  mapWin.on('moved', remember);
  mapWin.on('resized', remember);
}

function toggleMap() {
  if (!mapWin || mapWin.isDestroyed()) createMap();
  if (mapWin.isVisible()) mapWin.hide();
  else mapWin.show(); // с фокусом — чтобы сразу можно было листать карту
}

// ---------- Горячие клавиши ----------
function runAction(action) {
  switch (action) {
    case 'toggleMenu':
      if (win.isVisible()) win.hide(); else win.showInactive();
      break;
    case 'toggleMap':   toggleMap(); break;
    case 'toggleClick': setClickThrough(!clickThrough); break;
    case 'screenshot':  takeScreenshot(); break;
    case 'opacityUp':   setOpacity(config.opacity - 0.1); break;
    case 'opacityDown': setOpacity(config.opacity + 0.1); break;
    case 'openLink1':   openLink(0); break;
    case 'openLink2':   openLink(1); break;
    case 'openNotes':
      if (!win.isVisible()) win.showInactive();
      send('action', action);
      break;
    default:
      send('action', action); // таймер, компактный режим — обрабатывает интерфейс
  }
}

let hotkeysOn = false;
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeysOn = true;
  const failed = [];
  for (const [action, accel] of Object.entries(config.hotkeys)) {
    if (!accel || !ACTIONS[action]) continue;
    try {
      if (!globalShortcut.register(accel, () => runAction(action))) failed.push({ action, accel });
    } catch {
      failed.push({ action, accel });
    }
  }
  send('hotkeys:status', failed);
  return failed;
}

// ---------- Функции ----------
function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  send('clickthrough', on);
}

function setOpacity(v) {
  config.opacity = Math.min(1, Math.max(0.2, Math.round(v * 100) / 100));
  win.setOpacity(config.opacity);
  if (mapWin && !mapWin.isDestroyed()) mapWin.setOpacity(config.opacity);
  send('opacity', config.opacity);
  saveConfig();
}

function openLink(i) {
  const url = (config.links[i] || {}).url || '';
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  else send('toast', `Ссылка №${i + 1} не задана — впишите её в «Настройках»`);
}

async function takeScreenshot() {
  const wasVisible = win.isVisible();
  const mapVisible = mapWin && !mapWin.isDestroyed() && mapWin.isVisible();
  try {
    if (wasVisible) win.hide();
    if (mapVisible) mapWin.hide();
    await new Promise(r => setTimeout(r, 180)); // даём окнам исчезнуть с экрана
    const d = screen.getPrimaryDisplay();
    const size = {
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor)
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    if (!sources.length) throw new Error('экран не найден');
    const dir = path.join(app.getPath('pictures'), 'EndfieldMenu');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `endfield_${stamp}.png`);
    fs.writeFileSync(file, sources[0].thumbnail.toPNG());
    send('toast', `Скриншот сохранён: ${file}`);
  } catch (e) {
    send('toast', 'Скриншот не получился: ' + e.message);
  } finally {
    if (wasVisible) win.showInactive();
    if (mapVisible) mapWin.showInactive();
  }
}

// Загрузка ЦП и ОЗУ компьютера
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    const dt = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
    total += dt; idle += t.idle - p.idle;
  });
  lastCpu = now;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const used = os.totalmem() - os.freemem();
  send('stats', {
    cpu: cpuPercent(),
    ramUsedGb: +(used / 1024 ** 3).toFixed(1),
    ramTotalGb: +(os.totalmem() / 1024 ** 3).toFixed(1)
  });
}, 2000);

function bgUrl() {
  if (config.bgPath && fs.existsSync(config.bgPath)) return pathToFileURL(config.bgPath).href;
  return null;
}

// ---------- Слежение за игрой ----------
// Пока игры нет — раз в секунду смотрим список процессов.
// Когда нашли — каждые 250 мс проверяем, жив ли её процесс, и сразу закрываемся, когда он пропал.
let gamePid = null;
let gameName = '';
let searchTimer = null;
let aliveTimer = null;
let menuOpenedManually = false;

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        resolve(out.split(/\r?\n/).map(l => {
          const m = l.match(/^"([^"]+)","(\d+)"/);
          return m ? { name: m[1], pid: Number(m[2]) } : null;
        }).filter(Boolean));
      });
    } else {
      execFile('ps', ['-A', '-o', 'pid=,comm='], (err, out) => {
        if (err) return resolve([]);
        resolve(out.split('\n').map(l => {
          const m = l.trim().match(/^(\d+)\s+(.+)$/);
          return m ? { name: path.basename(m[2]), pid: Number(m[1]) } : null;
        }).filter(Boolean));
      });
    }
  });
}

function isGame(p) {
  if (p.pid === process.pid) return false;
  const n = p.name.toLowerCase();
  const want = (config.gameProcess || '').trim().toLowerCase();
  if (want) return n === want || n === want + '.exe';
  // Авто: имя содержит «endfield», но это не мы сами и не лаунчер
  return n.includes('endfield') && !n.includes('menu') && !n.includes('launcher')
    && !n.includes('gryphlink') && !n.includes('crash') && !n.includes('electron');
}

function startSearch() {
  clearInterval(searchTimer);
  const target = config.gameProcess ? `«${config.gameProcess}»` : 'процесс с «Endfield» в имени';
  log(`Ожидаю запуск игры: ищу ${target}…`, 'wait');
  log('Запустите Arknights: Endfield — меню появится само.', 'hint');
  let busy = false;
  searchTimer = setInterval(async () => {
    if (busy || gamePid) return;
    busy = true;
    const found = (await listProcesses()).find(isGame);
    busy = false;
    if (found) onGameFound(found);
  }, 1000);
}

function onGameFound(p) {
  clearInterval(searchTimer);
  gamePid = p.pid;
  gameName = p.name;
  log(`Игра найдена: ${p.name} (PID ${p.pid})`, 'ok');
  log('Загрузка меню… готово', 'ok');
  const hk = config.hotkeys.toggleMenu ? ` Меню: ${config.hotkeys.toggleMenu}.` : '';
  const mk = config.hotkeys.toggleMap ? ` Карта: ${config.hotkeys.toggleMap}.` : '';
  log(`Меню работает поверх игры.${hk}${mk}`, 'hint');
  log('Когда закроете игру, меню закроется само.', 'hint');

  win.showInactive();
  if (config.hideConsole && consoleWin && !consoleWin.isDestroyed()) {
    setTimeout(() => { if (!consoleWin.isDestroyed()) consoleWin.hide(); }, 1500);
  }

  aliveTimer = setInterval(() => {
    try {
      process.kill(gamePid, 0); // сигнал 0 ничего не делает с процессом — только проверяет, что он есть
    } catch (e) {
      if (e.code === 'EPERM') return; // процесс есть, просто запущен от администратора
      clearInterval(aliveTimer);
      log(`Игра закрыта (${gameName}). Выход.`, 'warn');
      app.exit(0); // моментально, без лишних обработчиков
    }
  }, 250);
}

// ---------- IPC ----------
ipcMain.handle('init', () => ({
  actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label])),
  defaults: DEFAULT_CONFIG.hotkeys,
  config,
  bg: bgUrl(),
  configPath: CONFIG_PATH,
  defaultMapUrl: DEFAULT_MAP_URL
}));

ipcMain.handle('hotkeys:set', (_e, action, accel) => {
  if (!ACTIONS[action]) return { ok: false, error: 'неизвестное действие' };
  for (const [a, k] of Object.entries(config.hotkeys)) {
    if (a !== action && accel && k === accel) config.hotkeys[a] = '';
  }
  config.hotkeys[action] = accel || '';
  saveConfig();
  const failed = registerHotkeys();
  const bad = failed.find(f => f.action === action);
  return { ok: !bad, hotkeys: config.hotkeys,
    error: bad ? 'Эта комбинация занята другой программой или системой' : null };
});
ipcMain.handle('hotkeys:reset', () => {
  config.hotkeys = { ...DEFAULT_CONFIG.hotkeys };
  saveConfig();
  registerHotkeys();
  return config.hotkeys;
});
// Пока пользователь нажимает новую комбинацию, глобальные клавиши отключены
ipcMain.on('hotkeys:suspend', () => { globalShortcut.unregisterAll(); hotkeysOn = false; });
ipcMain.on('hotkeys:resume', () => registerHotkeys());

ipcMain.on('config:patch', (_e, patch) => {
  const allowed = ['notes', 'timerMinutes', 'links', 'compact', 'mapUrl', 'gameProcess', 'hideConsole'];
  for (const k of allowed) if (k in patch) config[k] = patch[k];
  saveConfig();
  if ('mapUrl' in patch && mapView && /^https?:\/\//i.test(patch.mapUrl)) mapView.webContents.loadURL(patch.mapUrl);
});
ipcMain.on('opacity:set', (_e, v) => setOpacity(Number(v)));
ipcMain.on('action', (_e, action) => runAction(action));

ipcMain.handle('bg:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Картинка для фона меню',
    filters: [{ name: 'Картинки', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  config.bgPath = r.filePaths[0];
  saveConfig();
  return bgUrl();
});
ipcMain.handle('bg:reset', () => { config.bgPath = null; saveConfig(); return bgUrl(); });

ipcMain.on('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});
ipcMain.on('window:hide', () => win.hide());
ipcMain.on('window:quit', () => app.quit());

// Консоль
ipcMain.handle('console:history', () => consoleLog);
ipcMain.on('console:openMenu', () => {
  menuOpenedManually = true;
  log('Меню открыто без игры (тестовый режим).', 'warn');
  win.showInactive();
});
ipcMain.on('console:quit', () => app.quit());

// Карта
ipcMain.on('map:cmd', (_e, cmd) => {
  if (!mapView) return;
  const wc = mapView.webContents;
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'reload') wc.reload();
  if (cmd === 'home') wc.loadURL(config.mapUrl || DEFAULT_MAP_URL);
  if (cmd === 'browser' && /^https?:\/\//i.test(wc.getURL())) shell.openExternal(wc.getURL());
  if (cmd === 'hide') mapWin.hide();
});

// ---------- Запуск ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (gamePid) win.showInactive();
    else if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); }
  });
  app.whenReady().then(() => {
    createMenu();
    createConsole();
    log(`Endfield Menu v${app.getVersion()}`, 'title');
    log('В игру не внедряется: только окна поверх неё.', 'hint');
    win.webContents.once('did-finish-load', () => {
      const failed = registerHotkeys();
      log(failed.length
        ? `Горячие клавиши: ${failed.length} заняты другими программами — поменяйте их в меню.`
        : 'Горячие клавиши зарегистрированы.', failed.length ? 'warn' : 'ok');
      startSearch();
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}

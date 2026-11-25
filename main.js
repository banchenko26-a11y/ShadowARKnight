// Endfield Menu — главный процесс Electron.
// Отдельное окно поверх игры. В память игры и её файлы НЕ лезет.
const {
  app, BrowserWindow, globalShortcut, ipcMain, screen,
  desktopCapturer, dialog, shell, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// ---------- Действия, которые можно повесить на клавиши ----------
const ACTIONS = {
  toggleMenu:      { label: 'Показать / скрыть меню',          def: 'F8' },
  toggleClick:     { label: 'Клики сквозь меню (вкл/выкл)',    def: 'F9' },
  screenshot:      { label: 'Скриншот экрана',                 def: 'F10' },
  timerToggle:     { label: 'Таймер: старт / пауза',           def: 'F6' },
  timerReset:      { label: 'Таймер: сброс',                   def: 'Shift+F6' },
  openNotes:       { label: 'Открыть заметки',                 def: 'F7' },
  openLink1:       { label: 'Открыть ссылку №1',               def: 'Ctrl+1' },
  openLink2:       { label: 'Открыть ссылку №2',               def: 'Ctrl+2' },
  opacityUp:       { label: 'Прозрачность меню −',             def: 'Ctrl+Up' },
  opacityDown:     { label: 'Прозрачность меню +',             def: 'Ctrl+Down' },
  compactMode:     { label: 'Компактный режим',                def: 'Ctrl+F8' }
};

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
  bounds: null,
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

// ---------- Окно ----------
let win = null;
let clickThrough = false;

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = config.bounds || { width: 900, height: 560, x: wa.x + 60, y: wa.y + 60 };

  win = new BrowserWindow({
    ...b,
    minWidth: 360, minHeight: 240,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // Уровень «screen-saver» держит окно над игрой в оконном/безрамочном режиме
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(config.opacity);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  const rememberBounds = () => {
    if (!win.isDestroyed()) { config.bounds = win.getBounds(); saveConfig(); }
  };
  win.on('moved', rememberBounds);
  win.on('resized', rememberBounds);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Горячие клавиши ----------
function runAction(action) {
  switch (action) {
    case 'toggleMenu':
      if (win.isVisible()) win.hide(); else { win.showInactive(); }
      break;
    case 'toggleClick':
      setClickThrough(!clickThrough);
      break;
    case 'screenshot':
      takeScreenshot();
      break;
    case 'opacityUp':
      setOpacity(config.opacity - 0.1);
      break;
    case 'opacityDown':
      setOpacity(config.opacity + 0.1);
      break;
    case 'openLink1': openLink(0); break;
    case 'openLink2': openLink(1); break;
    case 'openNotes':
      if (!win.isVisible()) win.showInactive();
      send('action', action);
      break;
    default:
      send('action', action); // таймер, компактный режим — обрабатывает интерфейс
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accel] of Object.entries(config.hotkeys)) {
    if (!accel || !ACTIONS[action]) continue;
    try {
      const ok = globalShortcut.register(accel, () => runAction(action));
      if (!ok) failed.push({ action, accel });
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
  try {
    if (wasVisible) win.hide();
    await new Promise(r => setTimeout(r, 180)); // даём меню исчезнуть с экрана
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
  const used = os.totalmem() - os.freemem();
  send('stats', {
    cpu: cpuPercent(),
    ramUsedGb: +(used / 1024 ** 3).toFixed(1),
    ramTotalGb: +(os.totalmem() / 1024 ** 3).toFixed(1)
  });
}, 2000);

function bgUrl() {
  // Свою картинку каждый выбирает сам в «Настройках»; путь хранится в его конфиге.
  if (config.bgPath && fs.existsSync(config.bgPath)) return pathToFileURL(config.bgPath).href;
  return null; // стандартный фон из styles.css
}

// ---------- IPC ----------
ipcMain.handle('init', () => ({
  actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label])),
  defaults: DEFAULT_CONFIG.hotkeys,
  config,
  bg: bgUrl(),
  configPath: CONFIG_PATH
}));

ipcMain.handle('hotkeys:set', (_e, action, accel) => {
  if (!ACTIONS[action]) return { ok: false, error: 'неизвестное действие' };
  // одна комбинация — одно действие
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
// Пока пользователь нажимает новую комбинацию, глобальные клавиши отключены,
// иначе нажатие сразу сработает как старое действие.
ipcMain.on('hotkeys:suspend', () => globalShortcut.unregisterAll());
ipcMain.on('hotkeys:resume', () => registerHotkeys());

ipcMain.on('config:patch', (_e, patch) => {
  const allowed = ['notes', 'timerMinutes', 'links', 'compact'];
  for (const k of allowed) if (k in patch) config[k] = patch[k];
  saveConfig();
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

// ---------- Запуск ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) win.showInactive(); });
  app.whenReady().then(() => {
    createWindow();
    win.webContents.once('did-finish-load', () => registerHotkeys());
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}

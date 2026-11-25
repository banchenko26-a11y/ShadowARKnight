const out = document.getElementById('out');
const api = window.menu;
const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });

function add({ text, kind, time }) {
  const line = document.createElement('div');
  const t = Object.assign(document.createElement('span'), { className: 't', textContent: `[${time}] ` });
  const m = Object.assign(document.createElement('span'), { className: kind || 'info' });
  m.textContent = (kind === 'ok' ? '[OK] ' : kind === 'warn' ? '[!] ' : kind === 'wait' ? '> ' : '') + text;
  line.append(t, m);
  out.insertBefore(line, cursor);
  out.scrollTop = out.scrollHeight;
}

out.append(cursor);
api.consoleHistory().then(lines => lines.forEach(add));
api.on('console:line', add);

document.getElementById('open').addEventListener('click', () => api.openMenuWithoutGame());
document.getElementById('quit').addEventListener('click', () => api.consoleQuit());

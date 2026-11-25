const api = window.menu;
const $ = (id) => document.getElementById(id);

['back', 'reload', 'home', 'browser'].forEach(cmd => $(cmd).addEventListener('click', () => api.mapCmd(cmd)));
$('close').addEventListener('click', () => api.mapCmd('hide'));

api.on('map:state', (s) => {
  $('err').hidden = true;
  $('back').disabled = !s.canBack;
  $('reload').innerHTML = s.loading ? '<span class="spin">⟳</span>' : '⟳';
  $('page').textContent = s.loading ? 'загрузка…' : (s.title || s.url);
});
api.on('map:error', (text) => {
  $('err').textContent = text;
  $('err').hidden = false;
});

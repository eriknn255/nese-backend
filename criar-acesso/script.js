const BASE_API = 'https://nese-be.ruexinternet.com/api/admin';
const ENDPOINT_STATUS = `${BASE_API}/bootstrap/status`;
const ENDPOINT_CONTAS = `${BASE_API}/contas`;

function mostrarBloqueio() {
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('form').hidden = true;
  document.getElementById('status-bloqueado').hidden = false;
}

function mostrarFormulario() {
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('status-bloqueado').hidden = true;
  document.getElementById('form').hidden = false;
}

function mostrarMensagem(texto, ehErro) {
  const el = document.getElementById('msg');
  el.textContent = texto;
  el.classList.toggle('msg-erro', !!ehErro);
  el.hidden = false;
}

async function verificarRede() {
  try {
    const res = await fetch(ENDPOINT_STATUS);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.permitido) return mostrarBloqueio();
    mostrarFormulario();
  } catch (e) {
    mostrarBloqueio();
  }
}

document.getElementById('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = document.getElementById('btn');
  btn.disabled = true;

  try {
    const res = await fetch(ENDPOINT_CONTAS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': document.getElementById('token').value.trim()
      },
      body: JSON.stringify({
        nome: document.getElementById('nome').value.trim(),
        email: document.getElementById('email').value.trim(),
        senha: document.getElementById('senha').value,
        nivel: document.getElementById('nivel').value
      })
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 404) return mostrarBloqueio();
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    mostrarMensagem('OK', false);
    document.getElementById('form').reset();
  } catch (e) {
    mostrarMensagem(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

const THEME_KEY = '_t';

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('theme-icon').textContent = '☀️';
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('theme-icon').textContent = '🌙';
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (e) {}
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
}

document.getElementById('theme-btn').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (e) {}
});

initTheme();
verificarRede();

const BASE_API = 'https://nese-be.ruexinternet.com/api/admin';
const ENDPOINT_STATUS = `${BASE_API}/bootstrap/status`;
const ENDPOINT_CONTAS = `${BASE_API}/contas`;

// Bloqueado = a página se apaga e vira um 404. Não mostra caixa, aviso
// nem título: qualquer texto próprio já confirmaria que existe ALGO aqui.
//
// LIMITE HONESTO DISTO: o arquivo é estático servido pelo Nginx, então o
// navegador JÁ recebeu 200 + HTML antes deste código rodar. O que se
// troca é só o que aparece na tela — na aba Network continua 200. Pra um
// 404 de verdade, o HTML precisaria ser servido pelo Node atrás do mesmo
// middleware que guarda POST /contas.
//
// Na prática isso cobre o visitante casual e o robô de varredura, que
// leem a página renderizada. Não engana quem inspeciona a resposta.
//
// A marcação replica a página de erro padrão do Nginx de propósito: um
// 404 "estilizado" chamaria mais atenção do que o genérico.
function mostrarBloqueio() {
  document.title = '404 Not Found';
  document.documentElement.innerHTML =
    '<head><title>404 Not Found</title></head>' +
    '<body style="background:#fff;color:#000;font-family:sans-serif;margin:0">' +
    '<center><h1>404 Not Found</h1></center><hr><center>nginx</center>' +
    '</body>';
}

function mostrarFormulario() {
  // Só aqui a página se revela: caixa, título, tema e formulário saem do
  // hidden. Antes disso o documento é uma tela vazia — quem não passa na
  // verificação nunca vê nenhum deles.
  document.getElementById('caixa').hidden = false;
  document.getElementById('theme-btn').hidden = false;
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('titulo').hidden = false;
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

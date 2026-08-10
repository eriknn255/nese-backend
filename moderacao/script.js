// ==========================================================================
// MODERAÇÃO — CRUD irrestrito de usuários/prestadores (ver rotas
// /api/admin/moderacao/* em admin.js). Página separada do dashboard de
// métricas (index.html/script.js, que é só leitura) — reaproveita o
// MESMO style.css e o MESMO token (TOKEN_KEY abaixo tem que bater
// exatamente com o de script.js, é assim que "logar uma vez, usar nos
// dois" funciona: os dois lêem/escrevem a mesma chave do localStorage).
// ==========================================================================

const BASE_API = 'https://nese-be.ruexinternet.com/api/admin';
const ENDPOINT_USUARIOS = `${BASE_API}/dashboard/usuarios`;
const ENDPOINT_USUARIO_DETALHE_BASE = `${BASE_API}/dashboard/usuarios/`;
const ENDPOINT_MODERACAO_USUARIOS = `${BASE_API}/moderacao/usuarios/`;
const ENDPOINT_MODERACAO_PRESTADORES = `${BASE_API}/moderacao/prestadores`;

// Mesma origem do backend, pra resolver avatar customizado (caminho
// relativo) — mesmo raciocínio de resolverAvatarUrl em script.js.
const BACKEND_ORIGIN = new URL(BASE_API).origin;

function resolverAvatarUrl(avatarEfetivo) {
  if (!avatarEfetivo) return null;
  if (/^https?:\/\//i.test(avatarEfetivo)) return avatarEfetivo;
  return BACKEND_ORIGIN + avatarEfetivo;
}

// ---- Token de admin (MESMA chave que script.js — compartilhado entre as duas páginas) ----
const TOKEN_KEY = 'mase-admin-token';

function getToken() {
  const campo = document.getElementById('admin-token').value.trim();
  if (campo) return campo;
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function initTokenField() {
  let saved = '';
  try {
    saved = localStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    // localStorage indisponível nesta sessão — segue sem preencher
  }
  if (saved) {
    document.getElementById('admin-token').value = saved;
    document.getElementById('remember-token').checked = true;
  }
}

document.getElementById('token-save-btn').addEventListener('click', () => {
  const lembrar = document.getElementById('remember-token').checked;
  const valor = document.getElementById('admin-token').value.trim();
  try {
    if (lembrar && valor) {
      localStorage.setItem(TOKEN_KEY, valor);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (e) {
    // sem persistência disponível nesta sessão
  }
  carregarAbaAtiva();
});

// ---- Utilidades (mesmo padrão de script.js) ----

function formatarDataExata(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto == null ? '' : String(texto);
  return div.innerHTML;
}

function filtrarLinhas(linhas, textoBusca, campos) {
  const termo = textoBusca.trim().toLowerCase();
  if (!termo) return linhas;
  return linhas.filter(linha =>
    campos.some(campo => String(linha[campo] ?? '').toLowerCase().includes(termo))
  );
}

function mostrarErro(mensagem) {
  const banner = document.getElementById('error-banner');
  banner.textContent = mensagem;
  banner.hidden = false;
}

function limparErro() {
  const banner = document.getElementById('error-banner');
  banner.hidden = true;
  banner.textContent = '';
}

async function chamarApi(url, opcoes = {}) {
  const token = getToken();
  if (!token) {
    throw new Error('Preencha o token de admin acima pra carregar.');
  }
  const res = await fetch(url, {
    ...opcoes,
    headers: {
      'X-Admin-Token': token,
      ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opcoes.headers || {})
    }
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.erro || `Erro ${res.status} ao chamar a API.`);
  }
  return data;
}

// ==========================================================================
// ABAS — só duas por enquanto (Usuários / Prestadores), mesmo padrão
// data-aba do dashboard, versão simplificada (sem sidebar retrátil).
// ==========================================================================

const TITULOS_ABA = {
  usuarios: 'Usuários',
  prestadores: 'Prestadores'
};

function ativarAba(aba) {
  document.querySelectorAll('.sidebar-link[data-aba]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.aba === aba);
  });
  document.querySelectorAll('.aba-conteudo').forEach(secao => {
    secao.hidden = secao.id !== `aba-${aba}`;
  });
  document.getElementById('aba-titulo').textContent = TITULOS_ABA[aba] || aba;
  carregarAbaAtiva();
}

document.querySelectorAll('.sidebar-link[data-aba]').forEach(btn => {
  btn.addEventListener('click', () => ativarAba(btn.dataset.aba));
});

function abaAtiva() {
  const ativo = document.querySelector('.sidebar-link[data-aba].active');
  return ativo ? ativo.dataset.aba : 'usuarios';
}

function carregarAbaAtiva() {
  limparErro();
  const aba = abaAtiva();
  if (aba === 'usuarios') carregarUsuarios();
  if (aba === 'prestadores') carregarPrestadores();
}

// ==========================================================================
// USUÁRIOS
// ==========================================================================

let usuariosListaCompleta = [];
const usuariosCarregados = {};

async function carregarUsuarios() {
  try {
    const data = await chamarApi(ENDPOINT_USUARIOS);
    usuariosListaCompleta = data.usuarios || [];
    usuariosListaCompleta.forEach(u => { usuariosCarregados[u.id] = u; });
    aplicarFiltroUsuarios();
    document.getElementById('last-update').textContent = 'última atualização: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    mostrarErro(`Não foi possível carregar usuários (${e.message}).`);
    document.getElementById('usuarios-tbody').innerHTML =
      `<tr><td colspan="6" class="empty-state">${escaparHtml(e.message)}</td></tr>`;
  }
}

function aplicarFiltroUsuarios() {
  const termo = document.getElementById('usuarios-busca').value;
  const filtrados = filtrarLinhas(usuariosListaCompleta, termo, ['nome', 'email', 'id']);
  renderUsuarios(filtrados);
}

document.getElementById('usuarios-busca').addEventListener('input', aplicarFiltroUsuarios);

function renderUsuarios(usuarios) {
  const tbody = document.getElementById('usuarios-tbody');

  if (!usuarios || usuarios.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum usuário encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = usuarios.map(u => {
    const avatar = resolverAvatarUrl(u.avatarEfetivo);
    return `
      <tr class="clickable-row" data-id="${escaparHtml(u.id)}">
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            ${avatar ? `<img src="${escaparHtml(avatar)}" alt="" width="28" height="28" style="border-radius:50%; object-fit:cover; flex-shrink:0;">` : ''}
            <div>
              <div>${escaparHtml(u.nome)}</div>
              <div class="last-seen" style="opacity:0.7;">${escaparHtml(u.email || '—')}</div>
            </div>
          </div>
        </td>
        <td class="id-mono">${escaparHtml(u.id)}</td>
        <td>—</td>
        <td>—</td>
        <td>${u.totalPrestadores ?? 0}</td>
        <td>${formatarDataExata(u.criadoEm)}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr.clickable-row').forEach(tr => {
    tr.addEventListener('click', () => abrirEdicaoUsuario(tr.dataset.id));
  });
}

async function abrirEdicaoUsuario(id) {
  abrirModal('Editar usuário');
  const corpo = document.getElementById('modal-body');
  corpo.innerHTML = '<div class="empty-state">carregando…</div>';

  try {
    const data = await chamarApi(`${ENDPOINT_USUARIO_DETALHE_BASE}${id}`);
    const u = data.usuario;

    corpo.innerHTML = `
      <form id="form-editar-usuario">
        <div class="modal-grid" style="grid-template-columns: 1fr;">
          <div>
            <div class="modal-field-label">ID</div>
            <div class="modal-field-value id-mono">${escaparHtml(u.id)}</div>
          </div>
          <div>
            <label class="modal-field-label" for="campo-nome">Nome</label>
            <input type="text" id="campo-nome" class="table-busca" style="width:100%;" value="${escaparHtml(u.nome)}">
          </div>
          <div>
            <label class="modal-field-label" for="campo-email">E-mail</label>
            <input type="email" id="campo-email" class="table-busca" style="width:100%;" value="${escaparHtml(u.email || '')}">
          </div>
          <div>
            <label class="modal-field-label" for="campo-telefone">Telefone</label>
            <input type="text" id="campo-telefone" class="table-busca" style="width:100%;" value="${escaparHtml(u.telefone || '')}" placeholder="(86) 99999-9999">
          </div>
          <div>
            <label class="modal-field-label" for="campo-cpf-cnpj">CPF/CNPJ</label>
            <input type="text" id="campo-cpf-cnpj" class="table-busca" style="width:100%;" value="${escaparHtml(u.cpfCnpj || '')}">
          </div>
        </div>

        <div class="modal-subsection-title">Serviços desta conta (${data.prestadores.length})</div>
        ${data.prestadores.length ? data.prestadores.map(p => `
          <div class="modal-prestador-item">
            <span>${escaparHtml(p.categoria)}</span>
            <div class="modal-prestador-acoes">
              <a href="#" class="modal-prestador-link" data-ir-prestador="${escaparHtml(p.id)}">editar</a>
            </div>
          </div>
        `).join('') : '<div class="empty-state">Nenhum serviço cadastrado.</div>'}

        <div id="form-usuario-erro" class="empty-state" style="color: var(--red); display:none;"></div>

        <div style="display:flex; justify-content:space-between; gap:8px; margin-top:16px;">
          <button type="button" id="btn-excluir-usuario" class="toolbar-btn toolbar-btn-perigo">Excluir conta</button>
          <button type="submit" class="toolbar-btn">Salvar alterações</button>
        </div>
      </form>
    `;

    corpo.querySelectorAll('[data-ir-prestador]').forEach(a => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        ativarAba('prestadores');
        setTimeout(() => abrirEdicaoPrestador(a.dataset.irPrestador), 150);
      });
    });

    document.getElementById('form-editar-usuario').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const erroEl = document.getElementById('form-usuario-erro');
      erroEl.style.display = 'none';

      const corpo2 = {
        nome: document.getElementById('campo-nome').value.trim(),
        email: document.getElementById('campo-email').value.trim(),
        telefone: document.getElementById('campo-telefone').value.trim(),
        cpfCnpj: document.getElementById('campo-cpf-cnpj').value.trim()
      };

      try {
        await chamarApi(`${ENDPOINT_MODERACAO_USUARIOS}${id}`, {
          method: 'PATCH',
          body: JSON.stringify(corpo2)
        });
        fecharModal();
        carregarUsuarios();
      } catch (e) {
        erroEl.textContent = e.message;
        erroEl.style.display = 'block';
      }
    });

    document.getElementById('btn-excluir-usuario').addEventListener('click', async () => {
      if (!confirm(`Excluir DEFINITIVAMENTE a conta "${u.nome}"? Isso remove também todos os prestadores, avaliações e salvos dessa conta. Não dá pra desfazer.`)) {
        return;
      }
      try {
        await chamarApi(`${ENDPOINT_MODERACAO_USUARIOS}${id}`, { method: 'DELETE' });
        fecharModal();
        carregarUsuarios();
      } catch (e) {
        const erroEl = document.getElementById('form-usuario-erro');
        erroEl.textContent = e.message;
        erroEl.style.display = 'block';
      }
    });

  } catch (e) {
    corpo.innerHTML = `<div class="empty-state">${escaparHtml(e.message)}</div>`;
  }
}

// ==========================================================================
// PRESTADORES
// ==========================================================================

let prestadoresListaCompleta = [];

async function carregarPrestadores() {
  try {
    const data = await chamarApi(`${ENDPOINT_MODERACAO_PRESTADORES}?limit=1000`);
    prestadoresListaCompleta = data.prestadores || [];
    aplicarFiltroPrestadores();
    document.getElementById('last-update').textContent = 'última atualização: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    mostrarErro(`Não foi possível carregar prestadores (${e.message}).`);
    document.getElementById('prestadores-tbody').innerHTML =
      `<tr><td colspan="5" class="empty-state">${escaparHtml(e.message)}</td></tr>`;
  }
}

function aplicarFiltroPrestadores() {
  const termo = document.getElementById('prestadores-busca').value;
  const filtrados = filtrarLinhas(prestadoresListaCompleta, termo, ['donoNome', 'donoEmail', 'categoria', 'id']);
  renderPrestadores(filtrados);
}

document.getElementById('prestadores-busca').addEventListener('input', aplicarFiltroPrestadores);

function renderPrestadores(prestadores) {
  const tbody = document.getElementById('prestadores-tbody');

  if (!prestadores || prestadores.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum prestador encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = prestadores.map(p => `
    <tr class="clickable-row" data-id="${escaparHtml(p.id)}">
      <td>
        <div>${escaparHtml(p.donoNome || '(sem dono)')}</div>
        <div class="last-seen" style="opacity:0.7;">${escaparHtml(p.donoEmail || '—')}</div>
      </td>
      <td>${escaparHtml(p.categoria)}</td>
      <td>${escaparHtml(p.telefone || '—')}</td>
      <td class="id-mono">${escaparHtml(p.id)}</td>
      <td>${formatarDataExata(p.criadoEm)}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr.clickable-row').forEach(tr => {
    tr.addEventListener('click', () => abrirEdicaoPrestador(tr.dataset.id));
  });
}

const DIAS_SEMANA_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function abrirEdicaoPrestador(id) {
  abrirModal('Editar prestador');
  const corpo = document.getElementById('modal-body');
  corpo.innerHTML = '<div class="empty-state">carregando…</div>';

  try {
    const p = await chamarApi(`${ENDPOINT_MODERACAO_PRESTADORES}/${id}`);

    const diasSelecionados = new Set(p.diasSemana || [0, 1, 2, 3, 4, 5, 6]);
    const tagsExtras = (p.tags || []).filter(t => t !== '/all' && t !== normalizarTagLocal(p.categoria));

    corpo.innerHTML = `
      <form id="form-editar-prestador">
        <div class="modal-grid" style="grid-template-columns: 1fr;">
          <div>
            <div class="modal-field-label">Dono</div>
            <div class="modal-field-value">${escaparHtml(p.donoNome || '—')} (${escaparHtml(p.donoEmail || '—')})</div>
          </div>
          <div>
            <div class="modal-field-label">ID</div>
            <div class="modal-field-value id-mono">${escaparHtml(p.id)}</div>
          </div>
          <div>
            <label class="modal-field-label" for="campo-categoria">Categoria</label>
            <input type="text" id="campo-categoria" class="table-busca" style="width:100%;" value="${escaparHtml(p.categoria)}">
          </div>
          <div>
            <label class="modal-field-label" for="campo-descricao">Descrição</label>
            <textarea id="campo-descricao" class="table-busca" style="width:100%; min-height:70px;">${escaparHtml(p.descricao || '')}</textarea>
          </div>
          <div>
            <label class="modal-field-label" for="campo-telefone-p">Telefone</label>
            <input type="text" id="campo-telefone-p" class="table-busca" style="width:100%;" value="${escaparHtml(p.telefone)}" placeholder="(86) 99999-9999">
          </div>
          <div>
            <label class="modal-field-label" for="campo-cor">Cor (hex)</label>
            <input type="text" id="campo-cor" class="table-busca" style="width:100%;" value="${escaparHtml(p.cor)}">
          </div>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <label class="modal-field-label" for="campo-lat">Latitude</label>
              <input type="number" step="any" id="campo-lat" class="table-busca" style="width:100%;" value="${p.lat}">
            </div>
            <div style="flex:1;">
              <label class="modal-field-label" for="campo-lng">Longitude</label>
              <input type="number" step="any" id="campo-lng" class="table-busca" style="width:100%;" value="${p.lng}">
            </div>
          </div>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <label class="modal-field-label" for="campo-horario-abre">Abre (0-24h)</label>
              <input type="number" step="0.5" min="0" max="24" id="campo-horario-abre" class="table-busca" style="width:100%;" value="${p.horarioAbre ?? ''}">
            </div>
            <div style="flex:1;">
              <label class="modal-field-label" for="campo-horario-fecha">Fecha (0-24h)</label>
              <input type="number" step="0.5" min="0" max="24" id="campo-horario-fecha" class="table-busca" style="width:100%;" value="${p.horarioFecha ?? ''}">
            </div>
          </div>
          <div>
            <div class="modal-field-label">Dias da semana</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              ${DIAS_SEMANA_LABELS.map((label, i) => `
                <label style="display:flex; align-items:center; gap:4px; font-size:12px;">
                  <input type="checkbox" class="campo-dia-semana" value="${i}" ${diasSelecionados.has(i) ? 'checked' : ''}>
                  ${label}
                </label>
              `).join('')}
            </div>
          </div>
          <div>
            <label class="modal-field-label" for="campo-tags">Tags extras (separadas por vírgula)</label>
            <input type="text" id="campo-tags" class="table-busca" style="width:100%;" value="${escaparHtml(tagsExtras.join(', '))}">
          </div>
        </div>

        <div id="form-prestador-erro" class="empty-state" style="color: var(--red); display:none;"></div>

        <div style="display:flex; justify-content:space-between; gap:8px; margin-top:16px;">
          <button type="button" id="btn-excluir-prestador" class="toolbar-btn toolbar-btn-perigo">Excluir prestador</button>
          <button type="submit" class="toolbar-btn">Salvar alterações</button>
        </div>
      </form>
    `;

    document.getElementById('form-editar-prestador').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const erroEl = document.getElementById('form-prestador-erro');
      erroEl.style.display = 'none';

      const diasSemana = [...corpo.querySelectorAll('.campo-dia-semana:checked')].map(el => Number(el.value));
      const horarioAbreValor = document.getElementById('campo-horario-abre').value;
      const horarioFechaValor = document.getElementById('campo-horario-fecha').value;

      const corpoReq = {
        categoria: document.getElementById('campo-categoria').value.trim(),
        descricao: document.getElementById('campo-descricao').value.trim(),
        telefone: document.getElementById('campo-telefone-p').value.trim(),
        cor: document.getElementById('campo-cor').value.trim(),
        lat: Number(document.getElementById('campo-lat').value),
        lng: Number(document.getElementById('campo-lng').value),
        horarioAbre: horarioAbreValor === '' ? null : Number(horarioAbreValor),
        horarioFecha: horarioFechaValor === '' ? null : Number(horarioFechaValor),
        diasSemana,
        tagsTexto: document.getElementById('campo-tags').value.trim()
      };

      try {
        await chamarApi(`${ENDPOINT_MODERACAO_PRESTADORES}/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(corpoReq)
        });
        fecharModal();
        carregarPrestadores();
      } catch (e) {
        erroEl.textContent = e.message;
        erroEl.style.display = 'block';
      }
    });

    document.getElementById('btn-excluir-prestador').addEventListener('click', async () => {
      if (!confirm(`Excluir DEFINITIVAMENTE este prestador (${p.categoria})? Não dá pra desfazer.`)) {
        return;
      }
      try {
        await chamarApi(`${ENDPOINT_MODERACAO_PRESTADORES}/${id}`, { method: 'DELETE' });
        fecharModal();
        carregarPrestadores();
      } catch (e) {
        const erroEl = document.getElementById('form-prestador-erro');
        erroEl.textContent = e.message;
        erroEl.style.display = 'block';
      }
    });

  } catch (e) {
    corpo.innerHTML = `<div class="empty-state">${escaparHtml(e.message)}</div>`;
  }
}

// mesma normalização de tag usada no backend (prestadores.js/admin.js) —
// só pra saber quais tags são "extras" (tudo que não é /all nem a
// categoria) na hora de preencher o campo de edição.
function normalizarTagLocal(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// ==========================================================================
// MODAL genérico (mesmo markup reaproveitado do dashboard)
// ==========================================================================

function abrirModal(titulo) {
  document.getElementById('modal-titulo').textContent = titulo;
  document.getElementById('modal-overlay').hidden = false;
}

function fecharModal() {
  document.getElementById('modal-overlay').hidden = true;
  document.getElementById('modal-body').innerHTML = '';
}

document.getElementById('modal-close-btn').addEventListener('click', fecharModal);
document.getElementById('modal-overlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'modal-overlay') fecharModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !document.getElementById('modal-overlay').hidden) fecharModal();
});

// ==========================================================================
// TEMA — mesma chave (THEME_KEY) que script.js, pra manter o tema
// consistente ao navegar entre dashboard e moderação.
// ==========================================================================

const THEME_KEY = 'mase-dashboard-theme';

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('theme-icon').textContent = '☀️';
    document.getElementById('theme-label').textContent = 'Claro';
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('theme-icon').textContent = '🌙';
    document.getElementById('theme-label').textContent = 'Escuro';
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (e) {
    // localStorage indisponível nesta sessão — segue com padrão escuro
  }
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
}

document.getElementById('theme-btn').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (e) {
    // sem persistência disponível nesta sessão, mas o tema ainda aplica visualmente
  }
});

// ==========================================================================
// BOOT
// ==========================================================================

initTheme();
initTokenField();
carregarAbaAtiva();

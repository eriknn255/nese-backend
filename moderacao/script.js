// ==========================================================================
// MODERAÇÃO — CRUD irrestrito de usuários/prestadores (ver rotas
// /api/admin/moderacao/* em admin.js). Página separada do dashboard de
// métricas, com CSS próprio (style.css desta pasta).
//
// ACESSO: exige login interno de nível 'full' (ver
// middleware/identidadeAdmin.js). A sessão é o JWT devolvido por
// POST /api/admin/login, guardado em SESSAO_KEY — MESMA chave que o
// dashboard usa, é assim que "logar uma vez vale nos dois painéis"
// funciona. Quem é nível 'ver' consegue logar aqui, mas o backend
// responde 403 em tudo; a tela avisa e manda de volta pro dashboard em
// vez de mostrar tabela vazia sem explicação.
// ==========================================================================

const BASE_API = 'https://nese-be.ruexinternet.com/api/admin';
const ENDPOINT_USUARIOS = `${BASE_API}/dashboard/usuarios`;
const ENDPOINT_USUARIO_DETALHE_BASE = `${BASE_API}/dashboard/usuarios/`;
const ENDPOINT_MODERACAO_USUARIOS = `${BASE_API}/moderacao/usuarios/`;
const ENDPOINT_MODERACAO_PRESTADORES = `${BASE_API}/moderacao/prestadores`;
const ENDPOINT_MODERACAO_LOG = `${BASE_API}/moderacao/log`;
const ENDPOINT_CONTAS = `${BASE_API}/contas`;
const ENDPOINT_TROCAR_SENHA = `${BASE_API}/trocar-senha`;

// Mesma origem do backend, pra resolver avatar customizado (caminho
// relativo) — mesmo raciocínio de resolverAvatarUrl em script.js.
const BACKEND_ORIGIN = new URL(BASE_API).origin;

function resolverAvatarUrl(avatarEfetivo) {
  if (!avatarEfetivo) return null;
  if (/^https?:\/\//i.test(avatarEfetivo)) return avatarEfetivo;
  return BACKEND_ORIGIN + avatarEfetivo;
}

// ==========================================================================
// SESSÃO (login interno) — substitui o antigo campo "cole o ADMIN_TOKEN
// aqui". O ADMIN_TOKEN do .env agora só cria login (POST /admin/contas);
// o que autentica no dia a dia é este JWT.
// ==========================================================================
const SESSAO_KEY = 'nese-admin-sessao';
const ENDPOINT_LOGIN = `${BASE_API}/login`;
const ENDPOINT_EU = `${BASE_API}/eu`;

let adminAtual = null; // { id, email, nome, nivel } depois do login

function getToken() {
  try {
    return localStorage.getItem(SESSAO_KEY) || '';
  } catch (e) {
    return '';
  }
}

function salvarSessao(token) {
  try {
    localStorage.setItem(SESSAO_KEY, token);
  } catch (e) {
    // sem persistência nesta sessão — segue valendo só até recarregar
  }
}

function encerrarSessao() {
  try {
    localStorage.removeItem(SESSAO_KEY);
  } catch (e) {
    // idem
  }
  adminAtual = null;
  mostrarLogin();
}

function mostrarLogin(mensagem) {
  document.getElementById('login-overlay').hidden = false;
  document.getElementById('app-shell').hidden = true;
  const erro = document.getElementById('login-erro');
  if (mensagem) {
    erro.textContent = mensagem;
    erro.hidden = false;
  } else {
    erro.hidden = true;
  }
}

function mostrarApp() {
  document.getElementById('login-overlay').hidden = true;
  document.getElementById('app-shell').hidden = false;
  document.getElementById('admin-identidade').textContent = `${adminAtual.nome} · ${adminAtual.nivel}`;
}

document.getElementById('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const botao = document.getElementById('login-btn');
  botao.disabled = true;
  botao.textContent = 'Entrando…';

  try {
    const res = await fetch(ENDPOINT_LOGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('login-email').value.trim(),
        senha: document.getElementById('login-senha').value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || `Falha no login (HTTP ${res.status}).`);

    salvarSessao(data.token);
    adminAtual = data.admin;

    // 'ver' não tem nada pra fazer aqui — o backend responde 403 em toda
    // rota desta tela. Melhor dizer isso na cara do que deixar a pessoa
    // olhando tabelas vazias achando que quebrou.
    if (adminAtual.nivel !== 'full') {
      mostrarLogin('Seu login é de nível "ver", que só acessa a dashboard. Peça um login "full" pra usar a moderação.');
      return;
    }

    mostrarApp();
    carregarAbaAtiva();
  } catch (e) {
    mostrarLogin(e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
});

document.getElementById('logout-btn').addEventListener('click', encerrarSessao);

// Revalida a sessão guardada no boot: JWT pode ter expirado (12h) ou o
// login pode ter sido revogado (DELETE /contas/:id) desde a última visita.
async function initSessao() {
  const token = getToken();
  if (!token) return mostrarLogin();

  try {
    const res = await fetch(ENDPOINT_EU, { headers: { 'X-Admin-Token': token } });
    if (!res.ok) return mostrarLogin(res.status === 401 ? 'Sessão expirada. Entre de novo.' : null);

    const data = await res.json();
    adminAtual = data.admin;
    if (adminAtual.nivel !== 'full') {
      return mostrarLogin('Seu login é de nível "ver", que só acessa a dashboard.');
    }
    mostrarApp();
    carregarAbaAtiva();
  } catch (e) {
    mostrarLogin('Não foi possível falar com o servidor.');
  }
}

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
    throw new Error('Sessão ausente. Entre de novo.');
  }
  const res = await fetch(url, {
    ...opcoes,
    headers: {
      'X-Admin-Token': token,
      ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opcoes.headers || {})
    }
  });

  // Sessão expirada (12h) ou login revogado enquanto a aba estava aberta:
  // volta pra tela de login em vez de deixar erro genérico na tela.
  if (res.status === 401) {
    encerrarSessao();
    throw new Error('Sessão expirada. Entre de novo.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.erro || `Erro ${res.status} ao chamar a API.`);
  }
  return data;
}

// ==========================================================================
// ABAS — Usuários / Prestadores / Log de auditoria / Contas de acesso,
// mesmo padrão data-aba do dashboard, versão simplificada (sem sidebar
// retrátil).
// ==========================================================================

const TITULOS_ABA = {
  usuarios: 'Usuários',
  prestadores: 'Prestadores',
  log: 'Log de auditoria',
  contas: 'Contas de acesso'
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
  if (aba === 'log') carregarLog();
  if (aba === 'contas') carregarContas();
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

        <div class="modal-subsection-title">Histórico desta conta</div>
        <div id="historico-usuario">
          <div class="empty-state" style="padding:14px 0;">carregando…</div>
        </div>

        <div id="form-usuario-erro" class="empty-state" style="color: var(--red); display:none;"></div>

        <div style="display:flex; justify-content:space-between; gap:8px; margin-top:16px;">
          <button type="button" id="btn-excluir-usuario" class="toolbar-btn toolbar-btn-perigo">Excluir conta</button>
          <button type="submit" class="toolbar-btn">Salvar alterações</button>
        </div>
      </form>
    `;

    buscarHistoricoEntidadeHtml('usuario', id).then(html => {
      const alvo = document.getElementById('historico-usuario');
      if (alvo) alvo.innerHTML = html;
    });

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

        <div class="modal-subsection-title">Histórico deste prestador</div>
        <div id="historico-prestador">
          <div class="empty-state" style="padding:14px 0;">carregando…</div>
        </div>

        <div id="form-prestador-erro" class="empty-state" style="color: var(--red); display:none;"></div>

        <div style="display:flex; justify-content:space-between; gap:8px; margin-top:16px;">
          <button type="button" id="btn-excluir-prestador" class="toolbar-btn toolbar-btn-perigo">Excluir prestador</button>
          <button type="submit" class="toolbar-btn">Salvar alterações</button>
        </div>
      </form>
    `;

    buscarHistoricoEntidadeHtml('prestador', id).then(html => {
      const alvo = document.getElementById('historico-prestador');
      if (alvo) alvo.innerHTML = html;
    });

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
// LOG DE AUDITORIA — lista geral (ver GET /moderacao/log em admin.js).
// Cada linha resume um PATCH ou DELETE (feito na moderação OU pelo próprio
// usuário no app normal — ver origem/ator) numa entidade: quem, quando,
// em qual entidade, e o diff (ou snapshot, no caso de exclusão).
// ==========================================================================

let logListaCompleta = [];

const LABELS_CAMPO = {
  categoria: 'categoria', descricao: 'descrição', telefone: 'telefone', cor: 'cor',
  lat: 'latitude', lng: 'longitude', horarioAbre: 'horário de abertura', horarioFecha: 'horário de fechamento',
  diasSemana: 'dias da semana', tags: 'tags',
  nome: 'nome', email: 'e-mail', cpfCnpj: 'CPF/CNPJ'
};

function formatarValorLog(valor) {
  if (valor === null || valor === undefined) return '—';
  if (Array.isArray(valor)) return valor.length ? valor.join(', ') : '—';
  return String(valor);
}

// 'usuario' = a própria conta, editando/excluindo pelo app normal;
// 'moderacao' = painel de moderação com ADMIN_TOKEN (ver origem em
// utils/auditoria.js).
function labelOrigem(origem) {
  return origem === 'usuario' ? 'Usuário' : 'Moderação';
}

// Lista de campos alterados em HTML — um por linha, em vez de uma string
// única concatenada. Um PATCH só pode mexer em vários campos de uma vez
// (ex: categoria + telefone + horário juntos), então isso não pode virar
// uma frase corrida: quebra o layout da tabela e fica ilegível.
function listaCamposAlterados(alteracoes) {
  return Object.entries(alteracoes).map(([campo, { de, para }]) => `
    <div class="log-campo-linha">
      <span class="log-campo-nome">${escaparHtml(LABELS_CAMPO[campo] || campo)}</span>
      <span class="log-campo-de">${escaparHtml(formatarValorLog(de))}</span>
      <span class="log-campo-seta">→</span>
      <span class="log-campo-para">${escaparHtml(formatarValorLog(para))}</span>
    </div>
  `).join('');
}

// compacto=true (histórico dentro do modal, já tem espaço vertical de
// sobra): mostra a lista inteira direto. compacto=false (tabela geral,
// uma linha por registro): esconde atrás de um <details> nativo quando
// tem mais de 1 campo, pra não estourar a altura da linha.
function formatarAlteracoesLog(entrada, { compacto = false } = {}) {
  if (entrada.acao === 'excluir') {
    if (!entrada.alteracoes) return '—';
    // snapshot completo (prestador) ou resumo mínimo (usuário — ver
    // comentário em admin.js/usuarios.js sobre não guardar dado pessoal
    // de conta apagada aqui) — sempre cabe numa linha só.
    if (entrada.entidadeTipo === 'usuario') {
      return `conta criada em ${formatarDataExata(entrada.alteracoes.criadoEm)}, excluída`;
    }
    return `prestador "${escaparHtml(entrada.alteracoes.categoria || '—')}" excluído`;
  }

  if (!entrada.alteracoes) return '—';
  const campos = Object.keys(entrada.alteracoes);
  const listaHtml = listaCamposAlterados(entrada.alteracoes);

  if (compacto || campos.length === 1) return listaHtml;

  return `
    <details>
      <summary>${campos.length} campos alterados</summary>
      ${listaHtml}
    </details>
  `;
}

async function carregarLog() {
  try {
    const data = await chamarApi(`${ENDPOINT_MODERACAO_LOG}?limit=500`);
    logListaCompleta = data.log || [];
    aplicarFiltroLog();
    document.getElementById('last-update').textContent = 'última atualização: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    mostrarErro(`Não foi possível carregar o log (${e.message}).`);
    document.getElementById('log-tbody').innerHTML =
      `<tr><td colspan="5" class="empty-state">${escaparHtml(e.message)}</td></tr>`;
  }
}

function aplicarFiltroLog() {
  const termo = document.getElementById('log-busca').value;
  const filtrados = filtrarLinhas(logListaCompleta, termo, ['ator', 'entidadeId']);
  renderLog(filtrados);
}

document.getElementById('log-busca').addEventListener('input', aplicarFiltroLog);

function renderLog(entradas) {
  const tbody = document.getElementById('log-tbody');

  if (!entradas || entradas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum registro de auditoria ainda.</td></tr>';
    return;
  }

  tbody.innerHTML = entradas.map(entrada => `
    <tr>
      <td class="last-seen">${formatarDataExata(entrada.criadoEm)}</td>
      <td>
        <div>${escaparHtml(entrada.ator)}</div>
        <div class="last-seen" style="opacity:0.7;">${labelOrigem(entrada.origem)}</div>
      </td>
      <td>${entrada.acao === 'excluir' ? 'Excluiu' : 'Editou'}</td>
      <td>
        <div>${entrada.entidadeTipo === 'usuario' ? 'Usuário' : 'Prestador'}</div>
        <div class="id-mono">${escaparHtml(entrada.entidadeId)}</div>
      </td>
      <td class="log-celula-alteracoes">${formatarAlteracoesLog(entrada)}</td>
    </tr>
  `).join('');
}

// Histórico de UMA entidade específica (usuário ou prestador), usado
// dentro dos modais de edição (ver abrirEdicaoUsuario/abrirEdicaoPrestador).
// Retorna o HTML pronto pra injetar — quem chama decide onde encaixar.
async function buscarHistoricoEntidadeHtml(entidadeTipo, entidadeId) {
  try {
    const data = await chamarApi(`${ENDPOINT_MODERACAO_LOG}?entidadeTipo=${entidadeTipo}&entidadeId=${encodeURIComponent(entidadeId)}&limit=50`);
    const entradas = data.log || [];
    if (entradas.length === 0) {
      return '<div class="empty-state" style="padding:14px 0;">Nenhuma edição ou exclusão registrada ainda.</div>';
    }
    return entradas.map(entrada => `
      <div class="modal-prestador-item" style="flex-direction:column; align-items:flex-start; gap:4px;">
        <div style="display:flex; justify-content:space-between; width:100%; gap:8px;">
          <span><strong>${escaparHtml(entrada.ator)}</strong> (${labelOrigem(entrada.origem)}) ${entrada.acao === 'excluir' ? 'excluiu' : 'editou'}</span>
          <span class="last-seen">${formatarDataExata(entrada.criadoEm)}</span>
        </div>
        <div style="width:100%;">${formatarAlteracoesLog(entrada, { compacto: true })}</div>
      </div>
    `).join('');
  } catch (e) {
    return `<div class="empty-state" style="padding:14px 0;">Não foi possível carregar o histórico (${escaparHtml(e.message)}).</div>`;
  }
}


// ==========================================================================
// CONTAS DE ACESSO — gestão dos logins internos (ver rotas /contas,
// /trocar-senha em admin.js). Aba só de nível 'full': o backend responde
// 403 pra 'ver', e de todo jeito quem é 'ver' nem entra nesta página.
//
// Criar login NÃO usa a sessão atual: exige o ADMIN_TOKEN do servidor
// (campo próprio no formulário, nunca persistido). É de propósito — uma
// sessão 'full' vazada não pode fabricar acessos novos.
// ==========================================================================

const LABEL_NIVEL = {
  ver: 'ver — só dashboard',
  full: 'full — dashboard + moderação'
};

function mostrarMensagemForm(id, texto, ehErro) {
  const el = document.getElementById(id);
  el.textContent = texto;
  el.classList.toggle('form-conta-msg-erro', !!ehErro);
  el.hidden = false;
}

async function carregarContas() {
  const tbody = document.getElementById('contas-tbody');
  try {
    const data = await chamarApi(ENDPOINT_CONTAS);
    renderContas(data.contas || []);
  } catch (e) {
    mostrarErro(`Não foi possível carregar as contas (${e.message}).`);
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${escaparHtml(e.message)}</td></tr>`;
  }
}

function renderContas(contas) {
  const tbody = document.getElementById('contas-tbody');

  if (contas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhuma conta cadastrada.</td></tr>';
    return;
  }

  tbody.innerHTML = contas.map(conta => {
    const souEu = adminAtual && adminAtual.id === conta.id;
    return `
      <tr>
        <td>${escaparHtml(conta.nome)}${souEu ? ' <span class="meta">(você)</span>' : ''}</td>
        <td>${escaparHtml(conta.email)}</td>
        <td>${escaparHtml(LABEL_NIVEL[conta.nivel] || conta.nivel)}</td>
        <td class="last-seen">${formatarDataExata(conta.criadoEm)}</td>
        <td class="meta">${escaparHtml(conta.criadoPor || '—')}</td>
        <td>
          ${souEu
            ? ''
            : `<button type="button" class="toolbar-btn toolbar-btn-perigo" data-excluir-conta="${escaparHtml(conta.id)}" data-nome="${escaparHtml(conta.nome)}">Revogar</button>`}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-excluir-conta]').forEach(btn => {
    btn.addEventListener('click', () => excluirConta(btn.dataset.excluirConta, btn.dataset.nome));
  });
}

async function excluirConta(id, nome) {
  if (!confirm(`Revogar o acesso de "${nome}"? A sessão dessa pessoa cai na próxima request.`)) return;

  try {
    await chamarApi(`${ENDPOINT_CONTAS}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    carregarContas();
  } catch (e) {
    mostrarErro(`Não foi possível revogar (${e.message}).`);
  }
}

document.getElementById('form-nova-conta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const botao = document.getElementById('nova-conta-btn');
  botao.disabled = true;

  const tokenServidor = document.getElementById('nova-conta-token').value.trim();

  try {
    // fetch direto (não chamarApi): esta rota é autenticada pelo
    // ADMIN_TOKEN do servidor, não pelo JWT da sessão.
    const res = await fetch(ENDPOINT_CONTAS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tokenServidor },
      body: JSON.stringify({
        nome: document.getElementById('nova-conta-nome').value.trim(),
        email: document.getElementById('nova-conta-email').value.trim(),
        senha: document.getElementById('nova-conta-senha').value,
        nivel: document.getElementById('nova-conta-nivel').value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || `Falha ao criar (HTTP ${res.status}).`);

    mostrarMensagemForm('nova-conta-msg', `Login "${data.email}" criado como ${data.nivel}.`, false);
    document.getElementById('form-nova-conta').reset();
    carregarContas();
  } catch (e) {
    mostrarMensagemForm('nova-conta-msg', e.message, true);
  } finally {
    botao.disabled = false;
  }
});

document.getElementById('form-trocar-senha').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const botao = document.getElementById('trocar-senha-btn');
  botao.disabled = true;

  try {
    const resposta = await chamarApi(ENDPOINT_TROCAR_SENHA, {
      method: 'POST',
      body: JSON.stringify({
        senhaAtual: document.getElementById('senha-atual').value,
        senhaNova: document.getElementById('senha-nova').value
      })
    });

    // Trocar a senha invalida TODAS as sessões abertas — inclusive esta
    // (ver senha_alterada_em em identidadeAdmin.js). O backend devolve um
    // token novo justamente pra quem trocou não ser deslogado no ato;
    // guardar ele aqui é o que mantém a aba funcionando. Sem isso, a
    // próxima request cairia em 401 e jogaria a pessoa pra tela de login
    // logo depois de trocar a senha com sucesso.
    if (resposta && resposta.token) salvarSessao(resposta.token);

    mostrarMensagemForm('trocar-senha-msg',
      'Senha trocada. Sessões abertas em outros navegadores foram encerradas; esta continua ativa.', false);
    document.getElementById('form-trocar-senha').reset();
  } catch (e) {
    mostrarMensagemForm('trocar-senha-msg', e.message, true);
  } finally {
    botao.disabled = false;
  }
});

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
initSessao(); // decide sozinho entre mostrar login ou carregar a tela

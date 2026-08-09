// Endpoint real do backend (ver routes/admin.js). Este dashboard NÃO usa
// dados fictícios em nenhuma hipótese — se o endpoint não responder, ou o
// token não estiver preenchido, a tela mostra erro explícito, nunca
// números inventados ou "de exemplo".
const ENDPOINT = 'https://nese-be.ruexinternet.com/api/admin/dashboard/data';
const ENDPOINT_USUARIOS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/usuarios';
const ENDPOINT_REQUESTS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/requests';
const ENDPOINT_LOCALIZACAO = 'https://nese-be.ruexinternet.com/api/admin/dashboard/localizacao';
// Detalhe de um usuário: id é acrescentado na hora da chamada (ver
// abrirDetalhesUsuario) — não dá pra montar isso como constante fixa.
const ENDPOINT_USUARIO_DETALHE_BASE = 'https://nese-be.ruexinternet.com/api/admin/dashboard/usuarios/';
const ENDPOINT_LOGS_CADASTRO = 'https://nese-be.ruexinternet.com/api/admin/dashboard/logs-cadastro';
const ENDPOINT_GRAFICOS_TECNICOS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/graficos/tecnicos';
const ENDPOINT_ERROS_POR_ROTA = 'https://nese-be.ruexinternet.com/api/admin/dashboard/erros-por-rota';
const ENDPOINT_GRAFICOS_COMERCIAL = 'https://nese-be.ruexinternet.com/api/admin/dashboard/graficos/comercial';
const ENDPOINT_RETENCAO = 'https://nese-be.ruexinternet.com/api/admin/dashboard/retencao';
const ENDPOINT_FUNIL = 'https://nese-be.ruexinternet.com/api/admin/dashboard/funil';
const ENDPOINT_CONTAS_MORTAS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/contas-mortas';
const ENDPOINT_AVALIACOES_INSIGHTS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/avaliacoes-insights';
const ENDPOINT_WHATSAPP = 'https://nese-be.ruexinternet.com/api/admin/dashboard/whatsapp';
const ENDPOINT_COBERTURA = 'https://nese-be.ruexinternet.com/api/admin/dashboard/cobertura';
const ENDPOINT_BUSCAS_SEM_RESULTADO = 'https://nese-be.ruexinternet.com/api/admin/dashboard/buscas-sem-resultado';
const ENDPOINT_MAPA_PRESTADORES = 'https://nese-be.ruexinternet.com/api/admin/dashboard/mapa-prestadores';
const ENDPOINT_ALERTAS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/alertas';
const ENDPOINT_STATUS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/status';
const ENDPOINT_SEGURANCA_IPS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/seguranca/ips';
const ENDPOINT_DEMANDA_NAO_ATENDIDA = 'https://nese-be.ruexinternet.com/api/admin/dashboard/demanda-nao-atendida';
const ENDPOINT_MODERACAO = 'https://nese-be.ruexinternet.com/api/admin/dashboard/moderacao';
const ENDPOINT_CHURN = 'https://nese-be.ruexinternet.com/api/admin/dashboard/churn';
const ENDPOINT_PRESTADORES_INCOMPLETOS = 'https://nese-be.ruexinternet.com/api/admin/dashboard/prestadores-incompletos';
const ENDPOINT_ROTAS_POPULARES = 'https://nese-be.ruexinternet.com/api/admin/dashboard/rotas-populares';

// Origem do backend (ex: ""), derivada do próprio
// ENDPOINT — usada só pra resolver caminhos relativos que vêm da API
// (ver resolverAvatarUrl). Precisa disso porque este dashboard é um
// arquivo estático servido FORA do backend (ver comentário em admin.js):
// se for aberto direto (file://) ou por outro servidor (ex: Live
// Server numa porta diferente), um caminho relativo tipo "/abc/avatar/
// avatar.webp" resolveria contra a origem do PRÓPRIO dashboard, não
// contra o backend — e a imagem quebraria em silêncio (404, sem erro
// visível na tela). Foto do Google não sofre disso por já vir como URL
// absoluta (https://lh3.googleusercontent.com/...); só a foto
// customizada (upload próprio) é que usa caminho relativo.
const BACKEND_ORIGIN = new URL(ENDPOINT).origin;

// ==========================================================================
// TIMEOUT PADRÃO PRA TODO FETCH DESTE PAINEL — sem isso, um endpoint
// lento ou travado (query pesada no servidor, ou algo como
// /dashboard/seguranca/ips esperando o ip-api.com externo responder)
// deixa a seção correspondente presa em "carregando…" pra sempre: a
// Promise do fetch nunca resolve NEM rejeita, então o catch de dentro de
// cada carregarX() nunca dispara, o renderXErro() correspondente nunca é
// chamado, e o placeholder inicial do HTML ("carregando…") nunca é
// substituído — foi exatamente esse mecanismo que deixava "algumas
// métricas sempre em carregando" no painel.
//
// AbortController força a Promise a rejeitar depois de TIMEOUT_FETCH_MS.
// Essa rejeição cai no catch de cada carregarX() como qualquer outro erro
// de rede — mesma UI, mesma mensagem de erro (agora com "tempo esgotado"
// em vez de travar), só que com um teto de espera em vez de infinito.
// 15s é generoso o bastante pra uma rede ruim/query pesada legítima, sem
// deixar a pessoa esperando minutos por uma seção que nunca vai responder.
const TIMEOUT_FETCH_MS = 15000;

// Faz fetch + confere status + faz o parse do JSON, tudo sob o MESMO
// timeout — de propósito um helper só, não fetch() e res.json() em
// funções separadas. Numa primeira versão desta correção, o timeout só
// cobria o fetch() inicial: o AbortController era liberado assim que os
// CABEÇALHOS chegavam, e o res.json() que vinha depois (lendo o CORPO da
// resposta) ficava sem proteção nenhuma — se o corpo demorasse ou a
// conexão travasse no meio do stream (payload grande, rede instável
// depois do handshake), a seção correspondente do painel voltava a ficar
// presa em "carregando…" pra sempre, exatamente como antes da primeira
// tentativa de conserto. Mantendo fetch+json dentro do mesmo try, o
// mesmo signal cobre a leitura do corpo também — abortar em qualquer
// ponto do processo rejeita a Promise e cai no catch normal de quem
// chamou.
async function buscarJson(url, options = {}) {
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_FETCH_MS);
  try {
    const res = await fetch(url, { ...options, signal: controlador.signal });
    if (res.status === 401) throw new Error('token inválido');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (erro) {
    if (erro.name === 'AbortError') {
      throw new Error(`tempo esgotado após ${TIMEOUT_FETCH_MS / 1000}s`);
    }
    throw erro;
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolverAvatarUrl(avatarEfetivo) {
  if (!avatarEfetivo) return null;
  // Já é absoluta (foto do Google) — usa como veio.
  if (/^https?:\/\//i.test(avatarEfetivo)) return avatarEfetivo;
  // Relativa (foto customizada) — resolve contra a origem do backend.
  return BACKEND_ORIGIN + avatarEfetivo;
}

// Formato real hoje (só o que o backend de fato calcula — ver
// routes/admin.js). Todas as seções planejadas já estão implementadas:
// cards de stats, lista de usuários (GET /dashboard/usuarios) e requests
// recentes (GET /dashboard/requests).
// {
//   stats: { ativosHoje, ativacoesMes, onlineAgora, totalServicos, errosHoje }
// }

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
    // localStorage indisponível nesta sessão (ex: preview sandboxed) — segue sem preencher
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
    // sem persistência disponível nesta sessão — token continua valendo só até recarregar a página
  }
  load();
});

function render(data) {
  document.getElementById('stat-online-agora').textContent = data.stats.onlineAgora;
  document.getElementById('stat-ativos-hoje').textContent = data.stats.ativosHoje;
  document.getElementById('stat-ativacoes-mes').textContent = data.stats.ativacoesMes;
  document.getElementById('stat-total-servicos').textContent = data.stats.totalServicos;
  document.getElementById('stat-erros-hoje').textContent = data.stats.errosHoje;
}

// Formata um timestamp (ms) como "há 3 min" / "há 2 h" / "há 5 dias", ou
// a data completa se já fizer mais de 30 dias — evita relativos absurdos
// tipo "há 400 dias" pra conta antiga.
function formatarTempoRelativo(ms) {
  if (ms == null) return 'nunca';
  const diffMs = Date.now() - ms;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'agora mesmo';
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHoras = Math.floor(diffMin / 60);
  if (diffHoras < 24) return `há ${diffHoras} h`;
  const diffDias = Math.floor(diffHoras / 24);
  if (diffDias < 30) return `há ${diffDias} dia${diffDias === 1 ? '' : 's'}`;
  return new Date(ms).toLocaleDateString('pt-BR');
}

// Data/hora EXATA (dia + horário), diferente de formatarTempoRelativo —
// usada especificamente pra "criado em", que deve ser um horário preciso
// e não um relativo aproximado tipo "há 3 dias". toLocaleString em pt-BR
// já dá dia/mês/ano + hora:minuto num formato só.
function formatarDataExata(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// Junta País/Estado/Cidade resolvidos pro usuário (ver JOIN com
// log_cadastros em GET /dashboard/usuarios) num rótulo curto pra célula
// da tabela — omite partes ausentes em vez de mostrar "null, null".
function formatarLocalizacaoResumo(u) {
  const partes = [u.municipio, u.estado, u.pais].filter(Boolean);
  return partes.length ? partes.join(' / ') : '—';
}

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto == null ? '' : String(texto);
  return div.innerHTML;
}

// ---- Utilidades compartilhadas por Usuários / Requests / Logs de cadastro ----

// Preserva a posição de rolagem de um container ao redesenhar seu conteúdo
// (innerHTML inteiro é trocado a cada refresh de 30s e a cada "carregar
// mais"/filtro) — sem isso, quem estava com scroll no meio da tabela de
// Requests ou Logs de cadastro volta pro topo a cada atualização.
// elementoRolavel null = preserva o scroll da JANELA (usado pela tabela de
// Usuários, que não tem um container próprio com scroll).
function comScrollPreservado(elementoRolavel, funcaoRender) {
  const posicaoAnterior = elementoRolavel ? elementoRolavel.scrollTop : window.scrollY;
  funcaoRender();
  if (elementoRolavel) {
    elementoRolavel.scrollTop = posicaoAnterior;
  } else {
    window.scrollTo(0, posicaoAnterior);
  }
}

// Filtro client-side genérico: texto vazio devolve tudo; senão compara
// (case-insensitive) contra os campos indicados de cada item. Roda sobre
// dados já carregados na memória — nunca bate na API a cada tecla digitada.
function filtrarLinhas(linhas, textoBusca, campos) {
  const termo = textoBusca.trim().toLowerCase();
  if (!termo) return linhas;
  return linhas.filter(linha =>
    campos.some(campo => String(linha[campo] ?? '').toLowerCase().includes(termo))
  );
}

// Gera um CSV (RFC 4180 básico: aspas duplicadas quando o campo tem vírgula,
// aspas ou quebra de linha) a partir de um array de objetos e dispara o
// download no navegador via Blob — sem round-trip no servidor, já que os
// dados exportados são exatamente os que a tabela já tem carregados.
function exportarCsv(nomeArquivo, colunas, linhas) {
  function celula(valor) {
    const texto = valor == null ? '' : String(valor);
    return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  }

  const cabecalho = colunas.map(c => celula(c.rotulo)).join(',');
  const corpo = linhas.map(linha => colunas.map(c => celula(c.valor(linha))).join(',')).join('\n');
  const csv = '\uFEFF' + cabecalho + '\n' + corpo; // BOM: Excel no Windows abre acentuação certa sem isso

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo;
  link.click();
  URL.revokeObjectURL(url);
}

// Guarda a última lista carregada (por id) pra abrir o modal sem precisar
// buscar de novo dados que já vieram na listagem — o modal ainda busca o
// detalhe completo (GET /dashboard/usuarios/:id), mas isso evita a tabela
// piscar vazia enquanto a request de detalhe não volta.
const usuariosCarregados = {};

// Lista completa (sem filtro) da última resposta de /dashboard/usuarios —
// a busca (ver #usuarios-busca) filtra sobre isso em memória, sem bater na
// API a cada tecla; e o refresh de 30s reaplica o filtro atual em cima dos
// dados novos, em vez de simplesmente sobrescrever o que a pessoa buscou.
let usuariosListaCompleta = [];

function renderUsuarios(usuarios) {
  const tbody = document.getElementById('usuarios-tbody');

  if (!usuarios || usuarios.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum usuário cadastrado ainda.</td></tr>';
    return;
  }

  usuarios.forEach(u => { usuariosCarregados[u.id] = u; });

  comScrollPreservado(null, () => {
    tbody.innerHTML = usuarios.map(u => {
      const avatarResolvido = resolverAvatarUrl(u.avatarEfetivo);
      const avatarSrc = avatarResolvido
        ? escaparHtml(avatarResolvido)
        : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3C/svg%3E';
      const badgeClasse = u.totalPrestadores > 0 ? 'count-badge' : 'count-badge zero';
      const dotClasse = u.online ? 'online-dot on' : 'online-dot off';

      return `
        <tr class="clickable-row" data-usuario-id="${escaparHtml(u.id)}" tabindex="0">
          <td>
            <div class="user-cell">
              <span class="${dotClasse}" title="${u.online ? 'online agora' : 'offline'}"></span>
              <img class="user-avatar" src="${avatarSrc}" alt="" loading="lazy" onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3C/svg%3E';">
              <div>
                <div>${escaparHtml(u.nome)}</div>
                <div class="last-seen">${escaparHtml(u.email || '—')}</div>
              </div>
            </div>
          </td>
          <td class="id-mono">${escaparHtml(u.id)}</td>
          <td class="last-seen">${escaparHtml(formatarLocalizacaoResumo(u))}</td>
          <td><span class="${badgeClasse}">${u.totalPrestadores}</span></td>
          <td class="last-seen">${formatarDataExata(u.criadoEm)}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr.clickable-row').forEach(tr => {
      tr.addEventListener('click', () => abrirDetalhesUsuario(tr.dataset.usuarioId));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          abrirDetalhesUsuario(tr.dataset.usuarioId);
        }
      });
    });
  });
}

function renderUsuariosErro(mensagem) {
  const tbody = document.getElementById('usuarios-tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

// Reaplica a busca atual (#usuarios-busca) sobre usuariosListaCompleta —
// chamada tanto ao digitar quanto depois de todo refresh de 30s.
function aplicarFiltroUsuarios() {
  const termo = document.getElementById('usuarios-busca').value;
  const filtrados = filtrarLinhas(usuariosListaCompleta, termo, ['nome', 'email', 'id']);
  if (filtrados.length === 0 && termo.trim()) {
    comScrollPreservado(null, () => {
      document.getElementById('usuarios-tbody').innerHTML =
        '<tr><td colspan="5" class="empty-state">Nenhum usuário bate com essa busca.</td></tr>';
    });
    return;
  }
  renderUsuarios(filtrados);
}

document.getElementById('usuarios-busca').addEventListener('input', aplicarFiltroUsuarios);

async function carregarUsuarios(token) {
  try {
    const data = await buscarJson(ENDPOINT_USUARIOS, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    usuariosListaCompleta = data.usuarios || [];
    aplicarFiltroUsuarios();
  } catch (e) {
    renderUsuariosErro(`Erro ao carregar usuários (${e.message}).`);
  }
}

function renderRequestsErro(mensagem) {
  const tbody = document.getElementById('requests-tbody');
  tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
  document.getElementById('requests-carregar-mais-btn').hidden = true;
}

function renderRequests(requests) {
  const tbody = document.getElementById('requests-tbody');
  const painel = document.getElementById('requests-panel');

  comScrollPreservado(painel, () => {
    if (!requests || requests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhuma request bate com o que está carregado/buscado.</td></tr>';
      return;
    }

    tbody.innerHTML = requests.map(r => {
      const ehErro = r.statusCode >= 400;
      const badgeClasse = ehErro ? 'count-badge erro' : 'count-badge zero';
      return `
        <tr>
          <td class="id-mono">${escaparHtml(r.rota)}</td>
          <td class="id-mono">${escaparHtml(r.metodo)}</td>
          <td><span class="${badgeClasse}">${r.statusCode}</span></td>
          <td class="last-seen">${r.duracaoMs} ms</td>
          <td class="id-mono">${escaparHtml(r.ip || '—')}</td>
          <td class="id-mono">${r.porta != null ? r.porta : '—'}</td>
          <td class="last-seen">${formatarTempoRelativo(r.criadoEm)}</td>
        </tr>
      `;
    }).join('');
  });
}

// limiteRequests cresce a cada clique em "Carregar mais" (ver botão mais
// abaixo) — não é paginação por offset, é "pedir uma janela maior" (ver
// comentário em GET /dashboard/requests, admin.js), o que persiste
// naturalmente através do refresh automático de 30s (load() sempre chama
// carregarRequests(token) sem resetar essa variável).
let limiteRequests = 100;
let requestsListaCompleta = [];
let requestsTemMais = false;

function aplicarFiltroRequests() {
  const termo = document.getElementById('requests-busca').value;
  const filtrados = filtrarLinhas(requestsListaCompleta, termo, ['rota', 'metodo', 'statusCode', 'ip']);
  renderRequests(filtrados);
}

document.getElementById('requests-busca').addEventListener('input', aplicarFiltroRequests);

const requestsCarregarMaisBtn = document.getElementById('requests-carregar-mais-btn');
requestsCarregarMaisBtn.addEventListener('click', () => {
  limiteRequests += 100;
  carregarRequests(getToken());
});

document.getElementById('requests-exportar-btn').addEventListener('click', () => {
  exportarCsv('requests.csv', [
    { rotulo: 'Rota', valor: r => r.rota },
    { rotulo: 'Método', valor: r => r.metodo },
    { rotulo: 'Status', valor: r => r.statusCode },
    { rotulo: 'Duração (ms)', valor: r => r.duracaoMs },
    { rotulo: 'IP', valor: r => r.ip || '' },
    { rotulo: 'Porta', valor: r => r.porta ?? '' },
    { rotulo: 'Quando', valor: r => formatarDataExata(r.criadoEm) }
  ], requestsListaCompleta);
});

// Limpeza manual — dispara sob demanda a MESMA janela de retenção que já
// roda sozinha 1x/dia no servidor (DELETE /dashboard/requests reusa
// limparRequestLogsAntigos(), ver jobs/limparRequestLogs.js). NÃO apaga
// tudo, só o que já passou dos 90 dias — mas ainda é destrutivo e sem
// volta, por isso o confirm() antes de disparar.
document.getElementById('requests-limpar-btn').addEventListener('click', async () => {
  const confirmado = confirm('Remover da tabela request_logs tudo com mais de 90 dias?\n\nEssa ação roda direto no banco e não tem como desfazer.');
  if (!confirmado) return;

  const token = getToken();
  if (!token) {
    alert('Preencha o token de admin acima antes de limpar os logs.');
    return;
  }

  const btn = document.getElementById('requests-limpar-btn');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Limpando…';

  try {
    const data = await buscarJson(ENDPOINT_REQUESTS, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    alert(`${data.removidas} registro(s) com mais de ${data.retencaoDias} dias removido(s).`);
    await carregarRequests(token);
  } catch (e) {
    alert(`Não foi possível limpar os logs (${e.message}).`);
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});

async function carregarRequests(token) {
  try {
    const data = await buscarJson(`${ENDPOINT_REQUESTS}?limit=${limiteRequests}`, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    requestsListaCompleta = data.requests || [];
    requestsTemMais = !!data.temMais;
    requestsCarregarMaisBtn.hidden = !requestsTemMais;
    aplicarFiltroRequests();
  } catch (e) {
    renderRequestsErro(`Erro ao carregar requests (${e.message}).`);
  }
}

// ---- Logs de cadastro (log_cadastros — DIFERENTE de requests: um evento
// por conta criada, não uma linha por request HTTP) ----

function renderLogsCadastroErro(mensagem) {
  const tbody = document.getElementById('logs-cadastro-tbody');
  tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

function renderLogsCadastro(logs) {
  const tbody = document.getElementById('logs-cadastro-tbody');
  const painel = document.getElementById('logs-cadastro-panel');

  comScrollPreservado(painel, () => {
    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum cadastro bate com o que está carregado/buscado.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(l => {
      const localizacao = [l.municipio, l.estado, l.pais].filter(Boolean).join(' / ') || '—';
      return `
        <tr>
          <td>${escaparHtml(l.nomeCompleto)}</td>
          <td class="last-seen">${escaparHtml(l.email || '—')}</td>
          <td class="last-seen">${escaparHtml(localizacao)}</td>
          <td class="id-mono">${escaparHtml(l.ip || '—')}</td>
          <td class="id-mono">${l.porta != null ? l.porta : '—'}</td>
          <td class="last-seen">${formatarDataExata(l.criadoEm)}</td>
        </tr>
      `;
    }).join('');
  });
}

// Mesmo padrão de limiteRequests (ver comentário lá) — cresce por clique,
// não é offset, persiste através do refresh automático de 30s.
let limiteLogsCadastro = 100;
let logsCadastroListaCompleta = [];

function aplicarFiltroLogsCadastro() {
  const termo = document.getElementById('logs-cadastro-busca').value;
  const filtrados = filtrarLinhas(logsCadastroListaCompleta, termo, ['nomeCompleto', 'email', 'ip']);
  renderLogsCadastro(filtrados);
}

document.getElementById('logs-cadastro-busca').addEventListener('input', aplicarFiltroLogsCadastro);

const logsCadastroCarregarMaisBtn = document.getElementById('logs-cadastro-carregar-mais-btn');
logsCadastroCarregarMaisBtn.addEventListener('click', () => {
  limiteLogsCadastro += 100;
  carregarLogsCadastro(getToken());
});

document.getElementById('logs-cadastro-exportar-btn').addEventListener('click', () => {
  exportarCsv('logs-cadastro.csv', [
    { rotulo: 'Nome', valor: l => l.nomeCompleto },
    { rotulo: 'Email', valor: l => l.email || '' },
    { rotulo: 'País', valor: l => l.pais || '' },
    { rotulo: 'Estado', valor: l => l.estado || '' },
    { rotulo: 'Município', valor: l => l.municipio || '' },
    { rotulo: 'IP', valor: l => l.ip || '' },
    { rotulo: 'Porta', valor: l => l.porta ?? '' },
    { rotulo: 'Quando', valor: l => formatarDataExata(l.criadoEm) }
  ], logsCadastroListaCompleta);
});

async function carregarLogsCadastro(token) {
  try {
    const data = await buscarJson(`${ENDPOINT_LOGS_CADASTRO}?limit=${limiteLogsCadastro}`, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    logsCadastroListaCompleta = data.logs || [];
    logsCadastroCarregarMaisBtn.hidden = !data.temMais;
    aplicarFiltroLogsCadastro();
  } catch (e) {
    renderLogsCadastroErro(`Erro ao carregar logs de cadastro (${e.message}).`);
  }
}

// ---- Gráficos (cadastros por dia / requests por status / categorias) ----

// Formata "YYYY-MM-DD" (o que o strftime do backend devolve) pra "DD/MM",
// rótulo curto o bastante pra caber embaixo de cada barra.
function formatarRotuloDia(diaIso) {
  const partes = diaIso.split('-');
  return `${partes[2]}/${partes[1]}`;
}

function renderGraficoErro(elementId, mensagem) {
  // Se havia um gráfico de área nesse container, destrói a instância antes
  // de sobrescrever o innerHTML — senão o Chart.js fica com uma instância
  // presa a um <canvas> que já saiu do DOM (mesmo cuidado de
  // renderGraficoArea abaixo).
  if (instanciasGraficoArea[elementId]) {
    instanciasGraficoArea[elementId].destroy();
    delete instanciasGraficoArea[elementId];
  }
  document.getElementById(elementId).innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
}

// ---- Gráficos de ÁREA (séries temporais) via Chart.js ----
//
// Convenção do painel: todo gráfico que representa uma LINHA DO TEMPO
// (dia a dia, hora a hora etc.) usa este helper — modo "área" (linha +
// preenchimento), que deixa a tendência mais legível que barras soltas.
// Gráficos CATEGÓRICOS (status HTTP, categoria de serviço — sem eixo de
// tempo) continuam de propósito como barras em CSS puro
// (renderGraficoRequestsPorStatus/renderGraficoCategorias, mais abaixo):
// não são série temporal, então "área" não faria sentido neles. Qualquer
// gráfico novo de linha do tempo que aparecer no futuro deve chamar
// renderGraficoArea() em vez de reinventar isso.
//
// instanciasGraficoArea guarda a instância Chart.js viva de cada
// container (chave = id do container). Necessário porque carregarGraficos()
// roda a cada 30s (ver load()/setInterval no fim do arquivo) e recria o
// <canvas> do zero a cada vez (innerHTML) — sem destruir a instância
// antiga primeiro, o Chart.js vazaria uma instância por ciclo, presa a um
// canvas que não existe mais no DOM.
const instanciasGraficoArea = {};

// Lê uma CSS custom property já resolvida (respeita tema claro/escuro
// ativo no momento) — Chart.js desenha em <canvas>, então não pode herdar
// var(--cor) direto do CSS como os elementos HTML dos gráficos em barra.
function corCss(variavel) {
  return getComputedStyle(document.documentElement).getPropertyValue(variavel).trim();
}

// labels/valores: arrays paralelos (um rótulo do eixo X pra cada valor).
// cor: nome da CSS custom property (ex: '--gold'), não o valor já resolvido.
// formatarTooltip: opcional, formata o valor mostrado ao passar o mouse.
function renderGraficoArea(containerId, { labels, valores, cor = '--gold', formatarTooltip = v => String(v) }) {
  if (instanciasGraficoArea[containerId]) {
    instanciasGraficoArea[containerId].destroy();
    delete instanciasGraficoArea[containerId];
  }

  const container = document.getElementById(containerId);
  const canvasId = containerId + '-canvas';
  container.innerHTML = `<canvas id="${canvasId}"></canvas>`;

  const corLinha = corCss(cor);
  const corGrade = corCss('--border');
  const corTexto = corCss('--muted');

  instanciasGraficoArea[containerId] = new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: valores,
        borderColor: corLinha,
        backgroundColor: corLinha + '33', // mesma cor, ~20% opacidade — é o "preenchimento" que faz a área
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: corLinha,
        pointBorderColor: corLinha
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => formatarTooltip(item.parsed.y) } }
      },
      scales: {
        x: {
          grid: { color: corGrade },
          ticks: { color: corTexto, font: { family: 'IBM Plex Mono, monospace', size: 10.5 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: corGrade },
          ticks: { color: corTexto, precision: 0, font: { size: 10.5 } }
        }
      }
    }
  });
}

// Chart.js precisa recalcular o tamanho do <canvas> quando o container sai
// de `hidden` (display:none) — enquanto escondido ele enxerga 0x0 e some.
// Como load() atualiza os gráficos a cada 30s independente da aba ativa
// (ver comentário em load()), o gráfico pode ter sido (re)criado com a
// aba "Gráficos" fora de tela; ao entrar nela, força o recálculo.
function redimensionarGraficosArea() {
  Object.values(instanciasGraficoArea).forEach(chart => chart.resize());
}

// Guarda a última resposta de /dashboard/graficos só pra poder redesenhar
// o(s) gráfico(s) de área na hora, ao trocar o tema — sem isso, as cores
// (linha/grade/texto) só atualizariam no próximo ciclo de 30s, já que são
// lidas das CSS vars uma vez, no momento em que o Chart.js é criado.
let ultimoCadastrosPorDia = null;

function formatarTooltipCadastros(valor) {
  return `${valor} cadastro${valor === 1 ? '' : 's'}`;
}

// diasCadastros: janela ativa do gráfico "Cadastros por dia" (7/14/30),
// controlada pelo seletor #cadastros-periodo-seletor. Persiste através do
// refresh automático de 30s (mesmo raciocínio de limiteRequests/
// limiteLogsCadastro, acima) — só muda quando a pessoa clica outro botão.
let diasCadastros = 14;

function renderGraficoCadastrosPorDia(linhas) {
  ultimoCadastrosPorDia = linhas;

  if (!linhas || linhas.length === 0) {
    renderGraficoErro('chart-cadastros-dia', `Nenhum cadastro nos últimos ${diasCadastros} dias.`);
    return;
  }

  renderGraficoArea('chart-cadastros-dia', {
    labels: linhas.map(l => formatarRotuloDia(l.dia)),
    valores: linhas.map(l => l.total),
    cor: '--teal',
    formatarTooltip: formatarTooltipCadastros
  });
}

document.querySelectorAll('#cadastros-periodo-seletor button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    diasCadastros = Number(btn.dataset.dias);
    document.querySelectorAll('#cadastros-periodo-seletor button').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    carregarGraficosComercial(getToken());
  });
});

function renderGraficoRequestsPorStatus(linhas) {
  const container = document.getElementById('chart-requests-status');
  if (!linhas || linhas.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhuma request nas últimas 24h.</div>';
    return;
  }
  const maiorTotal = Math.max(...linhas.map(l => l.total), 1);
  container.innerHTML = linhas.map(l => {
    const alturaPct = Math.max((l.total / maiorTotal) * 100, 4);
    return `
      <div class="bar-col">
        <span class="bar-valor">${l.total}</span>
        <div class="bar-fill status-${l.classe}" style="height:${alturaPct}%"></div>
        <span class="bar-label">${l.classe}</span>
      </div>
    `;
  }).join('');
}

function renderGraficoCategorias(linhas) {
  const container = document.getElementById('chart-categorias');
  if (!linhas || linhas.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum serviço cadastrado ainda.</div>';
    return;
  }
  const maiorTotal = Math.max(...linhas.map(l => l.total), 1);
  container.innerHTML = linhas.map(l => {
    const larguraPct = Math.max((l.total / maiorTotal) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(l.categoria)}">${escaparHtml(l.categoria)}</span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${l.total}</span>
      </div>
    `;
  }).join('');
}

// Formata a chave de hora que o backend devolve ("YYYY-MM-DD HH:00") só
// pro rótulo do eixo X — mostra apenas "HH:00", já que a janela é sempre
// as últimas 24h e o dia por extenso só ocuparia espaço sem ajudar a
// leitura (diferente de formatarRotuloDia, que cobre janelas de dias).
function formatarRotuloHora(chaveHora) {
  return chaveHora.slice(11, 16);
}

// rotuloPlural: já vem pronto no plural (evita regra de pluralização
// genérica errada pra frases tipo "usuário ativo" -> "usuários ativos",
// onde as DUAS palavras mudam, não só a última).
function formatarTooltipContagem(rotuloSingular, rotuloPlural) {
  return valor => `${valor} ${valor === 1 ? rotuloSingular : rotuloPlural}`;
}

function renderGraficoRequestsPorHora(linhas) {
  if (!linhas || linhas.length === 0) {
    renderGraficoErro('chart-requests-hora', 'Nenhuma request nas últimas 24h.');
    return;
  }
  renderGraficoArea('chart-requests-hora', {
    labels: linhas.map(l => formatarRotuloHora(l.hora)),
    valores: linhas.map(l => l.total),
    cor: '--blue',
    formatarTooltip: formatarTooltipContagem('request', 'requests')
  });
}

function renderGraficoErrosPorHora(linhas) {
  if (!linhas || linhas.length === 0) {
    renderGraficoErro('chart-erros-hora', 'Nenhum erro nas últimas 24h.');
    return;
  }
  renderGraficoArea('chart-erros-hora', {
    labels: linhas.map(l => formatarRotuloHora(l.hora)),
    valores: linhas.map(l => l.total),
    cor: '--red',
    formatarTooltip: formatarTooltipContagem('erro', 'erros')
  });
}

function renderGraficoUsuariosAtivosPorHora(linhas) {
  if (!linhas || linhas.length === 0) {
    renderGraficoErro('chart-usuarios-ativos-hora', 'Nenhuma atividade nas últimas 24h.');
    return;
  }
  renderGraficoArea('chart-usuarios-ativos-hora', {
    labels: linhas.map(l => formatarRotuloHora(l.hora)),
    valores: linhas.map(l => l.total),
    cor: '--green',
    formatarTooltip: formatarTooltipContagem('usuário ativo', 'usuários ativos')
  });
}

function renderGraficoCadastrosPorHora(linhas) {
  if (!linhas || linhas.length === 0) {
    renderGraficoErro('chart-cadastros-hora', 'Nenhum cadastro nas últimas 24h.');
    return;
  }
  renderGraficoArea('chart-cadastros-hora', {
    labels: linhas.map(l => formatarRotuloHora(l.hora)),
    valores: linhas.map(l => l.total),
    cor: '--teal',
    formatarTooltip: formatarTooltipContagem('cadastro', 'cadastros')
  });
}

// Cartões "Clientes / Prestadores / % / média" — não são gráfico, só
// números formatados (mesmo padrão dos cards da Visão geral).
function renderClientesVsPrestadores(cvp) {
  document.getElementById('stat-clientes').textContent = cvp.totalClientes;
  document.getElementById('stat-prestadores').textContent = cvp.totalPrestadores;
  document.getElementById('stat-percentual-prestadores').textContent = `${cvp.percentualPrestadores.toFixed(1)}%`;
}

function renderMediaServicos(media) {
  document.getElementById('stat-media-servicos').textContent = media.porContaPrestadora.toFixed(1);
}

function renderGraficosComerciaisErro(mensagem) {
  ['stat-clientes', 'stat-prestadores', 'stat-percentual-prestadores', 'stat-media-servicos'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  renderGraficoErro('chart-cadastros-dia', mensagem);
  renderGraficoErro('chart-cadastros-hora', mensagem);
  renderGraficoErro('chart-categorias', mensagem);
}

function renderGraficosTecnicosErro(mensagem) {
  renderGraficoErro('chart-requests-hora', mensagem);
  renderGraficoErro('chart-erros-hora', mensagem);
  renderGraficoErro('chart-usuarios-ativos-hora', mensagem);
  renderGraficoErro('chart-requests-status', mensagem);
  renderRotasPopularesErro(mensagem);
  document.getElementById('erros-por-rota-tbody').innerHTML = `<tr><td colspan="5" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

// Cor da taxa de erro escala com a gravidade — mesma lógica de leitura
// rápida que .count-badge.erro já usa em outras tabelas: verde/dourado
// não precisa de destaque, vermelho pede atenção na hora.
function renderErrosPorRota(porRota) {
  const tbody = document.getElementById('erros-por-rota-tbody');
  if (!porRota || porRota.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum erro nas últimas 24h. 🎉</td></tr>';
    return;
  }
  tbody.innerHTML = porRota.map(r => `
    <tr>
      <td><span class="id-mono">${escaparHtml(r.metodo)}</span> ${escaparHtml(r.rota)}</td>
      <td>${r.total4xx > 0 ? `<span class="count-badge">${r.total4xx}</span>` : '—'}</td>
      <td>${r.total5xx > 0 ? `<span class="count-badge erro">${r.total5xx}</span>` : '—'}</td>
      <td>${r.taxaErroPct}%</td>
      <td class="last-seen">${formatarDataExata(r.ultimoErroEm)}</td>
    </tr>
  `).join('');
}

async function carregarGraficosTecnicosPrincipais(token) {
  try {
    const data = await buscarJson(ENDPOINT_GRAFICOS_TECNICOS, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderGraficoRequestsPorHora(data.requestsPorHora);
    renderGraficoErrosPorHora(data.errosPorHora);
    renderGraficoUsuariosAtivosPorHora(data.usuariosAtivosPorHora);
    renderGraficoRequestsPorStatus(data.requestsPorStatusUltimas24h);
  } catch (e) {
    renderGraficoErro('chart-requests-hora', `Erro ao carregar (${e.message}).`);
    renderGraficoErro('chart-erros-hora', `Erro ao carregar (${e.message}).`);
    renderGraficoErro('chart-usuarios-ativos-hora', `Erro ao carregar (${e.message}).`);
    renderGraficoErro('chart-requests-status', `Erro ao carregar (${e.message}).`);
  }
}

async function carregarErrosPorRota(token) {
  try {
    const data = await buscarJson(ENDPOINT_ERROS_POR_ROTA, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderErrosPorRota(data.porRota);
  } catch (e) {
    document.getElementById('erros-por-rota-tbody').innerHTML = `<tr><td colspan="5" class="empty-state">Erro ao carregar (${e.message}).</td></tr>`;
  }
}

// Independentes entre si — uma falhar não deve travar a outra (mesmo
// padrão de carregarInsights logo abaixo).
async function carregarGraficosTecnicos(token) {
  await Promise.all([
    carregarGraficosTecnicosPrincipais(token),
    carregarRotasPopulares(token),
    carregarErrosPorRota(token)
  ]);
}

async function carregarGraficosComercial(token) {
  try {
    const data = await buscarJson(`${ENDPOINT_GRAFICOS_COMERCIAL}?dias=${diasCadastros}`, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderGraficoCadastrosPorDia(data.cadastrosPorDia);
    renderGraficoCadastrosPorHora(data.cadastrosPorHora);
    renderGraficoCategorias(data.prestadoresPorCategoria);
    renderClientesVsPrestadores(data.clientesVsPrestadores);
    renderMediaServicos(data.mediaServicos);
  } catch (e) {
    renderGraficosComerciaisErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Localização (País/Estado/Cidade) ----

function renderListaLocalizacao(elementId, linhas, campo) {
  const el = document.getElementById(elementId);
  if (!linhas || linhas.length === 0) {
    el.innerHTML = '<li class="empty-state">Nenhum dado ainda.</li>';
    return;
  }
  el.innerHTML = linhas.map(l => `
    <li><span>${escaparHtml(l[campo])}</span><span class="loc-total">${l.total}</span></li>
  `).join('');
}

function renderLocalizacaoErro(mensagem) {
  ['loc-pais', 'loc-estado', 'loc-municipio'].forEach(id => {
    document.getElementById(id).innerHTML = `<li class="empty-state">${escaparHtml(mensagem)}</li>`;
  });
}

async function carregarLocalizacao(token) {
  try {
    const data = await buscarJson(ENDPOINT_LOCALIZACAO, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderListaLocalizacao('loc-pais', data.porPais, 'pais');
    renderListaLocalizacao('loc-estado', data.porEstado, 'estado');
    renderListaLocalizacao('loc-municipio', data.porMunicipio, 'municipio');
  } catch (e) {
    renderLocalizacaoErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Modal de detalhes do usuário ----

// Link direto pro perfil público de um prestador no app principal.
//
// PROVISÓRIO: essa rota ainda não existe de verdade no app principal —
// nem o link direto, nem o botão "Compartilhar" do perfil (que usaria a
// mesma URL) foram implementados ainda. Assumimos aqui o padrão mais
// simples possível (querystring, ?prestador=<id>, na raiz do próprio
// domínio do backend) porque não exige nenhuma rota nova no servidor —
// mas é só uma suposição de trabalho. Centralizado nesta função de
// propósito: no dia em que o app principal definir o esquema real
// (ex: rota /prestador/:id, ou um hash), só este ponto precisa mudar,
// nada mais no dashboard depende do formato da URL.
function construirLinkPerfilPrestador(prestadorId) {
  return `${BACKEND_ORIGIN}/?prestador=${encodeURIComponent(prestadorId)}`;
}

function fecharModal() {
  document.getElementById('modal-overlay').setAttribute('hidden', '');
}

function renderModalErro(mensagem) {
  document.getElementById('modal-body').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
}

function renderModal(data) {
  const u = data.usuario;
  const avatarResolvido = resolverAvatarUrl(u.avatarEfetivo);
  const avatarSrc = avatarResolvido
    ? escaparHtml(avatarResolvido)
    : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3C/svg%3E';

  document.getElementById('modal-titulo').textContent = u.nome;

  const localizacaoTexto = data.cadastro
    ? [data.cadastro.municipio, data.cadastro.estado, data.cadastro.pais].filter(Boolean).join(' / ') || '—'
    : '—';

  const prestadoresHtml = data.prestadores.length
    ? data.prestadores.map(p => `
        <div class="modal-prestador-item">
          <span>${escaparHtml(p.nome)} <span class="last-seen">(${escaparHtml(p.categoria)})</span></span>
          <span class="modal-prestador-acoes">
            <span class="last-seen">${formatarDataExata(p.criadoEm)}</span>
            <a class="modal-prestador-link" href="${escaparHtml(construirLinkPerfilPrestador(p.id))}" target="_blank" rel="noopener noreferrer" title="Abrir perfil público (link provisório — rota real ainda não existe no app)">Ver perfil ↗</a>
          </span>
        </div>
      `).join('')
    : '<div class="empty-state">Nenhum serviço cadastrado.</div>';

  document.getElementById('modal-body').innerHTML = `
    <div class="modal-user-header">
      <img class="user-avatar" src="${avatarSrc}" alt="" onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3C/svg%3E';">
      <div>
        <div class="modal-user-name">${escaparHtml(u.nome)} <span class="${u.online ? 'online-dot on' : 'online-dot off'}" style="display:inline-block;vertical-align:middle;margin-left:6px;" title="${u.online ? 'online agora' : 'offline'}"></span></div>
        <div class="modal-user-email">${escaparHtml(u.email || '—')}</div>
      </div>
    </div>

    <div class="modal-grid">
      <div><div class="modal-field-label">ID</div><div class="modal-field-value">${escaparHtml(u.id)}</div></div>
      <div><div class="modal-field-label">Telefone</div><div class="modal-field-value">${escaparHtml(u.telefone || '—')}</div></div>
      <div><div class="modal-field-label">CPF/CNPJ</div><div class="modal-field-value">${escaparHtml(u.cpfCnpj || '—')}</div></div>
      <div><div class="modal-field-label">Criado em</div><div class="modal-field-value">${formatarDataExata(u.criadoEm)}</div></div>
      <div><div class="modal-field-label">Última atividade</div><div class="modal-field-value">${formatarDataExata(u.lastSeenAt)}</div></div>
      <div><div class="modal-field-label">Localização (cadastro)</div><div class="modal-field-value">${escaparHtml(localizacaoTexto)}</div></div>
      <div><div class="modal-field-label">IP do cadastro</div><div class="modal-field-value">${escaparHtml(data.cadastro?.ip || '—')}</div></div>
      <div><div class="modal-field-label">Porta do cadastro</div><div class="modal-field-value">${data.cadastro?.porta != null ? data.cadastro.porta : '—'}</div></div>
      <div><div class="modal-field-label">Avaliações feitas</div><div class="modal-field-value">${data.atividade.totalAvaliacoesFeitas}</div></div>
      <div><div class="modal-field-label">Prestadores salvos</div><div class="modal-field-value">${data.atividade.totalSalvos}</div></div>
      <div><div class="modal-field-label">Notificações não lidas</div><div class="modal-field-value">${data.atividade.notificacoesNaoLidas}</div></div>
    </div>

    <div class="modal-subsection-title">Serviços cadastrados por essa conta (${data.prestadores.length})</div>
    ${prestadoresHtml}
  `;
}

async function abrirDetalhesUsuario(usuarioId) {
  const token = getToken();
  const overlay = document.getElementById('modal-overlay');

  // Mostra o nome já conhecido (da listagem) imediatamente, enquanto o
  // detalhe completo carrega — evita o modal abrir com título vazio.
  const usuarioConhecido = usuariosCarregados[usuarioId];
  document.getElementById('modal-titulo').textContent = usuarioConhecido ? usuarioConhecido.nome : 'Detalhes do usuário';
  document.getElementById('modal-body').innerHTML = '<div class="empty-state">carregando…</div>';
  overlay.removeAttribute('hidden');

  if (!token) {
    renderModalErro('Preencha o token de admin acima pra ver os detalhes.');
    return;
  }

  try {
    const data = await buscarJson(ENDPOINT_USUARIO_DETALHE_BASE + encodeURIComponent(usuarioId), {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderModal(data);
  } catch (e) {
    const mensagem = e.message === 'HTTP 404' ? 'usuário não encontrado' : e.message;
    renderModalErro(`Não foi possível carregar os detalhes (${mensagem}).`);
  }
}

// ---- Retenção & Ativação / Avaliações / Cobertura / WhatsApp ----
// Continuam carregando tudo junto em carregarInsights() (chamado de load()),
// só o HTML de destino é que mudou: cada bloco agora mora na aba mais
// próxima do que ele mede (retenção/funil/contas mortas → aba "Retenção &
// Ativação"; nota média/expiração → aba "Avaliações"; cobertura → aba
// "Localização"; WhatsApp → aba "Gráficos comerciais"), em vez de tudo
// empilhado numa aba genérica "Insights".

function renderTabelaRetencao(coortes) {
  const container = document.getElementById('tabela-retencao');
  if (!coortes || coortes.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum cadastro na janela analisada.</div>';
    return;
  }
  const maxSemana = Math.max(...coortes.map(c => c.pontos.length - 1), 0);
  const cabecalho = Array.from({ length: maxSemana + 1 }, (_, i) => `<th>Sem. ${i}</th>`).join('');
  const linhas = coortes.map(c => {
    const celulas = Array.from({ length: maxSemana + 1 }, (_, i) => {
      const ponto = c.pontos[i];
      return `<td>${ponto ? ponto.percentual.toFixed(0) + '%' : '—'}</td>`;
    }).join('');
    return `<tr><td>${escaparHtml(c.coorteInicio)} <span class="last-seen">(${c.totalUsuarios})</span></td>${celulas}</tr>`;
  }).join('');
  container.innerHTML = `<table><thead><tr><th>Coorte</th>${cabecalho}</tr></thead><tbody>${linhas}</tbody></table>`;
}

async function carregarRetencao(token) {
  try {
    const data = await buscarJson(ENDPOINT_RETENCAO, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderTabelaRetencao(data.coortes);
  } catch (e) {
    document.getElementById('tabela-retencao').innerHTML = `<div class="empty-state">Erro ao carregar (${e.message}).</div>`;
  }
}

function formatarPercentual(valor) {
  return `${valor.toFixed(1)}%`;
}

function renderFunil(data) {
  document.getElementById('funil-servico-pct').textContent = formatarPercentual(data.primeiroServico.percentual);
  document.getElementById('funil-avaliacao-pct').textContent = formatarPercentual(data.primeiraAvaliacao.percentual);
  document.getElementById('funil-salvo-pct').textContent = formatarPercentual(data.primeiroSalvo.percentual);

  function tempoTexto(etapa) {
    return etapa.tempoMedioDias != null ? `${etapa.tempoMedioDias.toFixed(1)} dia(s) em média até a primeira vez` : 'sem dados de tempo ainda';
  }
  document.getElementById('funil-detalhe').textContent =
    `Serviço: ${tempoTexto(data.primeiroServico)} · Avaliação: ${tempoTexto(data.primeiraAvaliacao)} · Salvo: ${tempoTexto(data.primeiroSalvo)}`;
}

async function carregarFunil(token) {
  try {
    const data = await buscarJson(ENDPOINT_FUNIL, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderFunil(data);
  } catch (e) {
    ['funil-servico-pct', 'funil-avaliacao-pct', 'funil-salvo-pct'].forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('funil-detalhe').textContent = `Erro ao carregar (${e.message}).`;
  }
}

function renderContasMortas(data) {
  document.getElementById('stat-contas-mortas-total').textContent = data.total;
  const tbody = document.getElementById('contas-mortas-tbody');
  if (!data.contas || data.contas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhuma conta inativa encontrada.</td></tr>';
    return;
  }
  tbody.innerHTML = data.contas.map(c => `
    <tr>
      <td>${escaparHtml(c.nome)}</td>
      <td>${escaparHtml(c.email || '—')}</td>
      <td>${formatarDataExata(c.criadoEm)}</td>
      <td>${c.lastSeenAt != null ? formatarDataExata(c.lastSeenAt) : 'nunca'}</td>
    </tr>
  `).join('');
}

async function carregarContasMortas(token) {
  try {
    const data = await buscarJson(ENDPOINT_CONTAS_MORTAS, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderContasMortas(data);
  } catch (e) {
    document.getElementById('stat-contas-mortas-total').textContent = '—';
    document.getElementById('contas-mortas-tbody').innerHTML = `<tr><td colspan="4" class="empty-state">Erro ao carregar (${e.message}).</td></tr>`;
  }
}

function renderNotaPorCategoria(linhas) {
  const container = document.getElementById('chart-nota-categoria');
  if (!linhas || linhas.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhuma avaliação publicada ainda.</div>';
    return;
  }
  container.innerHTML = linhas.map(l => {
    const larguraPct = Math.max((l.notaMedia / 5) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(l.categoria)}">${escaparHtml(l.categoria)}</span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${l.notaMedia.toFixed(1)} ★ <span class="last-seen">(${l.totalAvaliacoes})</span></span>
      </div>
    `;
  }).join('');
}

async function carregarAvaliacoesInsights(token) {
  try {
    const data = await buscarJson(ENDPOINT_AVALIACOES_INSIGHTS, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    document.getElementById('stat-expiracao-automatica').textContent = formatarPercentual(data.expiracaoAutomatica.percentualExpiradaAutomaticamente);
    renderNotaPorCategoria(data.notaMediaPorCategoria);
    document.getElementById('stat-decisao-aprovacao').textContent = `${formatarPercentual(data.decisoes.percentualAprovacao)} (${data.decisoes.totalPublicadas})`;
    document.getElementById('stat-decisao-rejeicao').textContent = `${formatarPercentual(data.decisoes.percentualRejeicao)} (${data.decisoes.totalRejeitadas})`;
    document.getElementById('stat-decisao-total').textContent = data.decisoes.totalDecididas;
  } catch (e) {
    document.getElementById('stat-expiracao-automatica').textContent = '—';
    document.getElementById('chart-nota-categoria').innerHTML = `<div class="empty-state">Erro ao carregar (${e.message}).</div>`;
    ['stat-decisao-aprovacao', 'stat-decisao-rejeicao', 'stat-decisao-total'].forEach(id => document.getElementById(id).textContent = '—');
  }
}

function renderWhatsappPorPrestador(linhas) {
  const container = document.getElementById('chart-whatsapp-prestador');
  if (!linhas || linhas.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum clique registrado ainda.</div>';
    return;
  }
  const maiorTotal = Math.max(...linhas.map(l => l.totalCliques), 1);
  container.innerHTML = linhas.map(l => {
    const larguraPct = Math.max((l.totalCliques / maiorTotal) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(l.nome)}">${escaparHtml(l.nome)} <span class="last-seen">(${escaparHtml(l.categoria)})</span></span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${l.totalCliques}</span>
      </div>
    `;
  }).join('');
}

function renderWhatsappPorCategoria(linhas) {
  const container = document.getElementById('chart-whatsapp-categoria');
  if (!linhas || linhas.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum clique registrado ainda.</div>';
    return;
  }
  const maiorTotal = Math.max(...linhas.map(l => l.totalCliques), 1);
  container.innerHTML = linhas.map(l => {
    const larguraPct = Math.max((l.totalCliques / maiorTotal) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(l.categoria)}">${escaparHtml(l.categoria)}</span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${l.totalCliques}</span>
      </div>
    `;
  }).join('');
}

async function carregarWhatsapp(token) {
  try {
    const data = await buscarJson(ENDPOINT_WHATSAPP, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderWhatsappPorPrestador(data.porPrestador);
    renderWhatsappPorCategoria(data.porCategoria);
  } catch (e) {
    document.getElementById('chart-whatsapp-prestador').innerHTML = `<div class="empty-state">Erro ao carregar (${e.message}).</div>`;
    document.getElementById('chart-whatsapp-categoria').innerHTML = `<div class="empty-state">Erro ao carregar (${e.message}).</div>`;
  }
}

function renderCobertura(data) {
  const tbody = document.getElementById('cobertura-tbody');
  if (!data.porMunicipio || data.porMunicipio.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Sem dados de cobertura ainda (aguardando geocoding de usuários/prestadores).</td></tr>';
    return;
  }
  tbody.innerHTML = data.porMunicipio.map(m => `
    <tr>
      <td>${escaparHtml(m.municipio)}</td>
      <td>${m.totalUsuarios}</td>
      <td>${m.totalPrestadores === 0 ? `<span class="stat-value red" style="font-size:inherit;">0</span>` : m.totalPrestadores}</td>
    </tr>
  `).join('');
}

async function carregarCobertura(token) {
  try {
    const data = await buscarJson(ENDPOINT_COBERTURA, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderCobertura(data);
  } catch (e) {
    document.getElementById('cobertura-tbody').innerHTML = `<tr><td colspan="3" class="empty-state">Erro ao carregar (${e.message}).</td></tr>`;
  }
}

// Visão geral por categoria (sem quebrar por município) — o ranking
// categoria+município que morava aqui foi pro endpoint unificado, ver
// renderDemandaNaoAtendida/carregarDemandaNaoAtendida abaixo.
function renderBuscasSemResultado(data) {
  document.getElementById('stat-buscas-sem-resultado-total').textContent = data.totalGeral ?? 0;
  document.getElementById('stat-buscas-sem-resultado-pendentes').textContent = data.pendentesGeocoding ?? 0;

  const chart = document.getElementById('chart-buscas-sem-resultado-categoria');
  if (!data.porCategoria || data.porCategoria.length === 0) {
    chart.innerHTML = '<div class="empty-state">Nenhuma busca sem resultado registrada ainda.</div>';
    return;
  }
  const maiorTotal = Math.max(...data.porCategoria.map(l => l.total), 1);
  chart.innerHTML = data.porCategoria.map(l => {
    const larguraPct = Math.max((l.total / maiorTotal) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(l.categoria)}">${escaparHtml(l.categoria)}</span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${l.total}</span>
      </div>
    `;
  }).join('');
}

function renderBuscasSemResultadoErro(mensagem) {
  document.getElementById('stat-buscas-sem-resultado-total').textContent = '—';
  document.getElementById('stat-buscas-sem-resultado-pendentes').textContent = '—';
  document.getElementById('chart-buscas-sem-resultado-categoria').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
}

async function carregarBuscasSemResultado(token) {
  try {
    const data = await buscarJson(ENDPOINT_BUSCAS_SEM_RESULTADO, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderBuscasSemResultado(data);
  } catch (e) {
    renderBuscasSemResultadoErro(`Erro ao carregar (${e.message}).`);
  }
}

// Ranking único categoria+município, substituindo as duas tabelas que
// competiam entre si (ver comentário em /dashboard/demanda-nao-atendida
// no admin.js). 'nivel' vem pronto do backend — o front só decide a cor
// do badge.
const NIVEL_BADGE_CLASSE = {
  confirmada: 'count-badge erro',
  observada: 'count-badge',
  inferida: 'count-badge zero'
};
const NIVEL_LABEL = {
  confirmada: 'Confirmada',
  observada: 'Observada',
  inferida: 'Inferida'
};

function renderDemandaNaoAtendida(oportunidades) {
  const tbody = document.getElementById('demanda-nao-atendida-tbody');
  if (!oportunidades || oportunidades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhuma lacuna encontrada (ou dados insuficientes ainda).</td></tr>';
    return;
  }
  tbody.innerHTML = oportunidades.map(o => `
    <tr>
      <td>${escaparHtml(o.categoria)}</td>
      <td>${escaparHtml(o.municipio)}${o.estado ? ` / ${escaparHtml(o.estado)}` : ''}</td>
      <td><span class="${NIVEL_BADGE_CLASSE[o.nivel] || 'count-badge'}">${NIVEL_LABEL[o.nivel] || o.nivel}</span></td>
      <td>${o.totalBuscas > 0 ? o.totalBuscas : '—'}</td>
    </tr>
  `).join('');
}

function renderDemandaNaoAtendidaErro(mensagem) {
  document.getElementById('demanda-nao-atendida-tbody').innerHTML = `<tr><td colspan="4" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

async function carregarDemandaNaoAtendida(token) {
  try {
    const data = await buscarJson(ENDPOINT_DEMANDA_NAO_ATENDIDA, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderDemandaNaoAtendida(data.oportunidades);
  } catch (e) {
    renderDemandaNaoAtendidaErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Fila de moderação ----

function renderModeracao(data) {
  document.getElementById('stat-moderacao-total').textContent = data.totalPendentes;
  document.getElementById('stat-moderacao-mais-antiga').textContent =
    data.esperandoDesde != null ? formatarTempoRelativo(data.esperandoDesde) : '—';

  const tbody = document.getElementById('moderacao-tbody');
  if (!data.avaliacoes || data.avaliacoes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhuma avaliação pendente. 🎉</td></tr>';
    return;
  }
  tbody.innerHTML = data.avaliacoes.map(a => `
    <tr>
      <td>${escaparHtml(a.prestadorNome)}</td>
      <td>${escaparHtml(a.autorNome)}</td>
      <td>${'★'.repeat(a.nota)}${'☆'.repeat(5 - a.nota)}</td>
      <td class="last-seen">${formatarTempoRelativo(a.criadoEm)}</td>
    </tr>
  `).join('');
}

function renderModeracaoErro(mensagem) {
  document.getElementById('stat-moderacao-total').textContent = '—';
  document.getElementById('stat-moderacao-mais-antiga').textContent = '—';
  document.getElementById('moderacao-tbody').innerHTML = `<tr><td colspan="4" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

async function carregarModeracao(token) {
  try {
    const data = await buscarJson(ENDPOINT_MODERACAO, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderModeracao(data);
  } catch (e) {
    renderModeracaoErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Contas excluídas (churn) ----

function renderChurn(data) {
  document.getElementById('stat-churn-criadas').textContent = data.totalCriadas;
  document.getElementById('stat-churn-excluidas').textContent = data.totalExcluidas;
  const liquidoEl = document.getElementById('stat-churn-liquido');
  liquidoEl.textContent = data.crescimentoLiquido > 0 ? `+${data.crescimentoLiquido}` : data.crescimentoLiquido;
  liquidoEl.className = 'stat-value ' + (data.crescimentoLiquido >= 0 ? 'green' : 'red');
  document.getElementById('stat-churn-tempo-medio').textContent =
    data.tempoMedioAteExclusaoDias != null ? `${data.tempoMedioAteExclusaoDias.toFixed(1)} dia(s)` : '—';
}

function renderChurnErro(mensagem) {
  ['stat-churn-criadas', 'stat-churn-excluidas', 'stat-churn-liquido', 'stat-churn-tempo-medio'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
}

async function carregarChurn(token) {
  try {
    const data = await buscarJson(ENDPOINT_CHURN, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderChurn(data);
  } catch (e) {
    renderChurnErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Prestadores incompletos ----

const LACUNA_LABEL = { descricao: 'descrição', capa: 'capa', avaliacao: 'avaliação' };

function renderPrestadoresIncompletos(data) {
  document.getElementById('stat-prestadores-incompletos-total').textContent = data.total;

  const tbody = document.getElementById('prestadores-incompletos-tbody');
  if (!data.prestadores || data.prestadores.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhum prestador incompleto. 🎉</td></tr>';
    return;
  }
  tbody.innerHTML = data.prestadores.map(p => `
    <tr>
      <td>${escaparHtml(p.nome)}</td>
      <td>${escaparHtml(p.categoria)}</td>
      <td>${p.lacunas.map(l => `<span class="count-badge erro">${LACUNA_LABEL[l] || l}</span>`).join(' ')}</td>
      <td class="last-seen">${formatarDataExata(p.criadoEm)}</td>
    </tr>
  `).join('');
}

function renderPrestadoresIncompletosErro(mensagem) {
  document.getElementById('stat-prestadores-incompletos-total').textContent = '—';
  document.getElementById('prestadores-incompletos-tbody').innerHTML = `<tr><td colspan="4" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

async function carregarPrestadoresIncompletos(token) {
  try {
    const data = await buscarJson(ENDPOINT_PRESTADORES_INCOMPLETOS, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderPrestadoresIncompletos(data);
  } catch (e) {
    renderPrestadoresIncompletosErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Rotas mais chamadas (tráfego geral) ----

function renderRotasPopulares(porRota) {
  const tbody = document.getElementById('rotas-populares-tbody');
  if (!porRota || porRota.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhuma request nas últimas 24h.</td></tr>';
    return;
  }
  tbody.innerHTML = porRota.map(r => `
    <tr>
      <td><span class="id-mono">${escaparHtml(r.metodo)}</span> ${escaparHtml(r.rota)}</td>
      <td><span class="count-badge">${r.totalRequests}</span></td>
      <td>${r.duracaoMediaMs} ms</td>
      <td>${r.totalErros > 0 ? `<span class="count-badge erro">${r.totalErros}</span>` : '—'}</td>
    </tr>
  `).join('');
}

function renderRotasPopularesErro(mensagem) {
  document.getElementById('rotas-populares-tbody').innerHTML = `<tr><td colspan="4" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
}

async function carregarRotasPopulares(token) {
  try {
    const data = await buscarJson(ENDPOINT_ROTAS_POPULARES, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderRotasPopulares(data.porRota);
  } catch (e) {
    renderRotasPopularesErro(`Erro ao carregar (${e.message}).`);
  }
}

// ---- Mapa de densidade de prestadores (aba Visão geral) ----
// Leaflet + leaflet.heat (ambos carregados via CDN no <head>, ver
// index.html). A instância do mapa é criada uma única vez — Leaflet não
// gosta de reinicializar em cima do mesmo container — e só reaproveitada
// nas atualizações seguintes: cada load() (a cada 30s) troca os PONTOS do
// heatmap, não recria o mapa inteiro (preserva zoom/posição que o Erik
// já tiver ajustado na tela).
let mapaDensidade = null;
let camadaHeatDensidade = null;
let camadaTilesDensidade = null;

// CartoDB (gratuito, sem chave de API) tem uma variante clara e uma
// escura prontas — troca junto com o tema do painel (ver alternarTilesMapa
// chamado no listener do theme-btn) em vez de forçar um tema fixo de mapa
// que destoaria do resto da tela.
function urlTilesParaTema() {
  const claro = document.documentElement.getAttribute('data-theme') === 'light';
  return claro
    ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
}

function garantirMapaDensidade() {
  if (mapaDensidade) return mapaDensidade;
  const container = document.getElementById('mapa-densidade-prestadores');
  container.innerHTML = ''; // remove o "carregando…"/erro antes do Leaflet assumir o container
  // Centro/zoom aproximados do Brasil inteiro — mesmo ponto de partida
  // usado em mapas do IBGE pra visão nacional.
  mapaDensidade = L.map(container, { attributionControl: true, zoomControl: true })
    .setView([-14.235, -51.9253], 4);
  camadaTilesDensidade = L.tileLayer(urlTilesParaTema(), {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }).addTo(mapaDensidade);
  return mapaDensidade;
}

function alternarTilesMapa() {
  if (!camadaTilesDensidade) return;
  camadaTilesDensidade.setUrl(urlTilesParaTema());
}

function renderMapaDensidade(prestadores) {
  const mapa = garantirMapaDensidade();

  if (camadaHeatDensidade) {
    mapa.removeLayer(camadaHeatDensidade);
    camadaHeatDensidade = null;
  }

  if (!prestadores || prestadores.length === 0) return;

  // leaflet.heat espera [lat, lng, intensidade?] — intensidade omitida
  // (cada ponto pesa igual; não existe hoje uma métrica de "peso" por
  // prestador — cliques, nota — que faça sentido usar aqui em vez disso).
  const pontos = prestadores.map(p => [p.lat, p.lng]);
  camadaHeatDensidade = L.heatLayer(pontos, { radius: 18, blur: 22, maxZoom: 10 }).addTo(mapa);
}

// Container sobrescrito por innerHTML (mensagem de erro/"sem token")
// invalida a instância do Leaflet que estava montada nele — só faz isso
// quando AINDA NÃO existe um mapa de verdade na tela (primeira carga sem
// token, por exemplo). Se já existe um mapa carregado com sucesso antes,
// uma falha pontual neste ciclo (rede instável, timeout, hiccup do
// servidor — o load() roda a cada 30s) NÃO deveria apagar ele: é melhor
// deixar o heatmap com dado um ciclo desatualizado na tela do que fazer o
// mapa inteiro sumir e resetar zoom/posição a cada soluço de rede. Essa
// troca foi o que causava o "mapa some de repente".
function renderMapaDensidadeErro(mensagem) {
  if (mapaDensidade) {
    console.warn('Falha ao atualizar o mapa de densidade — mantendo o último estado carregado com sucesso:', mensagem);
    return;
  }
  document.getElementById('mapa-densidade-prestadores').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
}

async function carregarMapaPrestadores(token) {
  try {
    const data = await buscarJson(ENDPOINT_MAPA_PRESTADORES, { headers: { 'Accept': 'application/json', 'X-Admin-Token': token } });
    renderMapaDensidade(data.prestadores);
  } catch (e) {
    renderMapaDensidadeErro(`Erro ao carregar (${e.message}).`);
  }
}

function renderInsightsErro(mensagem) {
  document.getElementById('tabela-retencao').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
  ['funil-servico-pct', 'funil-avaliacao-pct', 'funil-salvo-pct'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('funil-detalhe').textContent = mensagem;
  document.getElementById('stat-contas-mortas-total').textContent = '—';
  document.getElementById('contas-mortas-tbody').innerHTML = `<tr><td colspan="4" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
  document.getElementById('stat-expiracao-automatica').textContent = '—';
  document.getElementById('chart-nota-categoria').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
  ['stat-decisao-aprovacao', 'stat-decisao-rejeicao', 'stat-decisao-total'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('chart-whatsapp-prestador').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
  document.getElementById('chart-whatsapp-categoria').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
  document.getElementById('cobertura-tbody').innerHTML = `<tr><td colspan="3" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
  renderBuscasSemResultadoErro(mensagem);
  renderDemandaNaoAtendidaErro(mensagem);
  renderModeracaoErro(mensagem);
  renderChurnErro(mensagem);
  renderPrestadoresIncompletosErro(mensagem);
}

// ---- Alertas (síntese de sinais de outras rotas — ver /dashboard/alertas) ----

const RATULOS_SEVERIDADE = { critico: 'Crítico', atencao: 'Atenção', info: 'Info' };

function renderAlertas(alertas) {
  const container = document.getElementById('alertas-lista');

  if (!alertas || alertas.length === 0) {
    container.innerHTML = '<div class="alertas-vazio">Nenhum alerta no momento — nenhum sinal cruzou o limiar de atenção.</div>';
    atualizarBadgeAlertas(0);
    return;
  }

  container.innerHTML = alertas.map(a => `
    <div class="alerta-card alerta-${escaparHtml(a.severidade)}">
      <div class="alerta-cabecalho">
        <span class="alerta-severidade-tag">${escaparHtml(RATULOS_SEVERIDADE[a.severidade] || a.severidade)}</span>
        <span class="alerta-titulo">${escaparHtml(a.titulo)}</span>
      </div>
      <div class="alerta-descricao">${escaparHtml(a.descricao)}</div>
    </div>
  `).join('');

  // Badge conta só crítico + atenção — "info" é contexto, não costuma
  // exigir ação imediata, então não empurra a contagem que chama atenção
  // na sidebar.
  const totalAcionavel = alertas.filter(a => a.severidade === 'critico' || a.severidade === 'atencao').length;
  atualizarBadgeAlertas(totalAcionavel);
}

function atualizarBadgeAlertas(total) {
  const badge = document.getElementById('sidebar-badge-alertas');
  if (!badge) return;
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.removeAttribute('hidden');
  } else {
    badge.setAttribute('hidden', '');
  }
}

function renderAlertasErro(mensagem) {
  document.getElementById('alertas-lista').innerHTML = `<div class="alertas-vazio">${escaparHtml(mensagem)}</div>`;
  atualizarBadgeAlertas(0);
}

async function carregarAlertas(token) {
  try {
    const data = await buscarJson(ENDPOINT_ALERTAS, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderAlertas(data.alertas);
  } catch (e) {
    renderAlertasErro(`Erro ao carregar alertas (${e.message}).`);
  }
}

// "Limpar" só esvazia a lista na tela — os alertas são uma síntese
// recalculada a cada carregamento (ver renderAlertas acima), não registros
// que a pessoa "possui" e pode apagar de fato. No próximo refresh
// automático (ou manual) a lista volta a refletir os sinais atuais.
document.getElementById('alertas-limpar-btn').addEventListener('click', () => {
  document.getElementById('alertas-lista').innerHTML = '<div class="alertas-vazio">Lista limpa — os alertas voltam no próximo carregamento automático.</div>';
  atualizarBadgeAlertas(0);
});

// ---- Status (raio-x geral do sistema — ver /dashboard/status) ----

// Formata segundos de uptime como "3d 4h 12min" (omite unidades zeradas
// à esquerda) — mais legível que um número cru de segundos ou horas
// pra um processo que já está no ar há dias.
function formatarUptime(segundos) {
  const dias = Math.floor(segundos / 86400);
  const horas = Math.floor((segundos % 86400) / 3600);
  const min = Math.floor((segundos % 3600) / 60);
  const partes = [];
  if (dias > 0) partes.push(`${dias}d`);
  if (dias > 0 || horas > 0) partes.push(`${horas}h`);
  partes.push(`${min}min`);
  return partes.join(' ');
}

function formatarMb(mb) {
  if (mb == null) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

const RATULOS_TABELAS_STATUS = {
  usuarios: 'Usuários',
  prestadores: 'Prestadores',
  avaliacoes: 'Avaliações',
  notificacoes: 'Notificações',
  requestLogs: 'Request logs',
  logCadastros: 'Logs de cadastro',
  buscasSemResultado: 'Buscas sem resultado',
  cliquesWhatsapp: 'Cliques WhatsApp',
  salvos: 'Salvos'
};

function renderStatusTabelas(contagens) {
  const container = document.getElementById('status-tabelas');
  const linhas = Object.entries(contagens || {})
    .map(([chave, total]) => ({ rotulo: RATULOS_TABELAS_STATUS[chave] || chave, total }))
    .sort((a, b) => b.total - a.total);

  if (linhas.length === 0) {
    container.innerHTML = '<div class="empty-state">Sem dados.</div>';
    return;
  }

  const maiorTotal = Math.max(...linhas.map(l => l.total), 1);
  container.innerHTML = linhas.map(l => {
    const larguraPct = Math.max((l.total / maiorTotal) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(l.rotulo)}">${escaparHtml(l.rotulo)}</span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${l.total.toLocaleString('pt-BR')}</span>
      </div>
    `;
  }).join('');
}

const RATULOS_NIVEL_STATUS = {
  operacional: 'Operacional',
  degradado: 'Degradado',
  instavel: 'Instável'
};

function renderStatusGeral(statusGeral) {
  const card = document.getElementById('status-geral-card');
  const nivel = statusGeral ? statusGeral.nivel : null;

  card.className = 'status-geral-card' + (nivel ? ` status-geral-${nivel}` : '');
  document.getElementById('status-geral-nivel').textContent = RATULOS_NIVEL_STATUS[nivel] || 'Desconhecido';
  document.getElementById('status-geral-motivo').textContent = statusGeral ? statusGeral.motivo : '';

  // Espelha o mesmo veredito no card "Status" da aba Visão geral — mesma
  // fonte (data.statusGeral), só resumido pra uma palavra + cor. Evita
  // duplicar a chamada de API só pra alimentar esse card.
  const COR_NIVEL_STAT = { operacional: 'green', degradado: 'gold', instavel: 'red' };
  const statCard = document.getElementById('stat-status-nivel');
  statCard.textContent = RATULOS_NIVEL_STATUS[nivel] || '—';
  statCard.className = 'stat-value' + (COR_NIVEL_STAT[nivel] ? ` ${COR_NIVEL_STAT[nivel]}` : '');
}

function renderStatus(data) {
  renderStatusGeral(data.statusGeral);

  document.getElementById('status-uptime').textContent = formatarUptime(data.processo.uptimeSegundos);
  document.getElementById('status-memoria').textContent = formatarMb(data.processo.memoriaRssMb);
  document.getElementById('status-node-version').textContent = data.processo.nodeVersion;
  document.getElementById('status-ambiente').textContent = data.processo.ambiente;
  document.getElementById('status-cors').textContent = data.processo.corsConfigurado ? 'Sim' : 'Não';

  document.getElementById('status-ultima-request').textContent = formatarDataExata(data.saude.ultimaRequestEm);
  document.getElementById('status-erros-hora').textContent = data.saude.errosUltimaHora;

  document.getElementById('status-db-caminho').textContent = `(${data.banco.caminho})`;
  document.getElementById('status-db-tamanho').textContent = formatarMb(data.banco.tamanhoMb);
  renderStatusTabelas(data.banco.contagens);

  document.getElementById('status-job-geocoding-prestadores').textContent = data.jobs.prestadoresPendentesGeocoding;
  document.getElementById('status-job-geocoding-buscas').textContent = data.jobs.buscasPendentesGeocoding;
  document.getElementById('status-job-avaliacoes-pendentes').textContent = data.jobs.avaliacoesPendentes;
  document.getElementById('status-job-retencao-dias').textContent = `${data.jobs.requestLogsRetencaoDias} dias`;
}

function renderStatusErro(mensagem) {
  renderStatusGeral(null);
  document.getElementById('status-geral-motivo').textContent = mensagem;
  [
    'status-uptime', 'status-memoria', 'status-node-version', 'status-ambiente', 'status-cors',
    'status-ultima-request', 'status-erros-hora', 'status-db-tamanho',
    'status-job-geocoding-prestadores', 'status-job-geocoding-buscas',
    'status-job-avaliacoes-pendentes', 'status-job-retencao-dias'
  ].forEach(id => { document.getElementById(id).textContent = '—'; });
  document.getElementById('status-db-caminho').textContent = '';
  document.getElementById('status-tabelas').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
}

async function carregarStatus(token) {
  try {
    const data = await buscarJson(ENDPOINT_STATUS, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderStatus(data);
  } catch (e) {
    renderStatusErro(`Erro ao carregar status (${e.message}).`);
  }
}

// ---- Segurança (densidade de requests por IP — ver /dashboard/seguranca/ips) ----

function renderSegurancaPorRegiao(porRegiao) {
  const container = document.getElementById('seguranca-por-regiao');
  if (!porRegiao || porRegiao.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum IP geolocalizado nesta janela.</div>';
    return;
  }
  const maiorTotal = Math.max(...porRegiao.map(r => r.totalRequests), 1);
  container.innerHTML = porRegiao.map(r => {
    const larguraPct = Math.max((r.totalRequests / maiorTotal) * 100, 3);
    return `
      <div class="bar-row">
        <span class="bar-row-label" title="${escaparHtml(r.regiao)}">${escaparHtml(r.regiao)} <span class="last-seen">(${r.totalIps} IP${r.totalIps === 1 ? '' : 's'})</span></span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${larguraPct}%"></div></div>
        <span class="bar-row-valor">${r.totalRequests.toLocaleString('pt-BR')}</span>
      </div>
    `;
  }).join('');
}

function renderSegurancaIps(ips) {
  const tbody = document.getElementById('seguranca-tbody');

  if (!ips || ips.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhuma request registrada nesta janela.</td></tr>';
    return;
  }

  tbody.innerHTML = ips.map(item => {
    const origemHtml = item.cidade || item.regiao || item.pais
      ? `<span class="ip-origem"><span class="ip-origem-cidade">${escaparHtml(item.cidade || item.regiao || item.pais)}</span>${item.pais && item.cidade ? `, ${escaparHtml(item.pais)}` : ''}</span>`
      : '<span class="ip-origem">—</span>';

    const sinalizacaoHtml = item.suspeito
      ? `<span class="ip-sinalizacao-suspeita">${item.motivos.map(m => `<span class="ip-motivo-tag">${escaparHtml(m)}</span>`).join('')}</span>`
      : '<span class="ip-sinalizacao-ok">—</span>';

    return `
      <tr class="${item.suspeito ? 'ip-suspeito-row' : ''}">
        <td class="id-mono">${escaparHtml(item.ip)}</td>
        <td>${origemHtml}</td>
        <td>${item.totalRequests.toLocaleString('pt-BR')}</td>
        <td class="id-mono">${item.requestsPorMinuto}</td>
        <td class="id-mono">${item.rotasDistintas}</td>
        <td class="id-mono">${item.taxaErroPct}%</td>
        <td>${sinalizacaoHtml}</td>
      </tr>
    `;
  }).join('');
}

function renderSeguranca(data) {
  renderSegurancaPorRegiao(data.porRegiao);
  renderSegurancaIps(data.ips);

  const resumoEl = document.getElementById('seguranca-resumo');
  if (resumoEl) {
    resumoEl.textContent = `${data.ips.length} IP(s) na janela · ${data.totalSuspeitos} sinalizado(s)`;
  }

  const badge = document.getElementById('sidebar-badge-seguranca');
  if (badge) {
    if (data.totalSuspeitos > 0) {
      badge.textContent = data.totalSuspeitos > 99 ? '99+' : String(data.totalSuspeitos);
      badge.removeAttribute('hidden');
    } else {
      badge.setAttribute('hidden', '');
    }
  }
}

function renderSegurancaErro(mensagem) {
  document.getElementById('seguranca-por-regiao').innerHTML = `<div class="empty-state">${escaparHtml(mensagem)}</div>`;
  document.getElementById('seguranca-tbody').innerHTML = `<tr><td colspan="7" class="empty-state">${escaparHtml(mensagem)}</td></tr>`;
  const badge = document.getElementById('sidebar-badge-seguranca');
  if (badge) badge.setAttribute('hidden', '');
}

// Janela de tempo lida do <select> — persistida em localStorage (mesmo
// padrão de refresh-interval-select) pra sobreviver a um refresh de
// página sem voltar pro padrão de 15min toda vez.
const SEGURANCA_JANELA_KEY = 'mase-seguranca-janela-minutos';

function obterJanelaSeguranca() {
  const select = document.getElementById('seguranca-janela');
  return select ? select.value : '15';
}

async function carregarSeguranca(token) {
  try {
    const minutos = obterJanelaSeguranca();
    const data = await buscarJson(`${ENDPOINT_SEGURANCA_IPS}?minutos=${encodeURIComponent(minutos)}`, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    renderSeguranca(data);
  } catch (e) {
    renderSegurancaErro(`Erro ao carregar segurança (${e.message}).`);
  }
}

(function initSelectSeguranca() {
  const select = document.getElementById('seguranca-janela');
  if (!select) return;
  try {
    const salvo = localStorage.getItem(SEGURANCA_JANELA_KEY);
    if (salvo) select.value = salvo;
  } catch (e) {
    // localStorage indisponível nesta sessão — segue com o padrão (15min)
  }
  select.addEventListener('change', () => {
    try {
      localStorage.setItem(SEGURANCA_JANELA_KEY, select.value);
    } catch (e) {
      // sem persistência disponível nesta sessão, mas o filtro ainda aplica
    }
    const token = getToken();
    if (token) carregarSeguranca(token);
  });
})();

// Independentes entre si, igual o resto — roda tudo em paralelo.
async function carregarInsights(token) {
  await Promise.all([
    carregarRetencao(token),
    carregarFunil(token),
    carregarContasMortas(token),
    carregarChurn(token),
    carregarAvaliacoesInsights(token),
    carregarModeracao(token),
    carregarWhatsapp(token),
    carregarCobertura(token),
    carregarBuscasSemResultado(token),
    carregarDemandaNaoAtendida(token),
    carregarPrestadoresIncompletos(token)
  ]);
}

document.getElementById('modal-close-btn').addEventListener('click', fecharModal);


document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') fecharModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fecharModal();
});

// ---- Área reservada (logs técnicos) — recolhida por padrão ----

// ---- Abas laterais (Visão geral / Usuários / Localização / Logs) ----

const TITULOS_ABA = {
  'visao-geral': 'Visão geral',
  'alertas': 'Alertas',
  'status': 'Status',
  'seguranca': 'Segurança',
  'usuarios': 'Usuários',
  'localizacao': 'Localização',
  'graficos-tecnico': 'Gráficos técnicos',
  'graficos-comercial': 'Gráficos comerciais',
  'logs-cadastro': 'Logs de cadastro',
  'requests': 'Requests',
  'retencao': 'Retenção & Ativação',
  'avaliacoes': 'Avaliações'
};

function ativarAba(nomeAba) {
  document.querySelectorAll('.aba-conteudo').forEach(secao => {
    secao.setAttribute('hidden', '');
  });
  const alvo = document.getElementById('aba-' + nomeAba);
  if (alvo) alvo.removeAttribute('hidden');

  document.querySelectorAll('.sidebar-link[data-aba]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.aba === nomeAba);
  });

  document.getElementById('aba-titulo').textContent = TITULOS_ABA[nomeAba] || nomeAba;

  // Ver comentário em redimensionarGraficosArea(): o(s) gráfico(s) de área
  // podem ter sido (re)criados enquanto esta aba estava escondida.
  if (nomeAba === 'graficos-tecnico' || nomeAba === 'graficos-comercial') {
    redimensionarGraficosArea();
  }

  // Mesmo problema, mesma causa: o Leaflet do mapa de densidade também
  // pode ter sido criado (ou só existido) enquanto "Visão geral" estava
  // com hidden — Leaflet calcula o tamanho do container na hora da
  // criação, e um container hidden mede 0x0. invalidateSize() força ele a
  // remedir agora que a aba está visível de novo; sem isso o mapa aparece
  // cortado/cinza até alguém redimensionar a janela por acaso.
  if (nomeAba === 'visao-geral' && mapaDensidade) {
    setTimeout(() => mapaDensidade.invalidateSize(), 0);
  }
}

document.querySelectorAll('.sidebar-link[data-aba]').forEach(btn => {
  btn.addEventListener('click', () => ativarAba(btn.dataset.aba));
});

// ---- Sidebar retraível ----
// Persistido em localStorage igual o tema — reabrir o painel deve manter
// a preferência de "menu retraído" da última visita, na mesma sessão de
// navegador (mesma ressalva de previews sandboxed já documentada em
// initTheme/initTokenField).
const SIDEBAR_KEY = 'mase-sidebar-retraida';

function aplicarSidebarRetraida(retraida) {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  sidebar.classList.toggle('collapsed', retraida);
  btn.setAttribute('aria-label', retraida ? 'Expandir menu' : 'Retrair menu');
  btn.title = retraida ? 'Expandir menu' : 'Retrair menu';
}

function initSidebar() {
  let retraida = false;
  try {
    retraida = localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch (e) {
    // localStorage indisponível nesta sessão — segue expandida por padrão
  }
  aplicarSidebarRetraida(retraida);
}

document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
  const sidebar = document.getElementById('sidebar');
  const retraida = !sidebar.classList.contains('collapsed');
  aplicarSidebarRetraida(retraida);
  try {
    localStorage.setItem(SIDEBAR_KEY, retraida ? '1' : '0');
  } catch (e) {
    // sem persistência disponível nesta sessão, mas o estado ainda aplica visualmente
  }
});

initSidebar();

function renderNoData() {
  ['stat-online-agora', 'stat-ativos-hoje', 'stat-ativacoes-mes', 'stat-total-servicos', 'stat-erros-hoje'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
}

async function load() {
  const errorBanner = document.getElementById('error-banner');
  const token = getToken();

  if (!token) {
    renderNoData();
    renderUsuariosErro('Preencha o token de admin acima pra carregar os usuários.');
    renderRequestsErro('Preencha o token de admin acima pra carregar as requests.');
    renderLocalizacaoErro('Preencha o token de admin acima pra carregar.');
    renderLogsCadastroErro('Preencha o token de admin acima pra carregar.');
    renderGraficosTecnicosErro('Preencha o token de admin acima pra carregar.');
    renderGraficosComerciaisErro('Preencha o token de admin acima pra carregar.');
    renderInsightsErro('Preencha o token de admin acima pra carregar.');
    renderMapaDensidadeErro('Preencha o token de admin acima pra carregar o mapa.');
    renderAlertasErro('Preencha o token de admin acima pra carregar.');
    renderStatusErro('Preencha o token de admin acima pra carregar.');
    renderSegurancaErro('Preencha o token de admin acima pra carregar.');
    errorBanner.textContent = 'Preencha o token de admin acima pra carregar os dados reais.';
    errorBanner.style.display = 'block';
    document.getElementById('last-update').textContent = 'aguardando token';
    return;
  }

  // Card de stats do topo (online agora, ativações no mês etc.) — corre
  // por conta própria, separado do Promise.all abaixo. Antes os dois
  // estavam no mesmo try/catch: se só ESTE fetch falhasse (timeout, 500
  // pontual, token expirado bem nessa hora), o catch rodava ANTES do
  // Promise.all sequer ser chamado — as outras 11 abas nunca tentavam
  // carregar, mesmo saudáveis, e se já tivessem dado certo antes (refresh
  // automático), o erro sobrescrevia com "não foi possível carregar" um
  // dado que continuava bom. Separado assim, uma falha aqui afeta só os
  // 5 cards do topo.
  try {
    const data = await buscarJson(ENDPOINT, {
      headers: { 'Accept': 'application/json', 'X-Admin-Token': token }
    });
    render(data);
    errorBanner.style.display = 'none';
  } catch (e) {
    renderNoData();
    errorBanner.textContent = `Erro: não foi possível carregar os cards do topo (${e.message}). As outras abas seguem carregando normalmente.`;
    errorBanner.style.display = 'block';
  }

  // As 11 abas — cada carregarX() já trata o próprio erro por dentro
  // (mostra "não foi possível carregar" só naquela aba específica, via
  // renderXErro chamado no catch de cada uma) — por isso não precisa de
  // try/catch aqui em cima: uma falha de rede numa delas não deveria
  // nunca derrubar as outras, e agora também não depende mais do fetch
  // de stats acima ter dado certo. O try/catch continua só como rede de
  // segurança contra alguma dessas funções um dia esquecer de tratar o
  // próprio erro (regressão futura) — não deveria disparar no uso normal.
  try {
    await Promise.all([carregarUsuarios(token), carregarRequests(token), carregarLocalizacao(token), carregarLogsCadastro(token), carregarGraficosTecnicos(token), carregarGraficosComercial(token), carregarInsights(token), carregarMapaPrestadores(token), carregarAlertas(token), carregarStatus(token), carregarSeguranca(token)]);
  } catch (e) {
    console.error('Uma das abas não tratou o próprio erro internamente:', e);
  }

  document.getElementById('last-update').textContent = 'última tentativa: ' + new Date().toLocaleTimeString('pt-BR');
}

// Tema claro/escuro persistido em localStorage.
// Nota: dentro de previews sandboxed (ex: iframe do Claude.ai) localStorage pode não persistir
// entre sessões. Abrindo o arquivo diretamente no navegador ou hospedado normalmente, funciona.
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
    // localStorage indisponível (ex: preview sandboxed) — segue com padrão escuro nesta sessão
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
  // Recolore o(s) gráfico(s) de área na hora — ver comentário em
  // ultimoCadastrosPorDia sobre por que isso não acontece sozinho.
  if (ultimoCadastrosPorDia) {
    renderGraficoCadastrosPorDia(ultimoCadastrosPorDia);
  }
  // Troca os tiles do mapa de densidade pra variante clara/escura
  // correspondente (ver urlTilesParaTema) — sem isso o mapa ficaria
  // escuro dentro de um painel claro (ou vice-versa) até o próximo load().
  alternarTilesMapa();
});

// ---- Atualização automática — liga/desliga e intervalo configuráveis
// pelo botão no cabeçalho, persistidos em localStorage (mesmo padrão do
// tema e da sidebar retraída). Sem toggle marcado ou sem load() manual,
// os dados só mudam quando o usuário mexe nos controles ou dá F5. ----
const REFRESH_ENABLED_KEY = 'mase-refresh-enabled';
const REFRESH_INTERVAL_KEY = 'mase-refresh-interval-ms';
let refreshTimer = null;

function pararAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function reiniciarAutoRefresh() {
  pararAutoRefresh();
  const toggle = document.getElementById('auto-refresh-toggle');
  const select = document.getElementById('refresh-interval-select');
  if (!toggle.checked) return;
  const ms = parseInt(select.value, 10) || 30000;
  refreshTimer = setInterval(load, ms);
}

function initAutoRefresh() {
  const toggle = document.getElementById('auto-refresh-toggle');
  const select = document.getElementById('refresh-interval-select');

  let enabled = true;
  let intervalMs = '30000';
  try {
    const savedEnabled = localStorage.getItem(REFRESH_ENABLED_KEY);
    if (savedEnabled !== null) enabled = savedEnabled === '1';
    const savedInterval = localStorage.getItem(REFRESH_INTERVAL_KEY);
    if (savedInterval) intervalMs = savedInterval;
  } catch (e) {
    // localStorage indisponível (ex: preview sandboxed) — segue com o padrão (ligado, 30s)
  }

  toggle.checked = enabled;
  if (Array.from(select.options).some(o => o.value === intervalMs)) {
    select.value = intervalMs;
  }
  select.disabled = !toggle.checked;

  toggle.addEventListener('change', () => {
    select.disabled = !toggle.checked;
    try {
      localStorage.setItem(REFRESH_ENABLED_KEY, toggle.checked ? '1' : '0');
    } catch (e) {
      // sem persistência disponível nesta sessão, mas o toggle ainda funciona
    }
    reiniciarAutoRefresh();
  });

  select.addEventListener('change', () => {
    try {
      localStorage.setItem(REFRESH_INTERVAL_KEY, select.value);
    } catch (e) {
      // sem persistência disponível nesta sessão, mas o intervalo ainda aplica
    }
    reiniciarAutoRefresh();
  });

  reiniciarAutoRefresh();
}

initTheme();
initTokenField();
load();
initAutoRefresh();

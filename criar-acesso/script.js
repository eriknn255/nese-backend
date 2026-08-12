// ==========================================================================
// ADMINISTRAÇÃO DE LOGINS INTERNOS (ver comentário em index.html).
//
// Fluxo: token + e-mail -> consulta se a conta existe -> os botões
// disponíveis mudam conforme a resposta. Nenhum botão de ação aparece
// antes da consulta, de propósito: "Salvar" sem saber se a conta existe
// seria ambíguo, e o admin poderia sobrescrever alguém achando que
// estava criando.
//
// Nada aqui protege nada: todas as rotas exigem ADMIN_TOKEN + IP na
// allowlist no servidor. Esconder botão é conveniência de UX.
// ==========================================================================

const BASE_API = 'https://nese-be.ruexinternet.com/api/admin';
const ENDPOINT_STATUS = `${BASE_API}/bootstrap/status`;
const ENDPOINT_CONTAS = `${BASE_API}/contas`;
const ENDPOINT_CONSULTA = `${BASE_API}/contas/consulta`;
const ENDPOINT_REMOVER = `${BASE_API}/contas/remover`;

// null = ainda não consultado; true/false = resultado da última consulta.
// Zerado sempre que token ou e-mail mudam, senão os botões continuariam
// refletindo uma consulta de outro e-mail.
let contaExiste = null;

// Bloqueado = a página se apaga e vira um 404. Não mostra caixa, aviso
// nem título: qualquer texto próprio já confirmaria que existe ALGO aqui.
//
// LIMITE HONESTO DISTO: o arquivo é estático servido pelo Nginx, então o
// navegador JÁ recebeu 200 + HTML antes deste código rodar. O que se
// troca é só o que aparece na tela — na aba Network continua 200.
function mostrarBloqueio() {
  document.title = '404 Not Found';
  document.documentElement.innerHTML =
    '<head><title>404 Not Found</title></head>' +
    '<body style="background:#fff;color:#000;font-family:sans-serif;margin:0">' +
    '<center><h1>404 Not Found</h1></center><hr><center>nginx</center>' +
    '</body>';
}

function mostrarFormulario() {
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

function limparMensagem() {
  document.getElementById('msg').hidden = true;
}

// Reflete na UI o resultado da consulta. `existe` null volta ao estado
// inicial (só "Verificar e-mail").
function aplicarEstadoConsulta(existe, conta) {
  contaExiste = existe;
  const box = document.getElementById('consulta');

  document.getElementById('btn-verificar').hidden = existe !== null;
  // Fora da janela de horário o botão de criar aparece desabilitado e
  // explica o porquê. Aqui, ao contrário da tela de bloqueio, o silêncio
  // não ajuda: quem chegou até aqui já provou ter IP e token, e um botão
  // que falha sem dizer nada só gera dúvida sobre o sistema estar quebrado.
  const btnCriar = document.getElementById('btn-criar');
  btnCriar.hidden = existe !== false;
  btnCriar.disabled = !podeCriarConta;
  btnCriar.title = podeCriarConta ? '' : 'Criar login só é permitido dentro da janela de horário configurada.';
  document.getElementById('btn-salvar').hidden = existe !== true;
  document.getElementById('btn-apagar').hidden = existe !== true;

  if (existe === null) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  box.classList.toggle('consulta-existe', existe);
  if (existe) {
    box.textContent = `Já existe login para este e-mail. Salvar vai SOBRESCREVER nome, senha e nível — e derrubar as sessões abertas dessa pessoa.`;
    // Preenche com o que está valendo hoje: sem isso o formulário
    // começaria em branco e seria fácil trocar o nível de alguém sem
    // perceber. A senha não vem (só existe hash no servidor), então
    // sobrescrever SEMPRE define senha nova — é o comportamento honesto,
    // já que não há como "manter a atual" sem conhecê-la.
    if (conta) {
      document.getElementById('nome').value = conta.nome || '';
      document.getElementById('nivel').value = conta.nivel || 'ver';
      // Restrições atuais também: sem isso, sobrescrever começaria com os
      // campos em branco e o servidor recusaria — ou pior, o admin
      // digitaria de novo e trocaria sem querer o que já valia.
      preencherRestricoes(conta);
    }
  } else {
    box.textContent = podeCriarConta
      ? 'Nenhum login para este e-mail. Salvar vai criar uma conta nova.'
      : 'Nenhum login para este e-mail. Criar conta só é permitido dentro da janela de horário configurada.';
  }
}

// Qualquer mudança em token ou e-mail invalida a consulta anterior.
['token', 'email'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    if (contaExiste !== null) aplicarEstadoConsulta(null, null);
    limparMensagem();
  });
});

// Resposta genérica do portão de rede (ver MENSAGEM_GENERICA no backend).
// Precisa ser distinguida do 404 legítimo de "esse e-mail não tem login":
// os dois usam 404, mas um significa "você não deveria estar aqui" e o
// outro é resultado normal de uma consulta.
const MSG_PORTAO = 'Não foi possível concluir a operação.';

async function chamar(url, corpo, metodo) {
  const res = await fetch(url, {
    method: metodo || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': document.getElementById('token').value.trim()
    },
    body: JSON.stringify(corpo)
  });

  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));

  // Portão de rede recusou (IP saiu da allowlist, config mudou): a página
  // inteira vira 404, coerente com o estado inicial. Retorna undefined
  // pra quem chamou parar sem tentar usar resposta nenhuma.
  if (res.status === 404 && data.erro === MSG_PORTAO) {
    mostrarBloqueio();
    return undefined;
  }

  if (!res.ok) throw new Error(data.erro || `Falha (HTTP ${res.status}).`);
  return data;
}

function linhasPara(valor) {
  return String(valor || '').split('\n').map(x => x.trim()).filter(Boolean);
}

// Monta os <option> a partir do que o servidor mandou (GET
// /bootstrap/status). Fonte única: é a MESMA lista que ele usa pra
// validar (utils/opcoesRestricao.js). Antes as opções viviam escritas à
// mão no HTML e o servidor aceitava qualquer valor no formato certo —
// duas listas livres pra divergir em silêncio.
function montarSeletor(id, opcoes) {
  const el = document.getElementById(id);
  el.innerHTML = '';
  (opcoes || []).forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.valor;
    opt.textContent = o.rotulo;
    el.appendChild(opt);
  });
}

function montarSeletoresRestricao(opcoes) {
  if (!opcoes) return;
  montarSeletor('r-horario', opcoes.horarios);
  montarSeletor('r-fuso', opcoes.fusos);
  montarSeletor('r-paises', opcoes.paises);
  const horario = document.getElementById('r-horario');
  if ([...horario.options].some(o => o.value === '08:00-18:00')) horario.value = '08:00-18:00';
}

function dadosFormulario() {
  const pais = document.getElementById('r-paises').value;
  return {
    email: document.getElementById('email').value.trim(),
    nome: document.getElementById('nome').value.trim(),
    senha: document.getElementById('senha').value,
    nivel: document.getElementById('nivel').value,
    // Restrições DESTE login — obrigatórias no servidor (IP e horário).
    ips: linhasPara(document.getElementById('r-ips').value),
    horario: document.getElementById('r-horario').value,
    fusoHorario: document.getElementById('r-fuso').value,
    // O backend espera lista; o seletor é de escolha única, então vira
    // array de 0 ou 1 item. Vazio = sem restrição de país.
    paises: pais ? [pais] : []
  };
}

// Repõe nos seletores o que já está gravado. Não existe fallback pra
// valor fora da lista porque isso deixou de ser possível: o backend só
// aceita opções do menu (ver lerRestricoes em admin.js).
function preencherRestricoes(conta) {
  document.getElementById('r-ips').value = (conta.ips || '').split(',').filter(Boolean).join('\n');

  const definir = (id, valor) => {
    const el = document.getElementById(id);
    if ([...el.options].some(o => o.value === valor)) el.value = valor;
  };

  definir('r-horario', conta.horario || '');
  definir('r-fuso', conta.fusoHorario || '');
  definir('r-paises', (conta.paises || '').split(',').filter(Boolean)[0] || '');
}

async function comBotao(id, acao) {
  const btn = document.getElementById(id);
  const rotulo = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Aguarde…';
  try {
    await acao();
  } catch (e) {
    mostrarMensagem(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo;
  }
}

document.getElementById('btn-verificar').addEventListener('click', () => comBotao('btn-verificar', async () => {
  limparMensagem();
  const email = document.getElementById('email').value.trim();
  if (!email) return mostrarMensagem('Informe o e-mail.', true);

  const data = await chamar(ENDPOINT_CONSULTA, { email });
  if (!data) return;
  aplicarEstadoConsulta(Boolean(data.existe), data.conta);
}));

document.getElementById('btn-criar').addEventListener('click', () => comBotao('btn-criar', async () => {
  limparMensagem();
  const data = await chamar(ENDPOINT_CONTAS, dadosFormulario());
  if (!data) return;
  mostrarMensagem(`Login "${data.email}" criado como ${data.nivel}.`, false);
  document.getElementById('form').reset();
  aplicarEstadoConsulta(null, null);
}));

document.getElementById('btn-salvar').addEventListener('click', () => comBotao('btn-salvar', async () => {
  limparMensagem();
  const dados = dadosFormulario();
  if (!confirm(`Sobrescrever as credenciais de ${dados.email}? As sessões abertas dessa pessoa serão encerradas.`)) return;

  const data = await chamar(ENDPOINT_CONTAS, dados, 'PUT');
  if (!data) return;
  mostrarMensagem(`Credenciais de "${data.email}" atualizadas (${data.nivel}). Sessões abertas encerradas.`, false);
  document.getElementById('senha').value = '';
}));

document.getElementById('btn-apagar').addEventListener('click', () => comBotao('btn-apagar', async () => {
  limparMensagem();
  const email = document.getElementById('email').value.trim();
  if (!confirm(`Apagar para sempre o login de ${email}? Não dá pra desfazer.`)) return;

  const data = await chamar(ENDPOINT_REMOVER, { email });
  if (data === undefined) return;
  mostrarMensagem(`Login de "${email}" apagado.`, false);
  document.getElementById('form').reset();
  aplicarEstadoConsulta(null, null);
}));

// `permitido` (só IP) libera a PÁGINA; `podeCriar` (IP + horário + país)
// libera só a criação. É o que permite apagar/sobrescrever fora de hora
// sem afrouxar a regra de conceder acesso novo.
let podeCriarConta = false;


async function verificarRede() {
  try {
    const res = await fetch(ENDPOINT_STATUS);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.permitido) return mostrarBloqueio();
    podeCriarConta = data.podeCriar === true;
    montarSeletoresRestricao(data.opcoes);
    mostrarFormulario();
  } catch (e) {
    mostrarBloqueio();
  }
}

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

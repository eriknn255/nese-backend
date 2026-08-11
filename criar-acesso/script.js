// ==========================================================================
// CRIAR ACESSO — página de bootstrap (ver comentário em index.html).
//
// Fluxo: pergunta ao servidor se esta rede está liberada -> mostra o
// formulário OU o motivo do bloqueio -> cria o login com o ADMIN_TOKEN.
//
// Nada aqui protege coisa alguma: esconder o formulário é só pra não
// fazer a pessoa digitar tudo e tomar 403 no final. A trava real está em
// exigirRedeAutorizada + exigirAdmin no backend.
// ==========================================================================

const BASE_API = 'https://nese-be.ruexinternet.com/api/admin';
const ENDPOINT_STATUS = `${BASE_API}/bootstrap/status`;
const ENDPOINT_CONTAS = `${BASE_API}/contas`;

// Bloqueio: uma tela morta, sem motivo, IP ou instrução — e sem sequer
// o título/rodapé, que já revelariam pra que serve esta URL. O servidor
// também não manda nada além de um 404 genérico (ver MENSAGEM_GENERICA
// em redeAutorizada.js); mesmo que mandasse, não seria exibido aqui.
function mostrarBloqueio() {
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('form').hidden = true;
  document.getElementById('status-bloqueado').hidden = false;
}

function mostrarFormulario() {
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('status-bloqueado').hidden = true;
  document.getElementById('titulo').hidden = false;
  document.getElementById('subtitulo').hidden = false;
  document.getElementById('rodape').hidden = false;
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

    // Qualquer coisa que não seja um "permitido: true" explícito vira a
    // mesma tela morta — inclusive erro de rede. Nunca mostra o
    // formulário "no escuro".
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
  btn.textContent = 'Criando…';

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

    // 404 aqui = a janela fechou entre o carregamento da página e o envio
    // (horário virou, IP mudou). Volta pro estado de bloqueio em vez de
    // deixar um formulário que não funciona mais na tela.
    if (res.status === 404) return mostrarBloqueio();
    if (!res.ok) throw new Error(data.erro || `Falha ao criar (HTTP ${res.status}).`);

    mostrarMensagem(`Login "${data.email}" criado como ${data.nivel}. Já dá pra entrar no painel.`, false);
    document.getElementById('form').reset();
  } catch (e) {
    mostrarMensagem(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar login';
  }
});

verificarRede();

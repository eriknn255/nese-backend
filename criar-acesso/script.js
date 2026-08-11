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

function mostrarBloqueio(motivo, ip) {
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('form').hidden = true;
  document.getElementById('bloqueado-motivo').textContent = motivo;
  document.getElementById('bloqueado-ip').textContent = ip || '—';
  document.getElementById('status-bloqueado').hidden = false;
}

function mostrarFormulario(ip) {
  document.getElementById('status-verificando').hidden = true;
  document.getElementById('status-bloqueado').hidden = true;
  document.getElementById('ok-ip').textContent = ip || '—';
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

    if (!res.ok) {
      return mostrarBloqueio(data.erro || `Não foi possível verificar (HTTP ${res.status}).`, data.ip);
    }
    if (!data.permitido) {
      return mostrarBloqueio(data.motivo || 'Acesso não autorizado a partir desta rede.', data.ip);
    }
    mostrarFormulario(data.ip);
  } catch (e) {
    // Servidor fora do ar / CORS / rede caiu: não dá pra afirmar que está
    // liberado, então trata como bloqueio — nunca mostra o formulário "no
    // escuro". Se estiver liberado mesmo, recarregar resolve.
    mostrarBloqueio('Não foi possível falar com o servidor.', null);
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

    // 403 aqui = a janela fechou entre o carregamento da página e o envio
    // (horário virou, IP mudou). Volta pro estado de bloqueio em vez de
    // deixar um formulário que não funciona mais na tela.
    if (res.status === 403) {
      return mostrarBloqueio(data.erro || 'Acesso não autorizado a partir desta rede.', data.ip);
    }
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

const db = require("../db");

const MS_DIA = 24 * 60 * 60 * 1000;

// ==========================================================================
// RETENÇÃO DE request_logs — ver logRequisicao em server.js: toda request
// que passa pelo servidor (autenticada ou não, incluindo estáticos) grava
// uma linha ali, sem TTL nenhum até este job existir. Numa base com
// tráfego real isso cresce pra sempre; aqui mantemos só os últimos N dias
// (LOG_RETENCAO_DIAS no .env, default 90 dias se ausente/inválido — dá
// margem suficiente pra investigar um pico antigo tipo o de 21h-01h sem
// já ter sido varrido pelo job antes de alguém perceber).
//
// log_cadastros e auditoria_contas ficam de fora DE PROPÓSITO — são
// histórico/auditoria (ver comentário delas em schema.sql, "sobrevive à
// exclusão da conta"), não devem ter TTL. Só request_logs é tráfego
// recente sem valor de retenção longa.
// ==========================================================================
const RETENCAO_DIAS_PADRAO = 90;
const INTERVALO_MS = MS_DIA; // 1x por dia é sobra pra um job de limpeza, não precisa de mais

// Retorna { removidas, retencaoDias } — usado tanto pelo job automático
// (que ignora o retorno, só loga) quanto pela limpeza manual sob demanda
// (DELETE /api/admin/dashboard/requests em routes/admin.js, o botão
// "Limpar logs" do painel), que precisa devolver pro admin quantas linhas
// saíram. Uma função só, uma regra só de "o que é velho" — o botão manual
// e o job automático nunca podem divergir sobre isso.
function limparRequestLogsAntigos() {
    const retencaoBruta = Number.parseInt(process.env.LOG_RETENCAO_DIAS, 10);
    const retencaoDias = Number.isFinite(retencaoBruta) && retencaoBruta > 0 ? retencaoBruta : RETENCAO_DIAS_PADRAO;
    const limite = Date.now() - retencaoDias * MS_DIA;

    try {
        const info = db.prepare("DELETE FROM request_logs WHERE criado_em < ?").run(limite);
        if (info.changes > 0) {
            console.log(`[jobs] limpeza request_logs: ${info.changes} linha(s) com mais de ${retencaoDias} dia(s) removida(s).`);
        }
        return { removidas: info.changes, retencaoDias };
    } catch (erro) {
        // Mesmo princípio de criarNotificacao()/obterLocalizacaoPorCoordenadas():
        // um job de manutenção nunca pode derrubar o processo — só loga e
        // tenta de novo no próximo ciclo. Propaga o erro pra quem chamou sob
        // demanda (a rota do admin) poder responder 500 em vez de mentir
        // que a limpeza funcionou.
        console.error("Falha na limpeza de request_logs:", erro);
        throw erro;
    }
}

function iniciarJobLimpezaLogs() {
    // O job automático NUNCA pode derrubar o processo por causa disso —
    // diferente da chamada sob demanda (rota do admin), aqui ninguém está
    // esperando uma resposta, então um erro só pode ser logado e tentado
    // de novo no próximo ciclo, nunca propagado.
    const rodarComSeguranca = () => {
        try {
            limparRequestLogsAntigos();
        } catch (erro) {
            // já logado dentro de limparRequestLogsAntigos — só garante que
            // o setInterval não morre por causa de uma exceção não tratada.
        }
    };
    rodarComSeguranca(); // roda uma vez já na subida, não só depois de 24h
    setInterval(rodarComSeguranca, INTERVALO_MS);
}

module.exports = { iniciarJobLimpezaLogs, limparRequestLogsAntigos };

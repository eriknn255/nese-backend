const db = require("../db");

const MS_DIA = 24 * 60 * 60 * 1000;

// ==========================================================================
// RETENÇÃO DE request_logs — ver logRequisicao em server.js: toda request
// que passa pelo servidor (autenticada ou não, incluindo estáticos) grava
// uma linha ali, sem TTL nenhum até este job existir. Numa base com
// tráfego real isso cresce pra sempre; aqui mantemos só os últimos N dias
// (LOG_RETENCAO_DIAS no .env, default abaixo se ausente/inválido).
//
// log_cadastros e auditoria_contas ficam de fora DE PROPÓSITO — são
// histórico/auditoria (ver comentário delas em schema.sql, "sobrevive à
// exclusão da conta"), não devem ter TTL. Só request_logs é tráfego
// recente sem valor de retenção longa.
// ==========================================================================
const RETENCAO_DIAS_PADRAO = 30;
const INTERVALO_MS = MS_DIA; // 1x por dia é sobra pra um job de limpeza, não precisa de mais

function limparRequestLogsAntigos() {
    const retencaoBruta = Number.parseInt(process.env.LOG_RETENCAO_DIAS, 10);
    const retencaoDias = Number.isFinite(retencaoBruta) && retencaoBruta > 0 ? retencaoBruta : RETENCAO_DIAS_PADRAO;
    const limite = Date.now() - retencaoDias * MS_DIA;

    try {
        const info = db.prepare("DELETE FROM request_logs WHERE criado_em < ?").run(limite);
        if (info.changes > 0) {
            console.log(`[jobs] limpeza request_logs: ${info.changes} linha(s) com mais de ${retencaoDias} dia(s) removida(s).`);
        }
    } catch (erro) {
        // Mesmo princípio de criarNotificacao()/obterLocalizacaoPorCoordenadas():
        // um job de manutenção nunca pode derrubar o processo — só loga e
        // tenta de novo no próximo ciclo.
        console.error("Falha na limpeza de request_logs:", erro);
    }
}

function iniciarJobLimpezaLogs() {
    limparRequestLogsAntigos(); // roda uma vez já na subida, não só depois de 24h
    setInterval(limparRequestLogsAntigos, INTERVALO_MS);
}

module.exports = { iniciarJobLimpezaLogs };
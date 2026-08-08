const db = require("../db");

// Mesmas regras do front (PRAZO_AVALIACAO_DIAS): sem resposta do
// prestador em 7 dias, a avaliação é publicada automaticamente — o
// silêncio favorece o cliente, não bloqueia review legítima.
const PRAZO_AVALIACAO_MS = 1 * 24 * 60 * 60 * 1000;

// Antes isso só rodava "na leitura" (resolverExpiracoesAvaliacoes chamada
// toda vez que a fila era aberta) porque não tinha como ter um relógio de
// verdade sem servidor. Agora tem: roda de verdade em intervalo, não
// depende de alguém abrir a tela pra resolver o que já venceu.
function expirarAvaliacoesVencidas() {
    const limite = Date.now() - PRAZO_AVALIACAO_MS;

    const resultado = db.prepare(`
        UPDATE avaliacoes
        SET status = 'publicada', expirou_automaticamente = 1
        WHERE status = 'pendente' AND criado_em <= ?
    `).run(limite);

    if (resultado.changes > 0) {
        console.log(`[expirarAvaliacoes] ${resultado.changes} avaliação(ões) publicada(s) automaticamente por prazo vencido.`);
    }
}

// A cada hora é suficiente pro prazo ser em dias — não precisa granularidade
// de minuto. Roda uma vez já na subida do servidor também.
const INTERVALO_MS = 60 * 60 * 1000;

function iniciarJobExpiracao() {
    expirarAvaliacoesVencidas();
    return setInterval(expirarAvaliacoesVencidas, INTERVALO_MS);
}

module.exports = { iniciarJobExpiracao, expirarAvaliacoesVencidas };

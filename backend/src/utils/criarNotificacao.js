const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { enviarPush } = require("./push");

// ==========================================================================
// CRIAÇÃO DE NOTIFICAÇÃO IN-APP — chamado de dentro de outras rotas
// (avaliacoes.js, usuarios.js) sempre que um evento relevante acontece pra
// alguém. Nunca lança erro pra quem chamou: notificação é um "extra", uma
// falha aqui (ex: usuarioId inválido) não pode derrubar a ação principal
// (publicar avaliação, salvar prestador etc.) que já foi concluída antes
// dessa chamada.
// ==========================================================================
function criarNotificacao({ usuarioId, tipo, titulo, corpo = null, link = null }) {
    if (!usuarioId || !tipo || !titulo) return; // nunca notifica "ninguém" ou sem conteúdo mínimo

    try {
        db.prepare(`
            INSERT INTO notificacoes (id, usuario_id, tipo, titulo, corpo, link, lida, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `).run(uuidv4(), usuarioId, tipo, titulo, corpo, link, Date.now());

        // Depois do INSERT, nunca antes: se o envio falhar, a notificação
        // in-app já existe e a pessoa a vê ao abrir o app. Na ordem inversa,
        // um push poderia apontar pra algo que não está na lista.
        //
        // Dentro do try mesmo com o enviarPush() já engolindo os próprios
        // erros: a consulta ao banco que ele faz é síncrona e pode lançar, e
        // nada aqui pode derrubar a ação principal.
        enviarPush({ usuarioId, titulo, corpo, link });
    } catch (erro) {
        // Loga e segue — ver comentário acima sobre não derrubar a ação principal.
        console.error("Falha ao criar notificação (tipo:", tipo, "):", erro);
    }
}

module.exports = { criarNotificacao };

const db = require("../db");

// ==========================================================================
// AUDITORIA — histórico de alterações em usuarios/prestadores, GRAVADO
// INDEPENDENTE DE QUEM FEZ A MUDANÇA: tanto a moderação (routes/admin.js,
// origem='moderacao') quanto o PRÓPRIO DONO DA CONTA editando/excluindo
// pelo app normal (routes/usuarios.js e routes/prestadores.js,
// origem='usuario'). Isso existia só pro lado da moderação antes — passou
// a cobrir as duas origens porque o que importa pra fins jurídicos é o
// histórico DA CONTA, não só de quem tem o ADMIN_TOKEN (ver conversa que
// motivou isto: "o foco é no usuário").
//
// ator: rótulo de quem fez a mudança. Na moderação é o nome digitado no
// painel (ver nomeModerador em admin.js — não autentica nada, é só
// rótulo). Na origem 'usuario' é sempre "O próprio usuário" — aqui SIM
// dá pra confiar que foi a conta dona mesmo, porque a rota já passou por
// exigirUsuario + checagem de posse (req.usuario.id === :id, ou
// exigirDono pro prestador) antes de chegar em registrarAuditoria.
// ==========================================================================

function registrarAuditoria({ ator, origem, acao, entidadeTipo, entidadeId, alteracoes }) {
    db.prepare(`
        INSERT INTO log_auditoria_moderacao (moderador, origem, acao, entidade_tipo, entidade_id, alteracoes, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ator, origem, acao, entidadeTipo, entidadeId, alteracoes ? JSON.stringify(alteracoes) : null, Date.now());
}

// Monta { campo: { de, para } } só dos campos que de fato mudaram — evita
// gravar "editou" com um diff vazio quando o PATCH reenvia os mesmos
// valores (comum quando o front manda o form inteiro de volta).
function diffCampos(antes, depois) {
    const alteracoes = {};
    for (const campo of Object.keys(depois)) {
        const valorAntes = antes[campo];
        const valorDepois = depois[campo];
        const igual = Array.isArray(valorDepois)
            ? JSON.stringify(valorAntes) === JSON.stringify(valorDepois)
            : valorAntes === valorDepois;
        if (!igual) alteracoes[campo] = { de: valorAntes ?? null, para: valorDepois ?? null };
    }
    return Object.keys(alteracoes).length > 0 ? alteracoes : null;
}

module.exports = { registrarAuditoria, diffCampos };

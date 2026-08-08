const express = require("express");
const db = require("../db");
const { exigirUsuario } = require("../middleware/identidade");

const router = express.Router();

// ==========================================================================
// NOTIFICAÇÕES IN-APP — o "sino" no header. Toda rota aqui é escopada ao
// próprio usuário logado (req.usuario.id), igual o resto do app faz com
// "salvos" e "meus cadastros" — ninguém lê ou marca como lida a
// notificação de outra conta.
// ==========================================================================

// GET /api/notificacoes — lista as notificações do usuário, mais recentes
// primeiro. Limita a 50: isso é uma lista de sino, não um histórico
// completo — se crescer além disso no futuro, vira caso de paginação.
router.get("/", exigirUsuario, (req, res) => {
    const linhas = db.prepare(`
        SELECT id, tipo, titulo, corpo, link, lida, criado_em AS criadoEm
        FROM notificacoes
        WHERE usuario_id = ?
        ORDER BY criado_em DESC
        LIMIT 50
    `).all(req.usuario.id);

    res.json(linhas.map(n => ({ ...n, lida: !!n.lida })));
});

// GET /api/notificacoes/nao-lidas — só a contagem, pra desenhar o badge
// numérico no sino sem baixar a lista inteira. É essa rota que o front
// chama em polling (ver ATRASO_POLLING_NOTIFICACOES em 01-constantes.js),
// então fica deliberadamente leve (um COUNT, sem SELECT * nem JOIN).
router.get("/nao-lidas", exigirUsuario, (req, res) => {
    const { total } = db.prepare("SELECT COUNT(*) AS total FROM notificacoes WHERE usuario_id = ? AND lida = 0")
        .get(req.usuario.id);
    res.json({ total });
});

// POST /api/notificacoes/:id/lida — marca UMA notificação como lida (ao
// tocar nela no front, antes de navegar pro destino do link).
router.post("/:id/lida", exigirUsuario, (req, res) => {
    const info = db.prepare("UPDATE notificacoes SET lida = 1 WHERE id = ? AND usuario_id = ?")
        .run(req.params.id, req.usuario.id);
    if (info.changes === 0) return res.status(404).json({ erro: "Notificação não encontrada." });
    res.status(204).end();
});

// POST /api/notificacoes/marcar-todas-lidas — botão "Marcar tudo como lido"
// no topo do painel do sino.
router.post("/marcar-todas-lidas", exigirUsuario, (req, res) => {
    db.prepare("UPDATE notificacoes SET lida = 1 WHERE usuario_id = ? AND lida = 0").run(req.usuario.id);
    res.status(204).end();
});

module.exports = router;
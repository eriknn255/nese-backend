/* ==========================================================================
   COLE ESTE BLOCO EM backend/src/routes/usuarios.js

   ONDE: logo depois de `const router = express.Router();` (ou em qualquer
   ponto ANTES da linha 272, `router.get("/:id", ...)`).

   A POSIÇÃO NÃO É DETALHE. O Express casa rotas na ORDEM DE REGISTRO, e este
   arquivo já tem `router.delete("/:id", ...)` lá na linha 485. Se o DELETE
   /dispositivos for registrado depois dele, "dispositivos" cai como valor de
   `:id` e a requisição entra na rota de EXCLUIR CONTA. O exigirUsuario
   barraria (o id não bate com a sessão), mas depender disso é sorte, não
   projeto. Registrando antes, a rota específica ganha e o `/:id` nunca vê
   essas chamadas.
   ========================================================================== */

// ==========================================================================
// APARELHOS DA CONTA (push) — o token do FCM é do APARELHO, a sessão é da
// CONTA, e o mesmo aparelho pode trocar de dono (alguém sai e outra pessoa
// entra). Por isso a chave primária é o token e o usuario_id é sobrescrito
// no conflito: o vínculo antigo morre no mesmo instante em que o novo nasce,
// sem deixar o aparelho recebendo aviso de duas contas.
// ==========================================================================

// POST /api/usuarios/dispositivos — registra/atualiza este aparelho.
router.post("/dispositivos", exigirUsuario, (req, res) => {
    const { token, plataforma } = req.body || {};
    if (!token || typeof token !== "string") {
        return res.status(400).json({ erro: "Token do dispositivo ausente." });
    }

    db.prepare(`
        INSERT INTO dispositivos (token, usuario_id, plataforma, criado_em)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
            usuario_id = excluded.usuario_id,
            plataforma = excluded.plataforma
    `).run(token, req.usuario.id, plataforma === "ios" ? "ios" : "android", Date.now());

    res.status(204).end();
});

// DELETE /api/usuarios/dispositivos — esquece este aparelho (ao sair da conta).
//
// O token vai no CORPO, não na URL: um token de FCM tem ~160 caracteres e
// caracteres que precisariam de escape em path. O app manda com
// `@HTTP(method = "DELETE", hasBody = true)`.
router.delete("/dispositivos", exigirUsuario, (req, res) => {
    const { token } = req.body || {};
    if (token) {
        // Restrito ao dono: sem o `AND usuario_id`, qualquer conta logada
        // poderia desregistrar o aparelho de outra pessoa só sabendo o token.
        db.prepare("DELETE FROM dispositivos WHERE token = ? AND usuario_id = ?")
            .run(token, req.usuario.id);
    }
    res.status(204).end();
});

const express = require("express");
const db = require("../db");

const router = express.Router();

// ==========================================================================
// POST /api/buscas/sem-resultado
// Chamado pelo client (tela de busca do app) toda vez que uma busca de
// prestadores volta com ZERO resultados — mesmo categoria/lat/lng/raio que
// já vai pro GET /prestadores da própria busca, só que aqui é
// fire-and-forget: o client não precisa esperar nem tratar a resposta,
// é só telemetria (ver comentário completo em db.js, CREATE TABLE
// buscas_sem_resultado).
//
// SEM exigirAdmin: essa rota é pública igual GET /prestadores (a maioria
// das buscas no app não exige login) — req.usuario aqui vem só do
// identificarUsuario global (ver server.js), que anexa null se não tiver
// token, sem bloquear a request.
//
// Não faz reverse geocoding aqui — grava lat/lng cru e deixa o job de
// background preencher município/estado/país depois (mesmo motivo do
// POST /prestadores: não atrasar uma resposta que o usuário está
// esperando na tela com uma chamada externa ao Nominatim).
// ==========================================================================
router.post("/sem-resultado", (req, res) => {
    const { categoria, lat, lng, raio_km } = req.body || {};

    if (typeof categoria !== "string" || !categoria.trim()) {
        return res.status(400).json({ erro: "categoria é obrigatória." });
    }
    if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).json({ erro: "lat/lng são obrigatórios e devem ser números." });
    }

    db.prepare(`
        INSERT INTO buscas_sem_resultado (categoria, lat, lng, raio_km, usuario_id, criado_em)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        categoria.trim(),
        lat,
        lng,
        typeof raio_km === "number" && !Number.isNaN(raio_km) ? raio_km : null,
        req.usuario ? req.usuario.id : null,
        Date.now()
    );

    // 204: não tem corpo de resposta significativo — o client dispara e
    // segue em frente, não precisa aguardar nem exibir nada com isso.
    res.status(204).end();
});

module.exports = router;
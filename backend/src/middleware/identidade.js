const jwt = require("jsonwebtoken");
const db = require("../db");

// ==========================================================================
// IDENTIDADE — a conta em si nasce de POST /usuarios/entrar-google, que
// confere a assinatura do ID token do Google antes de criar/recuperar o
// usuário (ver routes/usuarios.js). Ninguém cria conta só inventando um
// telefone.
//
// A SESSÃO agora é um JWT de curta duração assinado por NÓS (JWT_SECRET,
// ver .env) — não é mais o id "eterno" cru. entrar-google devolve esse
// token; o cliente manda em toda request seguinte como
// "Authorization: Bearer <token>". O token expira (ver expiresIn em
// usuarios.js), tem assinatura própria (ninguém forja sem o segredo) e
// não depende de bater com nada gravável só no cliente — quem descobrir
// o id de outra pessoa não consegue mais se passar por ela, só quem tiver
// o token válido.
// ==========================================================================
const JWT_SECRET = process.env.JWT_SECRET;

// Anexa req.usuario quando vem um Bearer token válido (assinatura ok, não
// expirado, e o usuário ainda existe no banco). Não bloqueia a request —
// quem exige identidade usa exigirUsuario abaixo.
function identificarUsuario(req, res, next) {
    const cabecalho = req.header("Authorization");
    if (!cabecalho || !cabecalho.startsWith("Bearer ") || !JWT_SECRET) {
        req.usuario = null;
        return next();
    }

    const token = cabecalho.slice("Bearer ".length).trim();
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.usuario = db.prepare("SELECT id, nome, email, telefone FROM usuarios WHERE id = ?").get(payload.sub) || null;
    } catch (erro) {
        // Token ausente, expirado, adulterado ou assinado com outro
        // segredo — qualquer um desses vira "não identificado", não erro
        // 500. Quem exige identidade decide o que fazer com isso.
        req.usuario = null;
    }
    next();
}

// Pra rotas que exigem alguém identificado (cadastrar prestador, avaliar,
// salvar, decidir avaliação pendente).
function exigirUsuario(req, res, next) {
    if (!req.usuario) {
        return res.status(401).json({ erro: "Sessão inválida ou expirada. Entre com o Google novamente (POST /api/usuarios/entrar-google)." });
    }
    next();
}

// ==========================================================================
// PRESENÇA — grava usuarios.last_seen_at a cada request autenticada, usado
// só pelo painel interno (routes/admin.js) pra calcular "usuários ativos".
// Throttled em memória (Map usuarioId -> timestamp da última gravação): sem
// isso, cada request autenticada (e o app faz várias por minuto de uso
// normal) viraria um UPDATE no SQLite, sem necessidade nenhuma pra uma
// métrica que só precisa de granularidade de minutos, não de milissegundo.
//
// O Map cresce com o número de usuários DIFERENTES que passaram pelo
// servidor desde o último restart, não a cada request — pm2 reinicia o
// processo periodicamente de qualquer forma (deploy, crash recovery), o
// que já limpa o Map sozinho; não é um vazamento de memória de longo prazo
// pro tamanho de base de usuários que esse app tem hoje. Se um dia isso
// virar um problema de verdade, dá pra trocar por um LRU com tamanho
// máximo — não vale a complexidade agora.
const ULTIMA_GRAVACAO_PRESENCA = new Map();
const THROTTLE_PRESENCA_MS = 60 * 1000; // no máximo 1 UPDATE por usuário por minuto

function registrarPresenca(req, res, next) {
    if (!req.usuario) return next(); // request anônima, nada a registrar

    const agora = Date.now();
    const ultimaGravacao = ULTIMA_GRAVACAO_PRESENCA.get(req.usuario.id);

    if (!ultimaGravacao || agora - ultimaGravacao >= THROTTLE_PRESENCA_MS) {
        ULTIMA_GRAVACAO_PRESENCA.set(req.usuario.id, agora);
        // Sem esperar/tratar erro de propósito — presença é um "extra",
        // igual criarNotificacao(): uma falha aqui nunca pode derrubar a
        // request de verdade que o usuário está fazendo.
        try {
            db.prepare("UPDATE usuarios SET last_seen_at = ? WHERE id = ?").run(agora, req.usuario.id);
        } catch (erro) {
            console.error("Falha ao registrar presença:", erro);
        }
    }

    next();
}

module.exports = { identificarUsuario, exigirUsuario, registrarPresenca };
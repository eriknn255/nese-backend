const jwt = require("jsonwebtoken");
const db = require("../db");

// ==========================================================================
// LOGIN INTERNO — dashboard e moderação. Duas coisas propositalmente
// separadas:
//
// 1. ADMIN_TOKEN (ver exigirAdmin em routes/admin.js): segredo fixo do
//    .env, só serve pra UMA coisa agora — criar um login novo
//    (POST /api/admin/contas). Ninguém cria conta de admin sem esse
//    segredo, nem um "full" já logado.
//
// 2. Login de verdade (email + senha, tabela `admins` em db.js): é o que
//    autentica o acesso ao dashboard/moderação no dia a dia. Cada login
//    tem um nível — 'ver' (só dashboard, só leitura) ou 'full' (dashboard
//    + moderação, leitura e escrita) — ver ROTAS_NIVEL_MINIMO em
//    routes/admin.js pra onde cada nível abre.
//
// A SESSÃO é um JWT próprio (ADMIN_SESSION_SECRET — segredo DIFERENTE do
// JWT_SECRET de usuário comum, de propósito: um token de sessão de
// usuário forjado/vazado não pode virar sessão de admin só por acidente
// de reaproveitar segredo). Mandado no MESMO header que o ADMIN_TOKEN
// antigo usava (X-Admin-Token) — não é confusão: são rotas diferentes,
// cada uma com seu middleware, então o mesmo nome de header carrega
// conteúdo diferente dependendo de qual rota o front está chamando. Isso
// foi de propósito pra não precisar tocar nas dezenas de `fetch(...,
// {headers: {'X-Admin-Token': token}})` que já existiam no dashboard —
// só a origem do valor de `token` mudou (era o segredo colado à mão,
// agora é o JWT devolvido pelo login).
// ==========================================================================
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;

// Anexa req.admin quando o header traz uma sessão válida (assinatura ok,
// não expirada, e o login ainda existe no banco — revogar em GET /contas
// DELETE mata a sessão na hora seguinte, sem esperar o JWT expirar
// sozinho). Não bloqueia a request; quem exige nível usa exigirNivel.
function identificarAdmin(req, res, next) {
    req.admin = null;
    const token = req.header("X-Admin-Token");
    if (!token || !ADMIN_SESSION_SECRET) return next();

    try {
        const payload = jwt.verify(token, ADMIN_SESSION_SECRET);
        const admin = db.prepare("SELECT id, email, nome, nivel, senha_alterada_em FROM admins WHERE id = ?").get(payload.sub);

        // Sessão emitida ANTES da última troca de senha morre agora. É o
        // que faz "trocar a senha" expulsar quem estava dentro — sem
        // isso, um token roubado sobreviveria à troca por até 12h,
        // justamente no cenário em que se troca a senha por suspeita de
        // vazamento.
        //
        // Comparação em SEGUNDOS dos dois lados. `iat` do JWT vem em
        // segundos (padrão da spec) e senha_alterada_em em milissegundos —
        // comparar em ms invalidaria até o token novo devolvido pela
        // própria troca de senha: emitido no mesmo instante, seu `iat`
        // truncado pra segundo fica alguns milissegundos "antes" do
        // carimbo da troca. Quem trocasse a senha era deslogado no ato.
        //
        // O efeito colateral é uma janela de 1 segundo em que um token
        // antigo emitido no mesmo segundo da troca sobrevive. Irrelevante
        // na prática, e o preço de não quebrar o caso normal.
        const alteradaEmSegundos = Math.floor((admin && admin.senha_alterada_em || 0) / 1000);
        if (admin && admin.senha_alterada_em && (payload.iat || 0) < alteradaEmSegundos) {
            req.admin = null;
            return next();
        }

        req.admin = admin || null;
    } catch (erro) {
        // Token ausente, expirado, adulterado, ou (comum!) na verdade é o
        // ADMIN_TOKEN estático colado no campo errado — qualquer um desses
        // vira "não autenticado", nunca erro 500.
        req.admin = null;
    }
    next();
}

const NIVEIS = { ver: 1, full: 2 };

// exigirNivel('ver')  -> loga tanto 'ver' quanto 'full' (dashboard).
// exigirNivel('full') -> só 'full' (escrita em qualquer lugar + moderação
// inteira, ver "ver só tem acesso à dashboard" na conversa que motivou
// isto).
function exigirNivel(minimo) {
    if (!ADMIN_SESSION_SECRET) {
        return (req, res) => res.status(500).json({ erro: "Servidor sem ADMIN_SESSION_SECRET configurado (ver .env)." });
    }
    return (req, res, next) => {
        if (!req.admin) {
            return res.status(401).json({ erro: "Faça login pra continuar." });
        }
        if (NIVEIS[req.admin.nivel] < NIVEIS[minimo]) {
            return res.status(403).json({ erro: "Seu login não tem permissão pra isso (nível 'ver' só acessa a dashboard)." });
        }
        next();
    };
}

module.exports = { identificarAdmin, exigirNivel };

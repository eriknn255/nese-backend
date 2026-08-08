require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./db"); // aplica schema + semeia demo antes de tudo

const { identificarUsuario, registrarPresenca } = require("./middleware/identidade");
const rotasUsuarios = require("./routes/usuarios");
const rotasPrestadores = require("./routes/prestadores");
const rotasAvaliacoes = require("./routes/avaliacoes");
const rotasNotificacoes = require("./routes/notificacoes");
const rotasAdmin = require("./routes/admin");
const rotasBuscas = require("./routes/buscas");
const { iniciarJobExpiracao } = require("./jobs/expirarAvaliacoes");
const { iniciarJobLimpezaLogs } = require("./jobs/limparRequestLogs");
const { iniciarJobGeocodificacaoPrestadores } = require("./jobs/geocodificarPrestadores");
const { iniciarJobGeocodificacaoBuscasSemResultado } = require("./jobs/geocodificarBuscasSemResultado");

const app = express();
app.set("trust proxy", 1);

// ==========================================================================
// CORS — restrito por allowlist via CORS_ORIGIN no .env (uma ou mais
// origens separadas por vírgula, ex: "https://nese.app,https://admin.nese.app").
// Sem CORS_ORIGIN configurado, cai pro comportamento antigo (libera
// qualquer origem) — não quebra quem já estava rodando sem essa variável,
// só ganha a proteção real ao configurá-la em produção. O aviso no console
// existe pra isso não passar despercebido: "funciona sem configurar" não
// deveria significar "ninguém percebe que configurar era importante".
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const origensPermitidas = CORS_ORIGIN
    ? CORS_ORIGIN.split(",").map(o => o.trim()).filter(Boolean)
    : null;

if (!origensPermitidas) {
    console.warn("[cors] CORS_ORIGIN não configurado no .env — liberando qualquer origem. Configure antes de ir pra produção.");
}

app.use(cors(origensPermitidas ? {
    origin(origem, callback) {
        // "origem" vem undefined em requests sem header Origin (ex: curl,
        // server-to-server, ou o dashboard aberto direto via file://) —
        // deixa passar, já que CORS é uma restrição de NAVEGADOR, não uma
        // autenticação (quem quiser bater na API sem Origin sempre podia).
        if (!origem || origensPermitidas.includes(origem)) {
            return callback(null, true);
        }
        callback(new Error(`Origem não permitida por CORS: ${origem}`));
    }
} : undefined));
app.use(express.json());
app.use(identificarUsuario); // anexa req.usuario (ou null) em toda request
app.use(registrarPresenca);  // grava last_seen_at (throttled) — ver middleware/identidade.js

// ==========================================================================
// LOG DE REQUESTS — grava em request_logs (ver schema.sql) TODA request que
// passa pelo servidor, autenticada ou não, incluindo os arquivos estáticos
// abaixo (loga que a ROTA foi acessada, nunca o conteúdo do arquivo — o
// painel interno vê o ecossistema inteiro, com essa única exceção
// deliberada). Fica ANTES do express.static de propósito: senão a resposta
// de um arquivo estático nunca passaria por aqui.
//
// req.route só existe depois que um Router bate a rota (não existe pra
// arquivo estático nem pra 404) — por isso usamos req.path sempre, nunca
// req.route.path: um único formato de "rota" pra toda linha da tabela, sem
// caso especial.
//
// Não bloqueia nem atrasa a resposta: o INSERT roda no evento "finish" (a
// resposta já foi enviada ao cliente antes do log gravar), e falha de log
// nunca derruba a request de verdade — mesmo princípio de
// criarNotificacao()/registrarPresenca().
function logRequisicao(req, res, next) {
    const inicio = process.hrtime.bigint();

    res.on("finish", () => {
        const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
        try {
            db.prepare(`
                INSERT INTO request_logs (metodo, rota, status_code, duracao_ms, usuario_id, ip, porta, user_agent, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                req.method,
                req.path,
                res.statusCode,
                Math.round(duracaoMs),
                req.usuario ? req.usuario.id : null,
                req.ip || null,
                // req.socket.remotePort: porta da conexão TCP que chega no
                // processo Node — atrás de um proxy reverso (Nginx), é a
                // porta da perna proxy→Node, não a porta de origem do
                // cliente (mesma ressalva já feita em log_cadastros, ver
                // routes/usuarios.js). Ainda assim útil rodando local
                // (sem proxy na frente): reflete a porta real do cliente.
                req.socket ? req.socket.remotePort : null,
                req.headers["user-agent"] || null,
                Date.now()
            );
        } catch (erro) {
            console.error("Falha ao gravar request_log:", erro);
        }
    });

    next();
}

app.use(logRequisicao);

// Fotos/vídeos servidos direto da raiz de public/<id>/... (capa, avatar,
// reviews — ver "PASTA POR PRESTADOR"/"PASTA POR USUÁRIO" em
// routes/prestadores.js e routes/usuarios.js). Sem segmento "/uploads"
// no meio: quanto menos nível fixo precisa bater igual entre o caminho
// que o front monta e o que o back grava, menor a chance de os dois
// dessincronizarem de novo (foi exatamente isso que quebrou antes — front
// e back concordavam em tudo, MENOS na ordem de "capa" vs "<id>").
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/usuarios", rotasUsuarios);
app.use("/api/prestadores", rotasPrestadores);
app.use("/api", rotasAvaliacoes); // /api/prestadores/:id/avaliacoes*, /api/avaliacoes/:id/*
app.use("/api/notificacoes", rotasNotificacoes);
app.use("/api/admin", rotasAdmin);
app.use("/api/buscas", rotasBuscas);

app.get("/api/saude", (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

// Handler de erro genérico — evita vazar stack trace pro cliente em
// produção, mas loga completo no servidor pra debugar.
app.use((erro, req, res, next) => {
    console.error(erro);
    res.status(500).json({ erro: "Erro interno." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[mase-backend] rodando em http://localhost:${PORT}`);
    iniciarJobExpiracao();
    iniciarJobLimpezaLogs();
    iniciarJobGeocodificacaoPrestadores();
    iniciarJobGeocodificacaoBuscasSemResultado();
});
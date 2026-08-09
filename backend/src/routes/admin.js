const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const db = require("../db");
const { obterLocalizacoesEmLote } = require("../utils/ipLocalizacao");
const { temAlgumaCapa } = require("../utils/midia");
const { limparRequestLogsAntigos } = require("../jobs/limparRequestLogs");

const router = express.Router();

// ==========================================================================
// PAINEL INTERNO — alimenta o dashboard HTML estático (index.html/style.css/
// script.js, fora deste repo) que só o Erik acessa. NÃO é uma conta de
// usuário comum (não passa por identidade.js/JWT de sessão) — é protegido
// por um token fixo de servidor (ADMIN_TOKEN, ver .env), comparado no
// header "X-Admin-Token". Simples de propósito: não existe conceito de
// "usuário admin" no schema hoje, e criar um sistema de roles inteiro só
// pra isso seria trabalho que essa necessidade não pede ainda.
//
// SEM ADMIN_TOKEN configurado no .env, a rota inteira responde 500 — nunca
// abre sem proteção nenhuma "por engano" em produção.
// ==========================================================================
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_TOKEN_BUFFER = ADMIN_TOKEN ? Buffer.from(ADMIN_TOKEN) : null;

function exigirAdmin(req, res, next) {
    if (!ADMIN_TOKEN) {
        return res.status(500).json({ erro: "Servidor sem ADMIN_TOKEN configurado (ver .env)." });
    }
    const token = req.header("X-Admin-Token") || "";
    const tokenBuffer = Buffer.from(token);

    // crypto.timingSafeEqual em vez de "===": comparação char-a-char (o
    // que "===" faz em strings) sai mais rápido quanto mais cedo os
    // caracteres divergem, o que em teoria vaza (por timing) quantos
    // caracteres do token um atacante já acertou. timingSafeEqual sempre
    // compara os bytes inteiros, em tempo constante. Precisa dos dois
    // buffers do MESMO tamanho antes de comparar (ele lança erro se não
    // forem) — por isso o "tamanhosIguais" checado primeiro, com "&&"
    // curto-circuitando pra nunca chamar timingSafeEqual com tamanhos
    // diferentes.
    const tamanhosIguais = tokenBuffer.length === ADMIN_TOKEN_BUFFER.length;
    const tokenValido = tamanhosIguais && crypto.timingSafeEqual(tokenBuffer, ADMIN_TOKEN_BUFFER);

    if (!tokenValido) {
        return res.status(401).json({ erro: "Token de admin inválido." });
    }
    next();
}

// Lê ?limit= da query string, com um teto (LIMITE_MAXIMO) pra ninguém
// pedir "limit=999999999" e forçar um SELECT gigante — sempre volta um
// inteiro positivo válido, nunca NaN nem negativo (cai no padrão nesses
// casos, nunca gera erro 400 por isso: é só um parâmetro de conveniência
// do painel, não uma validação de contrato de API).
function lerLimite(req, padrao, maximo) {
    const bruto = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(bruto) || bruto <= 0) return padrao;
    return Math.min(bruto, maximo);
}

const MS_HORA = 60 * 60 * 1000;
const MS_DIA = 24 * MS_HORA;

// Mesmo limiar usado pro ponto verde/cinza na lista de usuários e pro
// card "Online agora". 5 minutos porque registrarPresenca (ver
// middleware/identidade.js) já faz throttle de 1 gravação por minuto por
// usuário — um limiar menor que isso não ganharia precisão real, só
// mostraria "offline" por até 1min depois da última request de alguém
// que na prática ainda está usando. Calculado aqui (servidor) e não no
// front de propósito: evita depender do relógio do navegador de quem
// está olhando o painel bater com o do servidor que gravou last_seen_at.
const MS_ONLINE = 5 * 60 * 1000;

// ==========================================================================
// O QUE CONTA COMO "ERRO" nas métricas do painel (card "Erros hoje", gráfico
// "Erros por hora", "erros-por-rota", "rotas-populares" e na detecção de
// rota com taxa de erro alta que alimenta Alertas). Usado em TODAS essas
// queries — um lugar só decide a régua, pra nunca ficar uma métrica
// discordando de outra sobre o que é ou não erro.
//
// status_code >= 400, MAS excluindo 401 e 403 de propósito: esses dois são
// autenticação/autorização REJEITANDO CORRETAMENTE quem não tinha
// permissão — o servidor fez exatamente o que devia, não é uma falha.
// Antes disso, um 401 de alguém testando o painel sem token (ou com token
// vencido) contava igual a um 500 de verdade: como o painel bate em ~12
// endpoints a cada ciclo de auto-refresh, isso inflava "erros" com volume
// alto e constante sem sinalizar problema nenhum — foi exatamente o que
// gerou o pico de "Erros por hora" investigado antes de existir esta
// constante. 404/422/429/500 etc. continuam contando normalmente: esses
// sim tendem a indicar algo pra investigar (rota errada, payload
// inválido, rate limit, bug no servidor).
const CONDICAO_SQL_ERRO = "status_code >= 400 AND status_code NOT IN (401, 403)";

// GET /api/admin/dashboard/data
router.get("/dashboard/data", exigirAdmin, (req, res) => {
    const agora = Date.now();
    const inicioHoje = agora - MS_DIA;

    const { total: ativosHoje } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE last_seen_at >= ?"
    ).get(inicioHoje);

    // Início do mês corrente no horário local do servidor, em epoch ms —
    // bate com o mesmo Date.now() usado em criado_em na hora do cadastro.
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);

    const { total: ativacoesMes } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE criado_em >= ?"
    ).get(inicioMes.getTime());

    const { total: onlineAgora } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE last_seen_at >= ?"
    ).get(agora - MS_ONLINE);

    const { total: totalServicos } = db.prepare(
        "SELECT COUNT(*) AS total FROM prestadores"
    ).get();

    const { total: errosHoje } = db.prepare(
        `SELECT COUNT(*) AS total FROM request_logs WHERE ${CONDICAO_SQL_ERRO} AND criado_em >= ?`
    ).get(inicioHoje);

    res.json({
        stats: {
            ativosHoje,
            ativacoesMes,
            onlineAgora,
            totalServicos,
            errosHoje
        }
    });
});

// GET /api/admin/dashboard/localizacao
// Métricas de País/Estado/Cidade — agregadas a partir de log_cadastros
// (ver schema.sql), única tabela que guarda o resultado do geocoding
// reverso (utils/localizacao.js), feito uma vez por cadastro novo. NÃO
// dá pra tirar isso de `usuarios` porque essa tabela nunca teve essas
// colunas — log_cadastros é a fonte real, inclusive sobrevive à exclusão
// da conta (ver comentário na criação da tabela), então a contagem
// histórica não desaparece se alguém excluir a conta depois.
// GROUP BY ignora NULL de propósito (WHERE ... IS NOT NULL): cadastro
// sem permissão de localização, ou onde o Nominatim falhou, não deve
// virar uma barra fantasma "desconhecido" competindo com dados reais.
//
// pontosUsuarios: um ponto (lat/lng cru, sem agregação) por cadastro com
// coordenada conhecida — mesma ideia de GET /dashboard/mapa-prestadores,
// só que pro lado do CLIENTE em vez do prestador. Até agora só existia
// densidade geográfica de prestador nesse painel; isso alimenta o mesmo
// tipo de heatmap (ver renderMapaDensidadeUsuarios em script.js), mas
// pra responder "onde tem CLIENTE", não "onde tem serviço oferecido" —
// pergunta diferente da de /dashboard/cobertura (que já cruza os dois,
// mas só agregado por município, sem a distribuição fina dentro dele).
// Usa latitude/longitude CRUS (não pais/estado/municipio) pelo mesmo
// motivo do endpoint de prestadores: o heatmap precisa dos pontos
// individuais, agregar por município perderia a distribuição interna.
router.get("/dashboard/localizacao", exigirAdmin, (req, res) => {
    const porPais = db.prepare(`
        SELECT pais, COUNT(*) AS total FROM log_cadastros
        WHERE pais IS NOT NULL GROUP BY pais ORDER BY total DESC
    `).all();

    const porEstado = db.prepare(`
        SELECT estado, COUNT(*) AS total FROM log_cadastros
        WHERE estado IS NOT NULL GROUP BY estado ORDER BY total DESC
    `).all();

    const porMunicipio = db.prepare(`
        SELECT municipio, COUNT(*) AS total FROM log_cadastros
        WHERE municipio IS NOT NULL GROUP BY municipio ORDER BY total DESC
    `).all();

    const pontosUsuarios = db.prepare(`
        SELECT latitude AS lat, longitude AS lng FROM log_cadastros
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `).all();

    res.json({ porPais, porEstado, porMunicipio, pontosUsuarios });
});

// GET /api/admin/dashboard/usuarios
// Lista todas as contas, mais recentemente ativa primeiro (NULLs —
// contas que nunca fizeram uma request autenticada — vão pro final, não
// pro topo, senão toda conta nova sem atividade nenhuma apareceria antes
// de quem está de fato usando agora).
// totalPrestadores: contagem simples via subquery — não passa por
// SELECT_PRESTADORES_COM_NOTA (aquilo monta o objeto formatado pro
// público; aqui só precisa do número).
// avatarEfetivo replica a mesma regra do front (avatarUrlEfetivo em
// 00-script.js): foto customizada (avatar_customizado > 0) tem
// prioridade sobre a foto do Google, com cache-bust via ?v=.
// pais/estado/municipio: join com o registro de cadastro (log_cadastros)
// dessa conta — mesmo dado usado em /dashboard/localizacao, aqui por
// linha, pra aparecer na lista e no modal de detalhes sem outra chamada.
router.get("/dashboard/usuarios", exigirAdmin, (req, res) => {
    const agora = Date.now();

    const linhas = db.prepare(`
        SELECT
            u.id,
            u.nome,
            u.email,
            u.avatar_url AS avatarUrl,
            u.avatar_customizado AS avatarCustomizado,
            u.criado_em AS criadoEm,
            u.last_seen_at AS lastSeenAt,
            (SELECT COUNT(*) FROM prestadores p WHERE p.dono_usuario_id = u.id) AS totalPrestadores,
            lc.pais,
            lc.estado,
            lc.municipio
        FROM usuarios u
        LEFT JOIN log_cadastros lc ON lc.usuario_id = u.id
        ORDER BY u.last_seen_at IS NULL, u.last_seen_at DESC, u.criado_em DESC
    `).all();

    const usuarios = linhas.map(u => ({
        id: u.id,
        nome: u.nome,
        email: u.email,
        avatarEfetivo: u.avatarCustomizado > 0
            ? `/${u.id}/avatar/avatar.webp?v=${u.avatarCustomizado}`
            : u.avatarUrl,
        criadoEm: u.criadoEm,
        lastSeenAt: u.lastSeenAt,
        online: u.lastSeenAt != null && (agora - u.lastSeenAt) <= MS_ONLINE,
        totalPrestadores: u.totalPrestadores,
        pais: u.pais,
        estado: u.estado,
        municipio: u.municipio
    }));

    res.json({ usuarios });
});

// GET /api/admin/dashboard/usuarios/:id
// Detalhe completo de UMA conta — alimenta o modal aberto ao clicar numa
// linha da lista (ver script.js). Junta tudo que já existe espalhado:
// dados da conta, o snapshot de cadastro (log_cadastros — ip/porta/
// coordenadas/localização do momento exato do cadastro, que não muda
// mesmo que a pessoa edite o perfil depois), os prestadores que ela é
// dona, e alguns contadores de atividade (avaliações feitas, salvos,
// notificações não lidas). Nenhuma dessas contagens existia formatada
// em outro endpoint — são só COUNT(*) diretos, sem custo real mesmo
// puxados um a um.
router.get("/dashboard/usuarios/:id", exigirAdmin, (req, res) => {
    const agora = Date.now();

    const usuario = db.prepare(`
        SELECT id, nome, email, telefone, cpf_cnpj AS cpfCnpj,
               avatar_url AS avatarUrl, avatar_customizado AS avatarCustomizado,
               criado_em AS criadoEm, last_seen_at AS lastSeenAt
        FROM usuarios WHERE id = ?
    `).get(req.params.id);

    if (!usuario) {
        return res.status(404).json({ erro: "Usuário não encontrado." });
    }

    // Snapshot congelado do cadastro — ver comentário em schema.sql sobre
    // log_cadastros nunca ser um espelho ao vivo de `usuarios`.
    const cadastro = db.prepare(`
        SELECT ip, porta, latitude, longitude, pais, estado, municipio, criado_em AS criadoEm
        FROM log_cadastros WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 1
    `).get(req.params.id);

    const prestadores = db.prepare(`
        SELECT id, nome, categoria, criado_em AS criadoEm
        FROM prestadores WHERE dono_usuario_id = ? ORDER BY criado_em DESC
    `).all(req.params.id);

    const { total: totalAvaliacoesFeitas } = db.prepare(
        "SELECT COUNT(*) AS total FROM avaliacoes WHERE autor_usuario_id = ?"
    ).get(req.params.id);

    const { total: totalSalvos } = db.prepare(
        "SELECT COUNT(*) AS total FROM salvos WHERE usuario_id = ?"
    ).get(req.params.id);

    const { total: notificacoesNaoLidas } = db.prepare(
        "SELECT COUNT(*) AS total FROM notificacoes WHERE usuario_id = ? AND lida = 0"
    ).get(req.params.id);

    res.json({
        usuario: {
            ...usuario,
            avatarEfetivo: usuario.avatarCustomizado > 0
                ? `/${usuario.id}/avatar/avatar.webp?v=${usuario.avatarCustomizado}`
                : usuario.avatarUrl,
            online: usuario.lastSeenAt != null && (agora - usuario.lastSeenAt) <= MS_ONLINE
        },
        cadastro: cadastro || null,
        prestadores,
        atividade: { totalAvaliacoesFeitas, totalSalvos, notificacoesNaoLidas }
    });
});

// GET /api/admin/dashboard/requests?limit=N
// Últimas N requests gravadas pelo middleware logRequisicao (ver
// server.js), mais recente primeiro. ?limit= é só "quantas trazer desta
// vez" (o botão "Carregar mais" do painel pede um limit maior a cada
// clique) — não é paginação por offset de verdade, então nenhuma linha
// pula ou duplica entre uma chamada e outra mesmo com request_logs
// crescendo o tempo todo entre elas.
const LIMITE_REQUESTS_PADRAO = 100;
const LIMITE_REQUESTS_MAXIMO = 2000;

router.get("/dashboard/requests", exigirAdmin, (req, res) => {
    const limite = lerLimite(req, LIMITE_REQUESTS_PADRAO, LIMITE_REQUESTS_MAXIMO);

    const linhas = db.prepare(`
        SELECT metodo, rota, status_code AS statusCode, duracao_ms AS duracaoMs,
               usuario_id AS usuarioId, ip, porta, criado_em AS criadoEm
        FROM request_logs
        ORDER BY criado_em DESC
        LIMIT ?
    `).all(limite);

    // temMais: heurística barata — se voltou exatamente o limite pedido,
    // provavelmente existe mais além dele (só teria certeza com um COUNT(*)
    // à parte, caro de rodar em toda request só pra isso). Usada pelo
    // front só pra decidir se mostra o botão "Carregar mais".
    res.json({ requests: linhas, temMais: linhas.length === limite });
});

// ==========================================================================
// DELETE /api/admin/dashboard/requests
// Botão "Limpar logs" do painel — dispara sob demanda a MESMA limpeza que
// já roda sozinha 1x/dia (ver jobs/limparRequestLogs.js), em vez de esperar
// o próximo ciclo automático. Reusa limparRequestLogsAntigos() de propósito:
// uma função só decide "o que é velho" (LOG_RETENCAO_DIAS no .env, default
// 90 dias) — o botão manual e o job automático nunca podem discordar sobre
// isso, e não existe um segundo critério (tipo "apagar tudo") escondido
// aqui. Isso NÃO é um "zerar tabela": só remove o que já passou da janela
// de retenção, igual o job faria de qualquer forma no próximo dia.
//
// Só afeta request_logs — log_cadastros e auditoria_contas são histórico/
// auditoria (ver comentário completo em jobs/limparRequestLogs.js) e não
// têm rota de limpeza nenhuma, manual ou automática, de propósito.
router.delete("/dashboard/requests", exigirAdmin, (req, res) => {
    try {
        const { removidas, retencaoDias } = limparRequestLogsAntigos();
        res.json({ removidas, retencaoDias });
    } catch (erro) {
        console.error("Falha na limpeza manual de request_logs:", erro);
        res.status(500).json({ erro: "Falha ao limpar os logs. Ver console do servidor." });
    }
});

// ==========================================================================
// GET /api/admin/dashboard/logs-cadastro
// DIFERENTE de /dashboard/requests: aquilo é o tráfego HTTP inteiro (toda
// rota, autenticada ou não, incluindo estáticos — request_logs). Isto aqui
// é só o EVENTO "uma conta nova foi criada" (log_cadastros, ver schema.sql
// e POST /entrar-google em routes/usuarios.js) — um snapshot pessoal
// (nome, ip, coordenadas, localização resolvida) de cada cadastro, não
// uma linha por request. As duas tabelas nunca foram a mesma coisa; só
// dividiam aba no painel antes. ?limit= com o mesmo raciocínio (e a mesma
// ressalva sobre não ser offset de verdade) de /dashboard/requests, acima.
// ==========================================================================
const LIMITE_LOGS_CADASTRO_PADRAO = 100;
const LIMITE_LOGS_CADASTRO_MAXIMO = 2000;

router.get("/dashboard/logs-cadastro", exigirAdmin, (req, res) => {
    const limite = lerLimite(req, LIMITE_LOGS_CADASTRO_PADRAO, LIMITE_LOGS_CADASTRO_MAXIMO);

    const linhas = db.prepare(`
        SELECT id, usuario_id AS usuarioId, nome_completo AS nomeCompleto, email,
               ip, porta, latitude, longitude, pais, estado, municipio,
               criado_em AS criadoEm
        FROM log_cadastros
        ORDER BY criado_em DESC
        LIMIT ?
    `).all(limite);

    res.json({ logs: linhas, temMais: linhas.length === limite });
});

// ==========================================================================
// Helpers de série por HORA — usados pelos gráficos técnicos e pelo
// "Cadastros por hora" (comercial). SQLite só devolve linhas pra horas que
// TÊM pelo menos um registro (GROUP BY não inventa zero); sem preencher os
// buracos, um gráfico de área com hora sem tráfego simplesmente pula essa
// hora no eixo X, o que distorce a leitura visual (parece uma hora mais
// "perto" da vizinha do que realmente está). `gerarChaveHoraUTC` e
// `preencherHoras` resolvem isso no servidor, não no front — assim o
// front sempre recebe uma série já completa, sem buraco, pronta pra
// desenhar direto (mesmo princípio dos outros endpoints desta rota).
//
// Formato da chave ('%Y-%m-%d %H:00') tem que bater exatamente com o que
// o strftime('%Y-%m-%d %H:00', ...) das queries abaixo produz — ambos em
// UTC (sem modificador 'localtime'), igual o resto deste arquivo já fazia
// pra cadastrosPorDia.
// ==========================================================================
function gerarChaveHoraUTC(dataMs) {
    const d = new Date(dataMs);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
}

// Gera as últimas `horas` chaves (mais antiga primeiro), a partir da hora
// cheia atual (trunca minutos/segundos) — é o "grade" completo do eixo X.
function gerarGradeHoras(horas) {
    const agora = new Date();
    agora.setUTCMinutes(0, 0, 0);
    const chaves = [];
    for (let i = horas - 1; i >= 0; i--) {
        chaves.push(gerarChaveHoraUTC(agora.getTime() - i * MS_HORA));
    }
    return chaves;
}

// linhas: resultado de uma query agrupada por `hora` (só as horas com
// dado). Preenche as horas ausentes com total 0, na ordem da grade.
function preencherHoras(linhas, horas) {
    const porHora = new Map(linhas.map(l => [l.hora, l.total]));
    return gerarGradeHoras(horas).map(hora => ({ hora, total: porHora.get(hora) || 0 }));
}

const HORAS_PADRAO = 24;
const HORAS_MAXIMO = 168; // 7 dias — teto pra ninguém pedir uma grade absurda

const DIAS_CADASTROS_PADRAO = 14;
const DIAS_CADASTROS_MAXIMO = 90;

function lerHoras(req) {
    const bruto = Number.parseInt(req.query.horas, 10);
    if (!Number.isFinite(bruto) || bruto <= 0) return HORAS_PADRAO;
    return Math.min(bruto, HORAS_MAXIMO);
}

// ==========================================================================
// GET /api/admin/dashboard/graficos/tecnicos?horas=N
// Aba "Gráficos técnicos" — tudo que vem de request_logs, granularidade de
// hora (tráfego HTTP muda rápido demais pra fazer sentido em "por dia").
//
// - requestsPorHora: volume total de requests, últimas N horas.
// - errosPorHora: mesma janela, mesma régua de "erro" usada em todo o
//   resto do painel (ver CONDICAO_SQL_ERRO — exclui 401/403, que são auth
//   rejeitando certo, não falha).
// - usuariosAtivosPorHora: COUNT(DISTINCT usuario_id) por hora — é uma
//   APROXIMAÇÃO de "usuários online por hora", não um snapshot real de
//   presença: não existe tabela de histórico de online/offline (só
//   usuarios.last_seen_at, que é UM valor por conta, sobrescrito a cada
//   request — não dá pra reconstruir "quem estava online às 14h" de lá).
//   O que dá pra medir de verdade é "quantas contas distintas fizeram
//   pelo menos uma request autenticada nessa hora", que é um proxy
//   razoável de atividade horária. usuario_id IS NOT NULL exclui tráfego
//   anônimo (não logado) da contagem.
// - requestsPorStatusUltimas24h: mesma métrica que já existia (classe do
//   status, 2xx/3xx/4xx/5xx), sempre fixa em 24h — é sobre a "foto" do
//   tráfego recente, não sobre a janela ajustável de `horas`.
// ==========================================================================
router.get("/dashboard/graficos/tecnicos", exigirAdmin, (req, res) => {
    const horas = lerHoras(req);
    const desde = Date.now() - horas * MS_HORA;

    const requestsPorHoraBrutos = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', criado_em / 1000, 'unixepoch') AS hora,
               COUNT(*) AS total
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY hora
    `).all(desde);

    const errosPorHoraBrutos = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', criado_em / 1000, 'unixepoch') AS hora,
               COUNT(*) AS total
        FROM request_logs
        WHERE criado_em >= ? AND ${CONDICAO_SQL_ERRO}
        GROUP BY hora
    `).all(desde);

    const usuariosAtivosPorHoraBrutos = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', criado_em / 1000, 'unixepoch') AS hora,
               COUNT(DISTINCT usuario_id) AS total
        FROM request_logs
        WHERE criado_em >= ? AND usuario_id IS NOT NULL
        GROUP BY hora
    `).all(desde);

    const requestsPorStatusBrutos = db.prepare(`
        SELECT CAST(status_code / 100 AS INTEGER) AS centena, COUNT(*) AS total
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY centena
        ORDER BY centena ASC
    `).all(Date.now() - MS_DIA);

    const requestsPorStatusUltimas24h = requestsPorStatusBrutos.map(r => ({
        classe: `${r.centena}xx`,
        total: r.total
    }));

    res.json({
        requestsPorHora: preencherHoras(requestsPorHoraBrutos, horas),
        errosPorHora: preencherHoras(errosPorHoraBrutos, horas),
        usuariosAtivosPorHora: preencherHoras(usuariosAtivosPorHoraBrutos, horas),
        requestsPorStatusUltimas24h,
        horas
    });
});

// ==========================================================================
// GET /api/admin/dashboard/erros-por-rota?horas=N
// Granularidade que "requestsPorStatusUltimas24h" (acima) não dá: aquele
// mostra "quantos 5xx no total", sem dizer ONDE — "23 erros" é abstrato,
// "23 erros em POST /avaliacoes" é acionável. Mesma janela `horas` das
// outras métricas desta aba (reusa lerHoras).
//
// total4xx/total5xx separados (não somados num "total de erros" só): são
// sintomas diferentes — 4xx alto numa rota costuma ser cliente mandando
// request errada (validação, token expirado), 5xx é o SERVIDOR quebrando,
// sempre prioridade mais alta de investigar.
//
// taxaErroPct = erros / requests NAQUELA rota, não erros / total geral do
// app — uma rota pouco usada com 2 erros em 3 tentativas (67%) é mais
// grave que uma rota popular com 50 erros em 50 mil (0,1%), mesmo com
// contagem bruta de erro parecida.
//
// HAVING total4xx > 0 OR total5xx > 0: só rotas que tiveram AO MENOS um
// erro na janela aparecem — sem isso a query listaria toda rota do app
// (a maioria sempre 100% saudável), teria que filtrar isso na mão.
// ==========================================================================
// ==========================================================================
// GET /api/admin/dashboard/rotas-populares?horas=N
// Tráfego GERAL por rota — o que "erros-por-rota" (abaixo) não mostra:
// aquele é só sobre o que QUEBRA; este é sobre o que é USADO, com ou sem
// erro. As duas se complementam: uma rota pode aparecer nas duas (muito
// usada E com erros) ou só numa.
//
// duracaoMediaMs: média simples (AVG), não p95/p99 — request_logs não
// guarda dado suficiente pra percentil de verdade sem reprocessar tudo;
// média já é um sinal útil o bastante pra "essa rota está lenta?" numa
// janela de algumas horas, sem precisar de infra de métricas dedicada.
// ==========================================================================
router.get("/dashboard/rotas-populares", exigirAdmin, (req, res) => {
    const horas = lerHoras(req);
    const desde = Date.now() - horas * MS_HORA;

    const brutos = db.prepare(`
        SELECT
            metodo,
            rota,
            COUNT(*) AS totalRequests,
            AVG(duracao_ms) AS duracaoMediaMs,
            SUM(CASE WHEN ${CONDICAO_SQL_ERRO} THEN 1 ELSE 0 END) AS totalErros
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY metodo, rota
        ORDER BY totalRequests DESC
        LIMIT 25
    `).all(desde);

    const porRota = brutos.map(r => ({
        metodo: r.metodo,
        rota: r.rota,
        totalRequests: r.totalRequests,
        duracaoMediaMs: Math.round(r.duracaoMediaMs),
        totalErros: r.totalErros
    }));

    res.json({ porRota, horas });
});

router.get("/dashboard/erros-por-rota", exigirAdmin, (req, res) => {
    const horas = lerHoras(req);
    const desde = Date.now() - horas * MS_HORA;

    const brutos = db.prepare(`
        SELECT
            metodo,
            rota,
            COUNT(*) AS totalRequests,
            SUM(CASE WHEN status_code >= 400 AND status_code < 500 AND status_code NOT IN (401, 403) THEN 1 ELSE 0 END) AS total4xx,
            SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS total5xx,
            MAX(CASE WHEN ${CONDICAO_SQL_ERRO} THEN criado_em END) AS ultimoErroEm
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY metodo, rota
        HAVING total4xx > 0 OR total5xx > 0
        ORDER BY (total4xx + total5xx) DESC
        LIMIT 25
    `).all(desde);

    const porRota = brutos.map(r => ({
        metodo: r.metodo,
        rota: r.rota,
        total4xx: r.total4xx,
        total5xx: r.total5xx,
        totalErros: r.total4xx + r.total5xx,
        totalRequests: r.totalRequests,
        taxaErroPct: r.totalRequests > 0
            ? Math.round((r.total4xx + r.total5xx) / r.totalRequests * 1000) / 10
            : 0,
        ultimoErroEm: r.ultimoErroEm
    }));

    res.json({ porRota, horas });
});

// ==========================================================================
// GET /api/admin/dashboard/graficos/comercial?dias=N
// Aba "Gráficos comerciais" — crescimento de conta, mix de contas e
// catálogo de serviços. Nada aqui depende de request_logs (isso é
// tráfego técnico, fica na outra aba).
//
// - cadastrosPorDia: igual já existia (usuarios.criado_em, janela 7/14/30
//   via ?dias=).
// - cadastrosPorHora: mesma métrica, granularidade de hora, fixa nas
//   últimas 24h — útil pra ver O HORÁRIO do dia em que as pessoas mais se
//   cadastram (ex: "pico às 19h"), coisa que "por dia" não mostra.
// - prestadoresPorCategoria: igual já existia (top 10, sem filtro de
//   data).
// - clientesVsPrestadores: toda conta (`usuarios`) cai em um dos dois
//   grupos — "prestador" = tem pelo menos 1 linha em `prestadores` com
//   dono_usuario_id = essa conta; "cliente" = todo o resto (usa o app só
//   pra buscar/avaliar, nunca cadastrou um serviço próprio). Não é um
//   campo separado no schema — é derivado via EXISTS, então nunca
//   dessincroniza de prestadores de verdade (ex: se um prestador excluir
//   o único serviço que tinha, ele volta a contar como "cliente" no
//   próximo refresh, sem precisar de nenhuma migração de dado).
//   percentualPrestadores vem pronto (0 se não houver usuário nenhum,
//   evita divisão por zero no front).
// - mediaServicos: totalPrestadores / totalUsuarios (média sobre TODAS as
//   contas, incluindo quem não tem nenhum serviço — mostra "quantos
//   serviços o app tem por conta cadastrada" em geral) e
//   totalPrestadores / totalContasComServico (média só entre quem já é
//   prestador — mostra "quantos serviços cada prestador ativo mantém em
//   média", sem contas puramente clientes puxando a média pra baixo).
//   Ambas expostas porque respondem perguntas diferentes; o front decide
//   qual mostrar.
// ==========================================================================
router.get("/dashboard/graficos/comercial", exigirAdmin, (req, res) => {
    const diasBruto = Number.parseInt(req.query.dias, 10);
    const dias = (Number.isFinite(diasBruto) && diasBruto > 0)
        ? Math.min(diasBruto, DIAS_CADASTROS_MAXIMO)
        : DIAS_CADASTROS_PADRAO;

    const cadastrosPorDia = db.prepare(`
        SELECT strftime('%Y-%m-%d', criado_em / 1000, 'unixepoch') AS dia,
               COUNT(*) AS total
        FROM usuarios
        WHERE criado_em >= ?
        GROUP BY dia
        ORDER BY dia ASC
    `).all(Date.now() - dias * MS_DIA);

    const cadastrosPorHoraBrutos = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', criado_em / 1000, 'unixepoch') AS hora,
               COUNT(*) AS total
        FROM usuarios
        WHERE criado_em >= ?
        GROUP BY hora
    `).all(Date.now() - HORAS_PADRAO * MS_HORA);

    const prestadoresPorCategoria = db.prepare(`
        SELECT categoria, COUNT(*) AS total
        FROM prestadores
        GROUP BY categoria
        ORDER BY total DESC
        LIMIT 10
    `).all();

    const { total: totalUsuarios } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios"
    ).get();

    const { total: totalContasComServico } = db.prepare(`
        SELECT COUNT(*) AS total FROM usuarios u
        WHERE EXISTS (SELECT 1 FROM prestadores p WHERE p.dono_usuario_id = u.id)
    `).get();

    const { total: totalPrestadores } = db.prepare(
        "SELECT COUNT(*) AS total FROM prestadores"
    ).get();

    const totalClientes = totalUsuarios - totalContasComServico;
    const percentualPrestadores = totalUsuarios > 0
        ? (totalContasComServico / totalUsuarios) * 100
        : 0;

    res.json({
        cadastrosPorDia,
        cadastrosPorHora: preencherHoras(cadastrosPorHoraBrutos, HORAS_PADRAO),
        prestadoresPorCategoria,
        clientesVsPrestadores: {
            totalUsuarios,
            totalClientes,
            totalPrestadores: totalContasComServico,
            percentualPrestadores
        },
        mediaServicos: {
            totalPrestadores,
            porTodasContas: totalUsuarios > 0 ? totalPrestadores / totalUsuarios : 0,
            porContaPrestadora: totalContasComServico > 0 ? totalPrestadores / totalContasComServico : 0
        },
        dias
    });
});

const MS_SEMANA = 7 * MS_DIA;

// ==========================================================================
// GET /api/admin/dashboard/retencao?semanas=N
// Curva de retenção por coorte semanal: agrupa contas pela SEMANA em que
// se cadastraram (coorte) e mede, semana a semana depois disso, que % da
// coorte voltou a fazer pelo menos uma request autenticada.
//
// Não existe uma tabela de "presença histórica" (usuarios.last_seen_at é
// só o ÚLTIMO valor, sobrescrito a cada request — não dá pra reconstruir
// "estava ativo na semana 3" só com isso). Por isso a atividade por
// semana é derivada de request_logs (mesmo proxy usado em
// usuariosAtivosPorHora, ver /graficos/tecnicos): toda linha com
// usuario_id preenchido conta como "esse usuário esteve ativo naquele
// instante".
//
// Cálculo inteiro feito em JS (não em SQL) de propósito: "semana desde o
// cadastro DAQUELE usuário" é um deslocamento relativo por linha, não um
// agrupamento fixo de calendário — mais simples de expressar iterando do
// que numa única query SQL só com strftime.
// ==========================================================================
const SEMANAS_RETENCAO_PADRAO = 8;
const SEMANAS_RETENCAO_MAXIMO = 26;

router.get("/dashboard/retencao", exigirAdmin, (req, res) => {
    const semanasBruto = Number.parseInt(req.query.semanas, 10);
    const semanas = (Number.isFinite(semanasBruto) && semanasBruto > 0)
        ? Math.min(semanasBruto, SEMANAS_RETENCAO_MAXIMO)
        : SEMANAS_RETENCAO_PADRAO;

    const agora = Date.now();
    const inicioJanela = agora - semanas * MS_SEMANA;

    const usuarios = db.prepare(
        "SELECT id, criado_em AS criadoEm FROM usuarios WHERE criado_em >= ?"
    ).all(inicioJanela);

    if (usuarios.length === 0) {
        return res.json({ coortes: [], semanas });
    }

    // Início da semana de cada usuário, alinhado ao epoch (não precisa
    // bater com domingo/segunda calendário — só precisa ser consistente
    // pra agrupar quem se cadastrou "na mesma janela de 7 dias").
    const cohortPorUsuario = new Map(
        usuarios.map(u => [u.id, Math.floor(u.criadoEm / MS_SEMANA) * MS_SEMANA])
    );
    const idsValidos = new Set(cohortPorUsuario.keys());

    const atividade = db.prepare(`
        SELECT usuario_id AS usuarioId, criado_em AS criadoEm
        FROM request_logs
        WHERE usuario_id IS NOT NULL AND criado_em >= ?
    `).all(inicioJanela);

    // ativoNaSemana: `${usuarioId}-${offsetSemanas}` -> true. Um Set (não
    // Map de contagem) porque só interessa SE esteve ativo naquela
    // semana, não quantas vezes.
    const ativoNaSemana = new Set();
    for (const linha of atividade) {
        if (!idsValidos.has(linha.usuarioId)) continue;
        const inicioCoorte = cohortPorUsuario.get(linha.usuarioId);
        const offset = Math.floor((linha.criadoEm - inicioCoorte) / MS_SEMANA);
        if (offset < 0) continue;
        ativoNaSemana.add(`${linha.usuarioId}-${offset}`);
    }

    // Agrupa usuários por coorte (início de semana).
    const usuariosPorCoorte = new Map();
    for (const [usuarioId, inicioCoorte] of cohortPorUsuario) {
        if (!usuariosPorCoorte.has(inicioCoorte)) usuariosPorCoorte.set(inicioCoorte, []);
        usuariosPorCoorte.get(inicioCoorte).push(usuarioId);
    }

    const coortes = [...usuariosPorCoorte.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inicioCoorte, idsCoorte]) => {
            // offsetMaximo: quantas semanas completas já se passaram desde
            // essa coorte — não faz sentido pedir "retenção na semana 5"
            // de uma coorte que só existe há 2 semanas (viraria sempre 0%,
            // não porque ninguém voltou, mas porque essa semana ainda nem
            // aconteceu).
            const offsetMaximo = Math.min(
                Math.floor((agora - inicioCoorte) / MS_SEMANA),
                semanas - 1
            );

            const pontos = [];
            for (let offset = 0; offset <= offsetMaximo; offset++) {
                const ativos = idsCoorte.filter(id => ativoNaSemana.has(`${id}-${offset}`)).length;
                pontos.push({
                    semana: offset,
                    percentual: (ativos / idsCoorte.length) * 100
                });
            }

            return {
                coorteInicio: new Date(inicioCoorte).toISOString().slice(0, 10),
                totalUsuarios: idsCoorte.length,
                pontos
            };
        });

    res.json({ coortes, semanas });
});

// ==========================================================================
// GET /api/admin/dashboard/funil
// Funil cadastro -> primeira ação, pra cada uma das 3 ações que já
// existem no app: cadastrar um serviço (prestadores), fazer uma avaliação
// (avaliacoes) e salvar um prestador (salvos). Pra cada uma: quantos % de
// TODAS as contas já fizeram aquilo pelo menos uma vez, e o tempo médio
// (em dias) entre o cadastro da conta e a primeira vez que ela fez isso
// (só entre quem já fez — não dá pra medir "tempo até" de quem nunca fez).
//
// primeiraOcorrencia: subquery MIN(criado_em) agrupado pela conta —
// mesmo princípio nas 3 (dono_usuario_id / autor_usuario_id / usuario_id),
// cada uma na tabela certa.
// ==========================================================================
router.get("/dashboard/funil", exigirAdmin, (req, res) => {
    const { total: totalUsuarios } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios"
    ).get();

    function etapa(tabela, colunaConta) {
        if (totalUsuarios === 0) {
            return { total: 0, percentual: 0, tempoMedioDias: null };
        }

        const { total } = db.prepare(`
            SELECT COUNT(*) AS total FROM usuarios u
            WHERE EXISTS (SELECT 1 FROM ${tabela} t WHERE t.${colunaConta} = u.id)
        `).get();

        const { mediaMs } = db.prepare(`
            SELECT AVG(primeira.criado_em - u.criado_em) AS mediaMs
            FROM usuarios u
            JOIN (
                SELECT ${colunaConta} AS conta, MIN(criado_em) AS criado_em
                FROM ${tabela}
                WHERE ${colunaConta} IS NOT NULL
                GROUP BY ${colunaConta}
            ) primeira ON primeira.conta = u.id
        `).get();

        return {
            total,
            percentual: (total / totalUsuarios) * 100,
            tempoMedioDias: mediaMs != null ? mediaMs / MS_DIA : null
        };
    }

    res.json({
        totalUsuarios,
        primeiroServico: etapa("prestadores", "dono_usuario_id"),
        primeiraAvaliacao: etapa("avaliacoes", "autor_usuario_id"),
        primeiroSalvo: etapa("salvos", "usuario_id")
    });
});

// ==========================================================================
// GET /api/admin/dashboard/contas-mortas?dias=N&limit=N
// Contas cadastradas que nunca voltaram (last_seen_at nulo) ou não
// aparecem há mais de N dias — candidatas a reengajamento (mesmo que o
// mecanismo de contato ainda não exista, o número/lista já é útil pra
// dimensionar o problema). NULL entra no critério de propósito: conta
// que nunca fez UMA request autenticada sequer é o caso mais extremo de
// "morta", não pode ficar de fora.
// ==========================================================================
const DIAS_CONTA_MORTA_PADRAO = 30;
const DIAS_CONTA_MORTA_MAXIMO = 365;
const LIMITE_CONTAS_MORTAS_PADRAO = 100;
const LIMITE_CONTAS_MORTAS_MAXIMO = 1000;

router.get("/dashboard/contas-mortas", exigirAdmin, (req, res) => {
    const diasBruto = Number.parseInt(req.query.dias, 10);
    const dias = (Number.isFinite(diasBruto) && diasBruto > 0)
        ? Math.min(diasBruto, DIAS_CONTA_MORTA_MAXIMO)
        : DIAS_CONTA_MORTA_PADRAO;
    const limite = lerLimite(req, LIMITE_CONTAS_MORTAS_PADRAO, LIMITE_CONTAS_MORTAS_MAXIMO);

    const limiar = Date.now() - dias * MS_DIA;

    const { total } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE last_seen_at IS NULL OR last_seen_at < ?"
    ).get(limiar);

    // NULLs primeiro (nunca voltaram, o caso mais "morto" de todos),
    // depois quem tem last_seen_at mais antigo primeiro.
    const linhas = db.prepare(`
        SELECT id, nome, email, criado_em AS criadoEm, last_seen_at AS lastSeenAt
        FROM usuarios
        WHERE last_seen_at IS NULL OR last_seen_at < ?
        ORDER BY last_seen_at IS NOT NULL, last_seen_at ASC
        LIMIT ?
    `).all(limiar, limite);

    res.json({ total, contas: linhas, dias, temMais: linhas.length < total });
});

// ==========================================================================
// GET /api/admin/dashboard/churn?dias=N
// Crescimento LÍQUIDO no período: contas criadas menos contas excluídas —
// diferente de "ativações no mês" (GET /dashboard/data), que só olha pra
// criação e nunca mostrou quantas saíram no mesmo período.
//
// Fonte: auditoria_contas (ver schema.sql) — SOBREVIVE à exclusão da
// conta de propósito (é o único jeito de saber DEPOIS que uma conta que
// não existe mais um dia existiu e foi apagada). totalCriadas usa
// usuarios.criado_em como sempre (contas que ainda existem); totalCriadas
// e totalExcluidas não são mutuamente exclusivos com relação ao PERÍODO —
// uma conta criada E excluída dentro da mesma janela conta nos dois
// totais, é isso mesmo (ela existiu ali dentro, mesmo que por pouco
// tempo).
//
// tempoMedioAteExclusaoDias: só entre quem excluiu NESTE período — média
// de quanto tempo essas contas duraram entre criado_em e excluido_em.
// null se ninguém excluiu no período (evita 0 enganoso, que pareceria
// "todo mundo excluiu no mesmo instante que criou").
// ==========================================================================
router.get("/dashboard/churn", exigirAdmin, (req, res) => {
    const diasBruto = Number.parseInt(req.query.dias, 10);
    const dias = (Number.isFinite(diasBruto) && diasBruto > 0)
        ? Math.min(diasBruto, DIAS_CADASTROS_MAXIMO)
        : DIAS_CADASTROS_PADRAO;
    const desde = Date.now() - dias * MS_DIA;

    const { total: totalExcluidas } = db.prepare(
        "SELECT COUNT(*) AS total FROM auditoria_contas WHERE excluido_em >= ?"
    ).get(desde);

    const { total: totalCriadas } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE criado_em >= ?"
    ).get(desde);

    const excluidasPorDia = db.prepare(`
        SELECT strftime('%Y-%m-%d', excluido_em / 1000, 'unixepoch') AS dia,
               COUNT(*) AS total
        FROM auditoria_contas
        WHERE excluido_em >= ?
        GROUP BY dia
        ORDER BY dia ASC
    `).all(desde);

    const { mediaMs: tempoMedioAteExclusaoMs } = db.prepare(`
        SELECT AVG(excluido_em - criado_em) AS mediaMs
        FROM auditoria_contas
        WHERE excluido_em >= ?
    `).get(desde);

    res.json({
        totalCriadas,
        totalExcluidas,
        crescimentoLiquido: totalCriadas - totalExcluidas,
        excluidasPorDia,
        tempoMedioAteExclusaoDias: tempoMedioAteExclusaoMs != null ? tempoMedioAteExclusaoMs / MS_DIA : null,
        dias
    });
});

// ==========================================================================
// GET /api/admin/dashboard/moderacao
// Fila de moderação — quantas avaliações estão esperando decisão AGORA
// (status='pendente'), diferente de tudo que já existe no painel (que só
// olha pra trás, coisas já decididas). É a métrica operacional: "tem
// trabalho acumulado?". Complementa (não substitui) o contador
// `avaliacoesPendentes` que já existe em GET /dashboard/status: aquele é
// leitura passiva de sistema; esta rota é a fila ACIONÁVEL, com a lista
// de quem está esperando, mais antiga primeiro.
//
// esperandoDesde: a mais antiga pendente, pra saber se tem alguma perto
// de expirar automaticamente (ver jobs/expirarAvaliacoes.js) — não
// reimplementa o prazo aqui, só mostra a idade real de quem espera mais.
// ==========================================================================
const LIMITE_MODERACAO_PADRAO = 50;
const LIMITE_MODERACAO_MAXIMO = 500;

router.get("/dashboard/moderacao", exigirAdmin, (req, res) => {
    const limite = lerLimite(req, LIMITE_MODERACAO_PADRAO, LIMITE_MODERACAO_MAXIMO);

    const { total: totalPendentes } = db.prepare(
        "SELECT COUNT(*) AS total FROM avaliacoes WHERE status = 'pendente'"
    ).get();

    const linhas = db.prepare(`
        SELECT a.id, a.autor_nome AS autorNome, a.nota, a.criado_em AS criadoEm,
               p.id AS prestadorId, p.nome AS prestadorNome
        FROM avaliacoes a
        JOIN prestadores p ON p.id = a.prestador_id
        WHERE a.status = 'pendente'
        ORDER BY a.criado_em ASC
        LIMIT ?
    `).all(limite);

    res.json({
        totalPendentes,
        esperandoDesde: linhas.length > 0 ? linhas[0].criadoEm : null,
        avaliacoes: linhas,
        temMais: linhas.length === limite && linhas.length < totalPendentes
    });
});

// ==========================================================================
// GET /api/admin/dashboard/avaliacoes-insights
// Duas métricas sobre `avaliacoes` que não apareciam em lugar nenhum do
// painel ainda:
//
// - expiracaoAutomatica: entre as avaliações já DECIDIDAS como publicadas
//   (status='publicada'), quantas foram o prestador realmente aceitando
//   vs quantas passaram batido e foram publicadas sozinhas pelo job de
//   prazo (expirou_automaticamente=1, ver jobs/expirarAvaliacoes.js). Uma
//   taxa alta aqui é sinal de prestador desatento à fila cega, não de
//   avaliação ruim.
// - notaMediaPorCategoria: só sobre avaliações PUBLICADAS (mesma regra de
//   visibilidade do resto do app — pendente/rejeitada não conta pra nota
//   pública), agrupada pela categoria do PRESTADOR avaliado.
// - decisoes: taxa de aprovação vs rejeição — SÓ sobre avaliações já
//   DECIDIDAS (publicada + rejeitada), de propósito excluindo 'pendente'
//   do denominador. Se incluísse pendente, uma fila de moderação grande
//   (ver /dashboard/moderacao) diluiria artificialmente a taxa de
//   aprovação sem isso refletir nenhuma mudança real de comportamento —
//   pendente ainda não é uma decisão, não pode contar como "quase
//   rejeitada" só por ainda não ter sido publicada.
// ==========================================================================
router.get("/dashboard/avaliacoes-insights", exigirAdmin, (req, res) => {
    const { total: totalPublicadas } = db.prepare(
        "SELECT COUNT(*) AS total FROM avaliacoes WHERE status = 'publicada'"
    ).get();

    const { total: totalExpiradasAutomaticamente } = db.prepare(
        "SELECT COUNT(*) AS total FROM avaliacoes WHERE status = 'publicada' AND expirou_automaticamente = 1"
    ).get();

    const percentualExpiradaAutomaticamente = totalPublicadas > 0
        ? (totalExpiradasAutomaticamente / totalPublicadas) * 100
        : 0;

    const notaMediaPorCategoria = db.prepare(`
        SELECT p.categoria, AVG(a.nota) AS notaMedia, COUNT(*) AS totalAvaliacoes
        FROM avaliacoes a
        JOIN prestadores p ON p.id = a.prestador_id
        WHERE a.status = 'publicada'
        GROUP BY p.categoria
        ORDER BY notaMedia DESC
    `).all();

    const { total: totalRejeitadas } = db.prepare(
        "SELECT COUNT(*) AS total FROM avaliacoes WHERE status = 'rejeitada'"
    ).get();

    const totalDecididas = totalPublicadas + totalRejeitadas;

    res.json({
        expiracaoAutomatica: {
            totalPublicadas,
            totalExpiradasAutomaticamente,
            percentualExpiradaAutomaticamente
        },
        notaMediaPorCategoria,
        decisoes: {
            totalPublicadas,
            totalRejeitadas,
            totalDecididas,
            percentualAprovacao: totalDecididas > 0 ? (totalPublicadas / totalDecididas) * 100 : 0,
            percentualRejeicao: totalDecididas > 0 ? (totalRejeitadas / totalDecididas) * 100 : 0
        }
    });
});

// ==========================================================================
// GET /api/admin/dashboard/whatsapp
// Cliques em "chamar no WhatsApp" (cliques_whatsapp, ver POST
// /prestadores/:id/whatsapp-clique em routes/avaliacoes.js) — sinal mais
// forte de demanda real do que só cadastro ou salvo, porque é intenção
// explícita de contato. Dois rankings: por prestador (quem mais recebe
// intenção de contato) e por categoria (que tipo de serviço mais gera
// contato).
// ==========================================================================
router.get("/dashboard/whatsapp", exigirAdmin, (req, res) => {
    const porPrestador = db.prepare(`
        SELECT p.id, p.nome, p.categoria, COUNT(*) AS totalCliques
        FROM cliques_whatsapp c
        JOIN prestadores p ON p.id = c.prestador_id
        GROUP BY p.id
        ORDER BY totalCliques DESC
        LIMIT 15
    `).all();

    const porCategoria = db.prepare(`
        SELECT p.categoria, COUNT(*) AS totalCliques
        FROM cliques_whatsapp c
        JOIN prestadores p ON p.id = c.prestador_id
        GROUP BY p.categoria
        ORDER BY totalCliques DESC
    `).all();

    res.json({ porPrestador, porCategoria });
});

// ==========================================================================
// GET /api/admin/dashboard/prestadores-incompletos
// Perfis com lacuna que ninguém tá de olho ainda: sem descrição, sem
// nenhuma avaliação publicada, ou sem foto/vídeo de capa.
//
// "sem capa" é o único critério que NÃO dá pra checar só com SQL: não
// existe coluna no banco que diga "esse prestador tem capa" — a mídia
// vive só como ARQUIVO em public/<dono>-p-<posição>/capa/ (ver
// pastaPrestador em routes/prestadores.js; capa_tipo só diz qual FORMATO
// usar, foto ou vídeo, não se um arquivo de fato existe). Por isso
// temAlgumaCapa() (ver utils/midia.js) checa o filesystem de verdade, não
// confia só no banco. Prestador de demonstração (dono_usuario_id NULL,
// pasta_posicao NULL) nunca tem pasta real — conta como "sem capa" sem
// tentar ler disco (o caminho nem seria válido).
//
// Antes vivia aqui como temCapa() próprio, checando "capa2.webp" (sem
// hífen) — divergente do nome real gravado em routes/prestadores.js
// ("capa-2.webp", com hífen), então os slots 2 a 4 nunca eram detectados
// como preenchidos. Migrado pro util compartilhado (usado também em
// formatarPrestador.js) pra essa checagem existir num lugar só.

router.get("/dashboard/prestadores-incompletos", exigirAdmin, (req, res) => {
    const linhas = db.prepare(`
        SELECT
            p.id, p.nome, p.categoria, p.descricao,
            p.dono_usuario_id AS donoUsuarioId, p.pasta_posicao AS pastaPosicao,
            p.criado_em AS criadoEm,
            (SELECT COUNT(*) FROM avaliacoes a WHERE a.prestador_id = p.id AND a.status = 'publicada') AS totalAvaliacoesPublicadas
        FROM prestadores p
    `).all();

    const prestadores = linhas
        .map(p => {
            const lacunas = [];
            if (!p.descricao || p.descricao.trim() === "") lacunas.push("descricao");
            if (!temAlgumaCapa(p.donoUsuarioId, p.pastaPosicao)) lacunas.push("capa");
            if (p.totalAvaliacoesPublicadas === 0) lacunas.push("avaliacao");

            return {
                id: p.id,
                nome: p.nome,
                categoria: p.categoria,
                criadoEm: p.criadoEm,
                lacunas
            };
        })
        .filter(p => p.lacunas.length > 0)
        // Quem tem mais lacunas primeiro (perfil mais incompleto = maior
        // prioridade de arrumar); empate quebrado por mais antigo primeiro
        // (perfil velho e ainda incompleto é pior sinal que um cadastrado
        // ontem que ainda não teve tempo).
        .sort((a, b) => b.lacunas.length - a.lacunas.length || a.criadoEm - b.criadoEm);

    res.json({
        total: prestadores.length,
        totalPrestadores: linhas.length,
        prestadores
    });
});

// ==========================================================================
// GET /api/admin/dashboard/cobertura
// Cruza ONDE TEM GENTE CADASTRADA (log_cadastros.municipio, resolvido no
// momento do cadastro do USUÁRIO) com ONDE TEM SERVIÇO OFERECIDO
// (prestadores.municipio, resolvido em background pelo job
// geocodificarPrestadores — ver jobs/geocodificarPrestadores.js). Os dois
// municipios vêm do MESMO geocoding reverso (Nominatim), então os nomes
// batem entre si sem precisar de normalização extra.
//
// porMunicipio: só municípios com pelo menos 1 usuário cadastrado (WHERE
// no JOIN esquerdo com log_cadastros) — não faz sentido listar município
// com só prestador e zero usuário, isso nunca seria uma "oportunidade" de
// verdade (não tem demanda ali pra medir).
//
// prestadoresSemMunicipio: contador de quantos prestadores ainda não
// foram geocodificados (municipio IS NULL) — útil só pra saber se os
// números acima já são representativos ou se o job de background ainda
// está processando a fila.
//
// A lacuna "categoria sem oferta por município" que morava aqui
// (categoriasSemOferta) saiu — ver /dashboard/demanda-nao-atendida, mais
// abaixo, que unifica isso com "buscas sem resultado" num ranking só.
// ==========================================================================
// GET /api/admin/dashboard/mapa-prestadores
// Um ponto (lat/lng + categoria) por prestador com coordenada conhecida —
// alimenta o mapa de densidade da aba "Visão geral" (ver renderMapaDensidade
// em script.js, camada de heatmap do Leaflet). Devolve lat/lng cru (não
// agregado por município como em /dashboard/cobertura) porque o heatmap
// precisa dos pontos individuais pra calcular a própria densidade — agregar
// aqui antes perderia a distribuição dentro de um mesmo município grande.
// Sem paginação de propósito: mesmo o Brasil inteiro de prestadores ainda é
// um SELECT leve (3 colunas, sem JOIN) comparado às outras rotas do painel.
router.get("/dashboard/mapa-prestadores", exigirAdmin, (req, res) => {
    const prestadores = db.prepare(`
        SELECT lat, lng, categoria FROM prestadores
        WHERE lat IS NOT NULL AND lng IS NOT NULL
    `).all();

    res.json({ prestadores });
});

router.get("/dashboard/cobertura", exigirAdmin, (req, res) => {
    const usuariosPorMunicipio = db.prepare(`
        SELECT municipio, COUNT(DISTINCT usuario_id) AS totalUsuarios
        FROM log_cadastros
        WHERE municipio IS NOT NULL
        GROUP BY municipio
    `).all();

    const prestadoresPorMunicipio = db.prepare(`
        SELECT municipio, COUNT(*) AS totalPrestadores
        FROM prestadores
        WHERE municipio IS NOT NULL
        GROUP BY municipio
    `).all();

    const prestadoresPorMunicipioMap = new Map(
        prestadoresPorMunicipio.map(p => [p.municipio, p.totalPrestadores])
    );

    const porMunicipio = usuariosPorMunicipio
        .map(u => ({
            municipio: u.municipio,
            totalUsuarios: u.totalUsuarios,
            totalPrestadores: prestadoresPorMunicipioMap.get(u.municipio) || 0
        }))
        .sort((a, b) => b.totalUsuarios - a.totalUsuarios);

    const { total: prestadoresSemMunicipio } = db.prepare(
        "SELECT COUNT(*) AS total FROM prestadores WHERE municipio IS NULL"
    ).get();

    res.json({ porMunicipio, prestadoresSemMunicipio });
});

// ==========================================================================
// GET /api/admin/dashboard/buscas-sem-resultado
// Demanda REAL não atendida, agregada só por categoria (sem quebrar por
// município) — alimenta o gráfico de barras "qual categoria tem mais
// gente esbarrando em não achei ninguém", independente de onde. O
// ranking categoria+município (que também vinha daqui) saiu — ver
// /dashboard/demanda-nao-atendida, que combina isso com a lacuna inferida
// de cobertura num ranking só, em vez de duas tabelas competindo.
//
// pendentesGeocoding: quantas linhas ainda não foram resolvidas pelo job
// de background — mesmo propósito de prestadoresSemMunicipio (saber se os
// números já são representativos ou a fila ainda está processando).
// ==========================================================================
router.get("/dashboard/buscas-sem-resultado", exigirAdmin, (req, res) => {
    const porCategoria = db.prepare(`
        SELECT categoria, COUNT(*) AS total
        FROM buscas_sem_resultado
        GROUP BY categoria
        ORDER BY total DESC
        LIMIT 15
    `).all();

    const { total: totalGeral } = db.prepare(
        "SELECT COUNT(*) AS total FROM buscas_sem_resultado"
    ).get();

    const { total: pendentesGeocoding } = db.prepare(
        "SELECT COUNT(*) AS total FROM buscas_sem_resultado WHERE municipio IS NULL"
    ).get();

    res.json({ porCategoria, totalGeral, pendentesGeocoding });
});

// ==========================================================================
// GET /api/admin/dashboard/demanda-nao-atendida
// Substitui as duas tabelas categoria×município que competiam entre si
// (categoriasSemOferta, que morava em /dashboard/cobertura, e
// porCategoriaMunicipio, que morava em /dashboard/buscas-sem-resultado) —
// mesma pergunta ("onde falta oferta?"), dois sinais diferentes:
//
// - INFERIDO: município tem usuário cadastrado, mas ZERO prestador
//   daquela categoria ali (não significa que alguém tentou e não achou —
//   é dedução a partir de onde tem gente x onde tem oferta).
// - OBSERVADO: alguém de fato BUSCOU aquela categoria naquele município e
//   não achou nada (buscas_sem_resultado) — sinal mais forte porque é
//   demanda expressa, não deduzida.
//
// `nivel` classifica cada combinação categoria+município:
//   'confirmada' — os dois sinais concordam (tem gap E alguém já sentiu
//                  na pele) — prioridade máxima.
//   'observada'  — só busca sem resultado, sem gap inferido (pode
//                  significar que TEM prestador ali mas a busca não achou
//                  por outro motivo — filtro, distância, avaliação baixa
//                  — vale investigar, mas é sinal mais fraco que confirmada).
//   'inferida'   — só o gap teórico, ninguém buscou isso ainda (lacuna
//                  existe no papel, mas sem prova de demanda real).
//
// Ordenação: nivel (confirmada > observada > inferida) e, dentro do
// mesmo nivel, mais buscas primeiro — a chave-mestra é PROVA de demanda,
// não só a existência teórica do buraco.
// ==========================================================================
router.get("/dashboard/demanda-nao-atendida", exigirAdmin, (req, res) => {
    const buscas = db.prepare(`
        SELECT categoria, municipio, estado, COUNT(*) AS total
        FROM buscas_sem_resultado
        WHERE municipio IS NOT NULL
        GROUP BY categoria, municipio, estado
    `).all();

    const usuariosPorMunicipio = db.prepare(`
        SELECT municipio, COUNT(DISTINCT usuario_id) AS totalUsuarios
        FROM log_cadastros
        WHERE municipio IS NOT NULL
        GROUP BY municipio
    `).all();

    const todasCategorias = db.prepare(
        "SELECT DISTINCT categoria FROM prestadores ORDER BY categoria COLLATE NOCASE"
    ).all().map(c => c.categoria);

    const categoriasPorMunicipio = db.prepare(`
        SELECT municipio, categoria FROM prestadores WHERE municipio IS NOT NULL GROUP BY municipio, categoria
    `).all();
    const categoriasExistentesPorMunicipio = new Map();
    categoriasPorMunicipio.forEach(({ municipio, categoria }) => {
        if (!categoriasExistentesPorMunicipio.has(municipio)) categoriasExistentesPorMunicipio.set(municipio, new Set());
        categoriasExistentesPorMunicipio.get(municipio).add(categoria);
    });

    // Chave categoria+município (não inclui estado — mesma limitação já
    // existente antes desta unificação: nome de município pode colidir
    // entre estados diferentes; não é resolvido aqui, só preservado).
    const chave = (categoria, municipio) => `${categoria}|||${municipio}`;
    const combinado = new Map();

    for (const b of buscas) {
        combinado.set(chave(b.categoria, b.municipio), {
            categoria: b.categoria,
            municipio: b.municipio,
            estado: b.estado,
            totalBuscas: b.total,
            temGapInferido: false
        });
    }

    for (const { municipio, totalUsuarios } of usuariosPorMunicipio) {
        const existentes = categoriasExistentesPorMunicipio.get(municipio) || new Set();
        for (const categoria of todasCategorias) {
            if (existentes.has(categoria)) continue; // tem oferta ali — não é gap
            const k = chave(categoria, municipio);
            const atual = combinado.get(k);
            if (atual) {
                atual.temGapInferido = true;
            } else {
                combinado.set(k, {
                    categoria, municipio, estado: null,
                    totalBuscas: 0,
                    temGapInferido: true
                });
            }
        }
    }

    const PESO_NIVEL = { confirmada: 2, observada: 1, inferida: 0 };

    const oportunidades = [...combinado.values()]
        .map(item => ({
            ...item,
            nivel: item.totalBuscas > 0 && item.temGapInferido
                ? "confirmada"
                : item.totalBuscas > 0
                    ? "observada"
                    : "inferida"
        }))
        .sort((a, b) => (PESO_NIVEL[b.nivel] - PESO_NIVEL[a.nivel]) || (b.totalBuscas - a.totalBuscas))
        .slice(0, 40);

    res.json({ oportunidades });
});

// ==========================================================================
// GET /api/admin/dashboard/alertas
// Aba "Alertas" — só sinais TÉCNICOS/operacionais (servidor quebrando,
// rota com erro, job de background travado). De propósito NÃO inclui
// sinais de negócio (contas inativas, demanda não atendida por
// categoria/município) — esses já têm lar próprio nas abas "Retenção &
// Ativação" e "Localização"/cobertura, e misturar os dois aqui faria
// "Alertas" virar um catch-all sem foco. Ver GET /dashboard/status pro
// raio-x geral do sistema (contagens, saúde do processo, dos jobs).
//
// Limiares fixos no código (não configuráveis via .env ainda) — são
// julgamento de produto, não segredo operacional; se um dia precisarem
// mudar por ambiente, isso vira env var como RETENCAO_DIAS já é.
//
// - erros5xxUltimaHora: qualquer 5xx na última hora é sinal de servidor
//   quebrando AGORA — sempre crítico, mesmo que seja só 1.
// - rotasComTaxaErroAlta: reaproximação da query de /erros-por-rota,
//   mas só rotas com volume mínimo (>=10 requests na janela) e taxa de
//   erro >=20% — volume baixo com taxa alta (ex: 1 erro em 2 requests)
//   é ruído estatístico, não vira alerta.
// - geocodingAcumulado: registros aguardando o job de geocoding em
//   background há mais do que um ciclo razoável de processamento —
//   sinal de que o job pode estar travado/lento, não só "ainda não deu
//   tempo". Fica aqui (não em /dashboard/status) porque é acionável —
//   alguém devia checar o job — status é só leitura passiva.
// ==========================================================================
router.get("/dashboard/alertas", exigirAdmin, (req, res) => {
    const agora = Date.now();
    const alertas = [];

    // ---- erros 5xx na última hora ----
    const erros5xx = db.prepare(`
        SELECT metodo, rota, COUNT(*) AS total
        FROM request_logs
        WHERE status_code >= 500 AND criado_em >= ?
        GROUP BY metodo, rota
        ORDER BY total DESC
    `).all(agora - MS_HORA);

    if (erros5xx.length > 0) {
        const totalErros5xx = erros5xx.reduce((soma, r) => soma + r.total, 0);
        const piorRota = erros5xx[0];
        alertas.push({
            id: "erros-5xx-ultima-hora",
            severidade: "critico",
            titulo: `${totalErros5xx} erro(s) 5xx na última hora`,
            descricao: `Rota mais afetada: ${piorRota.metodo} ${piorRota.rota} (${piorRota.total} erro(s)).`,
            quando: agora
        });
    }

    // ---- rotas com taxa de erro alta (24h, volume mínimo) ----
    const VOLUME_MINIMO_ROTA = 10;
    const TAXA_ERRO_ALERTA_PCT = 20;

    const rotasComErro = db.prepare(`
        SELECT
            metodo, rota,
            COUNT(*) AS totalRequests,
            SUM(CASE WHEN ${CONDICAO_SQL_ERRO} THEN 1 ELSE 0 END) AS totalErros
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY metodo, rota
        HAVING totalRequests >= ? AND (totalErros * 100.0 / totalRequests) >= ?
        ORDER BY (totalErros * 1.0 / totalRequests) DESC
        LIMIT 5
    `).all(agora - MS_DIA, VOLUME_MINIMO_ROTA, TAXA_ERRO_ALERTA_PCT);

    rotasComErro.forEach(r => {
        const taxaPct = Math.round((r.totalErros / r.totalRequests) * 1000) / 10;
        alertas.push({
            id: `rota-taxa-erro-${r.metodo}-${r.rota}`,
            severidade: "atencao",
            titulo: `Taxa de erro alta em ${r.metodo} ${r.rota}`,
            descricao: `${taxaPct}% de erro nas últimas 24h (${r.totalErros} de ${r.totalRequests} requests).`,
            quando: agora
        });
    });

    // ---- geocoding acumulado (prestadores e buscas pendentes) ----
    const LIMIAR_GEOCODING_ACUMULADO = 20;

    const { total: prestadoresPendentes } = db.prepare(
        "SELECT COUNT(*) AS total FROM prestadores WHERE municipio IS NULL"
    ).get();
    if (prestadoresPendentes >= LIMIAR_GEOCODING_ACUMULADO) {
        alertas.push({
            id: "geocoding-prestadores-acumulado",
            severidade: "info",
            titulo: `${prestadoresPendentes} prestador(es) aguardando geocoding`,
            descricao: "Job de geocodificação (jobs/geocodificarPrestadores.js) pode estar atrasado ou travado.",
            quando: agora
        });
    }

    const { total: buscasPendentes } = db.prepare(
        "SELECT COUNT(*) AS total FROM buscas_sem_resultado WHERE municipio IS NULL"
    ).get();
    if (buscasPendentes >= LIMIAR_GEOCODING_ACUMULADO) {
        alertas.push({
            id: "geocoding-buscas-acumulado",
            severidade: "info",
            titulo: `${buscasPendentes} busca(s) sem resultado aguardando geocoding`,
            descricao: "Job de geocodificação (jobs/geocodificarBuscasSemResultado.js) pode estar atrasado ou travado.",
            quando: agora
        });
    }

    // Crítico primeiro, depois atenção, depois info; dentro da mesma
    // severidade, mais recente primeiro.
    const ORDEM_SEVERIDADE = { critico: 0, atencao: 1, info: 2 };
    alertas.sort((a, b) => {
        const diffSeveridade = ORDEM_SEVERIDADE[a.severidade] - ORDEM_SEVERIDADE[b.severidade];
        if (diffSeveridade !== 0) return diffSeveridade;
        return b.quando - a.quando;
    });

    res.json({ alertas });
});

// ==========================================================================
// GET /api/admin/dashboard/status
// Aba "Status" — raio-x geral do sistema num só lugar: processo Node,
// arquivo do banco, contagem de linhas por tabela, e saúde dos jobs de
// background. DIFERENTE de "Alertas": aqui é leitura passiva (o número
// como ele está agora), sem julgamento de "isso é bom ou ruim" — não
// filtra por limiar, não teria "severidade". Quem quer saber "tem algo
// errado AGORA" vai em Alertas; quem quer "como o sistema está de modo
// geral" vem aqui.
//
// - processo: uptime do processo Node (desde o último restart/deploy,
//   não desde o boot da máquina), uso de memória (RSS — memória
//   residente real, o número que mais importa pra saber se tá vazando),
//   versão do Node, e process.env.NODE_ENV (produção/desenvolvimento).
// - banco: caminho e tamanho em disco do arquivo .db (mesma variável
//   DB_PATH que db.js já usa pra abrir o banco — replicada aqui, não
//   importada, porque db.js não exporta o caminho, só a conexão já
//   aberta) + contagem de linhas de cada tabela principal, pra noção
//   rápida de volume sem precisar abrir um cliente SQLite à parte.
// - jobs: quantos registros cada job de background (geocoding de
//   prestadores, geocoding de buscas sem resultado, expiração de
//   avaliações) ainda tem por processar — não diz SE o job está rodando
//   (não há como saber isso de dentro de uma request HTTP comum), só
//   quanto trabalho pendente existe agora.
// - saude: timestamp da request mais recente já registrada (prova de
//   que o log de requests está vivo) e contagem de erro 5xx na última
//   hora (mesmo número que already alimenta o alerta crítico, aqui só
//   como leitura, sem o texto de alerta).
// ==========================================================================
router.get("/dashboard/status", exigirAdmin, (req, res) => {
    const agora = Date.now();

    // ---- processo ----
    const memoria = process.memoryUsage();
    const processo = {
        uptimeSegundos: Math.round(process.uptime()),
        memoriaRssMb: Math.round((memoria.rss / (1024 * 1024)) * 10) / 10,
        nodeVersion: process.version,
        ambiente: process.env.NODE_ENV || "development",
        corsConfigurado: Boolean(process.env.CORS_ORIGIN)
    };

    // ---- banco: caminho + tamanho em disco ----
    // Mesma lógica de DB_PATH que db.js usa pra abrir a conexão — não dá
    // pra importar de lá porque db.js só exporta a instância já aberta,
    // não o caminho usado. Se algum dia isso dessincronizar, é sinal de
    // que vale a pena db.js passar a exportar DB_PATH também.
    const DB_PATH = process.env.DB_PATH || "./data/mase.db";
    let tamanhoBancoMb = null;
    try {
        const stats = fs.statSync(path.resolve(DB_PATH));
        tamanhoBancoMb = Math.round((stats.size / (1024 * 1024)) * 10) / 10;
    } catch (erro) {
        // Arquivo não encontrado ou sem permissão de leitura — não impede
        // o resto do endpoint de responder, só fica null (front mostra "—").
        console.error("[status] Falha ao ler tamanho do arquivo do banco:", erro.message);
    }

    function contar(tabela) {
        const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).get();
        return total;
    }

    const banco = {
        caminho: DB_PATH,
        tamanhoMb: tamanhoBancoMb,
        contagens: {
            usuarios: contar("usuarios"),
            prestadores: contar("prestadores"),
            avaliacoes: contar("avaliacoes"),
            notificacoes: contar("notificacoes"),
            requestLogs: contar("request_logs"),
            logCadastros: contar("log_cadastros"),
            buscasSemResultado: contar("buscas_sem_resultado"),
            cliquesWhatsapp: contar("cliques_whatsapp"),
            salvos: contar("salvos")
        }
    };

    // ---- jobs de background: trabalho pendente ----
    const { total: prestadoresPendentesGeocoding } = db.prepare(
        "SELECT COUNT(*) AS total FROM prestadores WHERE municipio IS NULL"
    ).get();

    const { total: buscasPendentesGeocoding } = db.prepare(
        "SELECT COUNT(*) AS total FROM buscas_sem_resultado WHERE municipio IS NULL"
    ).get();

    const { total: avaliacoesPendentes } = db.prepare(
        "SELECT COUNT(*) AS total FROM avaliacoes WHERE status = 'pendente'"
    ).get();

    const jobs = {
        prestadoresPendentesGeocoding,
        buscasPendentesGeocoding,
        avaliacoesPendentes,
        requestLogsRetencaoDias: Number(process.env.REQUEST_LOGS_RETENCAO_DIAS) || 30
    };

    // ---- saúde ----
    const ultimaRequest = db.prepare(
        "SELECT criado_em AS criadoEm FROM request_logs ORDER BY criado_em DESC LIMIT 1"
    ).get();

    const { total: errosUltimaHora } = db.prepare(
        "SELECT COUNT(*) AS total FROM request_logs WHERE status_code >= 500 AND criado_em >= ?"
    ).get(agora - MS_HORA);

    const saude = {
        ultimaRequestEm: ultimaRequest ? ultimaRequest.criadoEm : null,
        errosUltimaHora
    };

    // ==========================================================================
    // VEREDITO GERAL — o "status em si" que dá nome à aba: um resumo de
    // uma frase (nivel + motivo) calculado AQUI no servidor a partir dos
    // mesmos números já coletados acima, pra não duplicar a régua de
    // limiar no front (mesmo princípio de MS_ONLINE ser calculado no
    // servidor, não no browser — ver comentário lá em cima). Três níveis,
    // do pior pro melhor, primeiro critério que bater decide:
    //
    // - instavel: sinal de algo quebrando NA MÃO — muitos 5xx nos últimos
    //   5 minutos (>=3, quase certo não ser coincidência) OU uma taxa de
    //   erro 5xx alta (>=10%) na última hora com volume mínimo (>=10
    //   requests, senão 1 erro em 2 requests já dispararia isso à toa).
    // - degradado: nada quebrando agora, mas sinais de atenção: houve
    //   ALGUM 5xx na última hora (menos grave que "muitos em 5min", mas
    //   ainda vale checar — ver aba Alertas pra detalhe) OU os jobs de
    //   background acumularam trabalho pendente muito além do normal
    //   (>=200 registros somados, sinal de job travado há tempo, não só
    //   "ainda não deu tempo de processar o lote mais recente").
    // - operacional: nenhum dos gatilhos acima.
    // ==========================================================================
    const MS_5_MIN = 5 * 60 * 1000;
    const LIMIAR_ERROS_5MIN_INSTAVEL = 3;
    const LIMIAR_TAXA_ERRO_HORA_INSTAVEL_PCT = 10;
    const VOLUME_MINIMO_TAXA_ERRO = 10;
    const LIMIAR_JOBS_PENDENTES_DEGRADADO = 200;

    const { total: errosUltimos5Min } = db.prepare(
        "SELECT COUNT(*) AS total FROM request_logs WHERE status_code >= 500 AND criado_em >= ?"
    ).get(agora - MS_5_MIN);

    const { total: totalRequestsUltimaHora } = db.prepare(
        "SELECT COUNT(*) AS total FROM request_logs WHERE criado_em >= ?"
    ).get(agora - MS_HORA);

    const taxaErro5xxUltimaHoraPct = totalRequestsUltimaHora > 0
        ? (errosUltimaHora / totalRequestsUltimaHora) * 100
        : 0;

    const totalJobsPendentes = prestadoresPendentesGeocoding + buscasPendentesGeocoding;

    let statusGeral;
    if (errosUltimos5Min >= LIMIAR_ERROS_5MIN_INSTAVEL) {
        statusGeral = {
            nivel: "instavel",
            motivo: `${errosUltimos5Min} erro(s) 5xx nos últimos 5 minutos.`
        };
    } else if (totalRequestsUltimaHora >= VOLUME_MINIMO_TAXA_ERRO && taxaErro5xxUltimaHoraPct >= LIMIAR_TAXA_ERRO_HORA_INSTAVEL_PCT) {
        statusGeral = {
            nivel: "instavel",
            motivo: `Taxa de erro 5xx de ${Math.round(taxaErro5xxUltimaHoraPct * 10) / 10}% na última hora.`
        };
    } else if (errosUltimaHora > 0) {
        statusGeral = {
            nivel: "degradado",
            motivo: `${errosUltimaHora} erro(s) 5xx na última hora — ver aba Alertas.`
        };
    } else if (totalJobsPendentes >= LIMIAR_JOBS_PENDENTES_DEGRADADO) {
        statusGeral = {
            nivel: "degradado",
            motivo: `${totalJobsPendentes} registro(s) acumulados aguardando geocoding.`
        };
    } else {
        statusGeral = {
            nivel: "operacional",
            motivo: "Nenhum erro 5xx na última hora e jobs de background em dia."
        };
    }

    res.json({ statusGeral, processo, banco, jobs, saude, geradoEm: agora });
});

// Lê ?minutos= da query string — mesmo padrão de lerLimite/lerHoras
// acima (nunca gera erro 400, cai num padrão sensato pra qualquer valor
// inválido/ausente/fora do teto).
const MINUTOS_SEGURANCA_PADRAO = 15;
const MINUTOS_SEGURANCA_MAXIMO = 24 * 60; // 24h — teto pra não fazer um GROUP BY gigante à toa

function lerMinutos(req) {
    const bruto = Number.parseInt(req.query.minutos, 10);
    if (!Number.isFinite(bruto) || bruto <= 0) return MINUTOS_SEGURANCA_PADRAO;
    return Math.min(bruto, MINUTOS_SEGURANCA_MAXIMO);
}

// ==========================================================================
// GET /api/admin/dashboard/seguranca/ips?minutos=N&limit=N
// Aba "Segurança" — quantidade e DENSIDADE de requests por IP numa janela
// recente, com sinalização automática de comportamento suspeito (volume
// alto, taxa de erro alta = provável scan de rotas inexistentes, ou
// muitas rotas distintas tocadas em pouco tempo = provável varredura).
// Não afirma "isto é um ataque" — só destaca o que foge do padrão, pra
// quem está olhando decidir. Geolocalização (país/região/cidade) é
// resolvida sob demanda SÓ para os IPs retornados nesta página (ver
// ipLocalizacao.js), nunca em background pra todo IP que passa pelo
// servidor — seria caro e a maioria nunca vai aparecer numa lista.
//
// requestsPorMinuto: totalRequests / minutos da JANELA pedida, não da
// duração real de atividade do IP dentro dela (ex: um IP que mandou 60
// requests nos primeiros 10 segundos de uma janela de 15min aparece como
// "4/min", sub-representando o pico real) — é uma aproximação
// deliberadamente simples, suficiente pra ranquear quem está pesando
// mais; um cálculo de pico real exigiria olhar a distribuição dentro da
// janela, não só o agregado.
//
// suspeito: true se qualquer um dos limiares abaixo for cruzado —
// motivo(s) no array `motivos`, pra não esconder QUAL sinal disparou.
// ==========================================================================
const LIMITE_IPS_PADRAO = 50;
const LIMITE_IPS_MAXIMO = 200;

const REQUESTS_MINUTO_SUSPEITO = 20;
const TAXA_ERRO_SUSPEITA_PCT = 50;
const VOLUME_MINIMO_TAXA_ERRO_IP = 10;
const ROTAS_DISTINTAS_SUSPEITAS = 15;

router.get("/dashboard/seguranca/ips", exigirAdmin, async (req, res) => {
    const minutos = lerMinutos(req);
    const limite = lerLimite(req, LIMITE_IPS_PADRAO, LIMITE_IPS_MAXIMO);
    const desde = Date.now() - minutos * 60 * 1000;

    // Aqui NÃO usa CONDICAO_SQL_ERRO de propósito — diferente das métricas
    // de "erro do produto" (Erros por hora, erros-por-rota etc.), onde
    // 401/403 são ruído (auth rejeitando certo). Nesta aba de Segurança,
    // um IP com muito 401/403 é exatamente o sinal que queremos pegar:
    // alguém tentando adivinhar o token admin ou escaneando rotas sem
    // credencial. Excluir aqui faria o painel parar de detectar o próprio
    // tipo de abuso que esta aba existe pra flagar.
    const linhas = db.prepare(`
        SELECT
            ip,
            COUNT(*) AS totalRequests,
            COUNT(DISTINCT rota) AS rotasDistintas,
            COUNT(DISTINCT user_agent) AS userAgentsDistintos,
            COUNT(DISTINCT usuario_id) AS usuariosDistintos,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS totalErros,
            MIN(criado_em) AS primeiraEm,
            MAX(criado_em) AS ultimaEm
        FROM request_logs
        WHERE ip IS NOT NULL AND criado_em >= ?
        GROUP BY ip
        ORDER BY totalRequests DESC
        LIMIT ?
    `).all(desde, limite);

    const ipsDaPagina = linhas.map(l => l.ip);
    let localizacoes = new Map();
    try {
        localizacoes = await obterLocalizacoesEmLote(ipsDaPagina);
    } catch (erro) {
        // obterLocalizacoesEmLote já não deveria lançar (ver comentário no
        // próprio arquivo), mas se algo escapar por aqui, a lista de IPs
        // ainda é útil sem geolocalização — não derruba a rota inteira
        // por causa de um enriquecimento.
        console.error("Falha inesperada ao geolocalizar IPs:", erro);
    }

    const ips = linhas.map(l => {
        const requestsPorMinuto = Math.round((l.totalRequests / minutos) * 10) / 10;
        const taxaErroPct = l.totalRequests > 0
            ? Math.round((l.totalErros / l.totalRequests) * 1000) / 10
            : 0;

        const motivos = [];
        if (requestsPorMinuto >= REQUESTS_MINUTO_SUSPEITO) {
            motivos.push(`${requestsPorMinuto} requests/min`);
        }
        if (l.totalRequests >= VOLUME_MINIMO_TAXA_ERRO_IP && taxaErroPct >= TAXA_ERRO_SUSPEITA_PCT) {
            motivos.push(`${taxaErroPct}% de erro`);
        }
        if (l.rotasDistintas >= ROTAS_DISTINTAS_SUSPEITAS) {
            motivos.push(`${l.rotasDistintas} rotas distintas`);
        }

        const localizacao = localizacoes.get(l.ip) || null;

        return {
            ip: l.ip,
            totalRequests: l.totalRequests,
            requestsPorMinuto,
            rotasDistintas: l.rotasDistintas,
            userAgentsDistintos: l.userAgentsDistintos,
            usuariosDistintos: l.usuariosDistintos,
            totalErros: l.totalErros,
            taxaErroPct,
            primeiraEm: l.primeiraEm,
            ultimaEm: l.ultimaEm,
            suspeito: motivos.length > 0,
            motivos,
            pais: localizacao ? localizacao.pais : null,
            regiao: localizacao ? localizacao.regiao : null,
            cidade: localizacao ? localizacao.cidade : null,
            organizacao: localizacao ? localizacao.organizacao : null
        };
    });

    // Suspeitos primeiro (mais sinais primeiro), depois por volume — quem
    // está olhando quer ver o problema no topo, não enterrado na posição
    // 30 só porque outros IPs tinham mais volume total sem ser suspeitos.
    ips.sort((a, b) => {
        if (a.suspeito !== b.suspeito) return a.suspeito ? -1 : 1;
        if (a.suspeito && b.suspeito && a.motivos.length !== b.motivos.length) {
            return b.motivos.length - a.motivos.length;
        }
        return b.totalRequests - a.totalRequests;
    });

    // Agregado por REGIÃO (país/estado, quando resolvido) — a "densidade
    // geográfica" propriamente dita: de onde vem a maior concentração de
    // requests nesta janela, não só por IP individual. Só entre os IPs já
    // geolocalizados nesta página (não dispara lookup adicional).
    const porRegiaoMap = new Map();
    ips.forEach(item => {
        if (!item.pais) return;
        const chave = item.regiao ? `${item.regiao}, ${item.pais}` : item.pais;
        const acumulado = porRegiaoMap.get(chave) || { regiao: chave, totalRequests: 0, totalIps: 0 };
        acumulado.totalRequests += item.totalRequests;
        acumulado.totalIps += 1;
        porRegiaoMap.set(chave, acumulado);
    });
    const porRegiao = [...porRegiaoMap.values()].sort((a, b) => b.totalRequests - a.totalRequests);

    res.json({
        ips,
        porRegiao,
        minutos,
        totalSuspeitos: ips.filter(i => i.suspeito).length
    });
});

module.exports = router;

const db = require("../db");

// ==========================================================================
// LIMITE DE TENTATIVAS DO LOGIN INTERNO (POST /api/admin/login).
//
// Existe por dois motivos independentes:
//   1. Força bruta — a rota é pública por natureza (é a porta de entrada
//      de quem ainda não tem sessão), então sem freio dá pra tentar senha
//      indefinidamente.
//   2. Negação de serviço — cada tentativa custa um scrypt (~60ms). Com
//      scrypt assíncrono isso não trava mais o event loop (ver
//      utils/senha.js), mas ainda consome CPU do threadpool; sem limite,
//      volume alto degrada o app inteiro.
//
// REGRAS (as três valem ao mesmo tempo; a primeira que bater já barra):
//   - e-mail que NÃO existe .... bloqueia essa string por 4h na 1ª tentativa
//   - credencial errada ........ 5 falhas em 15min bloqueiam a conta por 4h
//   - por IP ................... 30 tentativas em 30min bloqueiam por 2 dias
//
// A regra do e-mail inexistente é agressiva de propósito: quem digita um
// e-mail que nunca existiu ou errou feio, ou está varrendo. Ela NÃO tranca
// o dono da conta por engano porque o bloqueio é da STRING digitada — um
// "fulano@gmail.co" bloqueado não afeta em nada o "fulano@gmail.com" certo.
//
// RESPOSTA SEMPRE IDÊNTICA, em qualquer falha: mesmo status, mesma
// mensagem, mesmo tempo. Nada de "bloqueado por 4 horas" ou "e-mail não
// encontrado" — dizer QUAL regra disparou ensina a calibrar o ataque, e
// diferenciar as mensagens permite enumerar contas. O motivo real só
// aparece no log do servidor. A equalização de TEMPO é responsabilidade de
// quem chama (ver gastarTempoEquivalente em utils/senha.js): sem ela, uma
// resposta instantânea denunciaria o bloqueio pelo relógio.
// ==========================================================================

const MS_MINUTO = 60 * 1000;
const MS_HORA = 60 * MS_MINUTO;

const JANELA_CREDENCIAL = 15 * MS_MINUTO;
const MAX_CREDENCIAL = 5;
const BLOQUEIO_CREDENCIAL = 4 * MS_HORA;

const BLOQUEIO_EMAIL_INEXISTENTE = 4 * MS_HORA;

const JANELA_IP = 30 * MS_MINUTO;
const MAX_IP = 30;
const BLOQUEIO_IP = 2 * 24 * MS_HORA;

// Histórico bruto só serve pra contar dentro das janelas acima; qualquer
// coisa mais velha que a maior delas é lixo. Limpa oportunisticamente (a
// cada tentativa) em vez de num job dedicado: a tabela é pequena e o
// DELETE usa índice, então não justifica agendamento próprio.
const RETENCAO_TENTATIVAS = Math.max(JANELA_CREDENCIAL, JANELA_IP);

function normalizarIp(ip) {
    if (!ip) return "";
    return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function registrarTentativa(chave, tipo) {
    db.prepare("INSERT INTO tentativas_login (chave, tipo, criado_em) VALUES (?, ?, ?)")
        .run(chave, tipo, Date.now());
}

function contarTentativas(chave, tipo, janelaMs) {
    return db.prepare(
        "SELECT COUNT(*) AS total FROM tentativas_login WHERE tipo = ? AND chave = ? AND criado_em >= ?"
    ).get(tipo, chave, Date.now() - janelaMs).total;
}

function bloquear(chave, tipo, duracaoMs, motivo) {
    const agora = Date.now();
    // INSERT OR REPLACE: uma nova infração RENOVA o prazo em vez de somar
    // bloqueios — quem insiste durante o bloqueio recomeça a contagem do
    // zero, que é mais duro e mais simples de raciocinar.
    db.prepare(`
        INSERT OR REPLACE INTO bloqueios_login (chave, tipo, ate, motivo, criado_em)
        VALUES (?, ?, ?, ?, ?)
    `).run(chave, tipo, agora + duracaoMs, motivo, agora);
    console.warn(`[login] BLOQUEADO ${tipo}=${chave} por ${Math.round(duracaoMs / MS_HORA)}h — ${motivo}`);
}

function estaBloqueado(chave, tipo) {
    const linha = db.prepare("SELECT ate, motivo FROM bloqueios_login WHERE chave = ? AND tipo = ?")
        .get(chave, tipo);
    if (!linha) return null;
    if (linha.ate <= Date.now()) {
        // Expirou: apaga na leitura em vez de deixar lixo acumulando.
        db.prepare("DELETE FROM bloqueios_login WHERE chave = ? AND tipo = ?").run(chave, tipo);
        return null;
    }
    return linha;
}

function limparTentativasAntigas() {
    db.prepare("DELETE FROM tentativas_login WHERE criado_em < ?").run(Date.now() - RETENCAO_TENTATIVAS);
}

// SEM ISENÇÃO POR IP — e isso foi uma correção, não o desenho original.
//
// A primeira versão isentava os IPs de config/acesso.json, com a ideia de
// garantir que o dono nunca se trancasse do lado de fora. O furo: "vem do
// meu IP" não é identidade, é localização de rede. Qualquer um na mesma
// rede — um funcionário no escritório, alguém no mesmo Wi-Fi — herdava a
// isenção e ganhava tentativas infinitas contra QUALQUER conta. Justamente
// o ataque mais provável na prática, que é interno, passava livre.
//
// Agora as regras valem pra todo mundo, sem exceção de origem. A saída de
// emergência existe, mas exige SEGREDO em vez de endereço: ver
// POST /api/admin/desbloquear em routes/admin.js, que pede o ADMIN_TOKEN
// (o mesmo que cria login). Quem está na rede mas não tem o segredo do
// servidor não desbloqueia nada.

// Chamado ANTES de tocar em senha. Devolve { bloqueado, motivo }.
function verificarLimiteLogin(req, email) {
    const ip = normalizarIp(req.ip);

    const porEmail = email ? estaBloqueado(email, "email") : null;
    if (porEmail) return { bloqueado: true, motivo: `email bloqueado (${porEmail.motivo})`, ip };

    const porIp = estaBloqueado(ip, "ip");
    if (porIp) return { bloqueado: true, motivo: `ip bloqueado (${porIp.motivo})`, ip };

    return { bloqueado: false, ip };
}

// Chamado DEPOIS de saber o resultado. `contaExiste` separa os dois casos
// de falha, que têm regras diferentes.
function registrarFalhaLogin({ email, ip, contaExiste }) {
    limparTentativasAntigas();

    if (email) registrarTentativa(email, "email");
    registrarTentativa(ip, "ip");

    if (email && !contaExiste) {
        bloquear(email, "email", BLOQUEIO_EMAIL_INEXISTENTE, "e-mail inexistente");
    } else if (email) {
        const falhas = contarTentativas(email, "email", JANELA_CREDENCIAL);
        if (falhas >= MAX_CREDENCIAL) {
            bloquear(email, "email", BLOQUEIO_CREDENCIAL, `${falhas} falhas em ${JANELA_CREDENCIAL / MS_MINUTO}min`);
        }
    }

    const tentativasIp = contarTentativas(ip, "ip", JANELA_IP);
    if (tentativasIp >= MAX_IP) {
        bloquear(ip, "ip", BLOQUEIO_IP, `${tentativasIp} tentativas em ${JANELA_IP / MS_MINUTO}min`);
    }
}

// Login certo zera o histórico daquele e-mail — senão as falhas de ontem
// continuariam contando pra janela de hoje e bloqueariam quem já provou
// que é dono da conta. O contador do IP NÃO é zerado de propósito: ele
// mede volume de tentativas vindas dali, e um acerto no meio de uma
// varredura não deveria limpar o rastro.
function registrarSucessoLogin(email) {
    db.prepare("DELETE FROM tentativas_login WHERE tipo = 'email' AND chave = ?").run(email);
    db.prepare("DELETE FROM bloqueios_login WHERE tipo = 'email' AND chave = ?").run(email);
}

// ==========================================================================
// LIMITE DO ADMIN_TOKEN (POST /api/admin/contas) — mesma ideia do login,
// alvo diferente: aqui o que se tenta adivinhar é o segredo do servidor,
// não uma senha de conta.
//
// A rota já exige IP na allowlist + janela de horário, mas isso não é
// freio: quem está DENTRO da rede (colega de escritório, máquina
// comprometida na mesma faixa) podia chutar o ADMIN_TOKEN indefinidamente
// durante o horário comercial. Cinco erros bastam pra denunciar que
// alguém está adivinhando — ninguém legítimo erra o token cinco vezes.
//
// A chave é prefixada ("token:1.2.3.4") pra não misturar com o contador
// de login do mesmo IP: são infrações diferentes e não devem somar num
// balde só. O `tipo` continua 'ip' porque o CHECK da tabela só aceita
// 'email' ou 'ip', e mudar CHECK em SQLite exige recriar a tabela — o
// prefixo resolve sem migração.
// ==========================================================================
const JANELA_TOKEN = 30 * MS_MINUTO;
const MAX_TOKEN = 5;
const BLOQUEIO_TOKEN = 2 * 24 * MS_HORA;

function chaveToken(ip) {
    return `token:${normalizarIp(ip)}`;
}

function tokenBloqueado(ip) {
    return estaBloqueado(chaveToken(ip), "ip");
}

function registrarFalhaToken(ip) {
    limparTentativasAntigas();
    const chave = chaveToken(ip);
    registrarTentativa(chave, "ip");
    const falhas = contarTentativas(chave, "ip", JANELA_TOKEN);
    if (falhas >= MAX_TOKEN) {
        bloquear(chave, "ip", BLOQUEIO_TOKEN, `${falhas} tentativas de ADMIN_TOKEN em ${JANELA_TOKEN / MS_MINUTO}min`);
    }
}

function registrarSucessoToken(ip) {
    db.prepare("DELETE FROM tentativas_login WHERE chave = ?").run(chaveToken(ip));
}

// Limpa bloqueios manualmente (recuperação). alvo vazio = tudo.
// Devolve quantos registros saíram, pra rota poder confirmar sem que o
// chamador precise consultar o banco.
function desbloquear(alvo) {
    const chave = String(alvo || "").trim().toLowerCase();
    if (!chave) {
        const b = db.prepare("DELETE FROM bloqueios_login").run().changes;
        const t = db.prepare("DELETE FROM tentativas_login").run().changes;
        return { bloqueios: b, tentativas: t, alvo: "todos" };
    }
    // Não pergunta se é e-mail ou IP: limpa a chave nos dois tipos. Uma
    // string ou é um ou é outro, nunca os dois, então tentar adivinhar o
    // tipo só criaria caso de erro sem ganho nenhum.
    // Limpa também a variante prefixada do contador de ADMIN_TOKEN —
    // desbloquear um IP tem que soltar as duas travas, senão o dono
    // desbloqueia "o IP" e continua sem conseguir criar login.
    const prefixada = `token:${chave}`;
    const b = db.prepare("DELETE FROM bloqueios_login WHERE chave IN (?, ?)").run(chave, prefixada).changes;
    const t = db.prepare("DELETE FROM tentativas_login WHERE chave IN (?, ?)").run(chave, prefixada).changes;
    return { bloqueios: b, tentativas: t, alvo: chave };
}

// Lista o que está bloqueado agora — alimenta a visibilidade no painel
// (aba Segurança) e o diagnóstico de "por que fulano não entra?".
function listarBloqueios() {
    return db.prepare(`
        SELECT chave, tipo, ate, motivo, criado_em AS criadoEm
        FROM bloqueios_login WHERE ate > ? ORDER BY ate DESC
    `).all(Date.now());
}

module.exports = {
    verificarLimiteLogin, registrarFalhaLogin, registrarSucessoLogin,
    tokenBloqueado, registrarFalhaToken, registrarSucessoToken,
    desbloquear, listarBloqueios
};

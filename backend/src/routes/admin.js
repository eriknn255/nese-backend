const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { exigirNivel } = require("../middleware/identidadeAdmin");
const { exigirRedeAutorizada, avaliarAcesso, ipNaAllowlist, MENSAGEM_GENERICA } = require("../middleware/redeAutorizada");
const { avaliarRestricoes, paisPermitido, listaDe } = require("../utils/restricoesLogin");
const OPCOES = require("../utils/opcoesRestricao");
const { hashSenha, verificarSenha, gastarTempoEquivalente } = require("../utils/senha");
const {
    verificarLimiteLogin, registrarFalhaLogin, registrarSucessoLogin,
    tokenBloqueado, registrarFalhaToken, registrarSucessoToken,
    desbloquear, listarBloqueios
} = require("../middleware/limiteLogin");
const { registrarAuditoria, diffCampos } = require("../utils/auditoria");
const { obterLocalizacoesEmLote } = require("../utils/ipLocalizacao");
const { temAlgumaCapa, capasDisponiveis, pastaCapaPrestador } = require("../utils/midia");
const { limparRequestLogsAntigos } = require("../jobs/limparRequestLogs");

const router = express.Router();

// ==========================================================================
// PAINEL INTERNO — alimenta o dashboard e a moderação (fora deste repo:
// dashboard/ e moderacao/, HTML+CSS+JS estáticos servidos pelo Nginx).
//
// DOIS níveis de proteção que NÃO se confundem, apesar de usarem o mesmo
// nome de header (X-Admin-Token) em rotas diferentes:
//   1. ADMIN_TOKEN (exigirAdmin, abaixo): segredo fixo do .env, só abre
//      POST /contas (criar login novo). Ninguém cria login sem esse
//      segredo — nem um 'full' já logado.
//   2. Login de verdade (email+senha, tabela `admins`, ver
//      middleware/identidadeAdmin.js): autentica o resto — dashboard
//      (nivel 'ver' ou 'full') e moderação (só 'full'). Sessão é um JWT
//      próprio (ADMIN_SESSION_SECRET), devolvido por POST /login.
// ==========================================================================
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_TOKEN_BUFFER = ADMIN_TOKEN ? Buffer.from(ADMIN_TOKEN) : null;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;

// Guarda SÓ POST /contas agora (criar login) — ver comentário acima.
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

// Mesma checagem, com freio de tentativas por IP (ver registrarFalhaToken
// em middleware/limiteLogin.js). Usado só onde o ADMIN_TOKEN é a
// credencial — criar login e desbloquear.
//
// Bloqueado responde 404 GENÉRICO, não 401: um 401 confirmaria "a rota
// existe, você só errou o segredo", e depois de bloquear não há motivo pra
// seguir dando esse retorno. É o mesmo silêncio da página criar-acesso/.
function exigirAdminComLimite(req, res, next) {
    if (!ADMIN_TOKEN) {
        return res.status(500).json({ erro: "Servidor sem ADMIN_TOKEN configurado (ver .env)." });
    }

    const bloqueio = tokenBloqueado(req.ip);
    if (bloqueio) {
        console.warn(`[token] tentativa recusada ip=${req.ip} — bloqueado (${bloqueio.motivo})`);
        return res.status(404).json({ erro: MENSAGEM_GENERICA });
    }

    const tokenBuffer = Buffer.from(req.header("X-Admin-Token") || "");
    const tamanhosIguais = tokenBuffer.length === ADMIN_TOKEN_BUFFER.length;
    const tokenValido = tamanhosIguais && crypto.timingSafeEqual(tokenBuffer, ADMIN_TOKEN_BUFFER);

    if (!tokenValido) {
        registrarFalhaToken(req.ip);
        return res.status(401).json({ erro: "Token de admin inválido." });
    }

    registrarSucessoToken(req.ip);
    next();
}

// ==========================================================================
// LOGIN INTERNO — contas do dashboard/moderação.
//
// Fluxo pensado pra que o ADMIN_TOKEN saia do dia a dia: ele passa a ser
// usado SÓ pra criar login (POST /contas). Depois disso, quem acessa o
// painel usa email+senha, e o que autentica cada request é o JWT de
// sessão devolvido pelo /login — não o segredo do .env. Assim o segredo
// não fica colado no localStorage de todo mundo que precisa ver métrica,
// e dá pra revogar acesso de uma pessoa (DELETE /contas/:id) sem trocar
// o segredo e reconfigurar todo mundo.
// ==========================================================================

// ==========================================================================
// RESTRIÇÕES DE UM LOGIN (de onde/quando ele pode ser usado). Validadas
// aqui e gravadas nas colunas ips/horario/fuso_horario/paises de `admins`.
//
// IP e horário são OBRIGATÓRIOS: não existe criar login "aberto". A conta
// é da empresa e o acesso ao painel é privilegiado — deixar o campo em
// branco por pressa produziria exatamente a credencial que ninguém
// lembra de restringir depois. País segue opcional porque geo-IP é
// palpite (VPN, CGNAT e IP roteado por outro estado erram), e exigir uma
// camada não confiável só geraria bloqueio inexplicável.
// ==========================================================================
function lerRestricoes(corpo) {
    const ips = Array.isArray(corpo.ips) ? corpo.ips.map(x => String(x).trim()).filter(Boolean) : listaDe(corpo.ips);
    const paises = Array.isArray(corpo.paises) ? corpo.paises.map(x => String(x).trim()).filter(Boolean) : listaDe(corpo.paises);
    const horario = String(corpo.horario || "").trim();
    const fusoHorario = String(corpo.fusoHorario || "").trim();

    if (ips.length === 0) {
        return { erro: "Informe ao menos um IP autorizado para este login." };
    }
    // Lista FECHADA, não formato livre: horário, fuso e país só podem ser
    // valores do menu (ver utils/opcoesRestricao.js, a mesma lista que o
    // front usa pra montar os seletores). Validar só o formato deixaria a
    // API aceitar janelas que a interface não oferece, e aí voltaria a
    // existir dado que nenhum seletor consegue representar.
    if (!horario) {
        return { erro: "Escolha a janela de horário deste login." };
    }
    if (!OPCOES.HORARIOS_VALIDOS.includes(horario)) {
        return { erro: `Janela de horário inválida: ${horario}` };
    }
    if (!fusoHorario) {
        return { erro: "Escolha o fuso horário — sem ele a janela seria interpretada no fuso do servidor (UTC), deslocando o horário sem aviso." };
    }
    if (!OPCOES.FUSOS_VALIDOS.includes(fusoHorario)) {
        return { erro: `Fuso horário inválido: ${fusoHorario}` };
    }
    const paisForaDaLista = paises.find(x => !OPCOES.PAISES_VALIDOS.includes(x));
    if (paisForaDaLista) {
        return { erro: `País inválido: ${paisForaDaLista}` };
    }

    return { ips: ips.join(","), horario, fusoHorario, paises: paises.join(",") };
}

const EXPIRACAO_SESSAO_ADMIN = "12h";

function assinarSessaoAdmin(admin) {
    return jwt.sign({ sub: admin.id, nivel: admin.nivel }, ADMIN_SESSION_SECRET, { expiresIn: EXPIRACAO_SESSAO_ADMIN });
}

function normalizarEmailAdmin(valor) {
    return String(valor || "").trim().toLowerCase();
}

// GET /api/admin/bootstrap/status — a página criar-acesso/ chama isso
// antes de mostrar o formulário.
//
// Responde APENAS { permitido: true } ou 404 genérico. Sem motivo, sem
// IP, sem pista nenhuma do que barrou (ver MENSAGEM_GENERICA em
// redeAutorizada.js): pra quem não passou, esta rota é indistinguível de
// uma URL inexistente. O diagnóstico de verdade — qual IP tentou, qual
// regra barrou — sai no log do servidor, que só o administrador lê.
router.get("/bootstrap/status", (req, res) => {
    // Dois níveis, e a diferença é o coração do desenho:
    //
    //   permitido  = só IP na allowlist. Decide se a PÁGINA aparece.
    //   podeCriar  = IP + horário + país. Decide se CRIAR conta é possível.
    //
    // Separar os dois é o que permite revogar acesso às 23h. Se a página
    // inteira dependesse da janela de horário, um notebook roubado de
    // madrugada só poderia ser cortado no dia seguinte — a trava pensada
    // pra conter concessão de acesso acabaria impedindo a contenção.
    if (!ipNaAllowlist(req)) {
        console.warn(`[bootstrap] status negado ip=${req.ip} — fora da allowlist`);
        return res.status(404).json({ erro: MENSAGEM_GENERICA });
    }

    avaliarAcesso(req)
        .then(resultado => res.json({
            permitido: true,
            podeCriar: resultado.permitido === true,
            // Opções dos seletores vêm daqui, não escritas no HTML: uma
            // lista só, impossível de divergir da que o servidor valida.
            opcoes: { horarios: OPCOES.HORARIOS, fusos: OPCOES.FUSOS, paises: OPCOES.PAISES }
        }))
        .catch(() => res.status(500).json({ erro: MENSAGEM_GENERICA }));
});

// POST /api/admin/contas — cria um login novo. ÚNICA rota protegida pelo
// ADMIN_TOKEN estático, e a única porta de entrada quando ainda não
// existe login nenhum (ver criar-acesso/index.html).
//
// DUAS travas independentes, nesta ordem:
//   1. exigirRedeAutorizada — IP/horário/país (ver middleware). Barra
//      antes mesmo de olhar o token, pra não expor a comparação do
//      segredo a quem nem deveria alcançar a rota.
//   2. exigirAdmin — o ADMIN_TOKEN do .env.
// Estar na rede certa não basta; ter o token não basta. Precisa dos dois.
//
// Um 'full' logado NÃO pode criar conta: quem cria acesso precisa do
// segredo do servidor, senão bastaria uma sessão vazada pra alguém
// fabricar acessos permanentes pra si mesmo.
router.post("/contas", exigirRedeAutorizada, exigirAdminComLimite, async (req, res) => {
    if (!ADMIN_SESSION_SECRET) {
        return res.status(500).json({ erro: "Servidor sem ADMIN_SESSION_SECRET configurado (ver .env)." });
    }

    const email = normalizarEmailAdmin(req.body.email);
    const nome = String(req.body.nome || "").trim().slice(0, 80);
    const senha = String(req.body.senha || "");
    const nivel = req.body.nivel === "full" ? "full" : (req.body.nivel === "ver" ? "ver" : null);

    if (!email || !email.includes("@")) return res.status(400).json({ erro: "E-mail inválido." });
    if (!nome) return res.status(400).json({ erro: "nome é obrigatório." });
    if (!nivel) return res.status(400).json({ erro: "nivel precisa ser 'ver' ou 'full'." });
    // 10 caracteres: é um login interno de poucas pessoas, dá pra exigir
    // senha decente sem atrapalhar ninguém.
    if (senha.length < 10) return res.status(400).json({ erro: "A senha precisa ter pelo menos 10 caracteres." });

    const jaExiste = db.prepare("SELECT id FROM admins WHERE email = ?").get(email);
    if (jaExiste) return res.status(409).json({ erro: "Já existe um login com esse e-mail." });

    const restricoes = lerRestricoes(req.body);
    if (restricoes.erro) return res.status(400).json({ erro: restricoes.erro });

    const conta = {
        id: uuidv4(),
        email,
        nome,
        senha_hash: await hashSenha(senha),
        nivel,
        criado_em: Date.now(),
        // Se quem criou já estava logado, guarda o e-mail dele; se veio só
        // com o ADMIN_TOKEN puro (caso normal da primeira conta), fica
        // 'ADMIN_TOKEN' mesmo — é a verdade do que aconteceu.
        criado_por: req.admin ? req.admin.email : "ADMIN_TOKEN",
        ips: restricoes.ips,
        horario: restricoes.horario,
        fuso_horario: restricoes.fusoHorario,
        paises: restricoes.paises
    };

    db.prepare(`
        INSERT INTO admins (id, email, nome, senha_hash, nivel, criado_em, criado_por, ips, horario, fuso_horario, paises)
        VALUES (@id, @email, @nome, @senha_hash, @nivel, @criado_em, @criado_por, @ips, @horario, @fuso_horario, @paises)
    `).run(conta);

    res.status(201).json({
        id: conta.id, email: conta.email, nome: conta.nome, nivel: conta.nivel, criadoEm: conta.criado_em,
        ips: restricoes.ips, horario: restricoes.horario, fusoHorario: restricoes.fusoHorario, paises: restricoes.paises
    });
});

// POST /api/admin/login — email+senha, devolve o JWT de sessão. NÃO passa
// por exigirAdmin de propósito: é justamente a rota que existe pra quem
// não tem o segredo do servidor conseguir entrar.
// UMA resposta pra toda falha: credencial errada, e-mail inexistente,
// bloqueado por tentativas, bloqueado por IP. Mesmo status, mesmo texto —
// e, com gastarTempoEquivalente, mesmo tempo. Quem tenta adivinhar não
// consegue distinguir os casos nem pela mensagem nem pelo relógio.
const FALHA_LOGIN_GENERICA = "E-mail ou senha inválidos.";

router.post("/login", async (req, res) => {
    if (!ADMIN_SESSION_SECRET) {
        return res.status(500).json({ erro: "Servidor sem ADMIN_SESSION_SECRET configurado (ver .env)." });
    }

    const email = normalizarEmailAdmin(req.body.email);
    const senha = String(req.body.senha || "");

    const limite = verificarLimiteLogin(req, email);
    if (limite.bloqueado) {
        console.warn(`[login] tentativa recusada ip=${limite.ip} email=${email} — ${limite.motivo}`);
        // Paga o mesmo custo de um login normal ANTES de responder: sem
        // isso a resposta sairia instantânea e denunciaria o bloqueio.
        await gastarTempoEquivalente();
        return res.status(401).json({ erro: FALHA_LOGIN_GENERICA });
    }

    const conta = db.prepare("SELECT * FROM admins WHERE email = ?").get(email);

    // Sem conta encontrada, ainda assim gasta o tempo de um scrypt (mesmo
    // motivo acima) em vez de retornar de imediato.
    const senhaOk = conta ? await verificarSenha(senha, conta.senha_hash) : false;
    if (!conta) await gastarTempoEquivalente();

    if (!conta || !senhaOk) {
        registrarFalhaLogin({ email, ip: limite.ip, contaExiste: Boolean(conta) });
        return res.status(401).json({ erro: FALHA_LOGIN_GENERICA });
    }

    // Restrições do login: IP e horário (síncrono) + país (só aqui, porque
    // depende de consulta externa e não caberia em toda requisição).
    // Recusa com a MESMA resposta genérica de senha errada — dizer "seu
    // IP não é permitido" confirmaria que a credencial está correta, que
    // é exatamente o que a mensagem única existe pra não entregar.
    const restricao = avaliarRestricoes(conta, limite.ip);
    if (!restricao.permitido) {
        console.warn(`[login] recusado email=${email} ip=${limite.ip} — ${restricao.motivo}`);
        registrarFalhaLogin({ email, ip: limite.ip, contaExiste: true });
        return res.status(401).json({ erro: FALHA_LOGIN_GENERICA });
    }

    const pais = await paisPermitido(conta, limite.ip);
    if (!pais.ok) {
        console.warn(`[login] recusado email=${email} ip=${limite.ip} — país ${pais.pais} fora da lista`);
        registrarFalhaLogin({ email, ip: limite.ip, contaExiste: true });
        return res.status(401).json({ erro: FALHA_LOGIN_GENERICA });
    }

    registrarSucessoLogin(email);
    res.json({
        token: assinarSessaoAdmin(conta),
        admin: { id: conta.id, email: conta.email, nome: conta.nome, nivel: conta.nivel }
    });
});

// ==========================================================================
// RECUPERAÇÃO DE BLOQUEIO — a saída de emergência do limite de login (ver
// middleware/limiteLogin.js). Substitui a antiga isenção por IP, que era
// furada: quem estivesse na mesma rede herdava a isenção sem saber segredo
// nenhum.
//
// DUAS travas, iguais às de criar login: estar num IP da allowlist E ter o
// ADMIN_TOKEN. A diferença é que aqui NÃO se aplica a janela de horário
// (ipNaAllowlist em vez de exigirRedeAutorizada): recuperar acesso é
// justamente o que se precisa fazer fora de hora, e uma trava de horário
// no botão de emergência transformaria "esperei o bloqueio passar" na
// única opção — que é o problema que esta rota existe pra resolver.
//
// Só o ADMIN_TOKEN protege de verdade contra o colega de rede; o IP é a
// segunda camada.
function exigirRedeSemHorario(req, res, next) {
    if (!ipNaAllowlist(req)) {
        console.warn(`[login] desbloqueio recusado — IP fora da allowlist: ${req.ip}`);
        return res.status(404).json({ erro: MENSAGEM_GENERICA });
    }
    next();
}

// POST /api/admin/desbloquear  { alvo: "email@x.com" | "1.2.3.4" | "" }
// alvo vazio limpa TODOS os bloqueios.
// exigirAdmin SEM limite de tentativas, de propósito — e isso merece
// justificativa porque parece um furo.
//
// Se esta rota usasse exigirAdminComLimite, errar o ADMIN_TOKEN 5 vezes
// bloquearia o IP E fecharia a própria rota de recuperação: beco sem
// saída, resolvido só com SSH no servidor. Um freio que tranca a saída de
// emergência não protege, só transforma erro de digitação em incidente.
//
// O risco aceito é pequeno: o ADMIN_TOKEN é um segredo longo e aleatório,
// e força bruta contra isso por HTTP é inviável com ou sem rate limit — o
// limite em /contas é tripwire e sinal de log, não a defesa real. A defesa
// real é o token ser forte (se ele ainda for o placeholder do
// .env.example, TROQUE) somado à exigência de IP na allowlist.
router.post("/desbloquear", exigirRedeSemHorario, exigirAdmin, (req, res) => {
    const resultado = desbloquear(req.body.alvo);
    console.warn(`[login] DESBLOQUEIO manual: alvo=${resultado.alvo} bloqueios=${resultado.bloqueios} tentativas=${resultado.tentativas}`);
    res.json(resultado);
});

// GET /api/admin/bloqueios — o que está bloqueado agora. Nível 'full':
// saber quem está travado é informação de administração, não de leitura.
router.get("/bloqueios", exigirNivel('full'), (req, res) => {
    res.json({ bloqueios: listarBloqueios() });
});

// GET /api/admin/eu — quem sou eu / meu nível. O front chama isso logo
// depois do login pra decidir o que mostrar (esconder a moderação de quem
// é 'ver'), e pra detectar sessão expirada sem ter que disparar uma rota
// de dados qualquer só pra ver se dá 401.
router.get("/eu", exigirNivel('ver'), (req, res) => {
    res.json({ admin: req.admin });
});

// ==========================================================================
// ADMINISTRAÇÃO DE LOGINS INTERNOS — tudo por ADMIN_TOKEN, na página
// criar-acesso/. NÃO fica no painel de moderação de propósito: conta de
// funcionário não é "moderação" (que trata de usuário final), e ter as
// duas juntas fazia um 'full' já logado precisar de token + IP + horário
// pra criar login DENTRO do painel, falhando com 404 mudo.
//
// São contas DA EMPRESA, não do funcionário: quem administra é o dono do
// ADMIN_TOKEN. Por isso não existe mais "trocar minha senha" — redefinir
// a senha de alguém é sobrescrever a conta (PUT abaixo).
//
// Nada disto entra em log_auditoria_moderacao: aquela tabela registra
// mudança em dado de USUÁRIO FINAL, com finalidade jurídica. Credencial
// interna é outra categoria — misturar poluiria o histórico que importa.
// O rastro fica no log do servidor.
//
// PORTÕES, e a diferença é intencional:
//   - CRIAR conta nova ......... IP + horário + token
//     (conceder acesso novo é justamente o que a janela existe pra conter)
//   - SOBRESCREVER / APAGAR .... IP + token, SEM horário
//     (são ações de CONTENÇÃO: notebook roubado às 23h precisa de corte
//      imediato, e uma trava de horário viraria incidente em espera)
//
// Ressalva conhecida: sobrescrever permite elevar 'ver' -> 'full', ou
// seja, conceder acesso sem passar pela janela. Aceito por simplicidade —
// quem faz isso já tem o ADMIN_TOKEN, que é a proteção real.
// ==========================================================================

// POST /api/admin/contas/consulta  { email }
// A página pergunta ANTES de decidir os botões: e-mail sem conta mostra
// "Salvar"; com conta, mostra "Salvar alterações" + "Apagar".
//
// Exige ADMIN_TOKEN porque isto É um oráculo de enumeração — diz quais
// e-mails têm login. Atrás do token tudo bem (quem o tem já pode tudo);
// aberto, desfaria o cuidado que a rota de login tem em não revelar quais
// contas existem.
router.post("/contas/consulta", exigirRedeSemHorario, exigirAdmin, (req, res) => {
    const email = normalizarEmailAdmin(req.body.email);
    if (!email) return res.status(400).json({ erro: "Informe o e-mail." });

    const conta = db.prepare(`
        SELECT nome, nivel, criado_em AS criadoEm,
               ips, horario, fuso_horario AS fusoHorario, paises
        FROM admins WHERE email = ?
    `).get(email);
    // Devolve nome e nível pra página preencher com o que já está valendo:
    // sem isso, "sobrescrever" começaria em branco e seria fácil trocar o
    // nível de alguém sem perceber.
    res.json({ existe: Boolean(conta), conta: conta || null });
});

// PUT /api/admin/contas  { email, nome, senha, nivel } — sobrescreve.
router.put("/contas", exigirRedeSemHorario, exigirAdminComLimite, async (req, res) => {
    if (!ADMIN_SESSION_SECRET) {
        return res.status(500).json({ erro: "Servidor sem ADMIN_SESSION_SECRET configurado (ver .env)." });
    }

    const email = normalizarEmailAdmin(req.body.email);
    const nome = String(req.body.nome || "").trim().slice(0, 80);
    const senha = String(req.body.senha || "");
    const nivel = req.body.nivel === "full" ? "full" : (req.body.nivel === "ver" ? "ver" : null);

    const conta = db.prepare("SELECT * FROM admins WHERE email = ?").get(email);
    if (!conta) return res.status(404).json({ erro: "Não existe login com esse e-mail." });
    if (!nome) return res.status(400).json({ erro: "nome é obrigatório." });
    if (!nivel) return res.status(400).json({ erro: "nivel precisa ser 'ver' ou 'full'." });
    if (senha.length < 10) return res.status(400).json({ erro: "A senha precisa ter pelo menos 10 caracteres." });

    // Rebaixar o último 'full' deixaria a operação sem ninguém capaz de
    // usar a moderação. O ADMIN_TOKEN ainda resolveria, mas é erro fácil
    // de cometer e chato de descobrir depois.
    if (conta.nivel === "full" && nivel !== "full") {
        const totalFull = db.prepare("SELECT COUNT(*) AS total FROM admins WHERE nivel = 'full'").get().total;
        if (totalFull <= 1) {
            return res.status(400).json({ erro: "Esse é o último login 'full' — crie outro antes de rebaixar este." });
        }
    }

    // senha_alterada_em = agora derruba TODAS as sessões abertas dessa
    // pessoa já na request seguinte (ver identificarAdmin). É o
    // comportamento pedido: sobrescrever credencial tira quem estava
    // dentro, sem esperar o JWT de 12h expirar.
    const restricoes = lerRestricoes(req.body);
    if (restricoes.erro) return res.status(400).json({ erro: restricoes.erro });

    const agora = Date.now();
    db.prepare(`
        UPDATE admins SET nome = ?, senha_hash = ?, nivel = ?, senha_alterada_em = ?,
                          ips = ?, horario = ?, fuso_horario = ?, paises = ?
        WHERE email = ?
    `).run(nome, await hashSenha(senha), nivel, agora,
           restricoes.ips, restricoes.horario, restricoes.fusoHorario, restricoes.paises, email);

    console.warn(`[contas] SOBRESCRITA email=${email} nivel=${nivel} — sessões abertas encerradas`);
    res.json({ email, nome, nivel, sessoesEncerradas: true, ips: restricoes.ips, horario: restricoes.horario, fusoHorario: restricoes.fusoHorario, paises: restricoes.paises });
});

// POST /api/admin/contas/remover  { email }
// POST e não DELETE porque o alvo vai no corpo (e-mail em path exigiria
// encoding, e alguns proxies descartam corpo em DELETE).
router.post("/contas/remover", exigirRedeSemHorario, exigirAdminComLimite, (req, res) => {
    const email = normalizarEmailAdmin(req.body.email);
    const conta = db.prepare("SELECT id, nivel FROM admins WHERE email = ?").get(email);
    if (!conta) return res.status(404).json({ erro: "Não existe login com esse e-mail." });

    if (conta.nivel === "full") {
        const totalFull = db.prepare("SELECT COUNT(*) AS total FROM admins WHERE nivel = 'full'").get().total;
        if (totalFull <= 1) {
            return res.status(400).json({ erro: "Esse é o último login 'full' — crie outro antes de apagar este." });
        }
    }

    db.prepare("DELETE FROM admins WHERE id = ?").run(conta.id);
    console.warn(`[contas] REMOVIDA email=${email}`);
    res.status(204).end();
});

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
// O QUE CONTA COMO "FORA DO ESCOPO DO APP" numa rota — tentativa de acesso
// a arquivo interno (.env, .git, chaves SSH) ou a caminho que este app
// nunca serviu (painel de outra stack, extensão de outra linguagem) e
// caminho genuinamente inexistente (não bate em nenhum router nem em
// arquivo de storage de verdade). Usado em /dashboard/requests (sinaliza
// linha a linha), /dashboard/seguranca/ips (mais um sinal por IP, somado
// aos já existentes) e /dashboard/acessos-indevidos (visão agregada por
// rota) — um classificador só, pros três concordarem sobre o que é ou não
// suspeito — mesmo raciocínio de "isso não é uma falha de verdade" que
// também rege CONDICAO_SQL_ERRO, definido logo abaixo (depende deste
// classificador, por isso vem depois, não antes).
//
// Dois jeitos de uma rota ser LEGÍTIMA (tudo o resto é sinalizado):
//
// 1. Bate em algum PREFIXO_ROTA_LEGITIMO — os únicos caminhos que este
//    servidor de fato expõe de propósito PRO APP (ver app.use(...) em
//    server.js). Não importa o status code batido (200, 404 de um :id
//    que não existe, 500 etc.) — a ROTA em si é uma chamada que o app faz
//    de propósito.
//
// 2. Começa com um segmento em formato UUID v4 — fotos/vídeos são
//    servidos direto da raiz de storage/<id>/... (ver server.js e "PASTA
//    POR PRESTADOR/USUÁRIO" em routes/prestadores.js e usuarios.js), sem
//    prefixo /api, e <id> é sempre o uuid.v4() gerado no cadastro. Uma
//    rota nesse formato é, por construção, uma tentativa de pegar um
//    arquivo de verdade — mesmo que ELE especificamente já tenha sido
//    apagado (404 legítimo, não varredura).
//
// /api/admin FICA DE FORA dessa lista de propósito — a dashboard não é o
// app (ver comentário no topo do arquivo: painel interno, só o Erik
// acessa, protegido por ADMIN_TOKEN fixo, nem passa por identidade.js).
// Tratá-la como "escopo do app" era exatamente o problema: qualquer
// tentativa de acesso a /api/admin/* SEM o token certo é, por definição,
// alguém que não é o Erik tentando o painel — isso É um sinal de
// segurança, não deveria ser engolido pela lista de rotas legítimas do
// app. Em vez de entrar no critério de escopo, /api/admin tem critério
// próprio, à parte, mais adiante em classificarRotaSuspeita: o token
// bateu (o painel de verdade sendo usado) ou não bateu (tentativa de
// invasão do painel) — nunca "a rota existe, então tá tudo bem".
//
// Tudo que não bate em nenhum dos dois (nem no critério próprio do
// admin, abaixo) É sinalizado, com um motivo específico quando a rota
// casa uma assinatura conhecida de varredura (.php/.env/.git/wp-admin/
// etc.) — motivo genérico ("fora do escopo do app") pro resto, que é a
// maioria: bots tentando caminhos aleatórios que não têm assinatura
// reconhecível nenhuma, só não existem mesmo.
// ==========================================================================
const PREFIXOS_ROTA_LEGITIMOS = [
    "/api/usuarios", "/api/prestadores", "/api/avaliacoes",
    "/api/notificacoes", "/api/buscas", "/api/saude"
];

// Prefixo do próprio painel — julgado à parte (ver comentário acima), não
// pela lista de PREFIXOS_ROTA_LEGITIMOS.
const PREFIXO_ROTA_ADMIN = "/api/admin";

const REGEX_UUID_INICIO = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;

// Caminhos que praticamente todo navegador ou crawler pede sozinho, sem
// nenhuma intenção por trás (favicon da aba, robots.txt de SEO, ícone de
// "adicionar à tela inicial" no iOS, desafios de domínio em /.well-known/
// — ex: Apple App Site Association, validação Let's Encrypt). Nenhum
// disso é uma tentativa de ataque; sinalizar geraria só ruído de fundo
// constante que atrapalha achar o que de fato importa.
const REGEX_CAMINHO_BENIGNO_UNIVERSAL = /^\/(favicon\.ico|robots\.txt|apple-touch-icon(-precomposed)?\.png|\.well-known\/.*)$/i;

// Assinaturas que NUNCA aparecem numa chamada de verdade deste app:
// extensão/stack que este Express nunca serve (PHP, ASP.NET, JSP, CGI),
// arquivo de configuração/segredo (.env, .git, id_rsa, .aws, .ssh),
// painel administrativo de outro software (wp-admin, phpmyadmin,
// actuator), ou tentativa de directory traversal ("../").
const REGEX_ASSINATURA_MALICIOSA = /\.(php\d?|aspx?|jsp|cgi)(\?|$)|\.env(\.|$|\?)|\/\.git(\/|$)|wp-(admin|login|content|includes|json)|phpmyadmin|xmlrpc\.php|\.ssh\/|id_rsa|\.aws\/|\.htaccess|\.htpasswd|actuator|\/vendor\/|server-status|\/cgi-bin\/|\.(sql|bak|zip|tar|gz)$|\.\.(\/|%2f)/i;

// statusCode é opcional só pelos chamadores que não tenham essa coluna à
// mão (nenhum tem mais, ver os três SELECTs que alimentam isto — todos
// passaram a trazer status_code); sem ele, uma rota /api/admin cai no
// caso "sem informação de status" tratado como sinalizado mais abaixo,
// por segurança (não dá pra assumir token válido sem saber o status).
function classificarRotaSuspeita(rota, statusCode) {
    if (!rota) return null;

    if (REGEX_CAMINHO_BENIGNO_UNIVERSAL.test(rota)) return null;

    if (REGEX_ASSINATURA_MALICIOSA.test(rota)) {
        return "arquivo interno / assinatura de varredura";
    }

    const rotaLower = rota.toLowerCase();

    // Painel admin: critério é o TOKEN, não o escopo (ver comentário
    // grande acima de PREFIXOS_ROTA_LEGITIMOS). 401 = exigirAdmin
    // rejeitou o X-Admin-Token (ausente ou errado) → sinalizado, é
    // alguém tentando o painel sem ser o Erik. Qualquer outro status
    // (200, 404 de um :id, 500 etc.) → o token bateu, é o painel de
    // verdade sendo usado, não sinalizado.
    const ehRotaAdmin = rotaLower === PREFIXO_ROTA_ADMIN ||
        rotaLower.startsWith(PREFIXO_ROTA_ADMIN + "/") ||
        rotaLower.startsWith(PREFIXO_ROTA_ADMIN + "?");
    if (ehRotaAdmin) {
        return statusCode === 401 ? "token de admin inválido" : null;
    }

    const ehPrefixoLegitimo = PREFIXOS_ROTA_LEGITIMOS.some(
        p => rotaLower === p || rotaLower.startsWith(p + "/") || rotaLower.startsWith(p + "?")
    );
    if (ehPrefixoLegitimo) return null;

    if (REGEX_UUID_INICIO.test(rota)) return null; // arquivo de storage de verdade

    return "fora do escopo do app";
}

// Expõe classificarRotaSuspeita direto pro SQL, como função escalar do
// SQLite (better-sqlite3 suporta registrar função JS nativa) — em vez de
// reescrever a mesma lógica (prefixos, regex de assinatura, o critério
// especial de /api/admin) como uma condição SQL separada, só pra usar
// dentro de CONDICAO_SQL_ERRO logo abaixo. Um classificador, chamável dos
// dois lados (JS puro em /dashboard/requests|seguranca/ips|acessos-
// indevidos; SQL aqui) — nunca diverge. `deterministic: true` porque é
// função pura (mesma entrada, mesma saída sempre), permite o SQLite
// otimizar/cachear a chamada quando possível.
db.function("rotaEhSuspeita", { deterministic: true }, (rota, statusCode) => {
    return classificarRotaSuspeita(rota, statusCode) !== null ? 1 : 0;
});

// ==========================================================================
// O QUE CONTA COMO "ERRO" nas métricas do painel (card "Erros hoje", gráfico
// "Erros por hora", "erros-por-rota", "rotas-populares" e na detecção de
// rota com taxa de erro alta que alimenta Alertas). Usado em TODAS essas
// queries — um lugar só decide a régua, pra nunca ficar uma métrica
// discordando de outra sobre o que é ou não erro.
//
// status_code >= 400, MAS excluindo duas categorias que não são falha da
// aplicação — o servidor fez exatamente o que devia:
//
// - 401/403: autenticação/autorização REJEITANDO CORRETAMENTE quem não
//   tinha permissão. Antes disso, um 401 de alguém testando o painel sem
//   token (ou com token vencido) contava igual a um 500 de verdade: como
//   o painel bate em ~12 endpoints a cada ciclo de auto-refresh, isso
//   inflava "erros" com volume alto e constante sem sinalizar problema
//   nenhum — foi exatamente o que gerou o pico de "Erros por hora"
//   investigado antes de existir esta constante.
//
// - Rota sinalizada por classificarRotaSuspeita/rotaEhSuspeita (acima):
//   varredura automatizada batendo em caminho que este app nunca serviu
//   (ex: sonda de RCE em Struts/PHP, injeção OGNL, tentativa de pegar
//   .env/.git) sempre vai dar 404 aqui — não porque a aplicação tem
//   algum bug, mas porque aquele caminho simplesmente não existe e nunca
//   existiu. Sem essa exclusão, "Erros hoje" ficava poluído com ruído de
//   internet (scanners automatizados testando o servidor o tempo todo)
//   em vez de mostrar só o que de fato merece investigação — o mesmo
//   raciocínio do 401/403 acima, uma categoria a mais de "o servidor
//   reagiu certo a algo que não é sobre o app".
//
// 404/422/429/500 etc. em rota LEGÍTIMA do app continuam contando
// normalmente: esses sim tendem a indicar algo pra investigar (rota
// errada, payload inválido, rate limit, bug no servidor).
//
// CONDICAO_SQL_NAO_E_ERRO_REAL fica separada (não só embutida dentro de
// CONDICAO_SQL_ERRO) porque /dashboard/erros-por-rota precisa da mesma
// exclusão numa variante com faixa (4xx vs 5xx) que CONDICAO_SQL_ERRO não
// cobre sozinha — ver total4xx logo abaixo.
const CONDICAO_SQL_NAO_E_ERRO_REAL = "status_code NOT IN (401, 403) AND rotaEhSuspeita(rota, status_code) = 0";
const CONDICAO_SQL_ERRO = `status_code >= 400 AND ${CONDICAO_SQL_NAO_E_ERRO_REAL}`;

// GET /api/admin/dashboard/data
router.get("/dashboard/data", exigirNivel('ver'), (req, res) => {
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
    const inicioMesMs = inicioMes.getTime();

    const { total: ativacoesMes } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE criado_em >= ?"
    ).get(inicioMesMs);

    // Exclusões de conta do mês — mesma fonte e mesmo raciocínio do
    // totalExcluidas em GET /dashboard/churn: auditoria_contas sobrevive à
    // exclusão da conta (usuarios não tem mais a linha depois de excluída),
    // então é a única forma de contar isso. Aqui a janela é fixa "mês
    // corrente" (pro card "Exclusões de conta/mês" da Visão geral),
    // diferente de churn que aceita ?dias= arbitrário.
    const { total: exclusoesMes } = db.prepare(
        "SELECT COUNT(*) AS total FROM auditoria_contas WHERE excluido_em >= ?"
    ).get(inicioMesMs);

    const { total: onlineAgora } = db.prepare(
        "SELECT COUNT(*) AS total FROM usuarios WHERE last_seen_at >= ?"
    ).get(agora - MS_ONLINE);

    const { total: totalServicos } = db.prepare(
        "SELECT COUNT(*) AS total FROM prestadores"
    ).get();

    // Prestadores cadastrados no mês corrente, por categoria — top 1 pra
    // alimentar o card "Prestadores do mês (Top 1 serviço mais
    // procurado)". "Mais procurado" aqui é a categoria com mais NOVOS
    // prestadores no mês (não existe log de busca com resultado no
    // schema — buscas_sem_resultado só guarda buscas que NÃO acharam
    // nada, o oposto do que esse card quer dizer); é o melhor proxy real
    // disponível pra "serviço em alta": categoria que mais gente decidiu
    // oferecer esse mês tende a ser a que tem mais demanda percebida.
    // null (sem string formatada) se ninguém cadastrou serviço este mês —
    // o front já trata null como "—", não inventa "nenhum" nem 0.
    const topCategoriaMes = db.prepare(`
        SELECT categoria, COUNT(*) AS total
        FROM prestadores
        WHERE criado_em >= ?
        GROUP BY categoria
        ORDER BY total DESC
        LIMIT 1
    `).get(inicioMesMs);

    const prestadoresMesTopServico = topCategoriaMes
        ? `${topCategoriaMes.categoria} (${topCategoriaMes.total})`
        : null;

    const { total: errosHoje } = db.prepare(
        `SELECT COUNT(*) AS total FROM request_logs WHERE ${CONDICAO_SQL_ERRO} AND criado_em >= ?`
    ).get(inicioHoje);

    res.json({
        stats: {
            ativosHoje,
            ativacoesMes,
            exclusoesMes,
            onlineAgora,
            totalServicos,
            prestadoresMesTopServico,
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
router.get("/dashboard/localizacao", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/usuarios", exigirNivel('ver'), (req, res) => {
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
            u.bloqueado,
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
        bloqueado: !!u.bloqueado,
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
router.get("/dashboard/usuarios/:id", exigirNivel('ver'), (req, res) => {
    const agora = Date.now();

    const usuario = db.prepare(`
        SELECT id, nome, email, telefone, cpf_cnpj AS cpfCnpj,
               avatar_url AS avatarUrl, avatar_customizado AS avatarCustomizado,
               criado_em AS criadoEm, last_seen_at AS lastSeenAt,
               bloqueado, bloqueado_motivo AS bloqueadoMotivo, bloqueado_em AS bloqueadoEm
        FROM usuarios WHERE id = ?
    `).get(req.params.id);

    if (!usuario) {
        return res.status(404).json({ erro: "Usuário não encontrado." });
    }
    usuario.bloqueado = !!usuario.bloqueado;

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

router.get("/dashboard/requests", exigirNivel('ver'), (req, res) => {
    const limite = lerLimite(req, LIMITE_REQUESTS_PADRAO, LIMITE_REQUESTS_MAXIMO);

    const linhas = db.prepare(`
        SELECT metodo, rota, status_code AS statusCode, duracao_ms AS duracaoMs,
               usuario_id AS usuarioId, ip, porta, criado_em AS criadoEm
        FROM request_logs
        ORDER BY criado_em DESC
        LIMIT ?
    `).all(limite);

    // suspeita/motivoSuspeita: ver classificarRotaSuspeita, acima — mesma
    // régua usada em /dashboard/seguranca/ips e /dashboard/acessos-indevidos,
    // aplicada aqui linha a linha pra sinalizar direto na tabela "Requests
    // recentes" quais requests especificamente dispararam o sinal.
    const requests = linhas.map(l => {
        const motivoSuspeita = classificarRotaSuspeita(l.rota, l.statusCode);
        return { ...l, suspeita: motivoSuspeita !== null, motivoSuspeita };
    });

    // temMais: heurística barata — se voltou exatamente o limite pedido,
    // provavelmente existe mais além dele (só teria certeza com um COUNT(*)
    // à parte, caro de rodar em toda request só pra isso). Usada pelo
    // front só pra decidir se mostra o botão "Carregar mais".
    res.json({ requests, temMais: linhas.length === limite });
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
router.delete("/dashboard/requests", exigirNivel('full'), (req, res) => {
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

router.get("/dashboard/logs-cadastro", exigirNivel('ver'), (req, res) => {
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
// 168 = 7 dias. Continua sendo o teto de quem pede a janela em HORAS e
// espera resolução horária.
const HORAS_MAXIMO = 168;
// Teto das janelas longas dos gráficos (1 ano). Pode ser bem mais alto
// que HORAS_MAXIMO porque a granularidade adapta sozinha (hora -> dia ->
// mês, ver escolherGranularidade): o que precisava ser contido era o
// número de PONTOS no eixo, não o tamanho da janela em si.
const HORAS_MAXIMO_GRAFICOS = 24 * 365;

const DIAS_CADASTROS_PADRAO = 14;
const DIAS_CADASTROS_MAXIMO = 90;

function lerHoras(req) {
    const bruto = Number.parseInt(req.query.horas, 10);
    if (!Number.isFinite(bruto) || bruto <= 0) return HORAS_PADRAO;
    return Math.min(bruto, HORAS_MAXIMO);
}

// ==========================================================================
// JANELA DOS GRÁFICOS — resolve `?horas=N` ou `?horas=tudo` num intervalo
// concreto + a GRANULARIDADE do eixo X.
//
// Granularidade é automática, não escolhida por quem chama: uma janela
// longa em resolução de hora vira uma grade impossível de ler e de
// desenhar (90 dias = 2.160 pontos num gráfico de ~700px — menos de um
// pixel por ponto). A régua:
//   até  3 dias  -> hora   (até 72 colunas)
//   até 90 dias  -> dia    (até 90 colunas)
//   acima disso  -> mês    (o app envelhece sem estourar o eixo)
//
// "tudo" = desde o registro mais antigo que EXISTE na tabela consultada,
// e é aqui que mora uma ressalva importante: pra request_logs isso NÃO é
// "desde a criação do app". Aquela tabela tem TTL (ver
// jobs/limparRequestLogs.js + LOG_RETENCAO_DIAS, default 90 dias), então
// o dado mais antigo some sozinho. Já pra `usuarios` (gráficos
// comerciais) "tudo" é literal: nada é apagado por TTL lá, então a série
// vai mesmo até o primeiro cadastro. Cada endpoint informa o `desde` que
// usou pro front poder rotular isso com honestidade.
// ==========================================================================
const GRANULARIDADES = {
    hora: { chaveSql: "%Y-%m-%d %H:00", ms: MS_HORA },
    dia: { chaveSql: "%Y-%m-%d", ms: MS_DIA },
    mes: { chaveSql: "%Y-%m", ms: null } // mês não tem duração fixa — grade gerada por calendário
};

function escolherGranularidade(spanMs) {
    if (spanMs <= 3 * MS_DIA) return "hora";
    if (spanMs <= 90 * MS_DIA) return "dia";
    return "mes";
}

// tabela/coluna entram por parâmetro (não vêm da query string) porque
// isto é interpolado direto no SQL — nunca exponha isso a input do
// usuário.
function resolverJanelaGraficos(req, { tabela, coluna = "criado_em" }) {
    const bruto = String(req.query.horas || "").trim();
    const agora = Date.now();

    if (bruto === "tudo") {
        const linha = db.prepare(`SELECT MIN(${coluna}) AS inicio FROM ${tabela}`).get();
        // Tabela vazia: cai pro padrão em vez de devolver uma janela
        // infinita (ou NaN) — sem dado nenhum, qualquer janela dá o mesmo
        // gráfico vazio, então o padrão é a resposta menos surpreendente.
        const desde = linha && linha.inicio ? linha.inicio : agora - HORAS_PADRAO * MS_HORA;
        return { desde, ate: agora, granularidade: escolherGranularidade(agora - desde), tudo: true };
    }

    const bruteHoras = Number.parseInt(bruto, 10);
    const horas = (Number.isFinite(bruteHoras) && bruteHoras > 0)
        ? Math.min(bruteHoras, HORAS_MAXIMO_GRAFICOS)
        : HORAS_PADRAO;
    const desde = agora - horas * MS_HORA;
    return { desde, ate: agora, granularidade: escolherGranularidade(horas * MS_HORA), tudo: false, horas };
}

// Grade completa do eixo X (mais antigo primeiro), pra que buraco sem
// dado vire zero em vez de sumir e distorcer a leitura do gráfico.
function gerarGrade(desde, ate, granularidade) {
    const chaves = [];
    const d = new Date(desde);

    if (granularidade === "mes") {
        d.setUTCDate(1);
        d.setUTCHours(0, 0, 0, 0);
        while (d.getTime() <= ate) {
            chaves.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
            d.setUTCMonth(d.getUTCMonth() + 1);
        }
        return chaves;
    }

    const pad = n => String(n).padStart(2, "0");
    if (granularidade === "dia") {
        d.setUTCHours(0, 0, 0, 0);
        for (let t = d.getTime(); t <= ate; t += MS_DIA) {
            const x = new Date(t);
            chaves.push(`${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`);
        }
        return chaves;
    }

    d.setUTCMinutes(0, 0, 0);
    for (let t = d.getTime(); t <= ate; t += MS_HORA) {
        chaves.push(gerarChaveHoraUTC(t));
    }
    return chaves;
}

function preencherGrade(linhas, desde, ate, granularidade) {
    const mapa = new Map(linhas.map(l => [l.bucket, l.total]));
    return gerarGrade(desde, ate, granularidade).map(bucket => ({
        bucket,
        total: mapa.get(bucket) || 0
    }));
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
router.get("/dashboard/graficos/tecnicos", exigirNivel('ver'), (req, res) => {
    const { desde, ate, granularidade, tudo } = resolverJanelaGraficos(req, { tabela: "request_logs" });
    const fmt = GRANULARIDADES[granularidade].chaveSql;

    const requestsBrutos = db.prepare(`
        SELECT strftime('${fmt}', criado_em / 1000, 'unixepoch') AS bucket,
               COUNT(*) AS total
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY bucket
    `).all(desde);

    const errosBrutos = db.prepare(`
        SELECT strftime('${fmt}', criado_em / 1000, 'unixepoch') AS bucket,
               COUNT(*) AS total
        FROM request_logs
        WHERE criado_em >= ? AND ${CONDICAO_SQL_ERRO}
        GROUP BY bucket
    `).all(desde);

    const usuariosAtivosBrutos = db.prepare(`
        SELECT strftime('${fmt}', criado_em / 1000, 'unixepoch') AS bucket,
               COUNT(DISTINCT usuario_id) AS total
        FROM request_logs
        WHERE criado_em >= ? AND usuario_id IS NOT NULL
        GROUP BY bucket
    `).all(desde);

    // Distribuição por classe de status acompanha a janela escolhida (era
    // fixa em 24h): olhar 30 dias de tráfego e ver a barra de status ainda
    // presa em "ontem" faria os dois blocos discordarem na mesma tela.
    const requestsPorStatusBrutos = db.prepare(`
        SELECT CAST(status_code / 100 AS INTEGER) AS centena, COUNT(*) AS total
        FROM request_logs
        WHERE criado_em >= ?
        GROUP BY centena
        ORDER BY centena ASC
    `).all(desde);

    const requestsPorStatus = requestsPorStatusBrutos.map(r => ({
        classe: `${r.centena}xx`,
        total: r.total
    }));

    // Nomes antigos (requestsPorHora etc.) mantidos como ALIAS pra não
    // quebrar nada que ainda leia a resposta pela chave velha; as chaves
    // novas são as que o front usa. O item agora é { bucket, total } —
    // "bucket" e não "hora" porque a granularidade varia com a janela.
    const payload = {
        requests: preencherGrade(requestsBrutos, desde, ate, granularidade),
        erros: preencherGrade(errosBrutos, desde, ate, granularidade),
        usuariosAtivos: preencherGrade(usuariosAtivosBrutos, desde, ate, granularidade),
        requestsPorStatus,
        granularidade,
        desde,
        ate,
        tudo
    };
    payload.requestsPorHora = payload.requests;
    payload.errosPorHora = payload.erros;
    payload.usuariosAtivosPorHora = payload.usuariosAtivos;
    payload.requestsPorStatusUltimas24h = requestsPorStatus;

    res.json(payload);
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
router.get("/dashboard/rotas-populares", exigirNivel('ver'), (req, res) => {
    // Mesma janela dos gráficos da aba (aceita ?horas=N e ?horas=tudo) —
    // as duas tabelas ficam logo abaixo dos gráficos, discordar de janela
    // na mesma tela seria armadilha de leitura.
    const { desde } = resolverJanelaGraficos(req, { tabela: "request_logs" });

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

    res.json({ porRota });
});

router.get("/dashboard/erros-por-rota", exigirNivel('ver'), (req, res) => {
    const { desde } = resolverJanelaGraficos(req, { tabela: "request_logs" });

    const brutos = db.prepare(`
        SELECT
            metodo,
            rota,
            COUNT(*) AS totalRequests,
            SUM(CASE WHEN status_code >= 400 AND status_code < 500 AND ${CONDICAO_SQL_NAO_E_ERRO_REAL} THEN 1 ELSE 0 END) AS total4xx,
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

    res.json({ porRota });
});

// ==========================================================================
// GET /api/admin/dashboard/erros-hoje?limit=N
// Lista crua das requests com erro de HOJE (últimas 24h) — alimenta o
// modal que abre ao clicar no card "Erros hoje" da Visão geral. De
// propósito usa a MESMA condição (CONDICAO_SQL_ERRO) e a MESMA janela
// (agora - MS_DIA) que o card usa pra contar `errosHoje` em
// GET /dashboard/data — é o requisito do card: abrir "todos e somente" os
// erros que compõem aquele número, nem um a mais (ex: um erro de ontem)
// nem um a menos (ex: 401/403 que CONDICAO_SQL_ERRO já exclui em toda
// métrica de erro do painel).
// Diferente de /dashboard/erros-por-rota (que agrupa por rota, últimas
// 24h fixas por padrão MAS aceita ?horas= arbitrário): aqui é lista
// individual, uma linha por request, sem agregação — o modal mostra cada
// ocorrência (rota, status, quando, de qual usuário/IP), não um resumo.
// temMais: mesma heurística de /dashboard/requests (linhas.length ===
// limite), mas aqui dá pra confirmar com certeza via `total` (COUNT(*)
// exato) porque a janela é fixa, não corre risco de custo alto como um
// COUNT(*) sem filtro de tempo correria.
// ==========================================================================
const LIMITE_ERROS_HOJE_PADRAO = 100;
const LIMITE_ERROS_HOJE_MAXIMO = 2000;

router.get("/dashboard/erros-hoje", exigirNivel('ver'), (req, res) => {
    const limite = lerLimite(req, LIMITE_ERROS_HOJE_PADRAO, LIMITE_ERROS_HOJE_MAXIMO);
    const desde = Date.now() - MS_DIA;

    const linhas = db.prepare(`
        SELECT metodo, rota, status_code AS statusCode, duracao_ms AS duracaoMs,
               usuario_id AS usuarioId, ip, porta, criado_em AS criadoEm
        FROM request_logs
        WHERE ${CONDICAO_SQL_ERRO} AND criado_em >= ?
        ORDER BY criado_em DESC
        LIMIT ?
    `).all(desde, limite);

    const { total } = db.prepare(
        `SELECT COUNT(*) AS total FROM request_logs WHERE ${CONDICAO_SQL_ERRO} AND criado_em >= ?`
    ).get(desde);

    res.json({ erros: linhas, total, temMais: linhas.length < total });
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
router.get("/dashboard/graficos/comercial", exigirNivel('ver'), (req, res) => {
    // ?dias=tudo -> desde o PRIMEIRO cadastro. Aqui "tudo" é literal, ao
    // contrário dos gráficos técnicos: `usuarios` não tem TTL, nada é
    // apagado, então a série cobre mesmo toda a vida do app. A
    // granularidade acompanha o tamanho da janela (dia -> mês) pra não
    // virar uma grade ilegível quando o app tiver anos de idade.
    const pediuTudo = String(req.query.dias || "").trim() === "tudo";
    const agora = Date.now();

    let desde;
    let dias;
    if (pediuTudo) {
        const linha = db.prepare("SELECT MIN(criado_em) AS inicio FROM usuarios").get();
        desde = linha && linha.inicio ? linha.inicio : agora - DIAS_CADASTROS_PADRAO * MS_DIA;
        dias = Math.max(1, Math.ceil((agora - desde) / MS_DIA));
    } else {
        const diasBruto = Number.parseInt(req.query.dias, 10);
        dias = (Number.isFinite(diasBruto) && diasBruto > 0)
            ? Math.min(diasBruto, DIAS_CADASTROS_MAXIMO)
            : DIAS_CADASTROS_PADRAO;
        desde = agora - dias * MS_DIA;
    }

    const granularidadeCadastros = escolherGranularidade(agora - desde) === "mes" ? "mes" : "dia";
    const fmtCadastros = GRANULARIDADES[granularidadeCadastros].chaveSql;

    const cadastrosBrutos = db.prepare(`
        SELECT strftime('${fmtCadastros}', criado_em / 1000, 'unixepoch') AS bucket,
               COUNT(*) AS total
        FROM usuarios
        WHERE criado_em >= ?
        GROUP BY bucket
        ORDER BY bucket ASC
    `).all(desde);

    // Grade preenchida (dia/mês sem cadastro vira 0) — antes a série vinha
    // crua do SQL, então um dia sem ninguém se cadastrando simplesmente
    // não existia no eixo e a linha "pulava" o vazio, achatando a leitura.
    const cadastrosPorDia = preencherGrade(cadastrosBrutos, desde, agora, granularidadeCadastros)
        .map(({ bucket, total }) => ({ dia: bucket, bucket, total }));

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
        granularidadeCadastros,
        desde,
        tudo: pediuTudo,
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

router.get("/dashboard/retencao", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/funil", exigirNivel('ver'), (req, res) => {
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
        primeiroSalvo: etapa("salvos", "usuario_id"),
        // Clique no WhatsApp é o sinal de ativação mais forte que já
        // existe no app hoje — intenção explícita de contato, mais direto
        // que só salvar ou avaliar. Mesma ressalva do PRIMARY KEY
        // (prestador_id, usuario_id) com ON CONFLICT...DO UPDATE em
        // cliques_whatsapp (ver POST /prestadores/:id/whatsapp-clique,
        // routes/avaliacoes.js): se a pessoa reclicar no MESMO prestador
        // depois, o criado_em daquela linha é sobrescrito com o clique
        // mais recente — então MIN(criado_em) aqui só deixa de ser o
        // primeiro clique de verdade no caso (raro) de alguém que só
        // clicou repetidas vezes no mesmo prestador e nunca em nenhum
        // outro. Não afeta quem clicou em prestadores diferentes ao
        // longo do tempo.
        primeiroCliqueWhatsapp: etapa("cliques_whatsapp", "usuario_id")
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

router.get("/dashboard/contas-mortas", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/churn", exigirNivel('ver'), (req, res) => {
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

router.get("/dashboard/moderacao", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/avaliacoes-insights", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/whatsapp", exigirNivel('ver'), (req, res) => {
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

router.get("/dashboard/prestadores-incompletos", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/mapa-prestadores", exigirNivel('ver'), (req, res) => {
    const prestadores = db.prepare(`
        SELECT lat, lng, categoria FROM prestadores
        WHERE lat IS NOT NULL AND lng IS NOT NULL
    `).all();

    res.json({ prestadores });
});

// GET /api/admin/dashboard/mapa-buscas-sem-resultado
// Mesma ideia de /dashboard/mapa-prestadores, espelhada pro lado da
// demanda: um ponto (lat/lng cru + categoria) por busca sem resultado —
// alimenta o segundo mapa de densidade da aba "Oferta & Demanda", lado a
// lado com o de prestadores, pra comparar visualmente "onde tem oferta"
// com "onde a demanda esbarrou em nada". lat/lng aqui são sempre
// preenchidos na hora da busca (ver routes/buscas.js), diferente de
// município/estado/país que dependem do job de geocoding em background —
// por isso não há WHERE de pendência aqui, todo registro tem ponto.
router.get("/dashboard/mapa-buscas-sem-resultado", exigirNivel('ver'), (req, res) => {
    const buscas = db.prepare(`
        SELECT lat, lng, categoria FROM buscas_sem_resultado
        WHERE lat IS NOT NULL AND lng IS NOT NULL
    `).all();

    res.json({ buscas });
});

router.get("/dashboard/cobertura", exigirNivel('ver'), (req, res) => {
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
// A resposta é agregada por MUNICÍPIO (não mais uma linha por
// categoria+município) — alimenta o gráfico misto da aba "Oferta &
// Demanda": barra = totalBuscas (volume de frustração), linha =
// categoriasConfirmadas (quantas categorias diferentes, naquele
// município, têm os dois sinais concordando). Ordenação por
// categoriasConfirmadas e, dentro do empate, totalBuscas — a chave-mestra
// continua sendo PROVA de demanda, não só a existência teórica do buraco.
// categoriasObservadas/categoriasInferidas ficam disponíveis pro tooltip
// do gráfico dar o detalhe completo sem precisar de outra chamada.
// ==========================================================================
router.get("/dashboard/demanda-nao-atendida", exigirNivel('ver'), (req, res) => {
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

    const combos = [...combinado.values()].map(item => ({
        ...item,
        nivel: item.totalBuscas > 0 && item.temGapInferido
            ? "confirmada"
            : item.totalBuscas > 0
                ? "observada"
                : "inferida"
    }));

    // Agrega os combos categoria+município num total por município.
    const porMunicipioMap = new Map();
    for (const item of combos) {
        if (!item.municipio) continue;
        let acc = porMunicipioMap.get(item.municipio);
        if (!acc) {
            acc = {
                municipio: item.municipio,
                estado: item.estado,
                totalBuscas: 0,
                categoriasConfirmadas: 0,
                categoriasObservadas: 0,
                categoriasInferidas: 0
            };
            porMunicipioMap.set(item.municipio, acc);
        }
        acc.totalBuscas += item.totalBuscas;
        if (!acc.estado && item.estado) acc.estado = item.estado;
        if (item.nivel === "confirmada") acc.categoriasConfirmadas += 1;
        else if (item.nivel === "observada") acc.categoriasObservadas += 1;
        else acc.categoriasInferidas += 1;
    }

    const porMunicipio = [...porMunicipioMap.values()]
        .sort((a, b) => (b.categoriasConfirmadas - a.categoriasConfirmadas) || (b.totalBuscas - a.totalBuscas))
        .slice(0, 15);

    res.json({ porMunicipio });
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
router.get("/dashboard/alertas", exigirNivel('ver'), (req, res) => {
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
router.get("/dashboard/status", exigirNivel('ver'), (req, res) => {
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

    // LOG_RETENCAO_DIAS (não REQUEST_LOGS_RETENCAO_DIAS) e default 90 — tem
    // que bater exatamente com RETENCAO_DIAS_PADRAO/process.env.LOG_RETENCAO_DIAS
    // em jobs/limparRequestLogs.js, senão este número aqui só ilustra, não
    // descreve, a retenção que de fato está em vigor.
    const jobs = {
        prestadoresPendentesGeocoding,
        buscasPendentesGeocoding,
        avaliacoesPendentes,
        requestLogsRetencaoDias: Number(process.env.LOG_RETENCAO_DIAS) || 90
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
// Bem mais baixo que os outros limiares de propósito: diferente de
// volume/taxa de erro/rotas distintas (que podem ter explicação inocente
// em volume alto — um app cliente com bug batendo muito numa rota, por
// exemplo), UM ÚNICO acesso a /.env já não tem explicação inocente
// nenhuma. 3 é só uma margem pequena pra não sinalizar por um clique
// perdido de alguém testando URL errada manualmente.
const ACESSOS_FORA_DO_ESCOPO_SUSPEITO = 3;

router.get("/dashboard/seguranca/ips", exigirNivel('ver'), async (req, res) => {
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

    // Acessos fora do escopo do app (ver classificarRotaSuspeita, acima)
    // por IP, na MESMA janela — não dá pra fazer isso só com SQL (o
    // classificador usa regex/prefixo em JS), então é uma segunda query,
    // mais crua (só ip+rota, sem agregação), classificada e contada aqui.
    // Só entre os IPs que já apareceram no ranking acima — não faz sentido
    // gastar essa contagem com um IP que nem entrou no top da página.
    const rotasPorIp = db.prepare(`
        SELECT ip, rota, status_code AS statusCode FROM request_logs WHERE ip IS NOT NULL AND criado_em >= ?
    `).all(desde);
    const acessosForaDoEscopoPorIp = new Map();
    for (const { ip, rota, statusCode } of rotasPorIp) {
        if (classificarRotaSuspeita(rota, statusCode) === null) continue;
        acessosForaDoEscopoPorIp.set(ip, (acessosForaDoEscopoPorIp.get(ip) || 0) + 1);
    }

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
        const acessosForaDoEscopo = acessosForaDoEscopoPorIp.get(l.ip) || 0;

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
        if (acessosForaDoEscopo >= ACESSOS_FORA_DO_ESCOPO_SUSPEITO) {
            motivos.push(`${acessosForaDoEscopo} acesso(s) fora do escopo do app`);
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
            acessosForaDoEscopo,
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

// ==========================================================================
// GET /api/admin/dashboard/acessos-indevidos?minutos=N&limit=N
// Área própria pra "acesso fora do escopo do app" (ver classificarRotaSuspeita,
// acima) — diferente de /dashboard/seguranca/ips (que soma isso como só
// mais um motivo dentre vários, por IP), aqui a pergunta é "quais
// CAMINHOS estão sendo tentados", agrupado por rota: qual caminho mais
// bateram, quantos IPs distintos tentaram o mesmo caminho (um único IP
// insistindo é diferente de vários IPs tentando o mesmo — pode indicar
// uma lista de varredura compartilhada/replicada) e quando foi a última
// vez. mesma janela (?minutos=) e mesmo classificador de
// /dashboard/seguranca/ips — os dois sempre concordam sobre o que é ou
// não um acesso indevido, só cortam o dado em eixos diferentes (por IP x
// por rota).
// ==========================================================================
const LIMITE_ACESSOS_INDEVIDOS_PADRAO = 30;
const LIMITE_ACESSOS_INDEVIDOS_MAXIMO = 100;

router.get("/dashboard/acessos-indevidos", exigirNivel('ver'), (req, res) => {
    const minutos = lerMinutos(req);
    const limite = lerLimite(req, LIMITE_ACESSOS_INDEVIDOS_PADRAO, LIMITE_ACESSOS_INDEVIDOS_MAXIMO);
    const desde = Date.now() - minutos * 60 * 1000;

    const linhas = db.prepare(`
        SELECT rota, ip, status_code AS statusCode, criado_em AS criadoEm FROM request_logs WHERE criado_em >= ?
    `).all(desde);

    const porRotaMap = new Map();
    let totalGeral = 0;
    const ipsUnicos = new Set();

    for (const { rota, ip, statusCode, criadoEm } of linhas) {
        const motivo = classificarRotaSuspeita(rota, statusCode);
        if (motivo === null) continue;

        totalGeral += 1;
        if (ip) ipsUnicos.add(ip);

        let acc = porRotaMap.get(rota);
        if (!acc) {
            acc = { rota, motivo, total: 0, ips: new Set(), ultimaEm: criadoEm };
            porRotaMap.set(rota, acc);
        }
        acc.total += 1;
        if (ip) acc.ips.add(ip);
        if (criadoEm > acc.ultimaEm) acc.ultimaEm = criadoEm;
    }

    const porRota = [...porRotaMap.values()]
        .map(({ rota, motivo, total, ips, ultimaEm }) => ({
            rota, motivo, total, ipsDistintos: ips.size, ultimaEm
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, limite);

    res.json({
        totalGeral,
        ipsDistintosGeral: ipsUnicos.size,
        minutos,
        porRota
    });
});

// ==========================================================================
// MODERAÇÃO — CRUD administrativo total sobre usuarios/prestadores, pra
// uma página separada (dashboard/moderacao.html), fora do dashboard de
// métricas (só leitura). Mesmo token fixo (exigirAdmin/ADMIN_TOKEN) por
// enquanto — ver comentário no topo do arquivo sobre não existir um
// conceito de "usuário admin" no schema ainda.
//
// IRRESTRITO DE PROPÓSITO: ao contrário das rotas equivalentes em
// usuarios.js/prestadores.js (exigirUsuario + checagem de dono), estas
// não verificam posse — quem tem o ADMIN_TOKEN pode editar/excluir
// QUALQUER conta ou prestador da plataforma. É a base pedida pra uma
// tela de moderação, agora com um log de auditoria de quem mudou o quê
// (ver registrarAuditoria abaixo e a tabela log_auditoria_moderacao em
// db.js) — motivo de edição em texto livre continua de fora, fica pra
// depois se precisar.
// ==========================================================================

const { sanitizarTexto: sanitizarTextoModeracao } = require("../utils/sanitizar");
const { validarTelefone: validarTelefoneModeracao } = require("../utils/telefone");
const { validarCpfCnpj, digitosCpfCnpj } = require("../utils/cpfCnpj");
const { formatarPrestador, SELECT_PRESTADORES_COM_NOTA } = require("../utils/formatarPrestador");
const BASE_UPLOADS_MODERACAO = path.join(__dirname, "../../storage");

// mesma normalização de tag usada em prestadores.js (não exportada de lá,
// duplicada aqui de propósito pra não acoplar os dois arquivos por causa
// de uma função de 5 linhas)
function normalizarTagModeracao(texto) {
    return String(texto)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function normalizarDiasSemanaModeracao(diasSemana) {
    if (!Array.isArray(diasSemana)) return [0, 1, 2, 3, 4, 5, 6];
    const validos = [...new Set(diasSemana.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    return validos.length > 0 ? validos : [0, 1, 2, 3, 4, 5, 6];
}

// ==========================================================================
// AUDITORIA — ver utils/auditoria.js pro raciocínio completo (por que a
// mesma tabela cobre moderação E ações do próprio usuário).
//
// nomeModerador: agora vem do LOGIN autenticado (req.admin, ver
// middleware/identidadeAdmin.js), não mais de um nome digitado à mão no
// header X-Admin-Nome. Isso resolve o furo óbvio do formato anterior:
// antes qualquer um com o ADMIN_TOKEN podia se identificar como quem
// quisesse no log, o que pra fim jurídico não vale muita coisa. Agora o
// rótulo é a conta que efetivamente autenticou.
function nomeModerador(req) {
    return req.admin ? `${req.admin.nome} <${req.admin.email}>` : "desconhecido";
}

// GET /api/admin/moderacao/prestadores?busca=&limit=
// Lista todos os prestadores (sem filtro de dono) com nome/email de quem
// é dono, pra tela de moderação. ?busca= casa contra nome do prestador
// (herdado da conta — ver formatarPrestador.js), categoria, ou nome/email
// do dono; sem acento/maiúscula, mesmo padrão do resto do painel.
router.get("/moderacao/prestadores", exigirNivel('full'), (req, res) => {
    const limite = lerLimite(req, 200, 2000);
    const busca = sanitizarTextoModeracao(req.query.busca, 100);

    const linhas = db.prepare(`
        SELECT
            p.id, p.categoria, p.descricao, p.telefone, p.cor, p.lat, p.lng,
            p.horario_abre AS horarioAbre, p.horario_fecha AS horarioFecha,
            p.dias_semana AS diasSemana, p.tags, p.criado_em AS criadoEm,
            p.dono_usuario_id AS donoUsuarioId, p.pasta_posicao AS pastaPosicao,
            u.nome AS donoNome, u.email AS donoEmail, u.bloqueado AS donoBloqueado
        FROM prestadores p
        LEFT JOIN usuarios u ON u.id = p.dono_usuario_id
        ORDER BY p.criado_em DESC
        LIMIT ?
    `).all(limite);

    const filtrados = busca
        ? linhas.filter(p => {
            const alvo = normalizarTagModeracao(`${p.donoNome || ""} ${p.donoEmail || ""} ${p.categoria || ""}`);
            return alvo.includes(normalizarTagModeracao(busca));
        })
        : linhas;

    res.json({
        prestadores: filtrados.map(p => ({
            ...p,
            nome: p.donoNome, // prestador não tem nome próprio — herdado do dono (ver formatarPrestador.js)
            donoBloqueado: !!p.donoBloqueado,
            tags: p.tags ? JSON.parse(p.tags) : [],
            diasSemana: p.diasSemana ? JSON.parse(p.diasSemana) : [0, 1, 2, 3, 4, 5, 6]
        }))
    });
});

// GET /api/admin/moderacao/prestadores/:id
// Inclui `capas`: quais das 4 fotos de capa + o vídeo de fato existem no
// disco (ver utils/midia.js) — a tela de moderação usa isso pra saber
// quais botões "remover" mostrar, sem precisar tentar carregar cada
// slot às cegas (mesmo motivo de capasDisponiveis() já existir).
router.get("/moderacao/prestadores/:id", exigirNivel('full'), (req, res) => {
    const linha = db.prepare(`
        SELECT
            p.*, u.nome AS donoNome, u.email AS donoEmail, u.bloqueado AS donoBloqueado
        FROM prestadores p
        LEFT JOIN usuarios u ON u.id = p.dono_usuario_id
        WHERE p.id = ?
    `).get(req.params.id);

    if (!linha) return res.status(404).json({ erro: "Prestador não encontrado." });

    res.json({
        ...linha,
        nome: linha.donoNome,
        donoBloqueado: !!linha.donoBloqueado,
        tags: linha.tags ? JSON.parse(linha.tags) : [],
        diasSemana: linha.dias_semana ? JSON.parse(linha.dias_semana) : [0, 1, 2, 3, 4, 5, 6],
        capas: capasDisponiveis(linha.dono_usuario_id, linha.pasta_posicao)
    });
});

// PATCH /api/admin/moderacao/prestadores/:id
// Mesmos campos aceitos pelo PATCH do dono (ver routes/prestadores.js),
// mas sem exigirDono — admin edita qualquer prestador. Campo omitido
// preserva o valor atual (mesma regra de sempre neste projeto).
router.patch("/moderacao/prestadores/:id", exigirNivel('full'), (req, res) => {
    const atual = db.prepare("SELECT * FROM prestadores WHERE id = ?").get(req.params.id);
    if (!atual) return res.status(404).json({ erro: "Prestador não encontrado." });

    const categoria = req.body.categoria !== undefined ? sanitizarTextoModeracao(req.body.categoria, 60) : atual.categoria;
    const descricao = req.body.descricao !== undefined ? (sanitizarTextoModeracao(req.body.descricao, 460) || null) : atual.descricao;
    const telefone = req.body.telefone !== undefined ? sanitizarTextoModeracao(req.body.telefone, 30) : atual.telefone;
    const cor = req.body.cor !== undefined ? (sanitizarTextoModeracao(req.body.cor, 30) || atual.cor) : atual.cor;
    const lat = typeof req.body.lat === "number" ? req.body.lat : atual.lat;
    const lng = typeof req.body.lng === "number" ? req.body.lng : atual.lng;
    const horarioAbre = typeof req.body.horarioAbre === "number" ? req.body.horarioAbre : atual.horario_abre;
    const horarioFecha = typeof req.body.horarioFecha === "number" ? req.body.horarioFecha : atual.horario_fecha;
    const diasSemana = req.body.diasSemana !== undefined
        ? normalizarDiasSemanaModeracao(req.body.diasSemana)
        : (atual.dias_semana ? JSON.parse(atual.dias_semana) : [0, 1, 2, 3, 4, 5, 6]);

    if (!categoria || !telefone || typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ erro: "categoria, telefone, lat e lng são obrigatórios." });
    }
    if (!validarTelefoneModeracao(telefone)) {
        return res.status(400).json({ erro: "Telefone inválido. Use um número com DDD, ex: (86) 99999-9999." });
    }

    let tags;
    if (req.body.tagsTexto !== undefined) {
        tags = ["/all", normalizarTagModeracao(categoria)]
            .concat(String(req.body.tagsTexto || "").split(",").map(t => sanitizarTextoModeracao(t, 30)).filter(Boolean));
    } else {
        const tagsAtuais = JSON.parse(atual.tags || "[]");
        const categoriaAntigaNormalizada = normalizarTagModeracao(atual.categoria);
        const extras = tagsAtuais.filter(t => t !== "/all" && t !== categoriaAntigaNormalizada);
        tags = ["/all", normalizarTagModeracao(categoria), ...extras];
    }

    db.prepare(`
        UPDATE prestadores
        SET categoria = @categoria, descricao = @descricao, telefone = @telefone, cor = @cor, lat = @lat, lng = @lng,
            horario_abre = @horario_abre, horario_fecha = @horario_fecha, dias_semana = @dias_semana, tags = @tags
        WHERE id = @id
    `).run({
        id: req.params.id, categoria, descricao, telefone, cor, lat, lng,
        horario_abre: horarioAbre, horario_fecha: horarioFecha,
        dias_semana: JSON.stringify(diasSemana),
        tags: JSON.stringify(tags)
    });

    const alteracoes = diffCampos(
        {
            categoria: atual.categoria, descricao: atual.descricao, telefone: atual.telefone, cor: atual.cor,
            lat: atual.lat, lng: atual.lng, horarioAbre: atual.horario_abre, horarioFecha: atual.horario_fecha,
            diasSemana: atual.dias_semana ? JSON.parse(atual.dias_semana) : [0, 1, 2, 3, 4, 5, 6],
            tags: JSON.parse(atual.tags || "[]")
        },
        { categoria, descricao, telefone, cor, lat, lng, horarioAbre, horarioFecha, diasSemana, tags }
    );
    if (alteracoes) {
        registrarAuditoria({
            ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
            entidadeTipo: "prestador", entidadeId: req.params.id, alteracoes
        });
    }

    const linha = db.prepare(`${SELECT_PRESTADORES_COM_NOTA} WHERE p.id = ? GROUP BY p.id`).get(req.params.id);
    res.json(formatarPrestador(linha));
});

// DELETE /api/admin/moderacao/prestadores/:id — sem checagem de dono.
router.delete("/moderacao/prestadores/:id", exigirNivel('full'), (req, res) => {
    const linha = db.prepare("SELECT * FROM prestadores WHERE id = ?").get(req.params.id);
    if (!linha) return res.status(404).json({ erro: "Prestador não encontrado." });

    db.prepare("DELETE FROM prestadores WHERE id = ?").run(req.params.id);
    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "excluir",
        entidadeTipo: "prestador", entidadeId: req.params.id, alteracoes: linha
    });
    res.status(204).end();
});

// PATCH /api/admin/moderacao/usuarios/:id
// Edição irrestrita de conta — mesmos campos do PATCH do próprio usuário
// (nome/telefone/cpfCnpj, ver routes/usuarios.js) mais email, que o dono
// nunca pode editar sozinho (é herdado do Google no login). Checagem de
// unicidade de email replicada aqui porque a coluna é UNIQUE no schema.
router.patch("/moderacao/usuarios/:id", exigirNivel('full'), (req, res) => {
    const atual = db.prepare("SELECT nome, email, telefone, cpf_cnpj FROM usuarios WHERE id = ?").get(req.params.id);
    if (!atual) return res.status(404).json({ erro: "Usuário não encontrado." });

    let nome = atual.nome;
    if (req.body.nome !== undefined) {
        nome = sanitizarTextoModeracao(req.body.nome, 80);
        if (!nome) return res.status(400).json({ erro: "nome não pode ficar vazio." });
    }

    let email = atual.email;
    if (req.body.email !== undefined) {
        const emailBruto = sanitizarTextoModeracao(req.body.email, 190);
        email = emailBruto || null;
        if (email) {
            const conflito = db.prepare("SELECT id FROM usuarios WHERE email = ? AND id != ?").get(email, req.params.id);
            if (conflito) return res.status(400).json({ erro: "Já existe outra conta com esse e-mail." });
        }
    }

    let telefone = atual.telefone;
    if (req.body.telefone !== undefined) {
        const telefoneBruto = sanitizarTextoModeracao(req.body.telefone, 30);
        if (telefoneBruto && !validarTelefoneModeracao(telefoneBruto)) {
            return res.status(400).json({ erro: "Telefone inválido. Use um número com DDD, ex: (86) 99999-9999." });
        }
        telefone = telefoneBruto || null;
    }

    let cpfCnpj = atual.cpf_cnpj;
    if (req.body.cpfCnpj !== undefined) {
        const cpfCnpjBruto = sanitizarTextoModeracao(req.body.cpfCnpj, 20);
        if (cpfCnpjBruto && !validarCpfCnpj(cpfCnpjBruto)) {
            return res.status(400).json({ erro: "CPF/CNPJ inválido. Use 11 dígitos (CPF) ou 14 (CNPJ)." });
        }
        cpfCnpj = cpfCnpjBruto ? digitosCpfCnpj(cpfCnpjBruto) : null;
    }

    db.prepare("UPDATE usuarios SET nome = ?, email = ?, telefone = ?, cpf_cnpj = ? WHERE id = ?")
        .run(nome, email, telefone, cpfCnpj, req.params.id);

    const alteracoesUsuario = diffCampos(
        { nome: atual.nome, email: atual.email, telefone: atual.telefone, cpfCnpj: atual.cpf_cnpj },
        { nome, email, telefone, cpfCnpj }
    );
    if (alteracoesUsuario) {
        registrarAuditoria({
            ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
            entidadeTipo: "usuario", entidadeId: req.params.id, alteracoes: alteracoesUsuario
        });
    }

    const atualizado = db.prepare(`
        SELECT id, nome, email, telefone, cpf_cnpj AS cpfCnpj, avatar_url AS avatarUrl, criado_em AS criadoEm
        FROM usuarios WHERE id = ?
    `).get(req.params.id);
    res.json(atualizado);
});

// DELETE /api/admin/moderacao/usuarios/:id
// Mesma cascata/transação de DELETE /api/usuarios/:id (autoexclusão), só
// que sem exigir que seja a própria conta — ver comentário lá pra
// detalhe de cada passo (ordem de FK, auditoria_contas, limpeza de
// arquivo fora da transação).
router.delete("/moderacao/usuarios/:id", exigirNivel('full'), (req, res) => {
    const usuario = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.params.id);
    if (!usuario) return res.status(404).json({ erro: "Conta não encontrada." });

    const excluirTransacao = db.transaction((usuarioId) => {
        db.prepare("DELETE FROM avaliacoes WHERE autor_usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM cliques_whatsapp WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM salvos WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM notificacoes WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM prestadores WHERE dono_usuario_id = ?").run(usuarioId);

        db.prepare(`
            INSERT INTO auditoria_contas (usuario_id, criado_em, excluido_em)
            VALUES (?, ?, ?)
        `).run(usuarioId, usuario.criado_em, Date.now());

        db.prepare("DELETE FROM usuarios WHERE id = ?").run(usuarioId);
    });

    try {
        excluirTransacao(req.params.id);
    } catch (erro) {
        console.error("Falha ao excluir conta (moderação):", erro);
        return res.status(500).json({ erro: "Não foi possível excluir a conta agora. Tente de novo em instantes." });
    }

    // Mesma disciplina de privacidade de auditoria_contas (ver schema.sql):
    // nada de nome/e-mail/telefone sobrevivendo aqui, só o suficiente pra
    // provar QUE a conta existiu e quando foi excluída.
    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "excluir",
        entidadeTipo: "usuario", entidadeId: req.params.id,
        alteracoes: { criadoEm: usuario.criado_em }
    });

    fs.rm(path.join(BASE_UPLOADS_MODERACAO, req.params.id), { recursive: true, force: true }, () => {});
    fs.readdir(BASE_UPLOADS_MODERACAO, (erro, entradas) => {
        if (erro) return;
        entradas
            .filter(nome => nome.startsWith(`${req.params.id}-p-`))
            .forEach(nome => fs.rm(path.join(BASE_UPLOADS_MODERACAO, nome), { recursive: true, force: true }, () => {}));
    });

    res.status(204).end();
});

// ==========================================================================
// MÍDIA DE CAPA (prestador) — remoção pela moderação, sem checagem de
// dono (mesmo espírito irrestrito do resto de /moderacao). Não existe
// upload aqui, só remoção: pra trocar a mídia, o próprio dono sobe uma
// nova pelas rotas normais (POST /:id/foto-capa/:indice, POST
// /:id/capa-video em routes/prestadores.js) — moderação só tira o que
// não cumpre as diretrizes, não substitui por outra coisa.
//
// fs.rm({force:true}) não erra se o arquivo já não existir — mesmo
// padrão idempotente usado em removerFotosCapaAntigas/
// removerVideoCapaAntigo (routes/prestadores.js), reaproveitado aqui via
// pastaCapaPrestador (utils/midia.js) pra não duplicar a lógica de
// caminho num terceiro lugar.
// ==========================================================================

// DELETE /api/admin/moderacao/prestadores/:id/capa/:indice — indice 1 a 4,
// mesma numeração usada em POST /:id/foto-capa/:indice.
router.delete("/moderacao/prestadores/:id/capa/:indice", exigirNivel('full'), (req, res) => {
    const prestador = db.prepare("SELECT dono_usuario_id, pasta_posicao FROM prestadores WHERE id = ?").get(req.params.id);
    if (!prestador) return res.status(404).json({ erro: "Prestador não encontrado." });

    const indice = Number(req.params.indice);
    if (!Number.isInteger(indice) || indice < 1 || indice > 4) {
        return res.status(400).json({ erro: "indice precisa ser um número entre 1 e 4." });
    }

    const sufixo = indice === 1 ? "" : `-${indice}`;
    const arquivo = `capa${sufixo}.webp`;
    fs.rm(path.join(pastaCapaPrestador(prestador.dono_usuario_id, prestador.pasta_posicao), arquivo), { force: true }, () => {});

    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
        entidadeTipo: "prestador", entidadeId: req.params.id,
        alteracoes: { capa: { de: `slot ${indice} removido pela moderação`, para: null } }
    });

    res.status(204).end();
});

// DELETE /api/admin/moderacao/prestadores/:id/capa-video
router.delete("/moderacao/prestadores/:id/capa-video", exigirNivel('full'), (req, res) => {
    const prestador = db.prepare("SELECT dono_usuario_id, pasta_posicao, capa_tipo FROM prestadores WHERE id = ?").get(req.params.id);
    if (!prestador) return res.status(404).json({ erro: "Prestador não encontrado." });

    fs.rm(path.join(pastaCapaPrestador(prestador.dono_usuario_id, prestador.pasta_posicao), "capa.mp4"), { force: true }, () => {});
    // Volta capa_tipo pra 'foto' — mesma regra de exclusividade do upload
    // (POST /:id/foto-capa, /:id/capa-video em routes/prestadores.js):
    // sem vídeo, o prestador não pode continuar "marcado" como tendo capa
    // em vídeo, senão o front tentaria carregar um capa.mp4 que não
    // existe mais.
    db.prepare("UPDATE prestadores SET capa_tipo = 'foto' WHERE id = ?").run(req.params.id);

    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
        entidadeTipo: "prestador", entidadeId: req.params.id,
        alteracoes: { capaVideo: { de: "removido pela moderação", para: null } }
    });

    res.status(204).end();
});

// DELETE /api/admin/moderacao/usuarios/:id/avatar — remove a foto própria
// da conta (mesmo efeito de DELETE /api/usuarios/:id/avatar, sem exigir
// que seja o próprio dono). Volta a valer a foto do Google (avatar_url,
// sincronizada a cada login) por baixo.
router.delete("/moderacao/usuarios/:id/avatar", exigirNivel('full'), (req, res) => {
    const usuario = db.prepare("SELECT id FROM usuarios WHERE id = ?").get(req.params.id);
    if (!usuario) return res.status(404).json({ erro: "Usuário não encontrado." });

    db.prepare("UPDATE usuarios SET avatar_customizado = 0 WHERE id = ?").run(req.params.id);
    fs.rm(path.join(BASE_UPLOADS_MODERACAO, req.params.id, "avatar", "avatar.webp"), { force: true }, () => {});

    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
        entidadeTipo: "usuario", entidadeId: req.params.id,
        alteracoes: { avatar: { de: "foto própria removida pela moderação", para: null } }
    });

    res.status(204).end();
});

// ==========================================================================
// BLOQUEIO DE CONTA — ver migração usuarios.bloqueado em db.js pro
// raciocínio completo (por que é separado de excluir, e por que
// identidade.js/entrar-google checam isso em request e em login).
// ==========================================================================

// PATCH /api/admin/moderacao/usuarios/:id/bloqueio  { bloqueado: bool, motivo? }
router.patch("/moderacao/usuarios/:id/bloqueio", exigirNivel('full'), (req, res) => {
    const usuario = db.prepare("SELECT id, nome, bloqueado FROM usuarios WHERE id = ?").get(req.params.id);
    if (!usuario) return res.status(404).json({ erro: "Usuário não encontrado." });

    if (typeof req.body.bloqueado !== "boolean") {
        return res.status(400).json({ erro: "bloqueado precisa ser true ou false." });
    }

    const bloqueado = req.body.bloqueado;
    const motivo = bloqueado ? (sanitizarTextoModeracao(req.body.motivo, 300) || null) : null;
    const agora = bloqueado ? Date.now() : null;

    db.prepare("UPDATE usuarios SET bloqueado = ?, bloqueado_motivo = ?, bloqueado_em = ? WHERE id = ?")
        .run(bloqueado ? 1 : 0, motivo, agora, req.params.id);

    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
        entidadeTipo: "usuario", entidadeId: req.params.id,
        alteracoes: { bloqueado: { de: !!usuario.bloqueado, para: bloqueado }, motivo: motivo || undefined }
    });

    res.json({ id: usuario.id, bloqueado, bloqueadoMotivo: motivo, bloqueadoEm: agora });
});

// ==========================================================================
// BANIMENTO POR E-MAIL — ver migração emails_bloqueados em db.js. Cobre
// impedir login/cadastro futuro por e-mail, mesmo sem conta existente
// (ou depois de a conta ter sido excluída).
// ==========================================================================

// GET /api/admin/moderacao/emails-bloqueados
router.get("/moderacao/emails-bloqueados", exigirNivel('full'), (req, res) => {
    const linhas = db.prepare(`
        SELECT email, motivo, moderador, criado_em AS criadoEm
        FROM emails_bloqueados ORDER BY criado_em DESC
    `).all();
    res.json({ emailsBloqueados: linhas });
});

// POST /api/admin/moderacao/emails-bloqueados  { email, motivo? }
router.post("/moderacao/emails-bloqueados", exigirNivel('full'), (req, res) => {
    const email = sanitizarTextoModeracao(req.body.email, 190).toLowerCase();
    if (!email || !email.includes("@")) {
        return res.status(400).json({ erro: "Informe um e-mail válido." });
    }
    const motivo = sanitizarTextoModeracao(req.body.motivo, 300) || null;

    db.prepare(`
        INSERT INTO emails_bloqueados (email, motivo, moderador, criado_em)
        VALUES (@email, @motivo, @moderador, @criado_em)
        ON CONFLICT(email) DO UPDATE SET motivo = @motivo, moderador = @moderador, criado_em = @criado_em
    `).run({ email, motivo, moderador: nomeModerador(req), criado_em: Date.now() });

    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
        entidadeTipo: "usuario", entidadeId: email,
        alteracoes: { emailBloqueado: { de: null, para: motivo || true } }
    });

    res.status(201).json({ email, motivo });
});

// DELETE /api/admin/moderacao/emails-bloqueados/:email
router.delete("/moderacao/emails-bloqueados/:email", exigirNivel('full'), (req, res) => {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const existente = db.prepare("SELECT email FROM emails_bloqueados WHERE email = ?").get(email);
    if (!existente) return res.status(404).json({ erro: "Este e-mail não está bloqueado." });

    db.prepare("DELETE FROM emails_bloqueados WHERE email = ?").run(email);

    registrarAuditoria({
        ator: nomeModerador(req), origem: 'moderacao', acao: "editar",
        entidadeTipo: "usuario", entidadeId: email,
        alteracoes: { emailBloqueado: { de: true, para: null } }
    });

    res.status(204).end();
});

// GET /api/admin/moderacao/log?limit=&entidadeTipo=&entidadeId=
// Listagem geral (aba "Log de auditoria" da moderação) e, com
// entidadeTipo+entidadeId, o "histórico desta conta/prestador" mostrado
// dentro do modal de edição (ver carregarHistoricoEntidade em
// moderacao/script.js). Sem paginação de servidor de verdade — mesmo
// padrão de limit simples já usado no resto do painel.
router.get("/moderacao/log", exigirNivel('full'), (req, res) => {
    const limite = lerLimite(req, 100, 500);
    const entidadeTipo = req.query.entidadeTipo === "usuario" || req.query.entidadeTipo === "prestador"
        ? req.query.entidadeTipo
        : null;
    const entidadeId = entidadeTipo ? sanitizarTextoModeracao(req.query.entidadeId, 100) : null;
    const origemFiltro = req.query.origem === "moderacao" || req.query.origem === "usuario"
        ? req.query.origem
        : null;

    const condicoes = [];
    const params = [];
    if (entidadeTipo && entidadeId) {
        condicoes.push("entidade_tipo = ?", "entidade_id = ?");
        params.push(entidadeTipo, entidadeId);
    }
    if (origemFiltro) {
        condicoes.push("origem = ?");
        params.push(origemFiltro);
    }
    const whereSql = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";

    const linhas = db.prepare(`
        SELECT id, moderador AS ator, origem, acao, entidade_tipo AS entidadeTipo, entidade_id AS entidadeId,
               alteracoes, criado_em AS criadoEm
        FROM log_auditoria_moderacao
        ${whereSql}
        ORDER BY criado_em DESC
        LIMIT ?
    `).all(...params, limite);

    res.json({
        log: linhas.map(l => ({ ...l, alteracoes: l.alteracoes ? JSON.parse(l.alteracoes) : null }))
    });
});

module.exports = router;

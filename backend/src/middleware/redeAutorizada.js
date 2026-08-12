const { obterLocalizacoesEmLote } = require("../utils/ipLocalizacao");

// ==========================================================================
// REDE AUTORIZADA — trava da rota de bootstrap (POST /api/admin/contas,
// a que cria login novo). Existe por causa de um paradoxo do desenho
// anterior: pra entrar na moderação é preciso um login, mas o único
// lugar pra criar login era... dentro da moderação. A saída é uma página
// pública separada (criar-acesso/), sem exigir sessão — e é justamente
// por ela ser pública que ela precisa de uma trava que NÃO seja "estar
// logado".
//
// TUDO AQUI É SERVER-SIDE, de propósito. A página estática não consegue
// se proteger sozinha: qualquer um pode ignorar o HTML e chamar a rota
// via curl. Então a página só REFLETE o que este middleware decidiu; ela
// nunca decide nada.
//
// Três camadas, aplicadas nesta ordem (a primeira que falha já barra):
//   1. IP (BOOTSTRAP_IPS) — a trava de verdade.
//   2. Horário (BOOTSTRAP_HORARIO) — reduz a janela de exposição.
//   3. País (BOOTSTRAP_PAISES) — camada extra, ver ressalva abaixo.
//
// E o ADMIN_TOKEN continua exigido POR CIMA de tudo isso (ver exigirAdmin
// em routes/admin.js): passar na rede não cria nada sozinho.
//
// RESSALVA SOBRE GEOLOCALIZAÇÃO: a checagem de país usa geo-IP
// (ip-api.com, ver utils/ipLocalizacao.js), que é um palpite, não um
// fato — VPN, CGNAT de operadora móvel e IP corporativo roteado por
// outro estado erram com frequência, tanto liberando quem não devia
// quanto barrando você mesmo num dia ruim. Trate como defesa em
// profundidade, nunca como o controle principal: quem faz o trabalho
// pesado aqui é a lista de IPs. Por isso ela é OPCIONAL e vem desligada
// por padrão; se o serviço externo estiver fora do ar, a checagem é
// PULADA (fail-open) em vez de trancar você pra fora do próprio sistema
// por causa de uma API de terceiro.
// ==========================================================================

// ==========================================================================
// De onde vem a configuração: backend/config/acesso.json, VERSIONADO no
// Git. Nada aqui é segredo (ver comentário no próprio JSON), então o
// lugar certo é o repositório — assim mudar o IP liberado é um commit,
// e o servidor se reproduz com `git pull && pm2 restart`, sem ninguém
// editando arquivo à mão na EC2.
//
// As variáveis de ambiente equivalentes (BOOTSTRAP_IPS etc.) continuam
// funcionando e têm PRECEDÊNCIA sobre o JSON — mas só como escotilha de
// emergência: liberar um IP novo às pressas sem esperar deploy. O estado
// normal e esperado é o arquivo versionado.
// ==========================================================================
const path = require("path");

function carregarConfig() {
    try {
        // require em vez de fs.readFileSync: o cache do Node garante que
        // o arquivo é lido uma vez só por boot, que é exatamente a
        // semântica que a config precisa (mudou o JSON? precisa de
        // restart, igual .env — nada de reler a cada request).
        return require(path.join(__dirname, "../../config/acesso.json"));
    } catch (erro) {
        // Arquivo ausente ou JSON inválido não pode derrubar o servidor
        // inteiro — degrada pra "criação de login fechada", que é o
        // mesmo lado seguro de não ter IP configurado.
        console.error("[bootstrap] falha ao ler config/acesso.json:", erro.message);
        // Sinaliza a causa pra avaliarAcesso poder dizer "JSON inválido"
        // em vez de "nenhum IP autorizado" — os dois fecham a rota, mas
        // um é configuração vazia e o outro é erro de sintaxe. Confundir
        // os dois manda quem está diagnosticando pro lugar errado.
        return { _erroLeitura: erro.message };
    }
}

const CONFIG = carregarConfig();

// Env vence o JSON quando presente (escotilha de emergência).
const IPS_BRUTO = (process.env.BOOTSTRAP_IPS || "").trim();
const HORARIO_BRUTO = (process.env.BOOTSTRAP_HORARIO || CONFIG.horario || "").trim();
const PAISES_BRUTO = (process.env.BOOTSTRAP_PAISES || "").trim();
const FUSO = process.env.BOOTSTRAP_TZ || CONFIG.fusoHorario || "America/Fortaleza";

// Lista vazia = rota FECHADA (nega tudo), nunca aberta. Esquecer de
// configurar tem que falhar pro lado seguro — o contrário deixaria a
// criação de login exposta pra internet inteira sem ninguém perceber.
const REGRAS_IP = IPS_BRUTO
    ? IPS_BRUTO.split(",").map(s => s.trim()).filter(Boolean)
    : (Array.isArray(CONFIG.ips) ? CONFIG.ips.map(s => String(s).trim()).filter(Boolean) : []);

const PAISES_PERMITIDOS = PAISES_BRUTO
    ? PAISES_BRUTO.split(",").map(s => s.trim()).filter(Boolean)
    : (Array.isArray(CONFIG.paises) ? CONFIG.paises.map(s => String(s).trim()).filter(Boolean) : []);

function ipParaNumero(ip) {
    const partes = ip.split(".");
    if (partes.length !== 4) return null;
    let numero = 0;
    for (const parte of partes) {
        const octeto = Number(parte);
        if (!Number.isInteger(octeto) || octeto < 0 || octeto > 255) return null;
        numero = (numero << 8) + octeto;
    }
    return numero >>> 0;
}

// Normaliza o formato "IPv4 mapeado em IPv6" (::ffff:189.40.1.7) que o
// Node entrega em algumas configurações de socket — sem isso a
// comparação com a allowlist falharia por diferença de formato, não de
// endereço.
function normalizarIp(ip) {
    if (!ip) return "";
    return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function ipAutorizado(ip) {
    const alvo = normalizarIp(ip);
    if (!alvo) return false;

    for (const regra of REGRAS_IP) {
        if (!regra.includes("/")) {
            if (regra === alvo) return true;
            continue;
        }
        const [base, bitsBruto] = regra.split("/");
        const bits = Number(bitsBruto);
        const numeroBase = ipParaNumero(base);
        const numeroAlvo = ipParaNumero(alvo);
        if (numeroBase === null || numeroAlvo === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;

        // Máscara /0 precisa de tratamento à parte: em JS, x >>> 32 é
        // x >>> 0 (o deslocamento é mod 32), então a fórmula genérica
        // devolveria 0 em vez de "combina com tudo".
        const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if ((numeroBase & mascara) === (numeroAlvo & mascara)) return true;
    }
    return false;
}

// "08:00-18:00" no fuso de BOOTSTRAP_TZ (não no fuso do servidor: a EC2
// roda em UTC, então comparar contra a hora local do processo daria 3h
// de diferença e uma janela errada sem ninguém entender por quê).
function horarioAutorizado(agora = new Date()) {
    if (!HORARIO_BRUTO) return true; // sem janela configurada = qualquer horário

    const [inicioBruto, fimBruto] = HORARIO_BRUTO.split("-").map(s => s.trim());
    if (!inicioBruto || !fimBruto) return true;

    const emMinutos = (texto) => {
        const [h, m] = texto.split(":").map(Number);
        return (Number.isInteger(h) ? h : 0) * 60 + (Number.isInteger(m) ? m : 0);
    };

    const horaLocal = new Intl.DateTimeFormat("pt-BR", {
        timeZone: FUSO, hour: "2-digit", minute: "2-digit", hour12: false
    }).format(agora);

    const agoraMin = emMinutos(horaLocal);
    const inicioMin = emMinutos(inicioBruto);
    const fimMin = emMinutos(fimBruto);

    // Janela que cruza a meia-noite ("22:00-06:00") precisa da lógica
    // invertida — senão qualquer horário cairia fora.
    return inicioMin <= fimMin
        ? agoraMin >= inicioMin && agoraMin <= fimMin
        : agoraMin >= inicioMin || agoraMin <= fimMin;
}

async function paisAutorizado(ip) {
    if (PAISES_PERMITIDOS.length === 0) return { ok: true }; // desligado por padrão

    const permitidos = PAISES_PERMITIDOS.map(s => s.toLowerCase());
    try {
        const mapa = await obterLocalizacoesEmLote([normalizarIp(ip)]);
        const info = mapa.get(normalizarIp(ip));
        // Sem resposta útil do serviço externo: PULA a checagem em vez de
        // barrar (ver "fail-open" no cabeçalho) — a lista de IPs já
        // segurou a peteca até aqui.
        if (!info || !info.pais) return { ok: true };
        return { ok: permitidos.includes(String(info.pais).toLowerCase()), pais: info.pais };
    } catch (erro) {
        return { ok: true };
    }
}

// Resultado detalhado, sem efeito colateral. O campo `motivoInterno`
// NUNCA vai pra resposta HTTP: é só pro log do servidor. Quem está do
// outro lado recebe sempre a mesma negativa genérica, independente de
// ter sido IP, horário, país ou config quebrada — dizer QUAL regra
// barrou entrega o desenho do controle de graça (ex: "é horário" revela
// que existe janela e convida a voltar mais tarde; "é IP" confirma que
// existe allowlist). Ver MENSAGEM_GENERICA abaixo.
async function avaliarAcesso(req) {
    const ip = normalizarIp(req.ip);

    if (CONFIG._erroLeitura) {
        return { permitido: false, motivoInterno: `config/acesso.json inválido (${CONFIG._erroLeitura})`, ip };
    }
    if (REGRAS_IP.length === 0) {
        return { permitido: false, motivoInterno: "nenhum IP autorizado em config/acesso.json", ip };
    }
    if (!ipAutorizado(ip)) {
        return { permitido: false, motivoInterno: "IP fora da allowlist", ip };
    }
    if (!horarioAutorizado()) {
        return { permitido: false, motivoInterno: `fora da janela ${HORARIO_BRUTO} (${FUSO})`, ip };
    }
    const pais = await paisAutorizado(ip);
    if (!pais.ok) {
        return { permitido: false, motivoInterno: `país não autorizado (${pais.pais})`, ip };
    }
    return { permitido: true, ip };
}

// Middleware. Responde 403 com o IP visto pelo servidor — mostrar o IP é
// deliberado: quem legitimamente precisa liberar o próprio acesso tem
// que saber qual endereço colocar no .env, e o IP de origem não é
// segredo pra quem está fazendo a request (ele já é o dono dele).
// Resposta única pra qualquer negativa. Também NÃO devolve o IP de
// volta: mesmo sendo um dado que o visitante já possui, ecoá-lo confirma
// que o servidor o está inspecionando — e, pra quem tenta atrás de proxy
// ou VPN, entrega qual endereço chegou de verdade, o que ajuda a calibrar
// tentativas. Descobrir o próprio IP pra liberar acesso legítimo se faz
// pelo log do servidor, que só o administrador lê.
const MENSAGEM_GENERICA = "Não foi possível concluir a operação.";

function exigirRedeAutorizada(req, res, next) {
    avaliarAcesso(req).then(resultado => {
        if (!resultado.permitido) {
            console.warn(`[bootstrap] BLOQUEADO ip=${resultado.ip} motivo=${resultado.motivoInterno}`);
            // 404, não 403: 403 significa "existe e você não pode", o que
            // confirma que a rota existe e é protegida. 404 é indistinto
            // de uma URL que nunca existiu — quem varre a API não aprende
            // que aqui mora a criação de login.
            return res.status(404).json({ erro: MENSAGEM_GENERICA });
        }
        next();
    }).catch(erro => {
        console.error("[bootstrap] falha ao avaliar acesso:", erro);
        res.status(500).json({ erro: MENSAGEM_GENERICA });
    });
}

// Só a checagem de IP, SEM horário nem país. Existe separado de
// avaliarAcesso de propósito: quem consome isto (ver middleware/
// limiteLogin.js) quer saber "esse endereço é de casa?", não "pode criar
// login agora?". São perguntas diferentes.
//
// Misturar as duas foi um bug real: a isenção do limite de login usava
// avaliarAcesso, então às 21:01 — janela de bootstrap fechada — o IP do
// dono deixava de ser isento e ele podia se trancar do próprio painel
// justamente fora do horário comercial, que é quando mais se mexe.
// Horário e país restringem CRIAR credencial; não têm nada a dizer sobre
// em quem confiar pra contagem de tentativas.
function ipNaAllowlist(req) {
    return ipAutorizado(req.ip);
}

module.exports = { exigirRedeAutorizada, avaliarAcesso, ipNaAllowlist, MENSAGEM_GENERICA };

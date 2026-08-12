const { obterLocalizacoesEmLote } = require("./ipLocalizacao");

// ==========================================================================
// RESTRIÇÕES POR LOGIN — de onde e quando cada credencial de funcionário
// pode ser usada (colunas ips/horario/fuso_horario/paises em `admins`).
//
// NÃO confundir com middleware/redeAutorizada.js: aquele guarda a página
// criar-acesso/ e responde ao ADMIN_TOKEN; este governa os logins
// ver/full que a página cria. São coisas separadas de propósito — o admin
// e os funcionários não têm por que compartilhar as mesmas regras.
//
// Avaliado a CADA REQUISIÇÃO (ver identificarAdmin), não só no login: uma
// checagem apenas na entrada deixaria alguém que entrou às 17:59 usar o
// painel a madrugada inteira, o que esvazia o sentido de ter janela.
// ==========================================================================

function normalizarIp(ip) {
    if (!ip) return "";
    return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

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

function ipCombina(ip, regras) {
    const alvo = normalizarIp(ip);
    if (!alvo) return false;

    for (const regra of regras) {
        if (!regra.includes("/")) {
            if (regra === alvo) return true;
            continue;
        }
        const [base, bitsBruto] = regra.split("/");
        const bits = Number(bitsBruto);
        const numeroBase = ipParaNumero(base);
        const numeroAlvo = ipParaNumero(alvo);
        if (numeroBase === null || numeroAlvo === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
        // /0 precisa de caso próprio: em JS o deslocamento é mod 32, então
        // a fórmula genérica daria 0 em vez de "combina com tudo".
        const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if ((numeroBase & mascara) === (numeroAlvo & mascara)) return true;
    }
    return false;
}

function dentroDaJanela(janela, fuso, agora = new Date()) {
    if (!janela) return true;

    const [inicioBruto, fimBruto] = janela.split("-").map(x => x.trim());
    if (!inicioBruto || !fimBruto) return true;

    const emMinutos = texto => {
        const [h, m] = texto.split(":").map(Number);
        return (Number.isInteger(h) ? h : 0) * 60 + (Number.isInteger(m) ? m : 0);
    };

    let horaLocal;
    try {
        horaLocal = new Intl.DateTimeFormat("pt-BR", {
            timeZone: fuso || undefined, hour: "2-digit", minute: "2-digit", hour12: false
        }).format(agora);
    } catch (erro) {
        // Fuso inválido gravado (não deveria passar da validação da rota):
        // cai pro fuso do servidor em vez de derrubar o acesso de alguém
        // por causa de um dado ruim.
        horaLocal = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(agora);
    }

    const agoraMin = emMinutos(horaLocal);
    const inicioMin = emMinutos(inicioBruto);
    const fimMin = emMinutos(fimBruto);

    // Janela que cruza a meia-noite ("22:00-06:00") inverte a lógica.
    return inicioMin <= fimMin
        ? agoraMin >= inicioMin && agoraMin <= fimMin
        : agoraMin >= inicioMin || agoraMin <= fimMin;
}

function listaDe(texto) {
    return String(texto || "").split(",").map(x => x.trim()).filter(Boolean);
}

// Checagem SÍNCRONA (IP + horário) — a que roda em toda requisição.
// País fica de fora daqui de propósito: depende de consulta a serviço
// externo (geo-IP), e fazer isso a cada request adicionaria latência de
// rede a TODAS as chamadas do painel. Ver paisPermitido abaixo, usado só
// no momento do login.
function avaliarRestricoes(admin, ip) {
    const ips = listaDe(admin.ips);
    if (ips.length > 0 && !ipCombina(ip, ips)) {
        return { permitido: false, motivo: "IP fora da lista do login" };
    }
    if (!dentroDaJanela(admin.horario, admin.fuso_horario)) {
        return { permitido: false, motivo: `fora da janela ${admin.horario} (${admin.fuso_horario || "fuso do servidor"})` };
    }
    return { permitido: true };
}

// Checagem de país — só no login. Mesma ressalva de sempre: geo-IP é
// palpite (VPN, CGNAT, IP roteado por outro estado erram), e se o serviço
// externo estiver fora do ar a checagem é PULADA em vez de barrar. Quem
// segura de verdade é a lista de IPs.
async function paisPermitido(admin, ip) {
    const paises = listaDe(admin.paises);
    if (paises.length === 0) return { ok: true };

    try {
        const alvo = normalizarIp(ip);
        const mapa = await obterLocalizacoesEmLote([alvo]);
        const info = mapa.get(alvo);
        if (!info || !info.pais) return { ok: true };
        return { ok: paises.map(p => p.toLowerCase()).includes(String(info.pais).toLowerCase()), pais: info.pais };
    } catch (erro) {
        return { ok: true };
    }
}

module.exports = { avaliarRestricoes, paisPermitido, ipCombina, dentroDaJanela, listaDe, normalizarIp };

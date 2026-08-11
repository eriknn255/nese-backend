const db = require("../db");

// ==========================================================================
// GEOLOCALIZAÇÃO POR IP — usada só pela aba "Segurança" do painel (ver
// GET /dashboard/seguranca/ips em routes/admin.js), pra dar contexto de
// PAÍS/REGIÃO/CIDADE de onde um IP com volume ou taxa de erro suspeita
// está vindo. Mesmo princípio de utils/localizacao.js (geocoding reverso
// de lat/lng): serviço externo gratuito sem chave, nunca lança erro pra
// quem chamou, e SEMPRE cacheado — aqui o cache é ainda mais importante
// porque, diferente do geocoding de cadastro (uma vez por conta), a
// mesma aba pode ser recarregada a cada 30s mostrando os mesmos IPs de
// novo e de novo.
//
// ip-api.com (plano gratuito, sem chave): permite até 45 requests/minuto
// e tem um endpoint de LOTE (POST /batch, até 100 IPs por chamada) — por
// isso obterLocalizacoesEmLote recebe uma LISTA de IPs e faz UMA chamada
// só, em vez de N chamadas individuais (o que estouraria o limite de
// requests/minuto rapidinho com uma lista de 20-30 IPs a cada refresh).
// ==========================================================================

const TIMEOUT_MS = 5000;
const URL_LOTE = "http://ip-api.com/batch?fields=status,country,regionName,city,org,query";
const MAXIMO_POR_LOTE = 100; // teto do próprio serviço

// IPs privados/reservados/loopback nunca resolvem pra nada útil (rodando
// local, atrás de um proxy sem X-Forwarded-For, etc.) — descarta ANTES de
// gastar uma chamada externa ou uma linha de cache com eles.
function ehIpPrivadoOuInvalido(ip) {
    if (!ip) return true;
    if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.")) return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    return false;
}

// Busca no cache (ip_lookup_cache, ver schema em db.js) os IPs já
// resolvidos (com sucesso OU falha registrada) — nunca reconsulta o
// serviço externo pra um IP que já está cacheado, mesmo que a resolução
// anterior tenha sido "falha".
function lerCache(ips) {
    if (ips.length === 0) return new Map();
    const placeholders = ips.map(() => "?").join(",");
    const linhas = db.prepare(
        `SELECT ip, pais, regiao, cidade, organizacao, falha FROM ip_lookup_cache WHERE ip IN (${placeholders})`
    ).all(...ips);
    return new Map(linhas.map(l => [l.ip, l]));
}

const inserirNoCache = db.prepare(`
    INSERT INTO ip_lookup_cache (ip, pais, regiao, cidade, organizacao, falha, resolvido_em)
    VALUES (@ip, @pais, @regiao, @cidade, @organizacao, @falha, @resolvidoEm)
    ON CONFLICT(ip) DO UPDATE SET
        pais = excluded.pais, regiao = excluded.regiao, cidade = excluded.cidade,
        organizacao = excluded.organizacao, falha = excluded.falha, resolvido_em = excluded.resolvido_em
`);

// Recebe uma lista de IPs (pode ter repetidos, tanto faz) e devolve um
// Map ip -> { pais, regiao, cidade, organizacao } | null (null = IP
// privado, inválido, ou a resolução falhou). NUNCA lança erro — mesmo
// princípio de obterLocalizacaoPorCoordenadas em utils/localizacao.js:
// enriquecimento nunca pode derrubar a rota que chamou.
async function obterLocalizacoesEmLote(ipsBrutos) {
    const resultado = new Map();
    const ipsUnicos = [...new Set(ipsBrutos)].filter(Boolean);

    const ipsValidos = [];
    for (const ip of ipsUnicos) {
        if (ehIpPrivadoOuInvalido(ip)) {
            resultado.set(ip, null);
        } else {
            ipsValidos.push(ip);
        }
    }

    const cache = lerCache(ipsValidos);
    const ipsFaltando = [];
    for (const ip of ipsValidos) {
        const linha = cache.get(ip);
        if (!linha) {
            ipsFaltando.push(ip);
        } else {
            resultado.set(ip, linha.falha ? null : {
                pais: linha.pais,
                regiao: linha.regiao,
                cidade: linha.cidade,
                organizacao: linha.organizacao
            });
        }
    }

    if (ipsFaltando.length === 0) return resultado;

    // Lote de até MAXIMO_POR_LOTE por chamada — se vier mais IPs faltando
    // que isso (lista grande, cache ainda vazio), processa em fatias
    // sequenciais em vez de estourar o limite do serviço numa chamada só.
    for (let inicio = 0; inicio < ipsFaltando.length; inicio += MAXIMO_POR_LOTE) {
        const fatia = ipsFaltando.slice(inicio, inicio + MAXIMO_POR_LOTE);
        await resolverFatiaEArmazenar(fatia, resultado);
    }

    return resultado;
}

async function resolverFatiaEArmazenar(ips, resultado) {
    const controlador = new AbortController();
    const timeout = setTimeout(() => controlador.abort(), TIMEOUT_MS);
    const agora = Date.now();

    try {
        const resposta = await fetch(URL_LOTE, {
            method: "POST",
            signal: controlador.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ips)
        });

        if (!resposta.ok) throw new Error(`ip-api respondeu ${resposta.status}`);

        const dados = await resposta.json();

        // dados vem na MESMA ORDEM dos ips enviados (garantia do serviço),
        // mas usamos dados[i].query (o próprio IP ecoado de volta) como
        // chave de verdade em vez de confiar só na posição — mais robusto
        // se o serviço algum dia reordenar ou pular uma entrada.
        dados.forEach(item => {
            const ip = item.query;
            if (!ip) return;

            if (item.status !== "success") {
                resultado.set(ip, null);
                inserirNoCache.run({
                    ip, pais: null, regiao: null, cidade: null, organizacao: null,
                    falha: 1, resolvidoEm: agora
                });
                return;
            }

            const localizacao = {
                pais: item.country || null,
                regiao: item.regionName || null,
                cidade: item.city || null,
                organizacao: item.org || null
            };
            resultado.set(ip, localizacao);
            inserirNoCache.run({
                ip, ...localizacao, falha: 0, resolvidoEm: agora
            });
        });

        // IPs que o serviço não devolveu de jeito nenhum (resposta
        // truncada, erro parcial) — marca como null pro chamador não
        // ficar esperando um valor que nunca chega, mas NÃO cacheia como
        // falha permanente (pode ter sido só um problema pontual desta
        // chamada, vale tentar de novo no próximo refresh).
        ips.forEach(ip => {
            if (!resultado.has(ip)) resultado.set(ip, null);
        });
    } catch (erro) {
        console.error("Falha ao resolver lote de geolocalização de IP:", erro.message);
        // Mesma decisão acima: falha de REDE (timeout, serviço fora do ar)
        // não vira cache permanente de falha — só devolve null pra esta
        // chamada, tenta de novo depois.
        ips.forEach(ip => {
            if (!resultado.has(ip)) resultado.set(ip, null);
        });
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { obterLocalizacoesEmLote, ehIpPrivadoOuInvalido };

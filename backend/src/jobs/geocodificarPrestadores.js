const db = require("../db");
const { obterLocalizacaoPorCoordenadas } = require("../utils/localizacao");

// ==========================================================================
// GEOCODING REVERSO EM BACKGROUND PARA PRESTADORES — mesma ideia de
// utils/localizacao.js (já usado em log_cadastros no cadastro de conta),
// mas rodando como job periódico, não no fluxo síncrono de POST
// /prestadores: cadastrar um serviço não pode ficar refém da latência (ou
// de uma falha) do Nominatim, então isso roda em background e vai
// preenchendo prestadores.municipio/estado/pais aos poucos.
//
// LOTE_POR_CICLO pequeno + INTERVALO_MS de alguns minutos: Nominatim tem
// uma política de uso justo (rate limit ~1 req/s, sem chave de API) — um
// job rodando a cada poucos minutos, poucos prestadores por vez, nunca
// chega perto disso, mesmo com o volume real do app (baixo).
//
// WHERE municipio IS NULL cobre tanto "nunca tentou" quanto "tentou e
// falhou" (obterLocalizacaoPorCoordenadas nunca lança erro — devolve
// tudo null quando falha, ver comentário lá) — então uma falha temporária
// do Nominatim não trava o prestador pra sempre: ele volta a ser elegível
// no próximo ciclo automaticamente.
// ==========================================================================
const LOTE_POR_CICLO = 5;
const INTERVALO_MS = 3 * 60 * 1000; // 3 min

async function geocodificarLotePendente() {
    // ORDER BY RANDOM() (não criado_em) de propósito: se um prestador em
    // particular falhar sempre (ex: coordenada inválida que o Nominatim
    // nunca resolve), ele fica com municipio NULL pra sempre e cairia de
    // novo no WHERE municipio IS NULL do próximo ciclo — com ORDER BY
    // criado_em ASC ele travaria permanentemente no topo da fila,
    // bloqueando os outros pendentes atrás dele. Aleatório garante que a
    // fila continua avançando mesmo com uma linha "presa".
    const pendentes = db.prepare(`
        SELECT id, lat, lng FROM prestadores
        WHERE municipio IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY RANDOM()
        LIMIT ?
    `).all(LOTE_POR_CICLO);

    if (pendentes.length === 0) return;

    // Sequencial (não Promise.all) de propósito: espalha as chamadas no
    // tempo em vez de disparar todas juntas, respeitando o rate limit do
    // Nominatim mesmo dentro de um único ciclo do job.
    for (const prestador of pendentes) {
        const { pais, estado, municipio } = await obterLocalizacaoPorCoordenadas(prestador.lat, prestador.lng);

        // Se o geocoding falhar (tudo null), a linha continua elegível
        // no próximo ciclo — não é um erro fatal, só falta de sorte com
        // o Nominatim naquele momento (ver obterLocalizacaoPorCoordenadas,
        // nunca lança erro pra quem chamou).
        db.prepare("UPDATE prestadores SET municipio = ?, estado = ?, pais = ? WHERE id = ?")
            .run(municipio, estado, pais, prestador.id);
    }
}

function iniciarJobGeocodificacaoPrestadores() {
    geocodificarLotePendente().catch(erro => console.error("Falha no ciclo de geocodificação de prestadores:", erro));
    return setInterval(() => {
        geocodificarLotePendente().catch(erro => console.error("Falha no ciclo de geocodificação de prestadores:", erro));
    }, INTERVALO_MS);
}

module.exports = { iniciarJobGeocodificacaoPrestadores };
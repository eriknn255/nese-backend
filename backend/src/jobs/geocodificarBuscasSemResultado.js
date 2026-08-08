const db = require("../db");
const { obterLocalizacaoPorCoordenadas } = require("../utils/localizacao");

// ==========================================================================
// GEOCODING REVERSO EM BACKGROUND PARA BUSCAS SEM RESULTADO — cópia do
// mesmo padrão de jobs/geocodificarPrestadores.js (ver comentário completo
// lá): POST /api/buscas/sem-resultado grava lat/lng cru pra não atrasar a
// resposta com uma chamada externa ao Nominatim, e este job preenche
// município/estado/país aos poucos, respeitando o rate limit do Nominatim.
//
// LOTE_POR_CICLO/INTERVALO_MS mais generosos que o de prestadores: buscas
// sem resultado tendem a ter volume bem maior que cadastro de prestador
// (é telemetria de toda busca vazia, não de toda conta nova), então um
// lote maior evita a fila crescer mais rápido do que o job dá conta.
// ==========================================================================
const LOTE_POR_CICLO = 15;
const INTERVALO_MS = 3 * 60 * 1000; // 3 min

async function geocodificarLotePendente() {
    // ORDER BY RANDOM() de propósito — mesma razão do job de prestadores:
    // uma coordenada que o Nominatim nunca resolve não pode travar a fila
    // pra sempre no topo de um ORDER BY criado_em ASC.
    const pendentes = db.prepare(`
        SELECT id, lat, lng FROM buscas_sem_resultado
        WHERE municipio IS NULL
        ORDER BY RANDOM()
        LIMIT ?
    `).all(LOTE_POR_CICLO);

    if (pendentes.length === 0) return;

    // Sequencial (não Promise.all) — espalha as chamadas no tempo em vez
    // de disparar todas juntas, respeitando o rate limit do Nominatim
    // mesmo dentro de um único ciclo do job.
    for (const busca of pendentes) {
        const { pais, estado, municipio } = await obterLocalizacaoPorCoordenadas(busca.lat, busca.lng);

        db.prepare("UPDATE buscas_sem_resultado SET municipio = ?, estado = ?, pais = ? WHERE id = ?")
            .run(municipio, estado, pais, busca.id);
    }
}

function iniciarJobGeocodificacaoBuscasSemResultado() {
    geocodificarLotePendente().catch(erro => console.error("Falha no ciclo de geocodificação de buscas sem resultado:", erro));
    return setInterval(() => {
        geocodificarLotePendente().catch(erro => console.error("Falha no ciclo de geocodificação de buscas sem resultado:", erro));
    }, INTERVALO_MS);
}

module.exports = { iniciarJobGeocodificacaoBuscasSemResultado };
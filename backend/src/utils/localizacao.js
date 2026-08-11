// ==========================================================================
// GEOCODING REVERSO — transforma latitude/longitude em País/Estado/
// Município, só usado uma vez por cadastro novo (ver POST /entrar-google
// em routes/usuarios.js, gravado em log_cadastros).
//
// Nominatim (OpenStreetMap): gratuito, sem chave de API — diferente do
// Geocoding API da Google, que precisaria de uma chave nova (você só tem
// GOOGLE_CLIENT_ID hoje, que é OAuth, não serve pra isso). Trade-off:
// Nominatim exige um identificador de app no header User-Agent (política
// deles, não opcional) e tem limite de uso justo pra volume alto — mas
// aqui só roda em CADASTRO NOVO (não em todo login), então o volume real
// é baixo. Se um dia isso virar gargalo, trocar por Google Geocoding API
// (com GOOGLE_MAPS_API_KEY própria) é só reescrever esta função — nada
// fora daqui precisa mudar.
//
// NUNCA lança erro pra quem chamou: localização é enriquecimento, não
// pode derrubar a criação de conta se o serviço externo estiver fora do
// ar ou lento (ver mesmo princípio em criarNotificacao.js).
// ==========================================================================

const TIMEOUT_MS = 5000;

async function obterLocalizacaoPorCoordenadas(latitude, longitude) {
    if (latitude == null || longitude == null) {
        return { pais: null, estado: null, municipio: null };
    }

    const controlador = new AbortController();
    const timeout = setTimeout(() => controlador.abort(), TIMEOUT_MS);

    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&zoom=10&addressdetails=1`;

        const resposta = await fetch(url, {
            signal: controlador.signal,
            headers: {
                // Exigido pela política de uso do Nominatim — identifica quem
                // está chamando, não é opcional (ver docs deles).
                "User-Agent": "Mase-App/1.0 (contato via ruexinternet.com)"
            }
        });

        if (!resposta.ok) throw new Error(`Nominatim respondeu ${resposta.status}`);

        const dados = await resposta.json();
        const endereco = dados.address || {};

        return {
            pais: endereco.country || null,
            estado: endereco.state || null,
            municipio: endereco.city || endereco.town || endereco.municipality || endereco.village || null
        };
    } catch (erro) {
        console.error("Falha ao resolver localização (geocoding reverso):", erro.message);
        return { pais: null, estado: null, municipio: null };
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { obterLocalizacaoPorCoordenadas };
const fs = require("fs");
const path = require("path");

// ==========================================================================
// utils/midia.js — única fonte de verdade sobre QUAIS arquivos de capa
// realmente existem no disco pra um prestador. Antes disso, duas cópias
// dessa lógica tinham divergido: admin.js (temCapa, usado só pro card
// "prestadores incompletos") checava "capa2.webp"/"capa3.webp"/"capa4.webp"
// (sem hífen), mas o upload real em routes/prestadores.js sempre grava com
// hífen ("capa-2.webp" etc, ver SUFIXOS_FOTOS_CAPA) — os slots 2 a 4 nunca
// batiam certo no admin. Fica tudo num lugar só agora.
//
// Objetivo maior: o FRONT nunca deveria tentar `/<pasta>/capa-2.webp` às
// cegas só pra descobrir via erro 404 que aquele slot está vazio (isso é
// o que gerava boa parte dos "Erros hoje" no painel — 404 de mídia que
// nunca existiu não é um erro de sistema, é um estado normal de "prestador
// só subiu 1 foto de capa"). Em vez disso, quem já sabe a resposta
// (o servidor, que tem o filesystem) devolve um booleano explícito no
// JSON do prestador (ver formatarPrestador.js) e o front só renderiza
// <img>/tenta carregar o que o backend já confirmou que existe.
// ==========================================================================

const BASE_PUBLIC = path.join(__dirname, "../public");

// Mesma fórmula de pasta usada em pastaPrestador() (routes/prestadores.js)
// e no antigo temCapa() (routes/admin.js) — repetida aqui de propósito
// (não importada de prestadores.js) pra este util não depender de uma
// rota Express só pra montar um caminho de disco.
function pastaCapaPrestador(donoUsuarioId, pastaPosicao) {
    return path.join(BASE_PUBLIC, `${donoUsuarioId}-p-${pastaPosicao}`, "capa");
}

function arquivoExiste(donoUsuarioId, pastaPosicao, nomeArquivo) {
    if (!donoUsuarioId || pastaPosicao == null) return false;
    return fs.existsSync(path.join(pastaCapaPrestador(donoUsuarioId, pastaPosicao), nomeArquivo));
}

// Um booleano por slot — nomes de arquivo IDÊNTICOS aos gravados de
// verdade em routes/prestadores.js (SUFIXOS_FOTOS_CAPA: "", "-2", "-3",
// "-4") e lidos em fotosCapaPrestador() no front. Se um dia o padrão de
// nome mudar num lado, muda aqui também — não tem mais um segundo lugar
// pra esquecer de atualizar.
function capasDisponiveis(donoUsuarioId, pastaPosicao) {
    return {
        capa: arquivoExiste(donoUsuarioId, pastaPosicao, "capa.webp"),
        capa2: arquivoExiste(donoUsuarioId, pastaPosicao, "capa-2.webp"),
        capa3: arquivoExiste(donoUsuarioId, pastaPosicao, "capa-3.webp"),
        capa4: arquivoExiste(donoUsuarioId, pastaPosicao, "capa-4.webp"),
        video: arquivoExiste(donoUsuarioId, pastaPosicao, "capa.mp4")
    };
}

// Usado pelo card "prestadores incompletos" (admin.js) — "tem capa" no
// sentido amplo, qualquer uma das 4 fotos OU o vídeo já resolve a lacuna.
function temAlgumaCapa(donoUsuarioId, pastaPosicao) {
    const disponiveis = capasDisponiveis(donoUsuarioId, pastaPosicao);
    return disponiveis.capa || disponiveis.capa2 || disponiveis.capa3 || disponiveis.capa4 || disponiveis.video;
}

module.exports = { pastaCapaPrestador, capasDisponiveis, temAlgumaCapa };

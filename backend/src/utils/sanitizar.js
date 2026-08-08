// ==========================================================================
// SANITIZAÇÃO DE TEXTO — camada de defesa no servidor.
// Comentário de avaliação, nome de autor e nome/categoria de prestador
// cadastrado agora passam a ser vistos por TODO MUNDO (antes era só o
// próprio aparelho, via localStorage) — então texto de usuário nunca
// entra cru no banco. Remove tags HTML e corta o tamanho.
//
// IMPORTANTE: isso não substitui escapar no front na hora de renderizar
// (innerHTML) — é defesa em profundidade, não a única camada. Ver
// conversa sobre os 19 innerHTML sem escape no script.js.
// ==========================================================================
function sanitizarTexto(valor, tamanhoMaximo = 500) {
    if (typeof valor !== "string") return "";

    return valor
        .replace(/<[^>]*>/g, "")   // remove qualquer coisa que pareça tag HTML
        .replace(/[<>]/g, "")      // sobra de < ou > sem par (ex: "a < b")
        .trim()
        .slice(0, tamanhoMaximo);
}

module.exports = { sanitizarTexto };

const crypto = require("crypto");
const { promisify } = require("util");

// scrypt em vez de bcrypt: já vem no Node (crypto), sem dependência nova
// só pra isso. Formato salvo: "salt:hash", os dois em hex, os dois
// gerados/derivados na hora — nunca reaproveita salt entre contas.
const TAMANHO_HASH = 64;

// ASSÍNCRONO, não scryptSync — e isso não é preferência de estilo.
// O scrypt é caro DE PROPÓSITO (~60ms com estes parâmetros): é o que
// torna força bruta inviável. Mas na versão Sync esse custo é pago
// TRAVANDO a única thread de JS do Node: durante os 60ms o servidor
// inteiro para — não aceita conexão, não responde ninguém, nem usuário
// comum do app.
//
// Numa rota pública como POST /admin/login isso vira vetor de negação de
// serviço: ~8 requests/segundo bastam pra manter o processo permanentemente
// travado, sem precisar acertar senha nenhuma. A versão assíncrona joga o
// trabalho no threadpool do libuv — continua custando os mesmos 60ms pra
// quem tenta adivinhar, mas o event loop segue livre atendendo o resto.
const scryptAsync = promisify(crypto.scrypt);

async function hashSenha(senha) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await scryptAsync(senha, salt, TAMANHO_HASH);
    return `${salt}:${hash.toString("hex")}`;
}

async function verificarSenha(senha, armazenado) {
    const [salt, hashSalvo] = (armazenado || "").split(":");
    if (!salt || !hashSalvo) return false;

    const hashTentativa = await scryptAsync(senha, salt, TAMANHO_HASH);
    const bufferSalvo = Buffer.from(hashSalvo, "hex");

    // mesmo raciocínio de timingSafeEqual do ADMIN_TOKEN (ver
    // routes/admin.js): tamanhos batendo antes de comparar bytes, senão
    // ele lança em vez de simplesmente dizer "não bate".
    return bufferSalvo.length === hashTentativa.length && crypto.timingSafeEqual(bufferSalvo, hashTentativa);
}

// Gasta o MESMO tempo de um scrypt real sem verificar nada. Usado nos
// caminhos de falha que não chegam a comparar senha (e-mail inexistente,
// tentativa já bloqueada) pra que todos custem igual.
//
// Sem isso, a mensagem genérica não bastaria: uma resposta instantânea
// denunciaria "esse e-mail não existe" ou "você está bloqueado", e daria
// pra enumerar contas cronometrando as respostas em vez de lendo o texto
// delas. O canal de vazamento seria o relógio, não a mensagem.
async function gastarTempoEquivalente() {
    await scryptAsync("equalizacao-de-tempo", "salt-fixo-descartavel", TAMANHO_HASH);
}

module.exports = { hashSenha, verificarSenha, gastarTempoEquivalente };

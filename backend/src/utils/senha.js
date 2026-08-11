const crypto = require("crypto");

// scrypt em vez de bcrypt: já vem no Node (crypto), sem dependência nova
// só pra isso. Formato salvo: "salt:hash", os dois em hex, os dois
// gerados/derivados na hora — nunca reaproveita salt entre contas.
const TAMANHO_HASH = 64;

function hashSenha(senha) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(senha, salt, TAMANHO_HASH).toString("hex");
    return `${salt}:${hash}`;
}

function verificarSenha(senha, armazenado) {
    const [salt, hashSalvo] = (armazenado || "").split(":");
    if (!salt || !hashSalvo) return false;

    const hashTentativa = crypto.scryptSync(senha, salt, TAMANHO_HASH);
    const bufferSalvo = Buffer.from(hashSalvo, "hex");

    // mesmo raciocínio de timingSafeEqual do ADMIN_TOKEN (ver
    // routes/admin.js): tamanhos batendo antes de comparar bytes, senão
    // ele lança em vez de simplesmente dizer "não bate".
    return bufferSalvo.length === hashTentativa.length && crypto.timingSafeEqual(bufferSalvo, hashTentativa);
}

module.exports = { hashSenha, verificarSenha };

// ==========================================================================
// VALIDAÇÃO DE TELEFONE — compartilhada entre routes/prestadores.js (onde
// telefone é obrigatório) e routes/usuarios.js (onde telefone da conta é
// opcional; a obrigatoriedade é decidida em cada rota, não aqui). Extraído
// pra um módulo próprio pra não duplicar a mesma regra nos dois arquivos.
// Mesma regra usada no cliente (ver telefoneValido em 00-script.js) — só
// que aqui é quem decide de verdade; o cliente só avisa sem esperar a rede.
// ==========================================================================

function digitosTelefone(telefone) {
    return String(telefone || "").replace(/\D/g, "");
}

// Telefone BR: 10 dígitos (fixo, DDD + 8) ou 11 (celular, DDD + 9), com
// DDD válido (11 a 99 — não existe DDD começando em 0 ou "00"). Não
// valida se o número existe de verdade (só um SMS faria isso), só barra
// o caso óbvio de string aleatória no campo.
function validarTelefone(telefone) {
    const digitos = digitosTelefone(telefone);
    if (digitos.length !== 10 && digitos.length !== 11) return false;
    const ddd = Number(digitos.slice(0, 2));
    return ddd >= 11 && ddd <= 99;
}

module.exports = { validarTelefone, digitosTelefone };

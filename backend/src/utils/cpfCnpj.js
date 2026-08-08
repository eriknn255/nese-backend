// ==========================================================================
// CPF/CNPJ DA CONTA — campo opcional em "Preferências da conta"
// (routes/usuarios.js, PATCH /:id). Auto-declarado: qualquer sequência de
// 11 (CPF) ou 14 (CNPJ) dígitos é aceita, SEM checar dígito verificador e
// SEM consultar a Receita Federal. Isso é uma decisão de produto, não uma
// limitação técnica — o app não faz nenhuma promessa de identidade
// verificada, só mostra que a conta preencheu o campo (ver selo
// "CPF/CNPJ cadastrado" em formatarPrestador.js/00-script.js, nunca
// "verificado"). Se um dia isso precisar virar verificação de verdade,
// entra aqui uma chamada pra alguma API de validação (ex: BrasilAPI pra
// CNPJ, que é gratuita) — o resto do app não muda, só essa função passa a
// devolver false pra números que não existem de verdade.
// ==========================================================================

function digitosCpfCnpj(valor) {
    return String(valor || "").replace(/\D/g, "");
}

// Só tamanho — 11 dígitos "parece" CPF, 14 "parece" CNPJ. Não valida se o
// número é real (ver comentário acima), só barra o caso óbvio de lixo no
// campo (ex: "123", ou letras que a máscara do front não pegou).
function validarCpfCnpj(valor) {
    const digitos = digitosCpfCnpj(valor);
    return digitos.length === 11 || digitos.length === 14;
}

module.exports = { validarCpfCnpj, digitosCpfCnpj };

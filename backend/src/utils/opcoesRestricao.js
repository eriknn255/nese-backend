// ==========================================================================
// OPÇÕES PERMITIDAS nas restrições de um login (horário, fuso, país).
//
// FONTE ÚNICA: o backend valida contra estas listas E as serve pro front
// montar os seletores (ver GET /bootstrap/status). Antes as opções viviam
// escritas à mão no HTML e o servidor aceitava qualquer valor no formato
// certo — duas listas que podiam divergir em silêncio, e um valor fora do
// menu podia entrar por chamada direta à API.
//
// Fechar a lista também elimina um caso feio: horário gravado que não
// corresponde a nenhuma opção. Com a lista aberta era possível, e o
// seletor precisava de uma gambiarra ("Outro") só pra não trocar o valor
// de alguém sem avisar. Sem valores fora do menu, o problema deixa de
// existir em vez de ser contornado.
// ==========================================================================

const HORARIOS = [
    { valor: "00:00-23:59", rotulo: "Qualquer horário (24h)" },
    { valor: "08:00-18:00", rotulo: "Comercial — 08:00 às 18:00" },
    { valor: "07:00-19:00", rotulo: "Estendido — 07:00 às 19:00" },
    { valor: "06:00-22:00", rotulo: "Amplo — 06:00 às 22:00" },
    { valor: "08:00-12:00", rotulo: "Manhã — 08:00 às 12:00" },
    { valor: "13:00-18:00", rotulo: "Tarde — 13:00 às 18:00" },
    { valor: "22:00-06:00", rotulo: "Noturno — 22:00 às 06:00" }
];

// Só o Brasil: a empresa e os funcionários estão aqui, e as ~400 zonas
// IANA tornariam a escolha pior, não melhor.
const FUSOS = [
    { valor: "America/Fortaleza", rotulo: "Fortaleza (UTC−3)" },
    { valor: "America/Sao_Paulo", rotulo: "São Paulo / Brasília (UTC−3)" },
    { valor: "America/Recife", rotulo: "Recife (UTC−3)" },
    { valor: "America/Bahia", rotulo: "Salvador (UTC−3)" },
    { valor: "America/Belem", rotulo: "Belém (UTC−3)" },
    { valor: "America/Araguaina", rotulo: "Araguaína (UTC−3)" },
    { valor: "America/Maceio", rotulo: "Maceió (UTC−3)" },
    { valor: "America/Santarem", rotulo: "Santarém (UTC−3)" },
    { valor: "America/Campo_Grande", rotulo: "Campo Grande (UTC−4)" },
    { valor: "America/Cuiaba", rotulo: "Cuiabá (UTC−4)" },
    { valor: "America/Manaus", rotulo: "Manaus (UTC−4)" },
    { valor: "America/Porto_Velho", rotulo: "Porto Velho (UTC−4)" },
    { valor: "America/Boa_Vista", rotulo: "Boa Vista (UTC−4)" },
    { valor: "America/Rio_Branco", rotulo: "Rio Branco (UTC−5)" },
    { valor: "America/Eirunepe", rotulo: "Eirunepé (UTC−5)" },
    { valor: "America/Noronha", rotulo: "Fernando de Noronha (UTC−2)" }
];

// `valor` precisa bater EXATAMENTE com o nome que o serviço de geo-IP
// devolve (ip-api.com, em inglês) — o rótulo é que fica em português.
// "" = sem restrição de país.
const PAISES = [
    { valor: "", rotulo: "Qualquer país (sem restrição)" },
    { valor: "Brazil", rotulo: "Brasil" },
    { valor: "Portugal", rotulo: "Portugal" },
    { valor: "United States", rotulo: "Estados Unidos" },
    { valor: "Argentina", rotulo: "Argentina" }
];

const valoresDe = lista => lista.map(x => x.valor);

module.exports = {
    HORARIOS, FUSOS, PAISES,
    HORARIOS_VALIDOS: valoresDe(HORARIOS),
    FUSOS_VALIDOS: valoresDe(FUSOS),
    PAISES_VALIDOS: valoresDe(PAISES).filter(Boolean)
};

// Mesma forma de objeto que o script.js já espera em PRESTADORES (tags como
// array, horario como {abre, fecha}) — pra minimizar o que muda no front na
// hora de trocar localStorage por fetch(). nota/quantidade vêm de fora (já
// calculados via JOIN na query), não ficam guardados na tabela — mesmo
// princípio de calcularAvaliacaoPrestador() no front: sempre recalculado,
// nunca um número fixo que pode ficar dessincronizado.
// SQL base reaproveitada em qualquer lugar que liste prestadores (busca,
// salvos, "meus cadastros") — LEFT JOIN com avaliações publicadas pra
// trazer a nota já calculada, sem duplicar essa lógica em cada rota.
//
// LEFT JOIN (não JOIN) com usuarios: nome e avatar do prestador são
// HERDADOS ao vivo da conta que o cadastrou (ver conversa sobre isso — se
// a pessoa troca o nome/foto no Google, todos os prestadores dela
// refletem sozinhos, sem precisar editar cada um) — mas precisa ser LEFT
// porque os 6 prestadores demo têm dono_usuario_id NULL de propósito (ver
// schema.sql), não são órfãos por engano. Com JOIN normal esses 6 somem
// de toda listagem (e 404 no GET /:id deles); com LEFT eles continuam
// aparecendo, só caem no fallback de formatarPrestador() abaixo (nome
// próprio da tabela prestadores, sem avatar customizado).
const { capasDisponiveis } = require("../midia");

const SELECT_PRESTADORES_COM_NOTA = `
    SELECT
        p.*,
        u.nome AS dono_nome,
        u.avatar_url AS dono_avatar_url,
        u.avatar_customizado AS dono_avatar_customizado,
        u.cpf_cnpj AS dono_cpf_cnpj,
        COUNT(a.id) AS avaliacoes_quantidade,
        AVG(a.nota) AS avaliacoes_media
    FROM prestadores p
    LEFT JOIN usuarios u ON u.id = p.dono_usuario_id
    LEFT JOIN avaliacoes a ON a.prestador_id = p.id AND a.status = 'publicada'
`;

function formatarPrestador(linha) {
    // Prestador com dono (imensa maioria daqui pra frente): nome/avatar
    // vêm sempre da conta, ao vivo. Prestador demo (dono_usuario_id NULL):
    // cai pro nome legado gravado na própria tabela prestadores e nunca
    // tem avatar customizado — não existe conta nenhuma por trás pra ter
    // subido uma foto própria.
    const temDono = !!linha.dono_usuario_id;

    // Checagem real de filesystem (ver utils/midia.js) — feita uma vez
    // aqui, no único lugar que monta o JSON público do prestador, pra
    // NUNCA mais o front precisar adivinhar via 404 se um slot de capa
    // existe. Prestador sem dono (demo) não tem pasta nenhuma; todos os
    // campos saem false sem tocar o disco.
    const capas = temDono
        ? capasDisponiveis(linha.dono_usuario_id, linha.pasta_posicao)
        : { capa: false, capa2: false, capa3: false, capa4: false, video: false };

    return {
        id: linha.id,
        nome: temDono ? (linha.dono_nome || linha.nome) : linha.nome,
        categoria: linha.categoria,
        descricao: linha.descricao || null,
        telefone: linha.telefone,
        cor: linha.cor,
        lat: linha.lat,
        lng: linha.lng,
        tags: JSON.parse(linha.tags),
        horario: {
            abre: linha.horario_abre,
            fecha: linha.horario_fecha,
            dias: linha.dias_semana ? JSON.parse(linha.dias_semana) : [0, 1, 2, 3, 4, 5, 6]
        },
        donoUsuarioId: linha.dono_usuario_id || null,
        avatarUrl: temDono ? (linha.dono_avatar_url || null) : null,
        // Raw (não !!): 0 = sem foto própria, ou o timestamp (ms) de quando
        // a conta subiu a última foto própria. O front usa esse número tanto
        // pra decidir "tem foto customizada?" (truthy/falsy, funciona igual
        // um booleano) quanto como cache-bust na URL (?v=...) — ver
        // avatarUrlEfetivo em 00-script.js. Virar booleano aqui destruiria
        // essa segunda informação e a foto nova nunca apareceria pra quem
        // já tinha a antiga em cache. Já é seguro do jeito que está: só é
        // gravado no banco DEPOIS que o arquivo é escrito com sucesso (ver
        // POST /:id/avatar em routes/usuarios.js), então nunca aponta pra
        // um arquivo que não existe — diferente da capa, não precisou de
        // um campo "disponível" novo.
        avatarCustomizado: temDono ? (linha.dono_avatar_customizado || 0) : 0,
        capaTipo: linha.capa_tipo || "foto",
        // Caminho relativo até a PASTA de capa (não o arquivo em si) —
        // o front continua sabendo os nomes fixos dentro dela
        // (capa.webp, capa-2.webp, capa-3.webp, capa-4.webp, capa.mp4;
        // ver fotoCapaPrestador/fotosCapaPrestador/fotoCapaVideoPrestador
        // em 00-script.js), só não precisa mais saber a FÓRMULA da pasta
        // em si (dono_usuario_id + "-p-" + pasta_posicao) — isso fica
        // só aqui, um lugar só, e nunca mais corre risco de dessincronizar
        // do que o backend realmente grava (ver routes/prestadores.js,
        // pastaPrestador()). null pros 6 prestadores demo (sem dono,
        // logo sem pasta de upload nenhuma).
        capaBase: temDono ? `/${linha.dono_usuario_id}-p-${linha.pasta_posicao}/capa` : null,
        // NOVO — booleano explícito por slot, checado no disco (ver
        // utils/midia.js). O front usa isso pra decidir SE tenta a URL,
        // em vez de montar `${capaBase}/capa-2.webp` às cegas e só
        // descobrir que não existe quando o navegador já disparou o
        // request e o servidor já respondeu 404 (isso inflava "Erros
        // hoje" no painel admin com um estado normal — "só subiu 1
        // foto" não é um erro de sistema). capaDisponivel cobre o
        // caso mais comum (slot 1, usado em toda lista/card/pin de
        // mapa); capasDisponiveis cobre o carrossel de 4 fotos no
        // perfil completo.
        capaDisponivel: capas.capa,
        capasDisponiveis: [capas.capa, capas.capa2, capas.capa3, capas.capa4],
        capaVideoDisponivel: capas.video,
        // SEMPRE booleano, nunca o número em si — o CPF/CNPJ da conta é
        // dado sensível, não tem motivo pra sair de "Preferências da
        // conta" pra um endpoint público. O selo (ver badgeDocumentoHTML
        // em 00-script.js) só precisa saber "tem ou não tem", vale pra
        // TODOS os prestadores da mesma conta (é a pessoa que declarou o
        // documento, não o cadastro individual) — por isso lido aqui, no
        // formatador compartilhado, e não como uma coluna própria em
        // `prestadores`.
        documentoCadastrado: temDono && !!linha.dono_cpf_cnpj,
        nota: {
            quantidade: linha.avaliacoes_quantidade || 0,
            media: linha.avaliacoes_quantidade > 0 ? linha.avaliacoes_media : null
        }
    };
}

module.exports = { formatarPrestador, SELECT_PRESTADORES_COM_NOTA };
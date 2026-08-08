const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { sanitizarTexto } = require("../utils/sanitizar");
const { exigirUsuario } = require("../middleware/identidade");
const { criarNotificacao } = require("../utils/criarNotificacao");

const router = express.Router();

// ==========================================================================
// MIGRAÇÃO LEVE: foto_url/foto_url2/foto_url3 — as até-3 fotos opcionais de
// uma avaliação. Faltavam no schema.sql (bug antigo: o código sempre usou
// essas colunas, mas a criação da tabela nunca as declarou — só passava
// batido em bancos onde alguém já tinha rodado um ALTER manual antes).
// Self-healing (tenta o ALTER, ignora erro de coluna duplicada), mesmo
// padrão de capa_tipo em prestadores.js e avatar_customizado em
// usuarios.js — corrige sozinho um banco já existente sem precisar de
// migration separada nem apagar nada.
// ==========================================================================
["foto_url", "foto_url2", "foto_url3"].forEach((coluna) => {
    try {
        db.exec(`ALTER TABLE avaliacoes ADD COLUMN ${coluna} TEXT`);
    } catch (erro) {
        if (!String(erro.message).includes("duplicate column")) throw erro;
    }
});

// ==========================================================================
// UPLOAD DE FOTO NA AVALIAÇÃO ("Fotos dos clientes" no perfil)
// Fecha a implementação que estava marcada como parcial no front
// (fotosClientesExemplo). Segue a MESMA regra da fila cega: a foto só
// aparece pra qualquer pessoa quando a avaliação for aceita pelo dono
// (status = 'publicada') — antes disso ela existe em disco, mas nenhuma
// rota pública devolve o caminho dela. Convertida sempre pra .webp
// (mesmo padrão dos outros diretórios de foto do app) via sharp, com
// redimensionamento pra não deixar o disco/servidor reféns de uma foto
// de 12MB direto do celular do cliente.
//
// Requer duas dependências novas: `npm install multer sharp`.
// ==========================================================================
// As fotos de avaliação ficam na pasta de quem ENVIOU a avaliação
// (public/<autor_usuario_id>/reviews/), não na do prestador avaliado —
// de propósito, pra fins de compliance: se um usuário pedir remoção dos
// próprios dados, apagar a conta dele já apaga TODAS as fotos que ele
// mandou (avatar + reviews), numa raiz de pasta só, sem precisar
// vasculhar a pasta de cada prestador que ele já avaliou. O "hash" da
// pasta é o id da CONTA do autor (uuid) — sempre existe, porque enviar
// avaliação exige login (exigirUsuario, ver rota abaixo).
function pastaReviewsAutor(autorUsuarioId) {
    return path.join(__dirname, "../public", autorUsuarioId, "reviews");
}

const TAMANHO_MAXIMO_BYTES = 6 * 1024 * 1024; // 6MB — folga pra foto de celular sem exagero

const upload = multer({
    storage: multer.memoryStorage(), // não grava o arquivo cru; passa pelo sharp antes
    limits: { fileSize: TAMANHO_MAXIMO_BYTES },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith("image/")) {
            return cb(new Error("TIPO_INVALIDO"));
        }
        cb(null, true);
    }
});

// Envolve upload.array("fotos", 3) pra transformar os erros do multer
// (arquivo grande demais, tipo inválido, mais de 3 arquivos) em JSON 400
// igual ao resto da API, em vez de deixar cair no handler de erro
// genérico do Express (que devolveria HTML/500). A rota em si só roda se
// isso chamar next() sem erro.
function receberFotosOpcionais(req, res, next) {
    upload.array("fotos", 3)(req, res, (erro) => {
        if (!erro) return next();

        if (erro instanceof multer.MulterError && erro.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ erro: `Foto muito grande (máximo ${TAMANHO_MAXIMO_BYTES / 1024 / 1024}MB).` });
        }
        if (erro instanceof multer.MulterError && erro.code === "LIMIT_UNEXPECTED_FILE") {
            return res.status(400).json({ erro: "No máximo 3 fotos por avaliação." });
        }
        if (erro.message === "TIPO_INVALIDO") {
            return res.status(400).json({ erro: "O arquivo enviado precisa ser uma imagem." });
        }
        return res.status(400).json({ erro: "Não foi possível receber as fotos enviadas." });
    });
}

// Formato fixo 9:19.5 (retrato "tela cheia", a mesma proporção de tela
// de celular moderno) pra foto MESTRE gravada em disco — é essa versão
// cheia que abre no PhotoLightbox em tela cheia (ver abrirLightbox em
// script.js). O card da grade (.ProviderProfileGalleryItem em style.css)
// usa um aspect-ratio diferente, 9:16 — mais "quadrado" pra caber 3 por
// linha — então corta um pedaço a mais dessa foto mestre só visualmente
// via CSS (object-fit: cover no <img> dentro do card); o arquivo salvo
// aqui continua sendo sempre o 9:19.5 inteiro, a foto não é recortada
// duas vezes em disco. Resolução trava em 1080p (maior lado, aqui a
// largura, no máximo 1080px) — mesma meta de "1080p" usada na
// compressão do lado do navegador antes do upload (ver
// comprimirImagemParaUpload em script.js), só que aqui é a garantia
// final, do lado do servidor, que não depende do navegador de quem
// mandou a foto ter aplicado a compressão certo.
// fit:"cover" corta o que sobra (em vez de só limitar o tamanho como
// antes, que mantinha a proporção original de cada foto — cada uma vinha
// com um formato diferente, dependendo do celular/orientação de quem
// tirou). position:"attention" pede ao sharp pra tentar centralizar o
// corte na parte mais "interessante" da imagem (maior saliência/
// contraste) em vez de cortar sempre no centro geométrico — importante
// aqui porque 9:19.5 é um recorte bem vertical, sobra pouca margem de erro.
const LARGURA_FOTO_AVALIACAO = 1080; // 1080p: maior lado da foto trava em 1080px
const ALTURA_FOTO_AVALIACAO = Math.round(LARGURA_FOTO_AVALIACAO * 19.5 / 9); // 2340

// nomeArquivo usa o id da PRÓPRIA avaliação + o índice do slot (1 a 3),
// não mais um uuid solto — assim as até-3 fotos de uma mesma avaliação
// ficam visualmente juntas dentro da pasta (avaliacao-x-1.webp, -2, -3) e
// dá pra saber de qual avaliação é um arquivo só olhando o nome.
async function salvarFotoAvaliacao(file, autorUsuarioId, avaliacaoId, indice) {
    if (!file) return null;

    const pasta = pastaReviewsAutor(autorUsuarioId);
    fs.mkdirSync(pasta, { recursive: true });

    const nomeArquivo = `${avaliacaoId}-${indice}.webp`;
    const caminhoAbsoluto = path.join(pasta, nomeArquivo);

    await sharp(file.buffer)
        .rotate() // aplica a orientação do EXIF e descarta o campo, evita foto "deitada"
        .resize(LARGURA_FOTO_AVALIACAO, ALTURA_FOTO_AVALIACAO, { fit: "cover", position: "attention" })
        .webp({ quality: 82 })
        .toFile(caminhoAbsoluto);

    return `/${autorUsuarioId}/reviews/${nomeArquivo}`;
}

// Processa até 3 arquivos em paralelo (Promise.all — são independentes
// entre si, não tem motivo pra serializar) e sempre devolve um array de
// EXATAMENTE 3 posições ([url1, url2, url3], cada uma null se aquele slot
// não veio preenchido) — os 3 valores mapeiam direto pras colunas
// foto_url/foto_url2/foto_url3 na hora do INSERT, sem precisar de lógica
// condicional a mais lá.
async function salvarFotosAvaliacao(files = [], autorUsuarioId, avaliacaoId) {
    const urls = await Promise.all(
        files.slice(0, 3).map((file, i) => salvarFotoAvaliacao(file, autorUsuarioId, avaliacaoId, i + 1))
    );
    while (urls.length < 3) urls.push(null);
    return urls;
}

// Mesma janela do front (JANELA_TAG_WHATSAPP_MS) — clique muito antigo não
// deveria "endossar" uma avaliação completamente distante no tempo dele.
const JANELA_TAG_WHATSAPP_MS = 60 * 24 * 60 * 60 * 1000;

// POST /api/prestadores/:id/whatsapp-clique
// Substitui registrarCliqueWhatsapp(). Igual ao front hoje, funciona sem
// login (o botão de WhatsApp no perfil não exige estar logado) — sem
// usuário identificado, só não grava nada (não prova contratação mesmo,
// é só uma pista pro prestador lembrar quem é quem na fila cega).
router.post("/prestadores/:id/whatsapp-clique", (req, res) => {
    if (req.usuario) {
        db.prepare(`
            INSERT INTO cliques_whatsapp (prestador_id, usuario_id, criado_em)
            VALUES (?, ?, ?)
            ON CONFLICT(prestador_id, usuario_id) DO UPDATE SET criado_em = excluded.criado_em
        `).run(req.params.id, req.usuario.id, Date.now());
    }
    res.status(204).end();
});

// POST /api/prestadores/:id/avaliacoes — cliente avalia.
// Exige login (mesma regra do front: sem usuarioLogado, nem abre o
// formulário) pra ter uma identidade de verdade por trás, tanto pra fila
// cega quanto pra tag de WhatsApp.
// receberFotoOpcional vem antes de exigirUsuario de propósito: assim, se
// vier um arquivo grande demais ou de tipo errado, o multer já barra com
// 400 antes de gastar uma checagem de auth — mas exigirUsuario continua
// rodando normalmente pros outros casos (não afeta quem já estava
// mandando avaliação sem foto, já que ela é opcional).
router.post("/prestadores/:id/avaliacoes", receberFotosOpcionais, exigirUsuario, async (req, res) => {
    const prestador = db.prepare("SELECT id, dono_usuario_id, categoria FROM prestadores WHERE id = ?").get(req.params.id);
    if (!prestador) return res.status(404).json({ erro: "Prestador não encontrado." });

    const autorNome = sanitizarTexto(req.body.autorNome, 80) || req.usuario.nome;
    const comentario = sanitizarTexto(req.body.comentario, 500);
    const nota = Number(req.body.nota);

    if (!comentario || !Number.isInteger(nota) || nota < 1 || nota > 5) {
        return res.status(400).json({ erro: "comentario é obrigatório e nota precisa ser um inteiro de 1 a 5." });
    }

    // Gerado ANTES de salvar as fotos de propósito: o nome dos arquivos
    // (avaliacaoId-1.webp etc, ver salvarFotoAvaliacao) precisa desse id.
    const avaliacaoId = uuidv4();

    let fotoUrl, fotoUrl2, fotoUrl3;
    try {
        [fotoUrl, fotoUrl2, fotoUrl3] = await salvarFotosAvaliacao(req.files, req.usuario.id, avaliacaoId);
    } catch (erro) {
        console.error("Falha ao processar fotos da avaliação:", erro);
        return res.status(400).json({ erro: "Não foi possível processar as fotos enviadas. Tente outras imagens." });
    }

    const clique = db.prepare("SELECT criado_em FROM cliques_whatsapp WHERE prestador_id = ? AND usuario_id = ?")
        .get(req.params.id, req.usuario.id);
    const viaWhatsapp = !!clique && (Date.now() - clique.criado_em) < JANELA_TAG_WHATSAPP_MS;

    const avaliacao = {
        id: avaliacaoId,
        prestador_id: req.params.id,
        autor_nome: autorNome,
        autor_usuario_id: req.usuario.id,
        nota,
        comentario,
        foto_url: fotoUrl,
        foto_url2: fotoUrl2,
        foto_url3: fotoUrl3,
        status: "pendente",
        via_whatsapp: viaWhatsapp ? 1 : 0,
        criado_em: Date.now()
    };

    db.prepare(`
        INSERT INTO avaliacoes (id, prestador_id, autor_nome, autor_usuario_id, nota, comentario, foto_url, foto_url2, foto_url3, status, via_whatsapp, criado_em)
        VALUES (@id, @prestador_id, @autor_nome, @autor_usuario_id, @nota, @comentario, @foto_url, @foto_url2, @foto_url3, @status, @via_whatsapp, @criado_em)
    `).run(avaliacao);

    // Só notifica se o prestador tem um dono real por trás (os 6 demos têm
    // dono_usuario_id NULL — ver formatarPrestador.js/schema.sql — e
    // criarNotificacao já ignora usuarioId vazio, mas o if aqui evita nem
    // tentar).
    // link aponta pra ESSA avaliação (não mais pro prestador): desde que os
    // cards de Aceitar/Rejeitar passaram a viver dentro do próprio painel
    // de notificações (ver 07-notificacoes.js), o front usa esse id pra
    // marcar a notificação como lida sozinha assim que a avaliação é
    // decidida por lá — sem precisar de outro clique.
    if (prestador.dono_usuario_id) {
        criarNotificacao({
            usuarioId: prestador.dono_usuario_id,
            tipo: "avaliacao_pendente",
            titulo: "Nova avaliação para revisar",
            corpo: `${autorNome} avaliou seu prestador de ${prestador.categoria}. Toque para decidir se ela aparece pro público.`,
            link: `avaliacao-pendente:${avaliacao.id}`
        });
    }

    res.status(201).json({ id: avaliacao.id, status: "pendente", fotoUrls: [fotoUrl, fotoUrl2, fotoUrl3].filter(Boolean) });
});

// GET /api/prestadores/:id/avaliacoes/pendentes — fila cega, só o dono vê.
// Igual renderizarAvaliacoesPendentes(): nunca devolve nota/comentário
// aqui, só o que ajuda a decidir (nome, data, tag de WhatsApp).
router.get("/prestadores/:id/avaliacoes/pendentes", exigirUsuario, (req, res) => {
    const prestador = db.prepare("SELECT dono_usuario_id FROM prestadores WHERE id = ?").get(req.params.id);
    if (!prestador) return res.status(404).json({ erro: "Prestador não encontrado." });
    if (prestador.dono_usuario_id !== req.usuario.id) {
        return res.status(403).json({ erro: "Só o dono do prestador vê a fila de avaliações pendentes." });
    }

    // JOIN com usuarios pra pegar id/avatarUrl/avatarCustomizado de quem
    // avaliou (mesma foto de conta usada no resto do app, ver
    // avatarUrlEfetivo no front) — não muda o que a fila cega já mostra
    // (nota/comentário continuam de fora, só ganhou uma foto ao lado do
    // nome). autorUsuarioId vai junto pro front conseguir tanto aplicar
    // avatarUrlEfetivo (considerar foto própria, não só a do Google)
    // quanto sortear o MESMO placeholder ilustrado que aparece em "Meu
    // perfil"/"Preferências da conta" dessa pessoa quando não há foto
    // nenhuma — sem o id, cada tela sorteava um desenho diferente pra a
    // mesma conta. LEFT JOIN porque autor_usuario_id sempre existe (login
    // obrigatório pra avaliar), mas o usuário pode não ter avatar_url
    // preenchido.
    const pendentes = db.prepare(`
        SELECT a.id, a.autor_nome AS autorNome, a.autor_usuario_id AS autorUsuarioId,
               u.avatar_url AS autorAvatarUrl, u.avatar_customizado AS autorAvatarCustomizado,
               a.via_whatsapp AS viaWhatsapp, a.criado_em AS criadoEm
        FROM avaliacoes a
        LEFT JOIN usuarios u ON u.id = a.autor_usuario_id
        WHERE a.prestador_id = ? AND a.status = 'pendente'
        ORDER BY a.criado_em ASC
    `).all(req.params.id);

    res.json(pendentes.map(p => ({ ...p, viaWhatsapp: !!p.viaWhatsapp, autorAvatarCustomizado: p.autorAvatarCustomizado || 0 })));
});

// POST /api/avaliacoes/:id/aceitar — dono publica.
router.post("/avaliacoes/:id/aceitar", exigirUsuario, (req, res) => {
    const avaliacao = decidirComoDeOwner(req, res, "publicada");
    if (!avaliacao) return;

    criarNotificacao({
        usuarioId: avaliacao.autor_usuario_id,
        tipo: "avaliacao_publicada",
        titulo: "Sua avaliação foi publicada",
        corpo: "O prestador aceitou sua avaliação — ela já aparece no perfil dele.",
        link: `prestador:${avaliacao.prestador_id}`
    });

    res.status(204).end();
});

// POST /api/avaliacoes/:id/rejeitar — dono rejeita, motivo obrigatório
// (mesmo padrão do front: rejeitar exige escolher um motivo, não some sem mais).
router.post("/avaliacoes/:id/rejeitar", exigirUsuario, (req, res) => {
    const motivo = sanitizarTexto(req.body.motivo, 120);
    if (!motivo) return res.status(400).json({ erro: "motivo é obrigatório pra rejeitar." });

    const avaliacao = decidirComoDeOwner(req, res, "rejeitada", motivo);
    if (!avaliacao) return;

    criarNotificacao({
        usuarioId: avaliacao.autor_usuario_id,
        tipo: "avaliacao_rejeitada",
        titulo: "Sua avaliação não foi publicada",
        corpo: `Motivo informado pelo prestador: ${motivo}`,
        link: `prestador:${avaliacao.prestador_id}`
    });

    res.status(204).end();
});

// Confere posse e aplica a mudança de status — usado por aceitar/rejeitar
// acima. Retorna a linha da avaliação (autor_usuario_id + prestador_id,
// pra quem chamou poder notificar o autor) se aplicou, ou null se já
// respondeu com erro (404/403/409).
function decidirComoDeOwner(req, res, novoStatus, motivo = null) {
    const avaliacao = db.prepare(`
        SELECT a.status, a.autor_usuario_id, a.prestador_id, p.dono_usuario_id
        FROM avaliacoes a
        JOIN prestadores p ON p.id = a.prestador_id
        WHERE a.id = ?
    `).get(req.params.id);

    if (!avaliacao) {
        res.status(404).json({ erro: "Avaliação não encontrada." });
        return null;
    }
    if (avaliacao.dono_usuario_id !== req.usuario.id) {
        res.status(403).json({ erro: "Só o dono do prestador decide essa avaliação." });
        return null;
    }
    if (avaliacao.status !== "pendente") {
        res.status(409).json({ erro: `Essa avaliação já foi decidida (status: ${avaliacao.status}).` });
        return null;
    }

    db.prepare("UPDATE avaliacoes SET status = ?, motivo_rejeicao = ? WHERE id = ?")
        .run(novoStatus, motivo, req.params.id);
    return avaliacao;
}

// Caminho salvo no banco é sempre relativo ("/{prestadorId}/reviews/x.webp").
// Isso é o que faz sentido guardar (não amarra o registro a um host).
// Mas devolver relativo pro front quebra em qualquer setup onde a página
// não é servida pelo mesmo host:porta do backend (ex: front aberto via
// Live Server/porta 5500, backend rodando na 3000) — o navegador resolve
// "/uploads/..." contra a origem da PÁGINA, não do backend, e a imagem
// nunca carrega. Por isso monta a URL absoluta aqui, na borda da API,
// usando o host que a própria requisição chegou (funciona local e em
// produção, atrás de proxy reverso incluso, sem precisar de env var nova).
function urlAbsolutaFoto(req, caminhoRelativo) {
    if (!caminhoRelativo) return null;
    return `${req.protocol}://${req.get("host")}${caminhoRelativo}`;
}

// GET /api/prestadores/:id/avaliacoes/ultima — a review real mais recente
// publicada (substitui avaliacaoParaExibir). null quando não há nenhuma.
router.get("/prestadores/:id/avaliacoes/ultima", (req, res) => {
    // Mesmo LEFT JOIN da fila de pendentes, pra devolver id/avatarUrl/
    // avatarCustomizado de quem avaliou junto com a review em si (ver
    // avatarUrlEfetivo + ProviderProfileReviewAvatar no front).
    const ultima = db.prepare(`
        SELECT a.autor_nome AS nome, a.autor_usuario_id AS usuarioId,
               u.avatar_url AS avatarUrl, u.avatar_customizado AS avatarCustomizado,
               a.comentario, a.nota, a.foto_url AS fotoUrl, a.foto_url2 AS fotoUrl2, a.foto_url3 AS fotoUrl3
        FROM avaliacoes a
        LEFT JOIN usuarios u ON u.id = a.autor_usuario_id
        WHERE a.prestador_id = ? AND a.status = 'publicada'
        ORDER BY a.criado_em DESC
        LIMIT 1
    `).get(req.params.id);

    if (!ultima) return res.json(null);

    // fotoUrls: as até-3 fotos dessa avaliação, já em URL absoluta e sem
    // os slots vazios. fotoUrl (singular) continua no payload — é a
    // primeira do array — só por compatibilidade com quem já lia esse
    // campo antes de existirem os outros dois slots.
    const fotoUrls = [ultima.fotoUrl, ultima.fotoUrl2, ultima.fotoUrl3]
        .filter(Boolean)
        .map(url => urlAbsolutaFoto(req, url));

    res.json({
        nome: ultima.nome,
        usuarioId: ultima.usuarioId,
        avatarUrl: ultima.avatarUrl,
        avatarCustomizado: ultima.avatarCustomizado || 0,
        comentario: ultima.comentario,
        nota: ultima.nota,
        fotoUrl: fotoUrls[0] || null,
        fotoUrls
    });
});

// GET /api/prestadores/:id/fotos-clientes — galeria de fotos reais
// (substitui fotosClientesExemplo do front). Só avaliação PUBLICADA
// entra aqui — mesma regra da fila cega, a foto não vaza antes do dono
// decidir. Nem toda avaliação tem foto (é opcional).
//
// Devolve UM item por AVALIAÇÃO (não uma linha achatada por foto) — cada
// item já traz o array `fotos` com as até-3 URLs daquela avaliação, na
// ordem dos slots. É o front (fotosClientesPrestador) que decide como
// exibir isso: capa = fotos[0], contador = fotos.length quando >1, e o
// PhotoLightbox arrasta só dentro desse array quando a pessoa abre aquela
// avaliação — nunca mistura fotos de avaliações diferentes no mesmo
// carrossel. Limita a 12 avaliações (não 12 fotos) pra não virar uma
// grade infinita no perfil; mais que isso, a galeria já cumpriu o papel
// de dar confiança.
router.get("/prestadores/:id/fotos-clientes", (req, res) => {
    const linhas = db.prepare(`
        SELECT foto_url, foto_url2, foto_url3, autor_nome AS autor, comentario, nota, criado_em AS criadoEm
        FROM avaliacoes
        WHERE prestador_id = ? AND status = 'publicada' AND (foto_url IS NOT NULL OR foto_url2 IS NOT NULL OR foto_url3 IS NOT NULL)
        ORDER BY criado_em DESC
        LIMIT 12
    `).all(req.params.id);

    const grupos = linhas.map(l => ({
        autor: l.autor,
        comentario: l.comentario,
        nota: l.nota,
        fotos: [l.foto_url, l.foto_url2, l.foto_url3]
            .filter(Boolean)
            .map(url => urlAbsolutaFoto(req, url))
    }));

    res.json(grupos);
});

module.exports = router;
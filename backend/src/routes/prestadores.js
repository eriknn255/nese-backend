const express = require("express");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const os = require("os");
const ffmpeg = require("fluent-ffmpeg");
// ffmpeg-static baixa o binário certo pra cada plataforma na hora do `npm
// install` (Windows aqui no dev, Linux na EC2) — evita depender de alguém
// instalar o ffmpeg manualmente e ele não estar no PATH (foi exatamente o
// erro "Cannot find ffmpeg" que apareceu rodando local no Windows).
ffmpeg.setFfmpegPath(require("ffmpeg-static"));
const db = require("../db");
const { sanitizarTexto } = require("../utils/sanitizar");
const { exigirUsuario } = require("../middleware/identidade");
const { formatarPrestador, SELECT_PRESTADORES_COM_NOTA } = require("../utils/formatarPrestador");
const { validarTelefone } = require("../utils/telefone");

const router = express.Router();

// ==========================================================================
// BUSCA — movida do front pro backend (era feita filtrando o array
// PRESTADORES inteiro, carregado por completo no navegador de todo mundo
// que abria o app; ver GET / mais abaixo). As três funções aqui são
// PORTADAS QUASE VERBATIM de normalizar()/calcularDistanciaKm()/
// estaAberto() que existiam em 00-script.js — mesma lógica, só mudou de
// lugar, pra garantir que o resultado da busca continue idêntico ao de
// antes (mesmo texto normalizado, mesma fórmula de distância, mesma regra
// de horário com virada de dia).
// ==========================================================================
function normalizar(texto) {
    return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function calcularDistanciaKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// "Aberto agora" (filtroAbertoAgora no front) precisa do horário de
// TERESINA/PI, não do relógio do servidor — antes, rodando no navegador,
// isso vinha de graça (o celular do usuário já está no fuso dele). Aqui
// precisa ser explícito: se o processo Node rodar num host configurado em
// UTC (comum em nuvem), new Date().getHours() cru daria a hora errada.
// América/Fortaleza cobre Piauí, UTC-3 o ano inteiro (Brasil não tem mais
// horário de verão desde 2019).
const FUSO_HORARIO_APP = "America/Fortaleza";

function agoraNoFuso() {
    const partes = new Intl.DateTimeFormat("en-US", {
        timeZone: FUSO_HORARIO_APP,
        weekday: "short", hour: "numeric", minute: "numeric", hour12: false
    }).formatToParts(new Date());
    const mapa = Object.fromEntries(partes.map(p => [p.type, p.value]));
    const diasSemana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // hour12:false ocasionalmente devolve "24" à meia-noite em vez de "0"
    // (comportamento conhecido do Intl em alguns runtimes) — normaliza.
    const hora = Number(mapa.hour) % 24;
    return { diaSemana: diasSemana[mapa.weekday], horaDecimal: hora + Number(mapa.minute) / 60 };
}

// Mesma assinatura/regra de estaAberto() no front: recebe o prestador já
// FORMATADO (formatarPrestador()), com prestador.horario.{abre,fecha,dias}.
function estaAberto(prestador) {
    if (!prestador.horario) return true;
    const { diaSemana, horaDecimal } = agoraNoFuso();
    const dias = prestador.horario.dias;
    if (Array.isArray(dias) && dias.length > 0 && !dias.includes(diaSemana)) return false;
    const { abre, fecha } = prestador.horario;
    // suporta virada de dia (ex: abre 22, fecha 6 → aberto durante a madrugada)
    if (abre <= fecha) return horaDecimal >= abre && horaDecimal < fecha;
    return horaDecimal >= abre || horaDecimal < fecha;
}

// ==========================================================================
// LIMITE DE CADASTROS + VALIDAÇÃO DE TELEFONE
// Sem isso, uma única conta Google (livre pra criar quantas quiser) podia
// encher o mapa de cadastros — inclusive com telefone em qualquer formato,
// nem que fosse "abc". Duas camadas, cada uma barrando um abuso diferente:
//   1) LIMITE_PRESTADORES_POR_CONTA — teto por conta (spam grosseiro).
//   2) validarTelefone — recusa string que não é um telefone BR de verdade.
// Nenhuma das duas impede alguém disposto a criar 3 contas Google
// diferentes pra ter 9 cadastros — isso só uma verificação de telefone
// por SMS resolveria de verdade, e é bem mais trabalho. Isto aqui é a
// barreira barata contra o abuso casual.
//
// NÃO existe mais checagem de telefone duplicado entre prestadores da
// mesma conta — é legítimo um WhatsApp só atender por mais de um serviço
// (ex: a mesma pessoa faz "Eletricista" e "Encanador"). O front só sinaliza
// isso de forma sutil (tag em "Meus Serviços", ver renderizarMeusCadastros
// em 00-script.js), nunca bloqueia.
// ==========================================================================
const LIMITE_PRESTADORES_POR_CONTA = 3;

// ==========================================================================
// MIGRAÇÃO LEVE: capa_tipo ("foto" | "video") — distingue se a capa do
// prestador é o carrossel de até 4 fotos (padrão) ou 1 vídeo único
// (exclusivos entre si, ver seção FOTOS/VÍDEO DE CAPA mais abaixo).
// Self-healing (tenta o ALTER, ignora erro de coluna duplicada) pra não
// depender de um arquivo de migration separado.
// ==========================================================================
try {
    db.exec("ALTER TABLE prestadores ADD COLUMN capa_tipo TEXT NOT NULL DEFAULT 'foto'");
} catch (erro) {
    if (!String(erro.message).includes("duplicate column")) throw erro;
}

// ==========================================================================
// MIGRAÇÃO LEVE: pasta_posicao — a ordem (1º, 2º ou 3º, já que
// LIMITE_PRESTADORES_POR_CONTA = 3) em que este prestador foi criado
// dentro da conta dona dele. Grava a pasta de mídia dele como
// "<dono_usuario_id>-p-<pasta_posicao>" (ver pastaPrestador logo abaixo).
// Gravado UMA VEZ na criação e nunca recalculado depois — se recalculasse
// dinamicamente a cada request, excluir um prestador do meio mudaria a
// posição dos que vieram depois, e as fotos já salvas ficariam apontando
// pra pasta errada (exatamente o tipo de bug de dessincronia entre
// front/back que motivou essa reestruturação toda).
// ==========================================================================
try {
    db.exec("ALTER TABLE prestadores ADD COLUMN pasta_posicao INTEGER");
} catch (erro) {
    if (!String(erro.message).includes("duplicate column")) throw erro;
}

// Backfill: prestadores criados ANTES dessa migração existir ficaram com
// pasta_posicao NULL (nunca passaram pelo INSERT novo que preenche essa
// coluna). Preenche uma vez, por conta, na ordem de criação — idempotente
// (só afeta linhas onde ainda é NULL, então rodar de novo não faz nada
// nas que já foram preenchidas).
const donosComPendencia = db.prepare(
    "SELECT DISTINCT dono_usuario_id FROM prestadores WHERE pasta_posicao IS NULL AND dono_usuario_id IS NOT NULL"
).all();
if (donosComPendencia.length > 0) {
    const atualizarPosicao = db.prepare("UPDATE prestadores SET pasta_posicao = ? WHERE id = ?");
    donosComPendencia.forEach(({ dono_usuario_id }) => {
        const doDono = db.prepare(
            "SELECT id FROM prestadores WHERE dono_usuario_id = ? ORDER BY criado_em ASC, id ASC"
        ).all(dono_usuario_id);
        doDono.forEach((linha, indice) => atualizarPosicao.run(indice + 1, linha.id));
    });
    console.log(`[prestadores] backfill de pasta_posicao aplicado (${donosComPendencia.length} conta(s)).`);
}

// diasSemana vem do front como array de números 0-6 (0=domingo...6=sábado,
// igual Date.getDay()). Filtra qualquer lixo (string, fora de faixa,
// duplicata) e cai em "todos os dias" se sobrar vazio ou não vier nada —
// mesmo fallback que "sem horário = sempre aberto" já usava, estendido
// pra dia da semana.
function normalizarDiasSemana(diasSemana) {
    if (!Array.isArray(diasSemana)) return [0, 1, 2, 3, 4, 5, 6];
    const validos = [...new Set(diasSemana.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    return validos.length > 0 ? validos : [0, 1, 2, 3, 4, 5, 6];
}

// GET /api/prestadores
// Query params, todos OPCIONAIS (sem nenhum, devolve tudo — mantém
// compatibilidade com quem já chamava sem parâmetro):
//   q        — texto livre, casa contra nome/categoria/tags (normalizado,
//              sem acento/maiúscula — mesma regra de sempre)
//   aberto=1 — só quem está aberto agora (horário de Teresina/PI, ver
//              estaAberto() acima — não é mais o relógio do aparelho)
//   lat/lng  — origem pro cálculo de distância; sem isso, resultado não
//              tem distanciaKm nem vem ordenado por proximidade
//   raioKm   — só combinado com lat/lng; sem raioKm, sem limite (mesmo
//              "sem limite" que o botão de raio no mapa já tinha)
// Front manda a MESMA busca de sempre (buscarPrestadores() em
// 00-script.js) — só que agora o servidor decide quem bate, em vez do
// navegador filtrar um catálogo inteiro baixado por completo.
router.get("/", (req, res) => {
    const linhas = db.prepare(`${SELECT_PRESTADORES_COM_NOTA} GROUP BY p.id`).all();
    let prestadores = linhas.map(formatarPrestador);

    const { q, aberto, lat, lng, raioKm } = req.query;

    if (aberto === "1") {
        prestadores = prestadores.filter(estaAberto);
    }

    if (q !== undefined && q !== "") {
        const termo = normalizar(q);
        prestadores = prestadores.filter(p => {
            const categoriaNorm = normalizar(p.categoria);
            const nomeNorm = normalizar(p.nome);
            return categoriaNorm.includes(termo) ||
                nomeNorm.includes(termo) ||
                p.tags.some(tag => normalizar(tag).includes(termo));
        });
    }

    if (lat !== undefined && lng !== undefined) {
        const baseLat = Number(lat), baseLng = Number(lng);
        const raio = raioKm !== undefined && raioKm !== "" ? Number(raioKm) : null;

        prestadores = prestadores
            .map(p => ({ ...p, distanciaKm: calcularDistanciaKm(baseLat, baseLng, p.lat, p.lng) }))
            .filter(p => raio === null || p.distanciaKm <= raio)
            .sort((a, b) => a.distanciaKm - b.distanciaKm);
    }

    res.json(prestadores);
});

// GET /api/prestadores/meus — cadastrados por ESTE usuário (substitui
// lerPrestadoresCadastrados(), que hoje é "por aparelho" via localStorage;
// com conta real, vira "por usuário" de verdade).
router.get("/meus", exigirUsuario, (req, res) => {
    const linhas = db.prepare(`
        ${SELECT_PRESTADORES_COM_NOTA}
        WHERE p.dono_usuario_id = ?
        GROUP BY p.id
    `).all(req.usuario.id);

    res.json(linhas.map(formatarPrestador));
});

// GET /api/prestadores/categorias — categorias já cadastradas por outros
// prestadores, pro front sugerir no campo "Categoria/serviço" (autocomplete
// via <datalist> nativo do navegador). NÃO restringe: continua sendo texto
// livre no POST/PATCH — isso aqui só melhora a consistência (evitar
// "Encanador"/"encanador"/"Cano" como 3 categorias diferentes por acidente)
// sem travar ninguém numa lista fechada.
router.get("/categorias", (req, res) => {
    const linhas = db.prepare("SELECT DISTINCT categoria FROM prestadores ORDER BY categoria COLLATE NOCASE").all();
    res.json(linhas.map(l => l.categoria));
});

// GET /api/prestadores/:id
router.get("/:id", (req, res) => {
    const linha = db.prepare(`${SELECT_PRESTADORES_COM_NOTA} WHERE p.id = ? GROUP BY p.id`).get(req.params.id);
    if (!linha) return res.status(404).json({ erro: "Prestador não encontrado." });
    res.json(formatarPrestador(linha));
});

// POST /api/prestadores — cadastro de novo prestador.
// Body: { categoria, telefone, tagsTexto (string separada por vírgula,
// igual o campo do form hoje), cor, lat, lng, horarioAbre, horarioFecha }
// horarioAbre/horarioFecha já vêm em hora decimal (ver horaParaDecimal no
// front) — decisão de converter "08:30" pra 8.5 continua no cliente.
// NÃO recebe mais nome nem foto de perfil — ambos são herdados ao vivo da
// conta (ver formatarPrestador.js). A coluna `nome` na tabela continua
// existindo só por legado (schema antigo com NOT NULL) — preenchida com
// o nome da conta no momento da criação, mas nunca mais lida depois disso.
router.post("/", exigirUsuario, (req, res) => {
    const categoria = sanitizarTexto(req.body.categoria, 60);
    const descricao = sanitizarTexto(req.body.descricao, 460) || null;
    const telefone = sanitizarTexto(req.body.telefone, 30);
    const cor = sanitizarTexto(req.body.cor, 30) || "#2f6fed";
    const { lat, lng, horarioAbre, horarioFecha } = req.body;

    if (!categoria || !telefone || typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ erro: "categoria, telefone, lat e lng são obrigatórios." });
    }

    if (!validarTelefone(telefone)) {
        return res.status(400).json({ erro: "Telefone inválido. Use um número com DDD, ex: (86) 99999-9999." });
    }

    const totalDoUsuario = db.prepare("SELECT COUNT(*) AS total FROM prestadores WHERE dono_usuario_id = ?")
        .get(req.usuario.id).total;
    if (totalDoUsuario >= LIMITE_PRESTADORES_POR_CONTA) {
        return res.status(400).json({ erro: `Você atingiu o limite de ${LIMITE_PRESTADORES_POR_CONTA} cadastros por conta.` });
    }

    const tags = ["/all", normalizarTag(categoria)]
        .concat(String(req.body.tagsTexto || "").split(",").map(t => sanitizarTexto(t, 30)).filter(Boolean));

    // Busca o nome direto no banco em vez de confiar em req.usuario.nome:
    // em todo o resto do arquivo (e em usuarios.js) só req.usuario.id é
    // usado — não dá pra saber se exigirUsuario realmente anexa mais que
    // isso ao req.usuario. Essa query garante o valor certo sem depender
    // do formato exato que o middleware devolve.
    const donoUsuario = db.prepare("SELECT nome FROM usuarios WHERE id = ?").get(req.usuario.id);
    if (!donoUsuario) {
        return res.status(401).json({ erro: "Usuário não encontrado." });
    }

    const prestador = {
        id: uuidv4(),
        nome: donoUsuario.nome, // legado (ver comentário acima) — nunca mais lido depois da criação
        categoria, descricao, telefone, cor, lat, lng,
        horario_abre: typeof horarioAbre === "number" ? horarioAbre : null,
        horario_fecha: typeof horarioFecha === "number" ? horarioFecha : null,
        dias_semana: JSON.stringify(normalizarDiasSemana(req.body.diasSemana)),
        tags: JSON.stringify(tags),
        dono_usuario_id: req.usuario.id,
        pasta_posicao: totalDoUsuario + 1, // 1º, 2º ou 3º prestador desta conta — ver migração acima
        criado_em: Date.now()
    };

    db.prepare(`
        INSERT INTO prestadores (id, nome, categoria, descricao, telefone, cor, lat, lng, horario_abre, horario_fecha, dias_semana, tags, dono_usuario_id, pasta_posicao, criado_em)
        VALUES (@id, @nome, @categoria, @descricao, @telefone, @cor, @lat, @lng, @horario_abre, @horario_fecha, @dias_semana, @tags, @dono_usuario_id, @pasta_posicao, @criado_em)
    `).run(prestador);

    garantirPastaPrestador(prestador.id); // cria a pasta do prestador já no cadastro

    const linha = db.prepare(`${SELECT_PRESTADORES_COM_NOTA} WHERE p.id = ? GROUP BY p.id`).get(prestador.id);
    res.status(201).json(formatarPrestador(linha));
});

// DELETE /api/prestadores/:id — só o dono remove (equivalente a
// removerPrestadorCadastrado, mas checando posse de verdade em vez de
// "este aparelho cadastrou").
router.delete("/:id", exigirUsuario, (req, res) => {
    const linha = db.prepare("SELECT dono_usuario_id FROM prestadores WHERE id = ?").get(req.params.id);
    if (!linha) return res.status(404).json({ erro: "Prestador não encontrado." });
    if (linha.dono_usuario_id !== req.usuario.id) {
        return res.status(403).json({ erro: "Só quem cadastrou pode remover." });
    }

    db.prepare("DELETE FROM prestadores WHERE id = ?").run(req.params.id);
    res.status(204).end();
});

// PATCH /api/prestadores/:id — edição pelo dono (tela "Editar" no front,
// mesmo formulário do cadastro reaproveitado com os dados já preenchidos).
// Aceita os mesmos campos do POST; qualquer campo omitido no corpo mantém
// o valor atual. Fotos de capa continuam na rota própria (foto-capa/
// capa-video) — esta rota não mexe nelas. Usa exigirDono (definida mais
// abaixo, mas function declaration é hoisted no escopo do módulo) em vez
// de repetir a checagem de posse inline feita no DELETE acima.
router.patch("/:id", exigirUsuario, exigirDono, (req, res) => {
    const atual = db.prepare("SELECT * FROM prestadores WHERE id = ?").get(req.params.id);
    if (!atual) return res.status(404).json({ erro: "Prestador não encontrado." });

    // nome não é mais editável aqui — sempre herdado da conta (ver
    // formatarPrestador.js). Se vier no corpo (front antigo em cache,
    // por exemplo), é simplesmente ignorado.
    const categoria = req.body.categoria !== undefined ? sanitizarTexto(req.body.categoria, 60) : atual.categoria;
    const descricao = req.body.descricao !== undefined ? (sanitizarTexto(req.body.descricao, 460) || null) : atual.descricao;
    const telefone = req.body.telefone !== undefined ? sanitizarTexto(req.body.telefone, 30) : atual.telefone;
    const lat = typeof req.body.lat === "number" ? req.body.lat : atual.lat;
    const lng = typeof req.body.lng === "number" ? req.body.lng : atual.lng;
    const horarioAbre = typeof req.body.horarioAbre === "number" ? req.body.horarioAbre : atual.horario_abre;
    const horarioFecha = typeof req.body.horarioFecha === "number" ? req.body.horarioFecha : atual.horario_fecha;
    const diasSemana = req.body.diasSemana !== undefined
        ? normalizarDiasSemana(req.body.diasSemana)
        : (atual.dias_semana ? JSON.parse(atual.dias_semana) : [0, 1, 2, 3, 4, 5, 6]);

    if (!categoria || !telefone || typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ erro: "categoria, telefone, lat e lng são obrigatórios." });
    }
    if (!validarTelefone(telefone)) {
        return res.status(400).json({ erro: "Telefone inválido. Use um número com DDD, ex: (86) 99999-9999." });
    }

    // tagsTexto: se não veio no corpo, preserva as tags extras que já
    // existiam (tudo que não é "/all" nem a tag da categoria antiga); se
    // veio (mesmo vazia), recalcula do zero a partir do texto novo — igual
    // o POST faz na criação.
    let tags;
    if (req.body.tagsTexto !== undefined) {
        tags = ["/all", normalizarTag(categoria)]
            .concat(String(req.body.tagsTexto || "").split(",").map(t => sanitizarTexto(t, 30)).filter(Boolean));
    } else {
        const tagsAtuais = JSON.parse(atual.tags || "[]");
        const categoriaAntigaNormalizada = normalizarTag(atual.categoria);
        const extras = tagsAtuais.filter(t => t !== "/all" && t !== categoriaAntigaNormalizada);
        tags = ["/all", normalizarTag(categoria), ...extras];
    }

    db.prepare(`
        UPDATE prestadores
        SET categoria = @categoria, descricao = @descricao, telefone = @telefone, lat = @lat, lng = @lng,
            horario_abre = @horario_abre, horario_fecha = @horario_fecha, dias_semana = @dias_semana, tags = @tags
        WHERE id = @id
    `).run({
        id: req.params.id, categoria, descricao, telefone, lat, lng,
        horario_abre: horarioAbre, horario_fecha: horarioFecha,
        dias_semana: JSON.stringify(diasSemana),
        tags: JSON.stringify(tags)
    });

    const linha = db.prepare(`${SELECT_PRESTADORES_COM_NOTA} WHERE p.id = ? GROUP BY p.id`).get(req.params.id);
    res.json(formatarPrestador(linha));
});

// mesma lógica de normalizar() no front (remove acento/caixa pra virar tag)
function normalizarTag(texto) {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

// ==========================================================================
// FOTOS/VÍDEO DE CAPA DO PRESTADOR (perfil + até 4 de capa, OU 1 vídeo)
// Diferente da foto de avaliação (avaliacoes.js, nome uuid), essas usam
// nome DETERMINÍSTICO a partir do id do prestador — o front monta a URL
// só com o id (fotoPerfilPrestador/fotosCapaPrestador/fotoCapaVideoPrestador
// em script.js), sem precisar de coluna nova no banco pra montar a URL
// (capa_tipo só diz QUAL das duas usar). Subir de novo simplesmente
// substitui o arquivo anterior (mesmo nome).
// Requer duas dependências novas: `npm install multer sharp` (mesmas já
// usadas em avaliacoes.js — se já rodou aquela migração, já estão instaladas).
// O vídeo de capa também precisa de `npm install fluent-ffmpeg ffmpeg-static`
// (é o ffmpeg-static que traz o binário do ffmpeg em si, baixado certo pra
// cada plataforma no npm install — não precisa instalar nada manualmente
// no sistema, nem no Windows do dev nem na EC2). Ver comprimirVideoCapa.
//
// Capa em foto e capa em vídeo são MUTUAMENTE EXCLUSIVAS: subir um vídeo
// remove as 4 fotos existentes (removerFotosCapaAntigas) e marca
// capa_tipo='video'; subir uma foto no slot 1 remove o vídeo existente
// (removerVideoCapaAntigo) e volta capa_tipo='foto'. O front já impede o
// usuário de tentar as duas coisas ao mesmo tempo (slots 2-4 desativados
// em modo vídeo), isso aqui é a garantia do lado do servidor.
// ==========================================================================
// ==========================================================================
// PASTA POR PRESTADOR: a mídia de capa fica em
// public/<dono_usuario_id>-p-<pasta_posicao>/capa/ — dona é sempre a
// CONTA (compliance: apagar a conta de alguém = apagar uma raiz de pasta
// só, sem precisar caçar arquivo espalhado por id de prestador). O sufixo
// "-p-N" existe só porque uma conta pode ter até
// LIMITE_PRESTADORES_POR_CONTA (3) prestadores — sem ele, o 2º e 3º
// prestador da mesma conta brigariam pela mesma pasta de capa.
// pasta_posicao é gravado uma única vez na criação (ver migração leve
// acima) e nunca recalculado — ver comentário na migração pro motivo.
// ==========================================================================
const BASE_UPLOADS_PRESTADORES = path.join(__dirname, "../public");

function pastaPrestador(id) {
    const linha = db.prepare("SELECT dono_usuario_id, pasta_posicao FROM prestadores WHERE id = ?").get(id);
    if (!linha) throw new Error(`Prestador ${id} não encontrado ao montar a pasta de mídia.`);
    return path.join(BASE_UPLOADS_PRESTADORES, `${linha.dono_usuario_id}-p-${linha.pasta_posicao}`, "capa");
}

// Idempotente (mkdirSync recursive não erra se já existir) — chamada tanto
// na criação do prestador (pasta já nasce pronta) quanto nas rotas de
// upload, por segurança.
function garantirPastaPrestador(id) {
    fs.mkdirSync(pastaPrestador(id), { recursive: true });
}

const TAMANHO_MAXIMO_FOTO_PRESTADOR = 6 * 1024 * 1024; // 6MB, mesma folga da foto de avaliação

// Sufixos dos 4 slots de foto de capa (slot 1 não leva sufixo — mesmo
// padrão de fotosCapaPrestador() no front). fs.rm({force:true}) não erra
// se o arquivo não existir, então dá pra chamar "às cegas" sem checar
// existência antes (equivalente a um DELETE idempotente).
const SUFIXOS_FOTOS_CAPA = ["", "-2", "-3", "-4"];

function removerFotosCapaAntigas(id) {
    SUFIXOS_FOTOS_CAPA.forEach((sufixo) => {
        fs.rm(path.join(pastaPrestador(id), `capa${sufixo}.webp`), { force: true }, () => { });
    });
}

function removerVideoCapaAntigo(id) {
    fs.rm(path.join(pastaPrestador(id), "capa.mp4"), { force: true }, () => { });
}

const uploadFotoPrestador = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TAMANHO_MAXIMO_FOTO_PRESTADOR },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith("image/")) return cb(new Error("TIPO_INVALIDO"));
        cb(null, true);
    }
});

// Mesmo padrão de receberFotoOpcional em avaliacoes.js: roda ANTES de
// exigirUsuario de propósito, pra barrar arquivo grande/tipo errado com
// 400 sem gastar uma checagem de auth à toa.
function receberFotoPrestador(req, res, next) {
    uploadFotoPrestador.single("foto")(req, res, (erro) => {
        if (!erro) return next();

        if (erro instanceof multer.MulterError && erro.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ erro: `Foto muito grande (máximo ${TAMANHO_MAXIMO_FOTO_PRESTADOR / 1024 / 1024}MB).` });
        }
        if (erro.message === "TIPO_INVALIDO") {
            return res.status(400).json({ erro: "O arquivo enviado precisa ser uma imagem." });
        }
        return res.status(400).json({ erro: "Não foi possível receber a foto enviada." });
    });
}

// Confere que quem está mandando é o dono do prestador — as duas rotas de
// foto abaixo precisam disso além de exigirUsuario (que só confirma QUEM
// está logado, não que essa pessoa é dona DESTE prestador específico).
function exigirDono(req, res, next) {
    const linha = db.prepare("SELECT dono_usuario_id FROM prestadores WHERE id = ?").get(req.params.id);
    if (!linha) return res.status(404).json({ erro: "Prestador não encontrado." });
    if (linha.dono_usuario_id !== req.usuario.id) {
        return res.status(403).json({ erro: "Só quem cadastrou pode alterar as fotos." });
    }
    next();
}

// A rota POST /:id/foto-perfil foi removida — avatar do prestador agora é
// sempre herdado da conta (usuarios.avatar_url, ver formatarPrestador.js),
// não existe mais upload próprio. Fotos já enviadas antes dessa mudança
// ficam órfãs em UPLOADS_DIR_PERFIL (não apagadas automaticamente — baixo
// risco, é só espaço em disco de imagens pequenas, sem custo de exibir).

// POST /api/prestadores/:id/foto-capa/:indice — carrossel de até 4 fotos
// (índice 1 a 4; ver fotosCapaPrestador em script.js). Sem crop forçado
// (fit:"inside") porque a capa já é exibida com object-fit:cover no
// front, que resolve o enquadramento na hora de mostrar — aqui só limita
// o tamanho do arquivo guardado.
router.post("/:id/foto-capa/:indice", receberFotoPrestador, exigirUsuario, exigirDono, async (req, res) => {
    const indice = Number(req.params.indice);
    if (!Number.isInteger(indice) || indice < 1 || indice > 4) {
        return res.status(400).json({ erro: "índice precisa ser um número de 1 a 4." });
    }
    if (!req.file) return res.status(400).json({ erro: "Envie uma imagem no campo 'foto'." });

    try {
        garantirPastaPrestador(req.params.id);
        const sufixo = indice === 1 ? "" : `-${indice}`;
        const destino = path.join(pastaPrestador(req.params.id), `capa${sufixo}.webp`);
        await sharp(req.file.buffer)
            .rotate()
            .resize(1200, 900, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 })
            .toFile(destino);

        // Exclusividade: subir uma foto de capa (em qualquer slot) volta o
        // prestador pro modo "fotos" — some com um vídeo que estivesse lá.
        removerVideoCapaAntigo(req.params.id);
        db.prepare("UPDATE prestadores SET capa_tipo = 'foto' WHERE id = ?").run(req.params.id);

        res.status(204).end();
    } catch (erro) {
        console.error("Falha ao processar foto de capa do prestador:", erro);
        res.status(400).json({ erro: "Não foi possível processar a foto enviada. Tente outra imagem." });
    }
});

// Vídeo sempre toca mudo (autoplay+muted+loop, ver script.js) — largura
// máxima e qualidade pensadas pro tamanho real de exibição (popup do mapa
// e capa do perfil, nunca tela cheia), não pra qualidade de arquivo original.
const LARGURA_MAXIMA_VIDEO_CAPA = 1080; // px — só reduz se for mais largo, nunca aumenta

// Recebe o buffer bruto do upload e grava a versão comprimida direto no
// destino final. ffmpeg trabalha melhor com um arquivo real de entrada do
// que com o buffer em memória (o container mp4 geralmente precisa buscar
// pra frente/trás no arquivo), por isso grava num temporário primeiro e
// apaga depois, dê certo ou não.
function comprimirVideoCapa(bufferOriginal, destinoFinal) {
    return new Promise((resolve, reject) => {
        const tempEntrada = path.join(os.tmpdir(), `capa-video-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

        fs.writeFile(tempEntrada, bufferOriginal, (erro) => {
            if (erro) return reject(erro);

            const limpar = () => fs.rm(tempEntrada, { force: true }, () => { });

            ffmpeg(tempEntrada)
                .videoCodec("libx264")
                //.noAudio() // sempre toca mudo — descartar o áudio economiza espaço sem perder nada da experiência
                .outputOptions([
                    "-crf 20",
                    // "slow" pedia mais RAM do que os 908MB dessa instância
                    // aguentam (confirmado: OOM killer matando o processo
                    // Node inteiro no meio da compressão — dmesg/journalctl,
                    // 03/08). "veryfast" reduz bastante o pico de memória e
                    // CPU, ao custo de um arquivo final um pouco maior —
                    // aceitável pro tamanho de exibição real (popup do mapa
                    // / capa do perfil, nunca tela cheia). Se migrar pra uma
                    // instância com mais RAM no futuro, dá pra subir de novo.
                    "-preset veryfast",
                    "-profile:v high",
                    "-maxrate 1500k",
                    "-bufsize 7000k",
                    "-r 30",
                    "-movflags +faststart",
                    `-vf scale='min(${LARGURA_MAXIMA_VIDEO_CAPA},iw)':-2`
                ])
                .on("error", (erroFfmpeg) => { limpar(); reject(erroFfmpeg); })
                .on("end", () => { limpar(); resolve(); })
                .save(destinoFinal);
        });
    });
}



const TAMANHO_MAXIMO_VIDEO_CAPA = 70 * 1024 * 1024; // 70MB — combinado com Erik

const uploadVideoCapaPrestador = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TAMANHO_MAXIMO_VIDEO_CAPA },
    fileFilter: (req, file, cb) => {
        // Só .mp4 (h264) — outros formatos (webm, mov) variam de suporte
        // dentro do WebView Android por aparelho/versão, e não vale o
        // risco de "vídeo preto" pro usuário final. Duração (60s) não dá
        // pra validar aqui sem ffmpeg/ffprobe no servidor — por ora fica
        // só client-side (ver validarVideoCapa em script.js); reavaliar
        // se algum vídeo mais longo passar batido.
        if (file.mimetype !== "video/mp4") return cb(new Error("TIPO_INVALIDO"));
        cb(null, true);
    }
});

function receberVideoCapaPrestador(req, res, next) {
    uploadVideoCapaPrestador.single("video")(req, res, (erro) => {
        if (!erro) return next();

        if (erro instanceof multer.MulterError && erro.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ erro: `Vídeo muito grande (máximo ${TAMANHO_MAXIMO_VIDEO_CAPA / 1024 / 1024}MB).` });
        }
        if (erro.message === "TIPO_INVALIDO") {
            return res.status(400).json({ erro: "O vídeo de capa precisa ser .mp4." });
        }
        return res.status(400).json({ erro: "Não foi possível receber o vídeo enviado." });
    });
}

// POST /api/prestadores/:id/capa-video — capa em vídeo, sempre 1 único
// (sem "índice" como as fotos — é o slot principal). Comprime e
// redimensiona via ffmpeg (ver comprimirVideoCapa) antes de gravar —
// o arquivo original do usuário pode vir bem mais pesado do que precisa
// pro tamanho real de exibição (popup do mapa / capa do perfil).
router.post("/:id/capa-video", receberVideoCapaPrestador, exigirUsuario, exigirDono, async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: "Envie um vídeo no campo 'video'." });

    try {
        garantirPastaPrestador(req.params.id);
        const destino = path.join(pastaPrestador(req.params.id), "capa.mp4");
        await comprimirVideoCapa(req.file.buffer, destino);

        // Exclusividade: vídeo de capa some com as 4 fotos existentes.
        removerFotosCapaAntigas(req.params.id);
        db.prepare("UPDATE prestadores SET capa_tipo = 'video' WHERE id = ?").run(req.params.id);

        res.status(204).end();
    } catch (erro) {
        console.error("Falha ao processar vídeo de capa do prestador:", erro);
        res.status(400).json({ erro: "Não foi possível processar o vídeo enviado. Tente outro arquivo." });
    }
});

module.exports = router;

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { sanitizarTexto } = require("../utils/sanitizar");
const { exigirUsuario } = require("../middleware/identidade");
const { formatarPrestador, SELECT_PRESTADORES_COM_NOTA } = require("../utils/formatarPrestador");
const { criarNotificacao } = require("../utils/criarNotificacao");
const { validarTelefone } = require("../utils/telefone");
const { validarCpfCnpj, digitosCpfCnpj } = require("../utils/cpfCnpj");
const { obterLocalizacaoPorCoordenadas } = require("../utils/localizacao");

const router = express.Router();

// ==========================================================================
// MIGRAÇÃO LEVE: avatar_customizado — diz se a conta subiu uma foto
// própria (POST /:id/avatar) que deve valer no lugar da foto do Google, E
// funciona como "versão" da foto: guarda 0 (nunca customizou) ou o
// timestamp (ms) do último upload — não é mais um booleano puro. Isso
// serve de cache-bust na URL da foto (?v=<timestamp>, ver avatarUrlEfetivo
// no front): o arquivo em disco tem sempre o mesmo nome determinístico
// (id da conta), então sem um valor que MUDA a cada upload, trocar a foto
// mantém a mesma URL de sempre e o navegador nunca pediria a versão nova
// — ficaria com a antiga em cache pra sempre, em qualquer lugar que já
// tivesse carregado ela antes (era exatamente o bug relatado: foto trocada
// não atualizava em todo canto).
// A foto do Google em si continua sendo sincronizada a cada login (coluna
// avatar_url, ver /entrar-google) independente disso — assim reverter
// (DELETE /:id/avatar) é só zerar essa flag, sem perder a foto do Google
// por baixo. Self-healing, mesmo padrão da migração capa_tipo em
// prestadores.js.
// ==========================================================================
try {
    db.exec("ALTER TABLE usuarios ADD COLUMN avatar_customizado INTEGER NOT NULL DEFAULT 0");
} catch (erro) {
    if (!String(erro.message).includes("duplicate column")) throw erro;
}

// ==========================================================================
// PASTA POR USUÁRIO: cada conta tem uma pasta própria em storage/<id>/avatar
// — antes vivia em public/uploads/usuarios/<id>, mas o segmento "uploads"
// não tinha função nenhuma (nunca existiu outro tipo de conteúdo estático
// fora de uploads) e só acrescentava mais um nível pra bater entre front e
// back. O "hash" continua sendo o próprio id da conta (uuid), igual já é
// usado em todo o resto do app.
// ==========================================================================
const BASE_UPLOADS_USUARIOS = path.join(__dirname, "../../storage");

function pastaUsuario(id) {
    return path.join(BASE_UPLOADS_USUARIOS, id, "avatar");
}

// Garante que a pasta da conta existe antes de gravar algo nela. Chamada
// tanto na criação da conta (pasta já nasce pronta) quanto, por segurança,
// na hora do upload em si (idempotente — mkdirSync com recursive não erra
// se já existir — cobre contas antigas de antes dessa mudança).
function garantirPastaUsuario(id) {
    fs.mkdirSync(pastaUsuario(id), { recursive: true });
}

const TAMANHO_MAXIMO_AVATAR_USUARIO = 6 * 1024 * 1024; // 6MB, mesma folga usada nas fotos de prestador

const uploadAvatarUsuario = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TAMANHO_MAXIMO_AVATAR_USUARIO },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/"))
});

function receberAvatarUsuario(req, res, next) {
    uploadAvatarUsuario.single("foto")(req, res, (erro) => {
        if (!erro) return next();
        if (erro instanceof multer.MulterError && erro.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({ erro: `Imagem muito grande (máximo ${TAMANHO_MAXIMO_AVATAR_USUARIO / 1024 / 1024}MB).` });
        }
        return res.status(400).json({ erro: "Não foi possível receber a imagem enviada." });
    });
}

// Mesma SELECT usada no restante do arquivo (GET/PATCH/entrar-google) —
// evita repetir a lista de colunas com o avatar_customizado embutido.
const SELECT_USUARIO = "SELECT id, nome, email, telefone, cpf_cnpj AS cpfCnpj, avatar_url AS avatarUrl, avatar_customizado AS avatarCustomizado FROM usuarios WHERE id = ?";

// ==========================================================================
// LOGIN COM GOOGLE — substitui o "entrar por telefone" (que não verificava
// nada, só confiava no que a pessoa digitava). Isso só funciona rodando
// como site normal (fora do WebView do app Android) — Google recusa OAuth
// dentro de WebView embutida de propósito, desde 2016. Ver conversa sobre
// isso: quando o REFLEXO virar app de novo, essa tela de login precisa
// abrir numa Custom Tab (ou usar o SDK nativo), não dentro da WebView.
//
// GOOGLE_CLIENT_ID precisa ser o MESMO Client ID configurado no front
// (script.js) — ele é a "audiência" que valida o token aqui.
// ==========================================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// JWT_SECRET assina a SESSÃO (não confundir com o Client ID do Google
// acima, que só serve pra validar quem a pessoa é). Precisa ser um
// segredo aleatório e comprido, só do servidor — ver .env. Sem ele,
// /entrar-google não emite token nenhum e ninguém consegue acessar rota
// protegida (ver identidade.js: sem JWT_SECRET, identificarUsuario nunca
// autentica ninguém).
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRACAO = "30d"; // sessão dura 30 dias; depois disso precisa logar de novo

function assinarTokenSessao(usuarioId) {
    return jwt.sign({ sub: usuarioId }, JWT_SECRET, { expiresIn: JWT_EXPIRACAO });
}

// POST /api/usuarios/entrar-google
// Body: { credential } — o ID token (JWT) que o botão "Sign in with
// Google" do front recebe pronto, sem o front nunca ver senha nenhuma.
// O servidor verifica a ASSINATURA desse token direto com o Google
// (verifyIdToken já faz isso, incluindo checar expiração e audiência) —
// então um token forjado não passa, ao contrário do telefone auto-declarado
// de antes. Depois de confirmar quem é a pessoa, assina o NOSSO próprio
// token de sessão (JWT_SECRET) — é esse token que o front usa daqui pra
// frente em toda request, não o credential do Google (que é de uso único).
router.post("/entrar-google", async (req, res) => {
    if (!googleClient) {
        return res.status(500).json({ erro: "Servidor sem GOOGLE_CLIENT_ID configurado (ver .env)." });
    }
    if (!JWT_SECRET) {
        return res.status(500).json({ erro: "Servidor sem JWT_SECRET configurado (ver .env)." });
    }

    const { credential, latitude, longitude } = req.body;
    if (!credential) return res.status(400).json({ erro: "credential é obrigatório." });

    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        payload = ticket.getPayload();
    } catch (erro) {
        return res.status(401).json({ erro: "Token do Google inválido ou expirado." });
    }

    const googleSub = payload.sub;
    const email = payload.email;
    const nome = sanitizarTexto(payload.name || email || "Você", 80);
    // payload.picture: URL do CDN do Google (lh3.googleusercontent.com),
    // não é um arquivo nosso — só guardamos a referência. Pode vir vazio
    // em contas sem foto configurada (payload simplesmente omite o campo).
    const avatarUrl = payload.picture || null;

    let usuario = db.prepare("SELECT id, nome, email, telefone, cpf_cnpj AS cpfCnpj, avatar_url AS avatarUrl, avatar_customizado AS avatarCustomizado FROM usuarios WHERE google_sub = ?").get(googleSub);

    if (!usuario) {
        const novo = { id: uuidv4(), nome, email, google_sub: googleSub, avatar_url: avatarUrl, criado_em: Date.now() };
        db.prepare(`
            INSERT INTO usuarios (id, nome, email, google_sub, telefone, avatar_url, criado_em)
            VALUES (@id, @nome, @email, @google_sub, NULL, @avatar_url, @criado_em)
        `).run(novo);
        garantirPastaUsuario(novo.id); // cria a pasta da conta já no cadastro
        usuario = { id: novo.id, nome: novo.nome, email: novo.email, telefone: null, cpfCnpj: null, avatarUrl: novo.avatar_url, avatarCustomizado: 0 };

        // ==================================================================
        // LOG_CADASTROS — snapshot do momento exato da criação da conta (ver
        // schema.sql). Só roda no ramo "conta nova", nunca em login de conta
        // existente — é um registro do EVENTO de cadastro, não um espelho
        // contínuo. Geocoding é feito ANTES de responder ao cliente (não em
        // segundo plano) de propósito: se rodasse depois via
        // setTimeout/fire-and-forget, um restart do servidor no meio
        // perderia a gravação silenciosamente, e não tem uma fila de retry
        // aqui pra cobrir isso. O timeout de 5s do Nominatim (ver
        // utils/localizacao.js) limita o quanto isso atrasa o login em caso
        // de lentidão do serviço externo.
        //
        // req.ip: já reflete X-Forwarded-For de verdade porque
        // "trust proxy" está ligado (ver server.js) — é o IP real de quem
        // fez a request, não o do Nginx na frente.
        //
        // req.socket.remotePort: ATENÇÃO — essa é a porta da conexão TCP
        // que chega no processo Node, ou seja, a porta do Nginx (proxy
        // reverso), não a porta de origem do celular do usuário. Uma porta
        // de cliente típica não sobrevive a um proxy reverso sem
        // configuração explícita nele (Nginx não repassa isso por padrão,
        // não existe um "X-Forwarded-Port" equivalente pra porta de
        // ORIGEM). Gravamos mesmo assim porque foi pedido explicitamente,
        // mas o valor é da perna proxy→Node, não do cliente de fato — se
        // precisar da porta real do cliente, o Nginx precisaria expor
        // $remote_port num header próprio (ex: X-Client-Port) pra gente ler
        // aqui.
        try {
            const localizacao = await obterLocalizacaoPorCoordenadas(latitude, longitude);
            db.prepare(`
                INSERT INTO log_cadastros (usuario_id, nome_completo, email, ip, porta, latitude, longitude, pais, estado, municipio, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                novo.id,
                nome,
                email,
                req.ip || null,
                req.socket ? req.socket.remotePort : null,
                latitude ?? null,
                longitude ?? null,
                localizacao.pais,
                localizacao.estado,
                localizacao.municipio,
                novo.criado_em
            );
        } catch (erro) {
            // Nunca derruba a criação da conta por causa do log de
            // auditoria — mesmo princípio de criarNotificacao().
            console.error("Falha ao gravar log_cadastros:", erro);
        }
    } else {
        // Login em conta já existente: a foto do Google pode ter mudado
        // desde o último login — atualiza pra manter em sincronia (é só
        // uma URL, sem custo de reprocessar/baixar nada). Não mexe em
        // avatar_customizado: se a pessoa já subiu uma foto própria, ela
        // continua valendo por cima da foto do Google até ser revertida
        // de propósito (DELETE /:id/avatar) — sincronizar avatar_url aqui
        // só mantém o "fallback" atualizado por baixo, não muda o que
        // está sendo exibido de fato.
        db.prepare("UPDATE usuarios SET avatar_url = ? WHERE id = ?").run(avatarUrl, usuario.id);
        usuario.avatarUrl = avatarUrl;
    }

    const token = assinarTokenSessao(usuario.id);
    res.json({ ...usuario, token });
});

// GET /api/usuarios/:id
// Exige sessão válida (exigirUsuario) porque é esta rota que
// restaurarSessao() usa no front pra CONFIRMAR que o token salvo ainda
// vale — sem essa checagem, qualquer id existente respondia 200 mesmo com
// token corrompido/expirado, e o front seguia achando a sessão boa (sino
// aparecia, polling de /notificacoes/nao-lidas começava) até essa outra
// rota, sim protegida, falhar com 401 pra sempre, silenciosamente.
// Também passa a exigir que seja a própria conta (mesmo padrão do
// PATCH/avatar abaixo) — nunca foi pra ser um "perfil público" de outra
// pessoa, então não faz sentido vazar email/telefone de terceiros.
router.get("/:id", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra consultar a própria conta." });
    }

    const usuario = db.prepare(SELECT_USUARIO).get(req.params.id);
    if (!usuario) return res.status(404).json({ erro: "Usuário não encontrado." });
    res.json(usuario);
});

// PATCH /api/usuarios/:id — editar perfil (nome, telefone e cpfCnpj
// editáveis no front; email vem do Google e não é editável por aqui de
// propósito, é a âncora da conta).
// telefone e cpfCnpj são OPCIONAIS aqui — string vazia é um valor válido
// e limpa o que estava salvo. Só quando vem algo não-vazio é que precisa
// passar na validação de formato correspondente.
router.patch("/:id", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra editar o próprio perfil." });
    }

    const nome = sanitizarTexto(req.body.nome, 80);
    if (!nome) return res.status(400).json({ erro: "nome é obrigatório." });

    const atual = db.prepare("SELECT telefone, cpf_cnpj FROM usuarios WHERE id = ?").get(req.params.id);

    // req.body.telefone === undefined (campo nem veio no corpo, ex: front
    // em cache mandando só {nome}) preserva o que já estava salvo — só uma
    // string vazia DE PROPÓSITO ("") é que limpa o telefone.
    let telefone = atual?.telefone ?? null;
    if (req.body.telefone !== undefined) {
        const telefoneBruto = sanitizarTexto(req.body.telefone, 30);
        if (telefoneBruto && !validarTelefone(telefoneBruto)) {
            return res.status(400).json({ erro: "Telefone inválido. Use um número com DDD, ex: (86) 99999-9999." });
        }
        telefone = telefoneBruto || null;
    }

    // Mesma lógica do telefone acima: campo ausente preserva, string vazia
    // limpa. validarCpfCnpj só checa QUANTIDADE de dígitos (11 ou 14) —
    // não confere dígito verificador nem consulta a Receita, é
    // auto-declarado de propósito (ver utils/cpfCnpj.js).
    let cpfCnpj = atual?.cpf_cnpj ?? null;
    if (req.body.cpfCnpj !== undefined) {
        const cpfCnpjBruto = sanitizarTexto(req.body.cpfCnpj, 20);
        if (cpfCnpjBruto && !validarCpfCnpj(cpfCnpjBruto)) {
            return res.status(400).json({ erro: "CPF/CNPJ inválido. Use 11 dígitos (CPF) ou 14 (CNPJ)." });
        }
        // Salva só os dígitos (o front manda mascarado, ex: "123.456.789-01")
        // — formatação é reaplicada na hora de exibir (ver mascararCpfCnpj em
        // 00-script.js), não faz sentido guardar pontuação no banco (ver
        // comentário da migração cpf_cnpj em db.js).
        cpfCnpj = cpfCnpjBruto ? digitosCpfCnpj(cpfCnpjBruto) : null;
    }

    db.prepare("UPDATE usuarios SET nome = ?, telefone = ?, cpf_cnpj = ? WHERE id = ?").run(nome, telefone, cpfCnpj, req.params.id);
    // Reconsulta em vez de montar a mão: evita depender de exigirUsuario
    // já trazer avatarUrl no formato certo (req.usuario vem do middleware,
    // que pode ter sido escrito antes dessa coluna existir).
    const atualizado = db.prepare(SELECT_USUARIO).get(req.params.id);
    res.json(atualizado);
});

// POST /api/usuarios/:id/avatar — sobe uma foto própria pra conta, que
// passa a valer no lugar da foto do Google em TUDO que mostra esse
// usuário (inclusive o nome/avatar herdado pelos prestadores dele, ver
// formatarPrestador.js). Cortado em quadrado (fit:"cover") — mesmo
// motivo do antigo avatar de prestador: é sempre exibido dentro de um
// círculo, sem crop no servidor um retrato alto ficaria espremido.
router.post("/:id/avatar", receberAvatarUsuario, exigirUsuario, async (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra trocar a foto da própria conta." });
    }
    if (!req.file) return res.status(400).json({ erro: "Envie uma imagem no campo 'foto'." });

    try {
        garantirPastaUsuario(req.params.id);
        const destino = path.join(pastaUsuario(req.params.id), "avatar.webp");
        await sharp(req.file.buffer)
            .rotate()
            .resize(500, 500, { fit: "cover", position: "centre" })
            .webp({ quality: 85 })
            .toFile(destino);

        // Date.now() (não 1): esse valor dobra como "versão" da foto pra
        // cache-bust no front (?v=..., ver avatarUrlEfetivo em
        // 00-script.js) — precisa mudar a cada upload, senão a URL fica
        // idêntica à de antes e o navegador nunca busca a versão nova.
        const versao = Date.now();
        db.prepare("UPDATE usuarios SET avatar_customizado = ? WHERE id = ?").run(versao, req.params.id);
        res.json({ avatarCustomizado: versao });
    } catch (erro) {
        console.error("Falha ao processar avatar da conta:", erro);
        res.status(400).json({ erro: "Não foi possível processar a imagem enviada. Tente outra foto." });
    }
});

// DELETE /api/usuarios/:id/avatar — volta a usar a foto do Google (que
// continua sincronizada em avatar_url a cada login, ver /entrar-google).
// Não precisa reenviar nada: só desliga a flag; o arquivo customizado
// fica órfão em disco (mesmo tratamento de baixo risco já usado nas
// outras fotos do app — é só espaço, sem custo de exibir nada errado).
router.delete("/:id/avatar", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra trocar a foto da própria conta." });
    }

    db.prepare("UPDATE usuarios SET avatar_customizado = 0 WHERE id = ?").run(req.params.id);
    fs.rm(path.join(pastaUsuario(req.params.id), "avatar.webp"), { force: true }, () => {});
    res.status(204).end();
});

// ---- SALVOS (prestadores salvos por esse usuário) ----

router.get("/:id/salvos", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra ver a própria lista de salvos." });
    }

    const linhas = db.prepare(`
        ${SELECT_PRESTADORES_COM_NOTA}
        JOIN salvos s ON s.prestador_id = p.id
        WHERE s.usuario_id = ?
        GROUP BY p.id
        ORDER BY s.criado_em DESC
    `).all(req.params.id);

    res.json(linhas.map(formatarPrestador));
});

router.post("/:id/salvos/:prestadorId", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra alterar a própria lista de salvos." });
    }

    const info = db.prepare(`
        INSERT OR IGNORE INTO salvos (usuario_id, prestador_id, criado_em)
        VALUES (?, ?, ?)
    `).run(req.params.id, req.params.prestadorId, Date.now());

    // info.changes === 0 quando já estava salvo (INSERT OR IGNORE não fez
    // nada) — não notifica de novo por um "salvar" que na prática não
    // aconteceu agora. dono_usuario_id !== req.usuario.id evita notificar
    // alguém que salvou o próprio cadastro.
    if (info.changes > 0) {
        const prestador = db.prepare("SELECT dono_usuario_id, categoria FROM prestadores WHERE id = ?").get(req.params.prestadorId);
        if (prestador && prestador.dono_usuario_id && prestador.dono_usuario_id !== req.usuario.id) {
            criarNotificacao({
                usuarioId: prestador.dono_usuario_id,
                tipo: "prestador_salvo",
                titulo: "Alguém salvou seu contato",
                corpo: `Uma pessoa visitou seu perfil de ${prestador.categoria} e salvou seu contato.`,
                link: `prestador:${req.params.prestadorId}`
            });
        }
    }

    res.status(204).end();
});

router.delete("/:id/salvos/:prestadorId", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra alterar a própria lista de salvos." });
    }

    db.prepare("DELETE FROM salvos WHERE usuario_id = ? AND prestador_id = ?").run(req.params.id, req.params.prestadorId);
    res.status(204).end();
});

// ==========================================================================
// EXCLUSÃO DE CONTA — "Excluir minha conta" em Preferências (ver
// abrirConfirmarExclusaoConta/excluirContaDefinitivamente em 00-script.js
// no front, que já chama exatamente esse endpoint). Irreversível: some com
// TUDO que referencia essa conta. A única coisa que sobrevive é uma linha
// em auditoria_contas (ver schema.sql), sem nenhum dado pessoal navegável.
// ==========================================================================

// Mesma raiz de pasta usada em pastaUsuario() (avatar) e pastaReviewsAutor()
// (avaliacoes.js) — ambas moram dentro de public/<id>/, e as pastas de
// mídia de cada prestador que essa conta é dona moram em public/<id>-p-<N>/
// (ver comentário "PASTA POR PRESTADOR" em routes/prestadores.js: essa
// convenção de nomenclatura — tudo que começa com o id da conta é dela —
// existe justamente pra isso, apagar a conta de alguém virar "apagar toda
// pasta que começa com esse id", sem precisar caçar arquivo espalhado por
// id de prestador). fs.rm recursive+force não erra se a pasta não existir,
// então dá pra chamar sem checar existência antes.
function removerArquivosDaConta(usuarioId) {
    fs.rm(path.join(BASE_UPLOADS_USUARIOS, usuarioId), { recursive: true, force: true }, () => {});

    fs.readdir(BASE_UPLOADS_USUARIOS, (erro, entradas) => {
        if (erro) return; // public/ nem existe ainda (banco novo, zero upload até agora) — nada a limpar
        entradas
            .filter(nome => nome.startsWith(`${usuarioId}-p-`))
            .forEach(nome => fs.rm(path.join(BASE_UPLOADS_USUARIOS, nome), { recursive: true, force: true }, () => {}));
    });
}

router.delete("/:id", exigirUsuario, (req, res) => {
    if (req.usuario.id !== req.params.id) {
        return res.status(403).json({ erro: "Só dá pra excluir a própria conta." });
    }

    const usuario = db.prepare("SELECT criado_em FROM usuarios WHERE id = ?").get(req.params.id);
    if (!usuario) return res.status(404).json({ erro: "Conta não encontrada." });

    // Tudo numa transação só: ou a conta some por inteiro, ou nada muda —
    // não existe estado "meio excluída" se algo falhar no meio do caminho.
    // Ordem importa: primeiro tudo que referencia usuarioId como FK (senão
    // o DELETE final em `usuarios` esbarra em FOREIGN KEY constraint —
    // foreign_keys=ON, ver db.js). `prestadores` fica por último desse
    // grupo de propósito: ao removê-los, o ON DELETE CASCADE do schema
    // arrasta sozinho qualquer avaliação/salvo/clique-de-whatsapp ainda
    // pendurado neles — inclusive os feitos por OUTRAS contas, que é
    // exatamente como "avaliações recebidas" some junto sem precisar de
    // uma query própria pra isso.
    const excluirTransacao = db.transaction((usuarioId) => {
        db.prepare("DELETE FROM avaliacoes WHERE autor_usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM cliques_whatsapp WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM salvos WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM notificacoes WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM prestadores WHERE dono_usuario_id = ?").run(usuarioId);

        db.prepare(`
            INSERT INTO auditoria_contas (usuario_id, criado_em, excluido_em)
            VALUES (?, ?, ?)
        `).run(usuarioId, usuario.criado_em, Date.now());

        db.prepare("DELETE FROM usuarios WHERE id = ?").run(usuarioId);
    });

    try {
        excluirTransacao(req.params.id);
    } catch (erro) {
        console.error("Falha ao excluir conta:", erro);
        return res.status(500).json({ erro: "Não foi possível excluir a conta agora. Tente de novo em instantes." });
    }

    // Fora da transação de propósito — são arquivos, não SQL; não rodam
    // nem revertem junto com o COMMIT/ROLLBACK do banco acima. Só chega
    // aqui depois que o banco já confirmou a exclusão de verdade, então
    // não tem risco de apagar arquivo de uma exclusão que acabou falhando.
    // O token de sessão dessa pessoa (JWT) não precisa ser invalidado à
    // parte: a próxima request com ele passa por identificarUsuario, que
    // já busca o usuário no banco (ver middleware/identidade.js) — sem a
    // linha, req.usuario vira null sozinho, igual sessão expirada.
    removerArquivosDaConta(req.params.id);

    res.status(204).end();
});

module.exports = router;
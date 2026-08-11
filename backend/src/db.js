const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
require("dotenv").config();

const DB_PATH = process.env.DB_PATH || "./data/mase.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// ==========================================================================
// MIGRAÇÕES — mudanças de estrutura em bancos que já existiam antes da
// coluna ser criada (dev local, banco de alguém que já tinha dado
// `npm run dev` antes desta mudança). NÃO fica no schema.sql porque
// SQLite não aceita "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" (só
// CREATE TABLE aceita IF NOT EXISTS) — reexecutar um ALTER TABLE puro a
// cada start quebra com "duplicate column name". Por isso cada migração
// aqui se guarda checando antes se já foi aplicada.
//
// foto_url: caminho da foto opcional enviada junto da avaliação (galeria
// "Fotos dos clientes" no perfil — ver routes/avaliacoes.js).
// ==========================================================================
const colunasAvaliacoes = db.prepare("PRAGMA table_info(avaliacoes)").all();
if (!colunasAvaliacoes.some(c => c.name === "foto_url")) {
    db.exec("ALTER TABLE avaliacoes ADD COLUMN foto_url TEXT");
    console.log("[db] migração aplicada: avaliacoes.foto_url");
}

// avatar_url: foto de perfil do Google (payload.picture do ID token),
// guardada no login — ver routes/usuarios.js. É só uma URL do CDN do
// Google (lh3.googleusercontent.com), não um arquivo nosso; guardamos
// pra não precisar chamar o Google de novo a cada carregamento de perfil.
const colunasUsuarios = db.prepare("PRAGMA table_info(usuarios)").all();
if (!colunasUsuarios.some(c => c.name === "avatar_url")) {
    db.exec("ALTER TABLE usuarios ADD COLUMN avatar_url TEXT");
    console.log("[db] migração aplicada: usuarios.avatar_url");
}

// cpf_cnpj: número declarado pela própria conta (ver POST /entrar-google
// não mexe nisso — só PATCH /:id, editável em "Preferências da conta").
// NÃO é validado contra a Receita Federal nem confere identidade — é só
// dígitos armazenados como texto (com formatação aplicada na hora de
// exibir, não na hora de salvar). Guardado como TEXT (não INTEGER) por
// dois motivos: CPF pode começar com zero (perderia o dígito num campo
// numérico) e o valor nunca é usado em conta matemática, só comparação/
// exibição. NULL = não informado (selo não aparece — ver
// SELECT_PRESTADORES_COM_NOTA em formatarPrestador.js).
if (!colunasUsuarios.some(c => c.name === "cpf_cnpj")) {
    db.exec("ALTER TABLE usuarios ADD COLUMN cpf_cnpj TEXT");
    console.log("[db] migração aplicada: usuarios.cpf_cnpj");
}

// dias_semana: array JSON de dias em que o prestador funciona (ver
// routes/prestadores.js e formatarPrestador.js) — NULL/coluna ausente
// continua se comportando como "todos os dias", igual sempre foi.
const colunasPrestadores = db.prepare("PRAGMA table_info(prestadores)").all();
if (!colunasPrestadores.some(c => c.name === "dias_semana")) {
    db.exec("ALTER TABLE prestadores ADD COLUMN dias_semana TEXT");
    console.log("[db] migração aplicada: prestadores.dias_semana");
}

// last_seen_at: timestamp (ms, Date.now()) da última request autenticada
// dessa conta — usado só pelo painel interno (routes/admin.js) pra
// calcular "usuários ativos hoje/semana". Atualizado pelo middleware
// registrarPresenca (ver server.js), throttled a 1x/min por usuário pra
// não gravar no banco a cada request. NULL = conta nunca fez uma request
// autenticada desde que essa coluna passou a existir (trata igual
// "nunca esteve ativa" nas contagens, não é erro).
if (!colunasUsuarios.some(c => c.name === "last_seen_at")) {
    db.exec("ALTER TABLE usuarios ADD COLUMN last_seen_at INTEGER");
    console.log("[db] migração aplicada: usuarios.last_seen_at");
}

// Índice pra last_seen_at — não pode ir no schema.sql porque a coluna só
// existe depois da migração logo acima (num banco criado do zero, a coluna
// nasce direto na migração, não no CREATE TABLE). Usado em toda query de
// "online agora"/"ativos hoje" e na ordenação da lista de usuários (ver
// routes/admin.js) — sem isso é table scan em `usuarios` a cada refresh do
// painel. IF NOT EXISTS: seguro rodar em todo start, só cria uma vez.
db.exec("CREATE INDEX IF NOT EXISTS idx_usuarios_last_seen ON usuarios(last_seen_at DESC)");

// descricao: texto livre opcional do prestador, exibido na seção "Sobre"
// do perfil público (ver routes/prestadores.js e formatarPrestador.js) —
// NULL/coluna ausente vira estado vazio no front (perfil mostra "Este
// prestador ainda não escreveu uma descrição."), nunca um erro.
if (!colunasPrestadores.some(c => c.name === "descricao")) {
    db.exec("ALTER TABLE prestadores ADD COLUMN descricao TEXT");
    console.log("[db] migração aplicada: prestadores.descricao");
}

// porta: porta TCP da conexão que chegou no processo Node (req.socket.
// remotePort), gravada junto de cada request_log (ver logRequisicao em
// server.js) — mesma ressalva já documentada em log_cadastros/porta: por
// trás de um proxy reverso (Nginx), essa é a porta da perna proxy→Node,
// não a porta de origem real do cliente (não existe um "X-Forwarded-Port"
// padrão pra isso). Só grava mesmo assim porque foi pedido explicitamente
// pra aparecer no painel — não é um substituto confiável de rastrear o
// cliente real sem cruzar com o log do proxy na frente.
const colunasRequestLogs = db.prepare("PRAGMA table_info(request_logs)").all();
if (!colunasRequestLogs.some(c => c.name === "porta")) {
    db.exec("ALTER TABLE request_logs ADD COLUMN porta INTEGER");
    console.log("[db] migração aplicada: request_logs.porta");
}

// municipio/estado/pais em `prestadores` — mesmo geocoding reverso já
// usado em log_cadastros (ver utils/localizacao.js), mas aqui pro
// PRESTADOR (pela lat/lng do cadastro do serviço, não do usuário). Sem
// isso não dá pra cruzar "onde tem gente" com "onde tem serviço
// oferecido" (ver GET /dashboard/cobertura em routes/admin.js).
// Preenchido em background pelo job iniciarJobGeocodificacaoPrestadores
// (ver jobs/geocodificarPrestadores.js) — não no momento do cadastro,
// pra não atrasar a resposta de POST /prestadores com uma chamada de
// rede externa (Nominatim). NULL = ainda não geocodificado (ou
// geocoding falhou) — o job tenta de novo nos próximos ciclos.
const colunasPrestadoresGeo = db.prepare("PRAGMA table_info(prestadores)").all();
if (!colunasPrestadoresGeo.some(c => c.name === "municipio")) {
    db.exec("ALTER TABLE prestadores ADD COLUMN municipio TEXT");
    db.exec("ALTER TABLE prestadores ADD COLUMN estado TEXT");
    db.exec("ALTER TABLE prestadores ADD COLUMN pais TEXT");
    console.log("[db] migração aplicada: prestadores.municipio/estado/pais");
}

// ==========================================================================
// buscas_sem_resultado — uma linha por busca de prestadores que voltou
// ZERO resultados (ver POST /api/buscas/sem-resultado em routes/buscas.js,
// chamado pelo client na tela de busca). É o card mais pedido antes de
// qualquer métrica nova: mostra demanda REAL não atendida (alguém
// procurou e não achou), diferente de "categorias sem oferta" em
// GET /dashboard/cobertura, que é só inferido (cruza onde tem usuário
// cadastrado com onde tem prestador, sem saber se alguém de fato buscou).
//
// CREATE TABLE direto aqui (não em schema.sql, que não faz parte deste
// pacote de arquivos) — mesma garantia de "IF NOT EXISTS" que todo o
// resto deste arquivo já segue, então rodar isso de novo em todo start
// não tem efeito colateral.
//
// lat/lng gravados CRUS (sem reverse geocoding síncrono) — mesmo motivo
// de prestadores.lat/lng: bloquear a resposta da busca com uma chamada
// externa ao Nominatim custaria latência real numa tela que o usuário
// está olhando na hora. município/estado/país ficam NULL até o job de
// background preencher (ver jobs/geocodificarBuscasSemResultado.js,
// cópia do padrão já usado em jobs/geocodificarPrestadores.js).
//
// usuario_id é opcional (ON DELETE SET NULL, não CASCADE): busca sem
// resultado de alguém não-logado ainda é dado útil (a maioria das buscas
// no app não exige login) — e mesmo que a conta seja apagada depois, o
// REGISTRO da lacuna de oferta continua valendo (não é dado pessoal, é
// characteristics do MERCADO: "categoria X não existe na cidade Y").
db.exec(`
    CREATE TABLE IF NOT EXISTS buscas_sem_resultado (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        categoria TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        raio_km REAL,
        municipio TEXT,
        estado TEXT,
        pais TEXT,
        usuario_id TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
        criado_em INTEGER NOT NULL
    )
`);

// Índices separados pro caso de uso de cada consulta: o job de
// geocoding varre por "município ainda não resolvido" (WHERE municipio
// IS NULL), o painel agrega por categoria+município pro ranking de
// lacunas — cobrir os dois evita table scan nas duas rotas.
db.exec("CREATE INDEX IF NOT EXISTS idx_buscas_sem_resultado_geocoding ON buscas_sem_resultado(municipio)");
db.exec("CREATE INDEX IF NOT EXISTS idx_buscas_sem_resultado_ranking ON buscas_sem_resultado(categoria, municipio)");

// ==========================================================================
// ip_lookup_cache — geolocalização (país/região/cidade/organização) de
// endereços IP vistos em request_logs, usada pela aba "Segurança" (ver
// GET /dashboard/seguranca/ips em routes/admin.js e utils/ipLocalizacao.js)
// pra dar contexto de ONDE um IP com volume/erro suspeito está vindo, sem
// resolver isso a cada request — só sob demanda, pros IPs que aparecem
// na lista, e cacheado aqui pra nunca repetir a mesma consulta externa.
//
// falha: 1 quando a última tentativa de resolver esse IP falhou (IP
// privado/reservado, serviço externo fora do ar, IP inválido) — cacheado
// TAMBÉM nesse caso, senão todo refresh do painel tentaria de novo um IP
// que sabidamente não resolve (ex: 127.0.0.1 rodando local).
// resolvido_em: quando essa linha foi escrita — permite, no futuro, expirar
// entradas muito antigas (IP pode mudar de dono/localização com o tempo);
// não expira automaticamente ainda porque a granularidade de país/região
// muda raramente o bastante pra isso não ser prioridade agora.
db.exec(`
    CREATE TABLE IF NOT EXISTS ip_lookup_cache (
        ip TEXT PRIMARY KEY,
        pais TEXT,
        regiao TEXT,
        cidade TEXT,
        organizacao TEXT,
        falha INTEGER NOT NULL DEFAULT 0,
        resolvido_em INTEGER NOT NULL
    )
`);

// ==========================================================================
// log_auditoria_moderacao — quem mudou o quê na tela de moderação (ver
// comentário que existia em routes/admin.js: "refinamentos (motivo de
// edição, log de auditoria de quem mudou o quê) ficam pra depois" — isto
// é esse "depois"). Cobre PATCH e DELETE de /api/admin/moderacao/*
// (usuários e prestadores); NÃO cobre o resto do painel, que é só leitura.
//
// moderador: não existe conceito de "usuário admin" no schema (só um
// ADMIN_TOKEN fixo compartilhado — ver exigirAdmin em routes/admin.js),
// então "quem" é um nome digitado pela pessoa moderando (ver campo
// #admin-nome em moderacao/index.html, mesmo padrão do token: guardado
// em localStorage, mandado no header X-Admin-Nome). Não autentica nada,
// é só rótulo de auditoria — não impede ninguém de mentir o nome, mas já
// é infinitamente melhor que "alguém com o token mexeu, sem saber quem".
//
// entidade_tipo/entidade_id: 'usuario'|'prestador' + o id da linha
// afetada. SEM FOREIGN KEY de propósito — mesmo raciocínio de
// auditoria_contas/log_cadastros: numa exclusão a linha referenciada já
// não existe mais no momento em que o log é uma prova útil de auditoria,
// uma FK aqui faria a própria gravação falhar bem na hora que mais
// importa registrar.
//
// alteracoes: JSON.stringify de { campo: { de, para } } só dos campos que
// de fato mudaram (PATCH) — nada gravado quando nada mudou de verdade.
// Em DELETE guarda um snapshot completo da linha (JSON.stringify do
// registro inteiro), já que depois de excluído não existe "antes" pra
// comparar com nada.
db.exec(`
    CREATE TABLE IF NOT EXISTS log_auditoria_moderacao (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        moderador TEXT NOT NULL,
        acao TEXT NOT NULL CHECK (acao IN ('editar', 'excluir')),
        entidade_tipo TEXT NOT NULL CHECK (entidade_tipo IN ('usuario', 'prestador')),
        entidade_id TEXT NOT NULL,
        alteracoes TEXT,
        criado_em INTEGER NOT NULL
    )
`);

// Cobre os dois usos reais da aba "Log de auditoria" (ver GET
// /moderacao/log em routes/admin.js): listagem geral por recência, e
// "histórico desta conta/prestador" filtrado por entidade específica.
db.exec("CREATE INDEX IF NOT EXISTS idx_log_auditoria_criado ON log_auditoria_moderacao(criado_em DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_log_auditoria_entidade ON log_auditoria_moderacao(entidade_tipo, entidade_id, criado_em DESC)");

// origem: 'moderacao' (painel de moderação, ADMIN_TOKEN) ou 'usuario' (a
// própria conta editando/excluindo pelo app normal — ver
// utils/auditoria.js). Migração porque a tabela já existia só com o lado
// da moderação; DEFAULT 'moderacao' preserva o significado das linhas
// antigas, todas gravadas antes de origem existir.
const colunasLogAuditoria = db.prepare("PRAGMA table_info(log_auditoria_moderacao)").all();
if (!colunasLogAuditoria.some(c => c.name === "origem")) {
    db.exec("ALTER TABLE log_auditoria_moderacao ADD COLUMN origem TEXT NOT NULL DEFAULT 'moderacao'");
    console.log("[db] migração aplicada: log_auditoria_moderacao.origem");
}

module.exports = db;

-- ==========================================================================
-- SCHEMA — espelha as chaves que hoje vivem em localStorage no script.js
-- (ver CHAVE_PRESTADORES_CADASTRADOS, CHAVE_PERFIL_USUARIO, CHAVE_CONFIG_APP,
-- CHAVE_AVALIACOES_PENDENTES, CHAVE_CLIQUES_WHATSAPP e o array PRESTADORES).
-- CHAVE_CONFIG_APP NÃO tem tabela aqui — é preferência de aparelho (tema,
-- notificação), não faz sentido morar no servidor. Continua 100% local.
--
-- ESTE ARQUIVO NÃO É A ESTRUTURA COMPLETA DO BANCO. As tabelas
-- buscas_sem_resultado, ip_lookup_cache, log_auditoria_moderacao e admins
-- são criadas direto em db.js (CREATE TABLE IF NOT EXISTS, mesmo padrão
-- de migração usado ali), não aqui — ver comentários correspondentes em
-- db.js pra contexto de cada uma. Antes de assumir "o banco tem só essas
-- 9 tabelas", cheque db.js também.
-- ==========================================================================

-- Identidade agora é Google OAuth (google_sub + email) em vez de telefone
-- auto-declarado — ver routes/usuarios.js (POST /entrar-google) e a
-- conversa sobre WebView bloquear OAuth (por isso isso só faz sentido
-- rodando como site normal por enquanto, não dentro do WebView do app).
-- telefone vira opcional: continua podendo ser preenchido no perfil, mas
-- não é mais o que identifica a conta.
CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    email TEXT UNIQUE,
    google_sub TEXT UNIQUE,
    telefone TEXT,
    criado_em INTEGER NOT NULL
);

-- id em TEXT (não autoincrement) pra poder semear os 6 prestadores de
-- demonstração com ids "1".."6" — mesmos ids que o script.js já usa hoje,
-- então quem já tinha algo salvo (ex: em "salvos") continua batendo.
CREATE TABLE IF NOT EXISTS prestadores (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    categoria TEXT NOT NULL,
    descricao TEXT,                  -- texto livre opcional, exibido na seção "Sobre" do perfil público
    telefone TEXT NOT NULL,
    cor TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    horario_abre REAL,
    horario_fecha REAL,
    dias_semana TEXT,                -- JSON.stringify([0..6]) — 0=domingo...6=sábado; NULL = todos os dias
    tags TEXT NOT NULL,              -- JSON.stringify(array) — mesma forma que o front já usa
    dono_usuario_id TEXT,            -- quem cadastrou; NULL nos 6 demos (não têm dono real)
    criado_em INTEGER NOT NULL,
    FOREIGN KEY (dono_usuario_id) REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS avaliacoes (
    id TEXT PRIMARY KEY,
    prestador_id TEXT NOT NULL,
    autor_nome TEXT NOT NULL,
    autor_usuario_id TEXT,
    nota INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
    comentario TEXT NOT NULL,
    foto_url TEXT,                    -- até 3 fotos opcionais da avaliação (ver routes/avaliacoes.js)
    foto_url2 TEXT,
    foto_url3 TEXT,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'publicada', 'rejeitada')),
    via_whatsapp INTEGER NOT NULL DEFAULT 0,
    motivo_rejeicao TEXT,
    expirou_automaticamente INTEGER NOT NULL DEFAULT 0,
    criado_em INTEGER NOT NULL,
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id) ON DELETE CASCADE,
    FOREIGN KEY (autor_usuario_id) REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS cliques_whatsapp (
    prestador_id TEXT NOT NULL,
    usuario_id TEXT NOT NULL,
    criado_em INTEGER NOT NULL,
    PRIMARY KEY (prestador_id, usuario_id),
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id) ON DELETE CASCADE,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS salvos (
    usuario_id TEXT NOT NULL,
    prestador_id TEXT NOT NULL,
    criado_em INTEGER NOT NULL,
    PRIMARY KEY (usuario_id, prestador_id),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
    FOREIGN KEY (prestador_id) REFERENCES prestadores(id) ON DELETE CASCADE
);

-- Notificações in-app — "sino" no header. Cada linha é um evento já
-- acontecido (avaliação nova pra revisar, avaliação decidida, prestador
-- salvo por alguém) endereçado a UM usuário específico. `link` guarda uma
-- referência leve tipo "tipo:id" (ex: "prestador:7", "avaliacoes-pendentes:7")
-- que o front interpreta pra saber que tela abrir ao tocar na notificação —
-- não é uma URL de verdade, só um ponteiro interno (ver
-- utils/notificacoes.js no backend e 07-notificacoes.js no front).
CREATE TABLE IF NOT EXISTS notificacoes (
    id TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL,
    tipo TEXT NOT NULL,               -- 'avaliacao_pendente' | 'avaliacao_publicada' | 'avaliacao_rejeitada' | 'prestador_salvo'
    titulo TEXT NOT NULL,
    corpo TEXT,
    link TEXT,
    lida INTEGER NOT NULL DEFAULT 0,
    criado_em INTEGER NOT NULL,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_avaliacoes_prestador ON avaliacoes(prestador_id, status);
CREATE INDEX IF NOT EXISTS idx_salvos_usuario ON salvos(usuario_id);
-- Usado em toda listagem/JOIN de prestadores por dono (formatarPrestador.js,
-- subquery de totalPrestadores em admin.js) — sem isso é table scan em
-- `prestadores` a cada linha de usuário listada no painel.
CREATE INDEX IF NOT EXISTS idx_prestadores_dono ON prestadores(dono_usuario_id);
-- lida=0 primeiro seria ideal, mas a lista sempre ordena por criado_em DESC
-- (mais recente no topo, lida ou não) — este índice já cobre os dois usos
-- reais: contagem de não lidas (nao-lidas) e listagem geral (GET /).
CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario ON notificacoes(usuario_id, criado_em DESC);

-- Aparelhos que recebem push da conta (ver utils/push.js). Cabe aqui, e não
-- numa "migração leve" do db.js: aquelas existem só pra ALTER TABLE em tabela
-- já existente. Este arquivo roda inteiro a cada boot (db.exec(schema)) e todo
-- CREATE aqui é IF NOT EXISTS — criar tabela nova já é idempotente.
CREATE TABLE IF NOT EXISTS dispositivos (
    -- O token É a identidade do aparelho pro FCM. Chave primária nele resolve
    -- de graça reinstalar/trocar de conta: o mesmo token nunca aparece duas
    -- vezes com donos diferentes.
    token TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL,
    plataforma TEXT NOT NULL DEFAULT 'android',
    criado_em INTEGER NOT NULL,
    -- Com ON DELETE CASCADE (e foreign_keys=ON, ver db.js) excluir a conta
    -- leva os aparelhos junto — diferente de `notificacoes`, esta tabela não
    -- precisa de DELETE próprio na transação de DELETE /api/usuarios/:id.
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- O envio consulta sempre por usuário ("todos os aparelhos desta conta").
CREATE INDEX IF NOT EXISTS idx_dispositivos_usuario ON dispositivos(usuario_id);

-- Único registro que SOBREVIVE à exclusão de uma conta (ver DELETE
-- /api/usuarios/:id em routes/usuarios.js) — de propósito, sem FOREIGN KEY
-- pra `usuarios`: a linha em `usuarios` já não existe mais no momento em
-- que isso é gravado, uma FK aqui faria essa própria inserção falhar.
-- Guarda só o suficiente pra provar/auditar QUE uma conta existiu e foi
-- excluída — nenhum dado pessoal navegável (sem nome, e-mail, telefone,
-- foto). usuario_id continua sendo o mesmo uuid de antes, mas sozinho ele
-- não identifica ninguém sem cruzar com um sistema externo.
CREATE TABLE IF NOT EXISTS auditoria_contas (
    usuario_id TEXT PRIMARY KEY,
    criado_em INTEGER NOT NULL,
    excluido_em INTEGER NOT NULL
);

-- ==========================================================================
-- LOG_CADASTROS — snapshot completo do momento exato em que uma conta foi
-- criada (POST /entrar-google, ramo "conta nova" — ver routes/usuarios.js).
-- Existe separado de `usuarios` por um motivo específico: ao contrário do
-- resto do app, este registro NÃO é apagado quando a conta é excluída —
-- decisão deliberada (fins de auditoria), confirmada explicitamente,
-- diferente do padrão de exclusão total usado em todo o resto do schema.
--
-- Por isso, igual auditoria_contas: usuario_id SEM FOREIGN KEY (a conta
-- pode não existir mais no momento em que esta linha é lida) e os dados
-- pessoais (nome, email) ficam DUPLICADOS aqui como estavam no instante do
-- cadastro — não é um espelho ao vivo de `usuarios`, é uma fotografia
-- congelada. Se o usuário editar nome depois, este registro não muda.
--
-- criado_em: timestamp em ms (Date.now()) — já é "horário exato" por
-- natureza, sem precisar de coluna extra.
-- latitude/longitude: só gravados quando o app tem permissão de
-- localização concedida (enviados pelo cliente no corpo de
-- POST /entrar-google) — NULL quando a pessoa negou/não tinha permissão
-- ainda nesse primeiro login.
-- pais/estado/municipio: resolvidos via geocoding reverso (Nominatim/
-- OpenStreetMap, gratuito — ver utils/localizacao.js) a partir de
-- latitude/longitude. NULL se o geocoding falhar ou não tiver coordenada
-- — nunca bloqueia a criação da conta em si (ver comentário na rota).
CREATE TABLE IF NOT EXISTS log_cadastros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id TEXT NOT NULL,
    nome_completo TEXT NOT NULL,
    email TEXT,
    ip TEXT,
    porta INTEGER,
    latitude REAL,
    longitude REAL,
    pais TEXT,
    estado TEXT,
    municipio TEXT,
    criado_em INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_cadastros_usuario ON log_cadastros(usuario_id);
CREATE INDEX IF NOT EXISTS idx_log_cadastros_criado ON log_cadastros(criado_em DESC);

-- ==========================================================================
-- REQUEST_LOGS — uma linha por request que passa pelo servidor (autenticada
-- ou não, incluindo estáticos), gravada pelo middleware logRequisicao em
-- server.js. Alimenta o painel interno (routes/admin.js/dashboard). Faltava
-- essa tabela no schema — o INSERT já existia em server.js, mas como roda
-- dentro de um try/catch silencioso (não pode derrubar a request real por
-- causa do log), a ausência da tabela nunca quebrava nada visivelmente: só
-- fazia o log falhar em silêncio a cada request, sem gravar nada.
--
-- Sem FOREIGN KEY em usuario_id de propósito: precisa continuar existindo
-- mesmo depois que a conta é excluída (mesmo raciocínio de auditoria_contas/
-- log_cadastros — log é histórico, não deve sumir junto com a conta nem
-- travar a exclusão dela).
-- ==========================================================================
CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metodo TEXT NOT NULL,
    rota TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    duracao_ms INTEGER NOT NULL,
    usuario_id TEXT,
    ip TEXT,
    porta INTEGER,           -- ver ressalva sobre porta de proxy vs cliente real na migração em db.js
    user_agent TEXT,
    criado_em INTEGER NOT NULL
);

-- criado_em DESC cobre o uso principal (últimas requests, mais recente
-- primeiro). status_code incluído pra permitir filtrar erros (>=400) sem
-- table scan, útil pra um card futuro tipo "erros recentes" no painel.
CREATE INDEX IF NOT EXISTS idx_request_logs_criado ON request_logs(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status_code, criado_em DESC);
-- Cobre o padrão específico da aba Segurança (GET /dashboard/seguranca/ips
-- em routes/admin.js): WHERE ip IS NOT NULL AND criado_em >= ? GROUP BY ip.
-- idx_request_logs_criado já ajuda no filtro de janela, mas o GROUP BY ip
-- em cima disso ainda force o SQLite a materializar e agrupar sem apoio de
-- índice; com (ip, criado_em) o motor consegue ler os agrupamentos direto
-- do índice em vez de tocar a tabela inteira pra cada IP.
CREATE INDEX IF NOT EXISTS idx_request_logs_ip_criado ON request_logs(ip, criado_em);

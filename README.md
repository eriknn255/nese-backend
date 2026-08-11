# Nese — backend + painéis internos

Backend da API do app **Nese** (descoberta de prestadores de serviço) mais os
dois painéis internos que consomem essa API.

```
backend/       API Express + SQLite (better-sqlite3)
dashboard/     Painel de métricas — HTML/CSS/JS estático, servido pelo Nginx
moderacao/     Painel de moderação — idem, CSS e JS próprios
criar-acesso/  Página de bootstrap: cria o primeiro login (ver abaixo)
```

Os painéis são estáticos de propósito: o Nginx serve as pastas direto, sem
passar pelo Express. Cada um tem seu próprio `style.css` e `script.js` — não
compartilham arquivo, só a chave de sessão no `localStorage`.

---

## Rodando local

```bash
cd backend
npm install
cp .env.example .env    # ajuste os segredos
node src/server.js
```

O banco é criado sozinho no primeiro boot (`DB_PATH`, padrão `./data/mase.db`),
junto com as migrações — `db.js` roda `CREATE TABLE IF NOT EXISTS` e os
`ALTER TABLE` pendentes a cada inicialização, então subir uma versão nova nunca
exige rodar migração à mão.

Para abrir os painéis local, sirva as pastas com qualquer servidor estático
(ex: `npx serve .` na raiz) — abrir por `file://` não funciona por causa do CORS.

---

## Autenticação

São **três** mecanismos distintos, que não se misturam:

| Quem | Como | Onde |
|---|---|---|
| Usuário do app | Google Sign-In → JWT (`JWT_SECRET`) | `middleware/identidade.js` |
| Login interno | E-mail + senha → JWT (`ADMIN_SESSION_SECRET`) | `middleware/identidadeAdmin.js` |
| Criação de login | Segredo fixo (`ADMIN_TOKEN`) | `exigirAdmin` em `routes/admin.js` |

O `ADMIN_TOKEN` **não** dá acesso ao painel. Ele serve só para criar logins:
quem quiser entrar no dashboard ou na moderação precisa de conta própria.
Assim o segredo do servidor não fica no `localStorage` de todo mundo, e dá
para revogar o acesso de uma pessoa sem trocar o segredo e reconfigurar os
demais.

### Níveis

- **`ver`** — só o dashboard, só leitura. Rotas de escrita respondem 403.
- **`full`** — dashboard + moderação, leitura e escrita, e gerencia logins.

A sessão dura 12h. `identificarAdmin` consulta o banco a cada request, então
excluir um login derruba a sessão dele na request seguinte, sem esperar o JWT
expirar.

### Criando o primeiro login

Os painéis exigem login, mas só dá para criar login... tendo acesso. Para
resolver esse paradoxo existe a página **`criar-acesso/`**, que não exige
sessão nenhuma.

Como ela é pública, a trava é outra — e é toda server-side
(`middleware/redeAutorizada.js`), porque uma página estática não consegue se
proteger sozinha: quem ignorar o HTML e chamar a rota via `curl` bate na mesma
verificação.

| Camada | Campo em `config/acesso.json` | Sem configurar |
|---|---|---|
| Allowlist de IP | `ips` | **Nega tudo** |
| Janela de horário | `horario` | Qualquer horário |
| País (geo-IP) | `paises` | Checagem desligada |

Essa config fica em **`backend/config/acesso.json`, versionado no Git** — nada
ali é segredo (saber qual IP está liberado não ajuda ninguém a entrar), e
config que muda com o tempo precisa ser reproduzível por `git pull`, não
editada à mão no servidor. Trocar o IP liberado é um commit:

```bash
# edite backend/config/acesso.json, commit, e no servidor:
git pull && pm2 restart nese-backend
```

Existem variáveis de ambiente equivalentes (`BOOTSTRAP_IPS` etc.) que têm
precedência sobre o JSON, mas só como escotilha de emergência — liberar um IP
às pressas sem esperar deploy. O estado normal é o arquivo versionado.

E o `ADMIN_TOKEN` continua exigido por cima disso: estar na rede certa não
basta, ter o token não basta — precisa dos dois.

`BOOTSTRAP_IPS` vazio fecha a rota em vez de abrir. Esquecer de configurar
falha para o lado seguro. Abra a página para descobrir qual IP o servidor está
vendo; ela mostra o endereço mesmo quando bloqueia, justamente para você saber
o que colocar no `.env`.

A checagem de país é a mais fraca das três — geo-IP erra com VPN, CGNAT de
operadora móvel e IP corporativo roteado por outro estado. Se o serviço externo
cair, a checagem é pulada (*fail-open*) de propósito: uma API de terceiro não
deve trancar você para fora do próprio sistema. Quem segura de verdade é a
lista de IPs.

Alternativa sem página, se preferir:

```bash
curl -X POST https://nese-be.ruexinternet.com/api/admin/contas \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: SEU_ADMIN_TOKEN' \
  -d '{"email":"voce@exemplo.com","nome":"Seu Nome","senha":"minimo10chars","nivel":"full"}'
```

Depois do primeiro login `full`, dá para gerenciar contas pela aba **Contas de
acesso** da moderação (criar novos logins ali também pede o `ADMIN_TOKEN`).

Rotas de gestão (exigem nível `full`, exceto onde indicado):

| Rota | O que faz |
|---|---|
| `POST /api/admin/contas` | Cria login — **exige `ADMIN_TOKEN`**, não sessão |
| `POST /api/admin/login` | E-mail + senha → token de sessão (rota pública) |
| `GET /api/admin/eu` | Quem sou eu / meu nível (`ver` também acessa) |
| `GET /api/admin/contas` | Lista os logins |
| `DELETE /api/admin/contas/:id` | Revoga um login |
| `POST /api/admin/trocar-senha` | Troca a própria senha (`ver` também) |

Não existe rota para trocar a senha de outra pessoa, de propósito. Se alguém
esquecer a senha, o caminho é criar um login novo com o `ADMIN_TOKEN` e excluir
o antigo — nenhuma sessão consegue sequestrar conta alheia.

Senhas são guardadas como `salt:hash` via **scrypt** (`utils/senha.js`), nunca
em texto puro.

---

## Log de auditoria

Toda edição e exclusão em contas e prestadores é registrada em
`log_auditoria_moderacao`, **independente de quem fez**:

- `origem: 'moderacao'` — feita no painel, identificada pelo login autenticado;
- `origem: 'usuario'` — feita pelo próprio dono, no app normal.

O registro guarda um diff por campo (`{ campo: { de, para } }`), só com o que
mudou de fato. Exclusão de prestador guarda um snapshot do registro; exclusão
de conta guarda apenas a data de criação — mesma disciplina de privacidade de
`auditoria_contas`, para não manter dado pessoal de conta apagada.

Visível na aba **Log de auditoria** da moderação e dentro de cada modal de
edição, como histórico daquela conta ou prestador.

---

## Deploy (EC2)

```bash
cd ~/Nese/backend
git pull
npm ci
pm2 restart nese-backend
pm2 logs nese-backend --lines 30
```

As migrações rodam no boot; conferir no log é o suficiente. Ao adicionar
variável nova no `.env.example`, lembre de colocá-la também no `.env` do
servidor **antes** do restart — várias rotas respondem 500 sem o segredo
correspondente, em vez de abrir sem proteção.

Stack em produção: Node 20, Nginx (TLS via Certbot, e serve `dashboard/`,
`moderacao/` e `criar-acesso/` como estáticos), PM2 (`nese-backend`).

`criar-acesso/` precisa de um `location` próprio no Nginx, igual aos outros
dois. Ela não é linkada de lugar nenhum e tem `<meta robots="noindex">` — o
acesso é digitando a URL.

---

## Variáveis de ambiente

Ver `backend/.env.example` — cada variável está comentada lá. As críticas:

| Variável | Sem ela |
|---|---|
| `JWT_SECRET` | Login de usuário do app não funciona |
| `ADMIN_SESSION_SECRET` | Painéis inteiros respondem 500 |
| `ADMIN_TOKEN` | Não dá para criar login novo |
| `GOOGLE_CLIENT_ID` | Google Sign-In falha |
| `CORS_ORIGIN` | Libera qualquer origem (avisa no console) |
| `BOOTSTRAP_IPS` | *(opcional — ver `config/acesso.json`)* |

`JWT_SECRET` e `ADMIN_SESSION_SECRET` devem ser **diferentes**: reaproveitar um
faria um token de usuário comum ser aceito como sessão de admin.

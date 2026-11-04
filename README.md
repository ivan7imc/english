# English Hub — plataforma de aulas de inglês

Site simples para professor publicar aulas (slides, textos, áudios e links) e alunos acessarem somente o conteúdo publicado, com marcação **visto / não visto** e painel de progresso.

- **Backend:** Node.js + Express
- **Banco em produção:** **Neon PostgreSQL** (driver `pg`)
- **Frontend:** HTML/CSS/JS puro, sem build
- **Hospedagem:** Render (Web Service)
- **Arquivos:** armazenados no próprio Neon como `BYTEA`, para não depender do disco efêmero do Render

> A prévia local pode rodar em **modo demonstração** com PGlite (PostgreSQL em WASM). Isso é apenas para testar sem credenciais. Em produção, configure `DATABASE_URL` do Neon e deixe `DEMO_MODE=false`.

## Funcionalidades

### Professor
- Login seguro com senha hash `scrypt` e sessão por token.
- Criar/editar/excluir aulas.
- Publicar/despublicar aulas (rascunhos ficam ocultos para alunos).
- Adicionar materiais por aula:
  - **Slides:** PDF, PPT, PPTX, ODP (PDF abre no navegador; demais para download).
  - **Texto:** conteúdo escrito.
  - **Áudio:** MP3, WAV, OGG, M4A, AAC, WEBM, FLAC com player.
  - **Link:** URL externa.
- Cadastrar/editar/desativar/excluir alunos e redefinir senhas.
- Painel de progresso por aluno/aula e exportação CSV.

### Aluno
- Login individual.
- Vê apenas aulas publicadas.
- Acessa materiais separados por aula.
- Marca aula como **vista** ou **não vista**.
- Filtra aulas por todas / não vistas / vistas.

## Rodar localmente em modo demonstração

```bash
npm install
npm run demo
```

Abra `http://localhost:3000`.

Contas de demonstração:

| Perfil | E-mail | Senha |
|---|---|---|
| Professor | `professor@demo.com` | `Professor123!` |
| Aluno | `aluno@demo.com` | `Aluno123!` |
| Aluno 2 | `bruno@demo.com` | `Aluno123!` |

O banco de demonstração fica em `data/demo-db` e não deve ser usado em produção.

## Rodar localmente com Neon real

1. Crie um projeto no Neon.
2. Copie a connection string em **Connect** (de preferência pooled).
3. Crie um arquivo `.env` a partir de `.env.example`:

```bash
cp .env.example .env
```

4. Preencha `DATABASE_URL` e defina `DEMO_MODE=false`.
5. Inicialize o banco e suba o servidor:

```bash
npm run db:init
npm start
```

Na primeira execução, crie o professor inicial pela tela de setup (protegida por `SETUP_KEY`) ou defina `TEACHER_EMAIL` / `TEACHER_PASSWORD` no `.env`.

## Deploy no Render + Neon

### 1. Criar o banco no Neon
1. Acesse o Neon e crie um projeto.
2. Abra **Connect** e copie a **connection string** (pooled).
3. Guarde: ela será a variável `DATABASE_URL` no Render.

### 2. Subir o código para um repositório Git
O Render implanta a partir de GitHub/GitLab. Envie esta pasta para um repositório, sem `.env` e sem `node_modules`.

### 3. Criar o Web Service no Render
Opção A — manual:
1. Render Dashboard → **New → Web Service**.
2. Conecte o repositório.
3. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm ci --omit=dev`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
4. Adicione as variáveis de ambiente:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | connection string do Neon |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `APP_NAME` | `English Hub` (ou o nome desejado) |
| `MAX_UPLOAD_MB` | `15` |
| `DEMO_MODE` | `false` |
| `SEED_DEMO` | `false` |
| `SETUP_KEY` | uma chave secreta para o primeiro acesso |

Opcional: em vez de `SETUP_KEY`, defina `TEACHER_NAME`, `TEACHER_EMAIL` e `TEACHER_PASSWORD` para criar o professor automaticamente na inicialização.

Opção B — Blueprint:
- O arquivo `render.yaml` já está pronto. Use **New → Blueprint** e informe `DATABASE_URL` e `SETUP_KEY` quando o Render pedir.

### 4. Primeiro acesso
1. Abra a URL do Render.
2. Se aparecer a tela de configuração, informe nome, e-mail, senha e a `SETUP_KEY`.
3. Entre como professor, crie as aulas e cadastre os alunos.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---:|---|
| `DATABASE_URL` | Sim (produção) | Connection string do Neon PostgreSQL. |
| `NODE_ENV` | Recomendado | `production` no Render. |
| `PORT` | Não | Render injeta automaticamente; local padrão `3000`. |
| `APP_NAME` | Não | Nome exibido no site. |
| `MAX_UPLOAD_MB` | Não | Limite por arquivo, padrão `15`, máximo `50`. |
| `SETUP_KEY` | Recomendado | Protege a criação do primeiro professor via web. |
| `TEACHER_NAME` / `TEACHER_EMAIL` / `TEACHER_PASSWORD` | Não | Cria o professor inicial automaticamente. |
| `DEMO_MODE` | Não | `true` apenas para demonstração local. |
| `SEED_DEMO` | Não | `true` cria contas e aulas de exemplo no modo demo. |
| `PG_POOL_MAX` | Não | Máximo de conexões do pool, padrão `5`. |

## Testes

```bash
npm test
```

Os testes usam um banco PostgreSQL em memória (PGlite) e cobrem autenticação, permissões, aulas, materiais, progresso e download de arquivos.

## Estrutura

```text
english-platform/
├── server.js           # API Express + regras de negócio
├── db.js               # Conexão Neon (pg) / demo (PGlite)
├── schema.sql          # Tabelas PostgreSQL
├── scripts/init-db.js  # Cria/verifica o esquema
├── public/             # Frontend estático
├── tests/api.test.js   # Testes de API
├── render.yaml         # Blueprint do Render
└── .env.example        # Modelo de configuração
```

## Observações importantes

- **Não use `DEMO_MODE=true` em produção.** Ele ignora o Neon e usa banco local.
- O Render tem filesystem efêmero; por isso os arquivos enviados ficam no Neon, não em `uploads/`.
- Para arquivos muito grandes ou muitos alunos, considere evoluir o armazenamento de mídia para um object storage (S3/R2) e guardar apenas metadados no Neon.
- As senhas nunca são armazenadas em texto puro.
- Links de mídia usam tickets temporários e exigem sessão válida.
- Faça backup do banco pelo Neon e mantenha a `DATABASE_URL` secreta.

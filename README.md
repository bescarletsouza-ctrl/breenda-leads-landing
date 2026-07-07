# Breenda — Landing page de captura de leads

Fluxo: **Landing Page → Supabase → Google Sheets**

```
Browser (index.html)
  → supabase-js (via CDN, sem npm)
  → INSERT na tabela "leads" (RLS: anon só pode INSERT)
       → Database Webhook do Supabase (evento INSERT)
            → Edge Function "sync-lead-to-sheets"
                 → Google Sheets API (values:append)
```

Sem login, sem dashboard, sem build step. Tudo estático + Supabase + uma Edge Function.

## Arquivos

- `index.html` — a página em si. Formulário (nome, telefone, email) + UTM capturado da URL.
- `supabase/migrations/0001_create_leads_table.sql` — cria a tabela `leads` e a policy de RLS.
- `supabase/functions/sync-lead-to-sheets/index.ts` — Edge Function que sincroniza com o Sheets.

## Passo a passo

### 1. Supabase — criar a tabela

1. Abra o Supabase Studio do seu projeto → **SQL Editor**.
2. Cole o conteúdo de `supabase/migrations/0001_create_leads_table.sql` e rode.
3. Confira em **Table Editor** que a tabela `leads` existe, com RLS habilitado e **apenas** a policy de insert para `anon`.

### 2. Supabase — pegar URL e chave anônima

1. Studio → **Settings → API**.
2. Copie **Project URL** e a chave **anon public**.
3. Abra `index.html` e substitua:
   ```js
   const SUPABASE_URL = "REPLACE_ME_SUPABASE_URL";
   const SUPABASE_ANON_KEY = "REPLACE_ME_SUPABASE_ANON_KEY";
   ```
   Esses valores são feitos para ficar públicos no client — não são segredos. A segurança vem da policy de RLS (só permite `insert`).

### 3. Google Cloud — criar a Service Account

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/), crie ou selecione um projeto (ex: `breenda-leads`).
2. **APIs & Services → Library** → busque "Google Sheets API" → **Enable**.
3. **IAM & Admin → Service Accounts → Create Service Account**.
   - Nome sugerido: `breenda-sheets-sync`.
   - Não precisa de nenhum papel (role) de projeto — o acesso vem de compartilhar a planilha diretamente com ela (princípio do menor privilégio).
4. Abra a service account criada → aba **Keys** → **Add Key → Create new key → JSON** → baixe o arquivo.
   - Esse arquivo fica só na sua máquina. Não cole o conteúdo dele em nenhum chat.
5. No JSON baixado, anote os campos `client_email` e `private_key` — vai precisar deles no próximo passo.
6. Abra a planilha do Google Sheets que vai receber os leads → **Compartilhar** → cole o `client_email` da service account → papel **Editor** → compartilhar (pode desmarcar "notificar").
7. Crie uma aba/linha de cabeçalho na planilha, por exemplo aba `Leads` com a primeira linha:
   `nome | telefone | email | utm_source | utm_campaign | utm_medium | utm_content | utm_term | created_at`
8. Anote o **Spreadsheet ID** (o trecho da URL entre `/d/` e `/edit`).

### 4. Deploy da Edge Function pelo Supabase Studio (sem CLI)

Não é necessário instalar o Supabase CLI. A função em
[`supabase/functions/sync-lead-to-sheets/index.ts`](supabase/functions/sync-lead-to-sheets/index.ts)
não usa nenhuma dependência externa (só `fetch`/`crypto` nativos do Deno), então
cola direto no editor do navegador.

1. Studio → **Edge Functions** → **Deploy a new function**.
2. Escolha a opção **"Via Editor"** (escrever o código no navegador), não um template pronto.
3. Nome da função: `sync-lead-to-sheets` (precisa bater com a URL usada no webhook, passo 5).
4. Apague o código de exemplo e cole todo o conteúdo do arquivo
   `supabase/functions/sync-lead-to-sheets/index.ts`.
5. Procure a opção **"Verify JWT" / "Enforce JWT Verification"** (na tela de criação ou
   depois em Settings da função) e **desative**. Sem isso, o Database Webhook do
   Supabase leva 401 ao chamar a função, porque ele não manda token de usuário
   autenticado — a própria função já valida o header `X-Webhook-Secret` internamente.
6. Clique em **Deploy**.
7. Copie a URL gerada, algo como:
   `https://<seu-project-ref>.supabase.co/functions/v1/sync-lead-to-sheets`
   — vai precisar dela no passo 5 (Database Webhook).

**Configurar os secrets** (nunca cole esses valores em um chat):

1. Em **Edge Functions**, abra a aba/seção **Secrets** (pode estar dentro da função
   ou em **Project Settings → Edge Functions → Secrets** — valem pro projeto todo).
2. Adicione um por um:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` — o `client_email` do JSON.
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` — o `private_key` do JSON, com as quebras de linha.
   - `GOOGLE_SHEETS_SPREADSHEET_ID` — o spreadsheet id do passo 3.
   - `GOOGLE_SHEETS_RANGE` — ex: `Leads!A:I`.
   - `WEBHOOK_SECRET` — invente uma string aleatória qualquer (ex: uma senha forte gerada por um gerenciador de senhas).

<details>
<summary>Alternativa com CLI (opcional, para quem prefere linha de comando)</summary>

Instale via [Scoop](https://scoop.sh/) (`scoop install supabase`) ou baixe o binário
em https://github.com/supabase/cli/releases. Depois:

```bash
supabase login
cd caminho/para/breenda_project
supabase link --project-ref <seu-project-ref>
supabase secrets set GOOGLE_SERVICE_ACCOUNT_EMAIL="<client_email do JSON>"
supabase secrets set GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="<private_key do JSON>"
supabase secrets set GOOGLE_SHEETS_SPREADSHEET_ID="<spreadsheet id>"
supabase secrets set GOOGLE_SHEETS_RANGE="Leads!A:I"
supabase secrets set WEBHOOK_SECRET="<gere uma string aleatória>"
supabase functions deploy sync-lead-to-sheets --no-verify-jwt
```

</details>

### 5. Configurar o Database Webhook

1. Studio → **Database → Webhooks → Create a new webhook**.
2. Nome: `leads-to-sheets`.
3. Tabela: `public.leads`.
4. Eventos: apenas **INSERT**.
5. Destino: a URL da função do passo 4 (ou o tipo "Supabase Edge Functions" se o Studio oferecer integração direta).
6. Em **HTTP Headers**, adicione: `X-Webhook-Secret: <mesmo valor do WEBHOOK_SECRET>`.
7. Salve.

**Teste:** insira uma linha de teste na tabela `leads` pelo Table Editor e confira se ela aparece na planilha em poucos segundos. Se não aparecer, veja os logs em **Edge Functions → Logs** no Studio.

### 6. Deploy da landing page na Vercel

> Este repositório já está configurado e conectado (`index.html` na raiz → projeto
> Vercel da landing; `diagnostico-base/index.html` → projeto Vercel `diagnóstico-base`,
> com **Root Directory** = `diagnostico-base` nas configurações desse projeto). Os
> passos abaixo ficam como referência caso precise recriar ou clonar o setup em
> outro projeto.

Sem Node/npm instalado, o caminho mais simples é via Git + importação no painel:

```bash
cd caminho/para/breenda_project
git init
git add .
git commit -m "Landing page de captura de leads"
```

1. Crie um repositório novo (vazio) no GitHub, ex: `breenda-leads-landing`.
2. `git remote add origin <url-do-repo>`
3. `git push -u origin main`
4. Acesse [vercel.com/new](https://vercel.com/new) → **Import** o repositório → Framework preset **Other** (site estático, sem build command, output = raiz) → **Deploy**.

Isso cria um projeto **novo** na Vercel, independente do projeto `pyero` já existente na conta.

**Alternativa mais simples (sem Git):** em [vercel.com/new](https://vercel.com/new) também é possível arrastar a pasta `breenda_project` direto para o navegador para um deploy avulso — mais rápido, mas sem deploy automático a cada alteração futura.

## Checklist de segurança

- Chave anônima do Supabase embutida no `index.html`: esperado, não é um vazamento.
- RLS com apenas a policy de `insert` para `anon`: ninguém consegue ler os leads pelo client público.
- JSON da Service Account do Google: nunca versionado, nunca colado em chat — só vive nos secrets da Edge Function (criptografados pelo Supabase) e no seu download local.
- A Edge Function confere o header `X-Webhook-Secret` porque é publicada sem verificação de JWT (o Database Webhook não é um usuário autenticado).
- Não é necessária nenhuma service role key ou senha de banco em nenhum ponto deste fluxo.

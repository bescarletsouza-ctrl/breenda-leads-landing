-- Tabela de leads capturados pela landing page.
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text not null,
  email text not null,
  utm_source text,
  utm_campaign text,
  utm_medium text,
  utm_content text,
  utm_term text,
  created_at timestamptz not null default now()
);

-- Habilita RLS: a partir daqui, qualquer acesso precisa de uma policy explícita.
alter table public.leads enable row level security;

-- Único acesso liberado para o público (chave anon): inserir um novo lead.
-- Não existe policy de select/update/delete para "anon" -> essas operações
-- ficam negadas por padrão. Não adicione policies de leitura/edição para
-- "anon"/"public" nesta tabela.
create policy "anon can insert leads"
  on public.leads
  for insert
  to anon
  with check (true);

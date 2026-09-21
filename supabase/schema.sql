-- =====================================================================
-- Bee Licitações — banco de dados (Supabase / PostgreSQL)
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em Run.
-- Pode rodar de novo com segurança: ele só cria o que ainda não existe.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. PERFIS (uma linha para cada pessoa que faz login)
-- ---------------------------------------------------------------------
create table if not exists public.perfis (
  id        uuid primary key references auth.users(id) on delete cascade,
  nome      text not null default '',
  email     text,
  whatsapp  text not null default '',
  papel     text not null default 'usuario' check (papel in ('admin','usuario')),
  ativo     boolean not null default true,
  cor       text not null default '#D9480F',
  criado    timestamptz not null default now()
);

-- Quem está logado e é administrador ativo?
create or replace function public.eh_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.perfis where id = auth.uid() and papel = 'admin' and ativo);
$$;

-- Quem está logado e está ativo?
create or replace function public.usuario_ativo() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.perfis where id = auth.uid() and ativo);
$$;

-- Quando alguém é criado no login, cria o perfil.
-- A PRIMEIRA pessoa criada vira administradora; as demais entram como usuário.
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cores text[] := array['#D9480F','#2B8A74','#3B5BDB','#9C36B5','#C2255C','#0C8599','#5C7CFA','#A8590B'];
  qtd int;
  p text;
begin
  select count(*) into qtd from public.perfis;
  p := case when not exists (select 1 from public.perfis where papel = 'admin') then 'admin' else 'usuario' end;
  insert into public.perfis (id, nome, email, papel, cor)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'nome',''), split_part(new.email,'@',1)),
          new.email, p, cores[1 + (qtd % array_length(cores,1))]);
  return new;
end $$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- Usuário comum só pode mudar o próprio nome e WhatsApp.
create or replace function public.perfis_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.eh_admin() then
    if new.id is distinct from old.id or new.papel is distinct from old.papel
       or new.ativo is distinct from old.ativo or new.email is distinct from old.email then
      raise exception 'Somente o administrador altera papel, e-mail e situação.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists perfis_antes_update on public.perfis;
create trigger perfis_antes_update before update on public.perfis
  for each row execute function public.perfis_guard();

-- ---------------------------------------------------------------------
-- 2. CATEGORIAS
-- ---------------------------------------------------------------------
create table if not exists public.categorias (
  id      uuid primary key default gen_random_uuid(),
  nome    text not null,
  criado  timestamptz not null default now()
);
create unique index if not exists categorias_nome_unico on public.categorias (lower(nome));

insert into public.categorias (nome) values
  ('Limpeza'),('Higiene'),('Descartáveis'),('Expediente'),('Informática'),
  ('Papel A4'),('Uniforme'),('Esportivo'),('Permanente'),('Outros')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. LICITAÇÕES
-- ---------------------------------------------------------------------
create table if not exists public.licitacoes (
  id               uuid primary key default gen_random_uuid(),
  orgao            text not null,
  modalidade       text not null default 'Pregão Eletrônico',
  numero           text not null default '',
  categoria_id     uuid references public.categorias(id) on delete set null,
  itens            integer not null default 0,
  responsavel_id   uuid references public.perfis(id) on delete set null,
  disputa          timestamp,                      -- horário de Brasília, sem fuso
  fase             text not null default 'elaboracao'
                   check (fase in ('elaboracao','formalizada','lances','julgamento','habilitacao','recurso','adjudicada','nao')),
  garantia         boolean not null default false,
  regional         boolean not null default false,
  catalogo         boolean not null default false,
  hab_apos         boolean not null default true,
  obs              text not null default '',
  disputa_anterior timestamp,
  remarcada_em     timestamptz,
  criado           timestamptz not null default now(),
  criado_por       uuid references public.perfis(id) on delete set null default auth.uid(),
  atualizado       timestamptz not null default now()
);
create index if not exists licitacoes_disputa_idx on public.licitacoes (disputa);
create index if not exists licitacoes_resp_idx on public.licitacoes (responsavel_id);

-- Regras de edição:
--  * administrador altera tudo;
--  * usuário altera só fase, data da disputa, marcações e observações;
--  * a remarcação é registrada sozinha quando a data muda.
create or replace function public.licitacoes_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.eh_admin() then
    if new.orgao is distinct from old.orgao or new.modalidade is distinct from old.modalidade
       or new.numero is distinct from old.numero or new.categoria_id is distinct from old.categoria_id
       or new.itens is distinct from old.itens or new.responsavel_id is distinct from old.responsavel_id
       or new.criado_por is distinct from old.criado_por then
      raise exception 'Somente o administrador altera órgão, número, modalidade, categoria, itens e responsável.'
        using errcode = '42501';
    end if;
  end if;
  if new.disputa is distinct from old.disputa and old.disputa is not null and new.disputa is not null then
    new.disputa_anterior := old.disputa;
    new.remarcada_em := now();
  else
    new.disputa_anterior := old.disputa_anterior;
    new.remarcada_em := old.remarcada_em;
  end if;
  new.atualizado := now();
  return new;
end $$;

drop trigger if exists licitacoes_antes_update on public.licitacoes;
create trigger licitacoes_antes_update before update on public.licitacoes
  for each row execute function public.licitacoes_guard();

-- ---------------------------------------------------------------------
-- 4. COMENTÁRIOS, HISTÓRICO, AVISOS, LEMBRETES
-- ---------------------------------------------------------------------
create table if not exists public.comentarios (
  id            uuid primary key default gen_random_uuid(),
  licitacao_id  uuid not null references public.licitacoes(id) on delete cascade,
  autor_id      uuid references public.perfis(id) on delete set null default auth.uid(),
  texto         text not null,
  criado        timestamptz not null default now()
);
create index if not exists comentarios_lic_idx on public.comentarios (licitacao_id, criado desc);

create table if not exists public.historico (
  id            uuid primary key default gen_random_uuid(),
  licitacao_id  uuid not null references public.licitacoes(id) on delete cascade,
  autor_id      uuid references public.perfis(id) on delete set null default auth.uid(),
  texto         text not null,
  criado        timestamptz not null default now()
);
create index if not exists historico_lic_idx on public.historico (licitacao_id, criado desc);
create index if not exists historico_criado_idx on public.historico (criado desc);

create table if not exists public.avisos (
  id            uuid primary key default gen_random_uuid(),
  para_id       uuid not null references public.perfis(id) on delete cascade,
  licitacao_id  uuid references public.licitacoes(id) on delete cascade,
  tipo          text not null,
  texto         text not null,
  lida          boolean not null default false,
  criado        timestamptz not null default now()
);
create index if not exists avisos_para_idx on public.avisos (para_id, criado desc);

-- Controle interno dos lembretes já enviados (só as funções do Netlify usam)
create table if not exists public.lembretes_enviados (
  licitacao_id  uuid not null references public.licitacoes(id) on delete cascade,
  tipo          text not null,
  disputa       timestamp not null,
  enviado       timestamptz not null default now(),
  primary key (licitacao_id, tipo, disputa)
);

-- ---------------------------------------------------------------------
-- 5. SEGURANÇA (RLS): quem pode ver e mexer em quê
-- ---------------------------------------------------------------------
alter table public.perfis             enable row level security;
alter table public.categorias         enable row level security;
alter table public.licitacoes         enable row level security;
alter table public.comentarios        enable row level security;
alter table public.historico          enable row level security;
alter table public.avisos             enable row level security;
alter table public.lembretes_enviados enable row level security;

-- limpa políticas antigas (permite rodar o arquivo de novo)
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public'
             and tablename in ('perfis','categorias','licitacoes','comentarios','historico','avisos','lembretes_enviados')
  loop execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename); end loop;
end $$;

-- perfis: todos os ativos veem a equipe; cada um edita o próprio; admin edita todos
create policy perfis_ver   on public.perfis for select to authenticated using (public.usuario_ativo());
create policy perfis_edit  on public.perfis for update to authenticated
  using (public.usuario_ativo() and (id = auth.uid() or public.eh_admin()))
  with check (id = auth.uid() or public.eh_admin());

-- categorias: todos veem; só admin muda
create policy cat_ver on public.categorias for select to authenticated using (public.usuario_ativo());
create policy cat_ins on public.categorias for insert to authenticated with check (public.eh_admin());
create policy cat_upd on public.categorias for update to authenticated using (public.eh_admin()) with check (public.eh_admin());
create policy cat_del on public.categorias for delete to authenticated using (public.eh_admin());

-- licitações: todos veem e atualizam (o gatilho limita o usuário); só admin cria e exclui
create policy lic_ver on public.licitacoes for select to authenticated using (public.usuario_ativo());
create policy lic_ins on public.licitacoes for insert to authenticated with check (public.eh_admin());
create policy lic_upd on public.licitacoes for update to authenticated using (public.usuario_ativo()) with check (public.usuario_ativo());
create policy lic_del on public.licitacoes for delete to authenticated using (public.eh_admin());

-- comentários e histórico
create policy com_ver on public.comentarios for select to authenticated using (public.usuario_ativo());
create policy com_ins on public.comentarios for insert to authenticated with check (public.usuario_ativo() and autor_id = auth.uid());
create policy com_del on public.comentarios for delete to authenticated using (public.eh_admin());
create policy his_ver on public.historico   for select to authenticated using (public.usuario_ativo());
create policy his_ins on public.historico   for insert to authenticated with check (public.usuario_ativo() and autor_id = auth.uid());

-- avisos: cada pessoa vê e marca como lidos só os seus
create policy avi_ver on public.avisos for select to authenticated using (para_id = auth.uid());
create policy avi_upd on public.avisos for update to authenticated using (para_id = auth.uid()) with check (para_id = auth.uid());

-- lembretes_enviados: sem política = ninguém pelo navegador (só as funções do Netlify)

-- permissões de tabela
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke insert, update, delete on public.perfis from authenticated;
grant update (nome, whatsapp, cor) on public.perfis to authenticated;
revoke update on public.avisos from authenticated;
grant update (lida) on public.avisos to authenticated;
revoke all on public.lembretes_enviados from authenticated;

-- ---------------------------------------------------------------------
-- 6. ATUALIZAÇÃO AO VIVO (o quadro muda na tela de todos ao mesmo tempo)
-- ---------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['licitacoes','categorias','perfis','avisos'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; when undefined_object then null; end;
  end loop;
end $$;

-- =====================================================================
-- Bee Licitações — ATUALIZAÇÃO 12: rotas de entrega
--
-- * município (código IBGE) e endereço de entrega em cada licitação;
-- * situação da entrega em cada pedido (a entregar, em rota, entregue)
--   e prazo de entrega;
-- * rotas salvas (paradas na ordem, km, tempo, situação);
-- * nova seção "Rotas de entrega" na visibilidade (Equipe).
--
-- Rode DEPOIS do 08-icms-origem-regra.sql.
-- Não apaga nada e pode ser rodado de novo com segurança.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. NOVA SEÇÃO NA VISIBILIDADE: "Rotas de entrega"
-- ---------------------------------------------------------------------
insert into public.permissoes_padrao (secao, nivel) values ('rotas','editar')
on conflict (secao) do nothing;

-- ---------------------------------------------------------------------
-- 2. MUNICÍPIO E ENDEREÇO DE ENTREGA NO CARTÃO
-- ---------------------------------------------------------------------
alter table public.licitacoes add column if not exists municipio_ibge   integer;
alter table public.licitacoes add column if not exists entrega_endereco text not null default '';
create index if not exists licitacoes_municipio_idx on public.licitacoes (municipio_ibge);

-- Só quem edita "Rotas de entrega" ou "Contratos e pedidos" altera esses campos.
create or replace function public.licitacoes_entrega_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.nivel('rotas') < 2 and public.nivel('contratos') < 2 then
    if new.municipio_ibge is distinct from old.municipio_ibge
       or new.entrega_endereco is distinct from old.entrega_endereco then
      raise exception 'Você não tem permissão para alterar o município ou o endereço de entrega.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists licitacoes_entrega_guard on public.licitacoes;
create trigger licitacoes_entrega_guard before update on public.licitacoes
  for each row execute function public.licitacoes_entrega_guard();

-- ---------------------------------------------------------------------
-- 3. ROTAS SALVAS
-- ---------------------------------------------------------------------
create table if not exists public.rotas (
  id           uuid primary key default gen_random_uuid(),
  nome         text not null default '',
  data         date not null default current_date,
  origem_ibge  integer not null default 3131307,          -- Ipatinga
  retorno      boolean not null default true,              -- volta ao ponto de partida
  criterio     text not null default 'km' check (criterio in ('km','tempo')),
  paradas      jsonb not null default '[]'::jsonb,         -- [{ibge, pedidos:[uuid]}] na ordem
  km           numeric,
  minutos      integer,
  estimada     boolean not null default false,             -- true = calculada em linha reta
  status       text not null default 'planejada' check (status in ('planejada','concluida')),
  obs          text not null default '',
  criado_por   uuid references public.perfis(id) on delete set null default auth.uid(),
  criado       timestamptz not null default now(),
  atualizado   timestamptz not null default now()
);
create index if not exists rotas_data_idx on public.rotas (data desc);

alter table public.rotas enable row level security;
drop policy if exists ro_ver on public.rotas;
drop policy if exists ro_ins on public.rotas;
drop policy if exists ro_upd on public.rotas;
drop policy if exists ro_del on public.rotas;
create policy ro_ver on public.rotas for select to authenticated using (public.nivel('rotas') >= 1);
create policy ro_ins on public.rotas for insert to authenticated
  with check (public.nivel('rotas') >= 2 and criado_por = auth.uid());
create policy ro_upd on public.rotas for update to authenticated
  using (public.nivel('rotas') >= 2) with check (public.nivel('rotas') >= 2);
create policy ro_del on public.rotas for delete to authenticated
  using (public.nivel('rotas') >= 2 and (criado_por = auth.uid() or public.eh_admin()));

revoke all on public.rotas from anon;
grant select, insert, update, delete on public.rotas to authenticated;
grant all on public.rotas to service_role;

-- ---------------------------------------------------------------------
-- 4. ENTREGA EM CADA PEDIDO (tabela empenhos)
--    entrega_status: 'pendente' (a entregar) | 'rota' (em rota) | 'entregue'
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'empenhos' and column_name = 'entrega_status') then
    -- Pedidos antigos (com mais de 30 dias) entram como já entregues, para o
    -- mapa não começar cheio de entregas que já foram feitas.
    alter table public.empenhos add column entrega_status text not null default 'entregue';
    update public.empenhos set entrega_status = 'pendente' where data >= current_date - 30;
    alter table public.empenhos alter column entrega_status set default 'pendente';
  end if;
end $$;
alter table public.empenhos drop constraint if exists empenhos_entrega_status_chk;
alter table public.empenhos add constraint empenhos_entrega_status_chk
  check (entrega_status in ('pendente','rota','entregue'));
alter table public.empenhos add column if not exists entrega_prazo date;
alter table public.empenhos add column if not exists entregue_em   date;
alter table public.empenhos add column if not exists rota_id       uuid references public.rotas(id) on delete set null;
create index if not exists empenhos_entrega_idx on public.empenhos (entrega_status);

-- Ao apagar uma rota, os pedidos que estavam "em rota" voltam para "a entregar".
create or replace function public.rotas_apagar_volta() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.empenhos set entrega_status = 'pendente', rota_id = null
   where rota_id = old.id and entrega_status = 'rota';
  return old;
end $$;
drop trigger if exists rotas_apagar_volta on public.rotas;
create trigger rotas_apagar_volta before delete on public.rotas
  for each row execute function public.rotas_apagar_volta();

-- Atualizar pedido: só os campos de entrega, por quem edita Rotas ou Contratos.
-- Valor, data, tipo, número e licitação continuam só com o administrador.
create or replace function public.empenhos_upd_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.eh_admin() then
    if new.valor is distinct from old.valor or new.data is distinct from old.data
       or new.tipo is distinct from old.tipo or new.numero is distinct from old.numero
       or new.licitacao_id is distinct from old.licitacao_id or new.criado_por is distinct from old.criado_por then
      raise exception 'Somente o administrador altera valor, data, tipo e número do pedido.' using errcode = '42501';
    end if;
  end if;
  if new.entrega_status = 'entregue' and new.entregue_em is null then new.entregue_em := current_date; end if;
  if new.entrega_status <> 'entregue' then new.entregue_em := null; end if;
  if new.entrega_status = 'pendente' then new.rota_id := null; end if;
  return new;
end $$;
drop trigger if exists empenhos_upd_guard on public.empenhos;
create trigger empenhos_upd_guard before update on public.empenhos
  for each row execute function public.empenhos_upd_guard();

drop policy if exists em_upd on public.empenhos;
create policy em_upd on public.empenhos for update to authenticated
  using (public.nivel('rotas') >= 2 or public.nivel('contratos') >= 2)
  with check (public.nivel('rotas') >= 2 or public.nivel('contratos') >= 2);

-- ---------------------------------------------------------------------
-- 5. TRAVA DE DUAS ETAPAS (MFA) NA TABELA NOVA
--    (só se a atualização 06 já foi rodada)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'mfa_ok') then
    execute 'drop policy if exists mfa_obrigatorio on public.rotas';
    execute 'create policy mfa_obrigatorio on public.rotas as restrictive for all to authenticated '
            'using (public.mfa_ok()) with check (public.mfa_ok())';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. ATUALIZAÇÃO AO VIVO
-- ---------------------------------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.rotas;
  exception when duplicate_object then null; when undefined_object then null; end;
end $$;

-- =====================================================================
-- Bee Licitações — ATUALIZAÇÃO 09: ICMS de origem na regra fiscal.
--
-- Rode DEPOIS do 07-produtos-fornecedores.sql.
-- Não apaga nada e pode ser rodado de novo com segurança.
-- As regras já cadastradas ficam com 12%.
-- =====================================================================

alter table public.regras_fiscais
  add column if not exists aliquota_origem numeric not null default 0.12;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'regras_fiscais_aliquota_origem_chk') then
    alter table public.regras_fiscais add constraint regras_fiscais_aliquota_origem_chk
      check (aliquota_origem >= 0 and aliquota_origem < 0.4);
  end if;
end $$;

-- Mudou imposto, MVA, alíquota interna ou ICMS de origem? A validação cai.
create or replace function public.regras_fiscais_validacao() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.icms_tipo is distinct from old.icms_tipo
     or new.mva_original is distinct from old.mva_original
     or new.aliquota_interna is distinct from old.aliquota_interna
     or new.aliquota_origem is distinct from old.aliquota_origem
     or new.ncm is distinct from old.ncm or new.cest is distinct from old.cest)
     and new.validado and old.validado and new.validado_em is not distinct from old.validado_em then
    new.validado := false;
  end if;
  if new.validado and (tg_op = 'INSERT' or not old.validado) then
    if auth.uid() is not null and not public.eh_admin() then
      raise exception 'Só o administrador marca a regra fiscal como validada pelo contador.' using errcode = '42501';
    end if;
    new.validado_por := auth.uid(); new.validado_em := now();
  elsif not new.validado then
    new.validado_por := null; new.validado_em := null;
  end if;
  if new.icms_tipo in ('st','st_mono') and new.mva_original is null and new.validado then
    raise exception 'Regra com ICMS-ST precisa da MVA antes de ser validada.' using errcode = '23514';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';

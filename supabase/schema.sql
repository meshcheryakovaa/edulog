-- EduLOG: схема для многопользовательского режима (Supabase / PostgreSQL).
-- Выполните целиком один раз в Supabase → SQL Editor. Скрипт можно запускать
-- повторно: существующие данные не удаляются.
--
-- Роли пользователей (profiles.role):
--   pending  — зарегистрировался, ждёт одобрения администратора (данных не видит);
--   viewer   — просмотр опубликованных плана, расписания и отметок зачётов;
--   editor   — плюс публикация файлов плана/расписания и отметки зачётов;
--   admin    — плюс управление пользователями и журнал действий;
--   blocked  — доступ закрыт.
-- Первый зарегистрированный пользователь автоматически становится администратором.

-- ---------- Профили ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'pending'
              check (role in ('pending','viewer','editor','admin','blocked')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Роль текущего пользователя. security definer — чтобы политики RLS
-- могли читать profiles, не упираясь в собственные же политики.
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'anon')
$$;

create or replace function public.can_read()  returns boolean language sql stable as
$$ select public.my_role() in ('viewer','editor','admin') $$;
create or replace function public.can_edit()  returns boolean language sql stable as
$$ select public.my_role() in ('editor','admin') $$;
create or replace function public.is_admin()  returns boolean language sql stable as
$$ select public.my_role() = 'admin' $$;

-- Профиль создаётся при регистрации. Первый пользователь — администратор.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('edulog_first_admin'));
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(new.raw_user_meta_data->>'full_name', ''), 200),
    case when exists (select 1 from public.profiles where role = 'admin') then 'pending' else 'admin' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Защита профиля: роль и email меняет только администратор,
-- последнего администратора нельзя понизить или удалить из приложения
-- (из панели Supabase и SQL Editor — можно).
create or replace function public.guard_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.created_at := old.created_at;
    new.updated_at := now();
    if auth.uid() is not null and not public.is_admin() then
      -- обычный пользователь может поменять только своё имя
      new.role := old.role;
      new.email := old.email;
    end if;
    if auth.uid() is not null and old.role = 'admin' and new.role <> 'admin'
       and not exists (select 1 from public.profiles where role = 'admin' and id <> old.id) then
      raise exception 'Нельзя снять роль с последнего администратора';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if auth.uid() is not null and old.role = 'admin'
       and not exists (select 1 from public.profiles where role = 'admin' and id <> old.id) then
      raise exception 'Нельзя удалить последнего администратора';
    end if;
    return old;
  end if;
  return null;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update or delete on public.profiles
  for each row execute function public.guard_profile();

alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
-- Удалять профили через API нельзя: доступ закрывается ролью blocked,
-- а сам аккаунт при необходимости удаляется в Supabase → Authentication → Users.

-- ---------- Опубликованные файлы: план (.txt) и расписание (.json) ----------
create table if not exists public.datasets (
  kind        text primary key check (kind in ('plan','sched')),
  name        text not null,
  content     text not null,
  size        integer generated always as (octet_length(content)) stored,
  updated_by  uuid references auth.users(id) on delete set null default auth.uid(),
  author      text not null default '',
  updated_at  timestamptz not null default now()
);
alter table public.datasets add column if not exists author text not null default '';

create or replace function public.touch_dataset()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.author := coalesce((select coalesce(nullif(full_name, ''), email) from public.profiles where id = auth.uid()), '');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists datasets_touch on public.datasets;
create trigger datasets_touch before insert or update on public.datasets
  for each row execute function public.touch_dataset();

alter table public.datasets enable row level security;
drop policy if exists datasets_select on public.datasets;
create policy datasets_select on public.datasets for select to authenticated using (public.can_read());
drop policy if exists datasets_insert on public.datasets;
create policy datasets_insert on public.datasets for insert to authenticated with check (public.can_edit());
drop policy if exists datasets_update on public.datasets;
create policy datasets_update on public.datasets for update to authenticated
  using (public.can_edit()) with check (public.can_edit());
drop policy if exists datasets_delete on public.datasets;
create policy datasets_delete on public.datasets for delete to authenticated using (public.can_edit());

-- ---------- Отметки зачётных дисциплин ----------
create table if not exists public.zachety (
  grp         text not null,
  code        text not null,
  updated_by  uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (grp, code)
);

alter table public.zachety enable row level security;
drop policy if exists zachety_select on public.zachety;
create policy zachety_select on public.zachety for select to authenticated using (public.can_read());
drop policy if exists zachety_insert on public.zachety;
create policy zachety_insert on public.zachety for insert to authenticated with check (public.can_edit());
drop policy if exists zachety_update on public.zachety;
create policy zachety_update on public.zachety for update to authenticated
  using (public.can_edit()) with check (public.can_edit());
drop policy if exists zachety_delete on public.zachety;
create policy zachety_delete on public.zachety for delete to authenticated using (public.can_edit());

-- ---------- Журнал действий (видит только администратор) ----------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  email       text,
  action      text not null,
  details     jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_at on public.audit_log (at desc);

alter table public.audit_log enable row level security;
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());
-- Записи добавляются только триггерами ниже (security definer), напрямую — нельзя.

create or replace function public.audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  act text; det jsonb;
begin
  if tg_table_name = 'datasets' then
    if tg_op = 'DELETE' then act := 'dataset.delete'; det := jsonb_build_object('kind', old.kind, 'name', old.name);
    else act := 'dataset.publish'; det := jsonb_build_object('kind', new.kind, 'name', new.name, 'size', octet_length(new.content));
    end if;
  elsif tg_table_name = 'zachety' then
    if tg_op = 'DELETE' then act := 'zachet.off'; det := jsonb_build_object('group', old.grp, 'code', old.code);
    else act := 'zachet.on'; det := jsonb_build_object('group', new.grp, 'code', new.code);
    end if;
  elsif tg_table_name = 'profiles' then
    if tg_op = 'DELETE' then act := 'user.delete'; det := jsonb_build_object('email', old.email);
    elsif tg_op = 'INSERT' then act := 'user.register'; det := jsonb_build_object('email', new.email, 'role', new.role);
    elsif new.role is distinct from old.role then
      act := 'user.role'; det := jsonb_build_object('email', new.email, 'from', old.role, 'to', new.role);
    else
      return null;
    end if;
  end if;
  insert into public.audit_log (user_id, email, action, details)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), act, det);
  return null;
end $$;

drop trigger if exists datasets_audit on public.datasets;
create trigger datasets_audit after insert or update or delete on public.datasets
  for each row execute function public.audit();
drop trigger if exists zachety_audit on public.zachety;
create trigger zachety_audit after insert or delete on public.zachety
  for each row execute function public.audit();
drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function public.audit();

-- ---------- Права для API ----------
grant usage on schema public to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.datasets to authenticated;
grant select, insert, update, delete on public.zachety to authenticated;
grant select on public.audit_log to authenticated;
revoke all on public.profiles, public.datasets, public.zachety, public.audit_log from anon;

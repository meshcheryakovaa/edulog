-- EduLOG: схема для многопользовательского режима (Supabase / PostgreSQL).
-- Выполните целиком один раз в Supabase → SQL Editor. Скрипт можно запускать
-- повторно: существующие данные не удаляются.
--
-- Роли пользователей (profiles.role):
--   pending  — зарегистрировался, ждёт одобрения администратора (данных не видит);
--   viewer   — просмотр опубликованных плана, расписания, отметок зачётов и словарей;
--   editor   — плюс публикация файлов плана/расписания, отметки зачётов и правка словарей;
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

-- ---------- Расписание по неделям ----------
-- Файл расписания содержит одну или несколько целых недель. Загрузка заменяет в базе
-- только эти недели (sched_weeks), остальные остаются. Каждая загрузка записывается
-- в sched_uploads вместе со сводкой «что изменилось» (summary), её показывает приложение.
-- Ключ недели wkey — дата понедельника (ГГГГ-ММ-ДД) или «n<номер>», если дат нет.
create table if not exists public.sched_weeks (
  wkey        text primary key,
  week        integer,
  date_start  text not null default '',
  date_end    text not null default '',
  lessons     integer not null default 0,
  content     text not null,
  upload_id   bigint,
  updated_at  timestamptz not null default now()
);
create table if not exists public.sched_uploads (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid default auth.uid(),
  author      text not null default '',
  file        text not null default '',
  summary     jsonb not null default '{}'::jsonb
);
create index if not exists sched_uploads_at on public.sched_uploads (id desc);

alter table public.sched_weeks enable row level security;
alter table public.sched_uploads enable row level security;
drop policy if exists sched_weeks_select on public.sched_weeks;
create policy sched_weeks_select on public.sched_weeks for select to authenticated using (public.can_read());
drop policy if exists sched_weeks_insert on public.sched_weeks;
create policy sched_weeks_insert on public.sched_weeks for insert to authenticated with check (public.can_edit());
drop policy if exists sched_weeks_update on public.sched_weeks;
create policy sched_weeks_update on public.sched_weeks for update to authenticated
  using (public.can_edit()) with check (public.can_edit());
drop policy if exists sched_weeks_delete on public.sched_weeks;
create policy sched_weeks_delete on public.sched_weeks for delete to authenticated using (public.can_edit());
drop policy if exists sched_uploads_select on public.sched_uploads;
create policy sched_uploads_select on public.sched_uploads for select to authenticated using (public.can_read());
drop policy if exists sched_uploads_insert on public.sched_uploads;
create policy sched_uploads_insert on public.sched_uploads for insert to authenticated with check (public.can_edit());
-- Журнал загрузок не правится и не удаляется через API.

-- Одна загрузка целиком в одной транзакции: запись в журнал, удаление и замена недель.
create or replace function public.sched_apply(p_file text, p_put jsonb, p_del text[], p_summary jsonb)
returns bigint language plpgsql security invoker set search_path = public as $$
declare
  up_id bigint; w jsonb;
begin
  if not public.can_edit() then
    raise exception 'permission denied: недостаточно прав для публикации расписания';
  end if;
  insert into public.sched_uploads (user_id, author, file, summary)
  values (auth.uid(),
          coalesce((select coalesce(nullif(full_name, ''), email) from public.profiles where id = auth.uid()), ''),
          coalesce(p_file, ''), coalesce(p_summary, '{}'::jsonb))
  returning id into up_id;
  if p_del is not null and array_length(p_del, 1) > 0 then
    delete from public.sched_weeks where wkey = any(p_del);
  end if;
  for w in select * from jsonb_array_elements(coalesce(p_put, '[]'::jsonb)) loop
    insert into public.sched_weeks (wkey, week, date_start, date_end, lessons, content, upload_id, updated_at)
    values (w->>'wkey', (w->>'week')::integer, coalesce(w->>'date_start', ''), coalesce(w->>'date_end', ''),
            coalesce((w->>'lessons')::integer, 0), w->>'content', up_id, now())
    on conflict (wkey) do update set
      week = excluded.week, date_start = excluded.date_start, date_end = excluded.date_end,
      lessons = excluded.lessons, content = excluded.content, upload_id = excluded.upload_id, updated_at = now();
  end loop;
  return up_id;
end $$;
revoke all on function public.sched_apply(text, jsonb, text[], jsonb) from public, anon;
grant execute on function public.sched_apply(text, jsonb, text[], jsonb) to authenticated;

-- ---------- Отметки «просмотрено» ----------
-- Каждый пользователь (Просмотр, Редактор, Администратор) отмечает изменения расписания,
-- которые он уже посмотрел. Отметки личные: другие их не видят.
-- ckey — неделя|группа|день|пара|подгруппа внутри загрузки upload_id.
create table if not exists public.sched_seen (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  upload_id   bigint not null references public.sched_uploads(id) on delete cascade,
  ckey        text not null check (length(ckey) <= 1000),
  at          timestamptz not null default now(),
  primary key (user_id, upload_id, ckey)
);
alter table public.sched_seen enable row level security;
drop policy if exists sched_seen_select on public.sched_seen;
create policy sched_seen_select on public.sched_seen for select to authenticated
  using (user_id = auth.uid() and public.can_read());
drop policy if exists sched_seen_insert on public.sched_seen;
create policy sched_seen_insert on public.sched_seen for insert to authenticated
  with check (user_id = auth.uid() and public.can_read());
drop policy if exists sched_seen_delete on public.sched_seen;
create policy sched_seen_delete on public.sched_seen for delete to authenticated
  using (user_id = auth.uid());

-- ---------- Служебное состояние ----------
-- key = 'zpos': где стоял каждый зачёт при последней публикации (группа|код|подгруппа → неделя, день, пара).
-- Редактор после публикации сравнивает с ним новое положение; сдвиги записываются в sched_uploads
-- отдельной записью (summary.kind = 'zachet', summary.z — переносы).
create table if not exists public.app_state (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_by  uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at  timestamptz not null default now()
);
alter table public.app_state enable row level security;
drop policy if exists app_state_select on public.app_state;
create policy app_state_select on public.app_state for select to authenticated using (public.can_edit());
drop policy if exists app_state_insert on public.app_state;
create policy app_state_insert on public.app_state for insert to authenticated with check (public.can_edit());
drop policy if exists app_state_update on public.app_state;
create policy app_state_update on public.app_state for update to authenticated
  using (public.can_edit()) with check (public.can_edit());

-- ---------- Словари ----------
-- dict_names — короткие названия для отображения на экране. Истинное название — ключ (key):
--   disc    — дисциплина без «1-»/«2-» и «(1 подгруппа)», как в расписании;
--   teacher — ключ преподавателя (фамилия и первая буква инициалов, нижний регистр);
--   group, room — название группы / аудитории как в файлах.
-- props — список свойств строк недельного плана; row_props — какие свойства стоят у строки
--   (группа + название строки плана). Удаление свойства снимает его со всех строк.
create table if not exists public.dict_names (
  kind        text not null check (kind in ('disc','teacher','group','room')),
  key         text not null,
  short       text not null check (length(short) between 1 and 200),
  updated_by  uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (kind, key)
);
create table if not exists public.props (
  id          text primary key,
  name        text not null check (length(name) between 1 and 200),
  short       text not null default '' check (length(short) <= 40),
  color       text not null default '#1c6a85' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort        integer not null default 0,
  updated_by  uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.row_props (
  grp         text not null,
  disc        text not null,
  prop_id     text not null references public.props(id) on delete cascade,
  updated_by  uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (grp, disc, prop_id)
);
create index if not exists row_props_prop on public.row_props (prop_id);

create or replace function public.touch_row()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists dict_names_touch on public.dict_names;
create trigger dict_names_touch before insert or update on public.dict_names
  for each row execute function public.touch_row();
drop trigger if exists props_touch on public.props;
create trigger props_touch before insert or update on public.props
  for each row execute function public.touch_row();
drop trigger if exists row_props_touch on public.row_props;
create trigger row_props_touch before insert or update on public.row_props
  for each row execute function public.touch_row();

alter table public.dict_names enable row level security;
alter table public.props enable row level security;
alter table public.row_props enable row level security;
do $$
declare t text;
begin
  foreach t in array array['dict_names','props','row_props'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.can_read())', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.can_edit())', t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.can_edit()) with check (public.can_edit())', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.can_edit())', t);
  end loop;
end $$;

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
  elsif tg_table_name = 'sched_uploads' then
    act := 'sched.upload';
    det := jsonb_build_object('file', new.file, 'kind', coalesce(new.summary->>'kind', ''),
      'z', jsonb_array_length(coalesce(new.summary->'z', '[]'::jsonb)), 'weeks',
      coalesce((select jsonb_agg(jsonb_build_object('k', x->>'k', 'week', x->'week', 'st', x->>'st'))
                from jsonb_array_elements(coalesce(new.summary->'weeks', '[]'::jsonb)) x), '[]'::jsonb));
  elsif tg_table_name = 'zachety' then
    if tg_op = 'DELETE' then act := 'zachet.off'; det := jsonb_build_object('group', old.grp, 'code', old.code);
    else act := 'zachet.on'; det := jsonb_build_object('group', new.grp, 'code', new.code);
    end if;
  elsif tg_table_name = 'dict_names' then
    act := 'dict.name';
    if tg_op = 'DELETE' then det := jsonb_build_object('kind', old.kind, 'key', old.key, 'short', null);
    elsif tg_op = 'UPDATE' and new.short is not distinct from old.short then return null;
    else det := jsonb_build_object('kind', new.kind, 'key', new.key, 'short', new.short);
    end if;
  elsif tg_table_name = 'props' then
    if tg_op = 'DELETE' then act := 'prop.delete'; det := jsonb_build_object('name', old.name);
    elsif tg_op = 'INSERT' then act := 'prop.add'; det := jsonb_build_object('name', new.name);
    elsif new.name is distinct from old.name or new.short is distinct from old.short or new.color is distinct from old.color then
      act := 'prop.edit'; det := jsonb_build_object('from', old.name, 'name', new.name);
    else
      return null;  -- только порядок в списке
    end if;
  elsif tg_table_name = 'row_props' then
    if tg_op = 'DELETE' then
      -- свойство удалено целиком: отметки снимаются каскадом, отдельно их не пишем
      if not exists (select 1 from public.props where id = old.prop_id) then return null; end if;
      act := 'prop.off';
      det := jsonb_build_object('group', old.grp, 'disc', old.disc, 'prop', (select name from public.props where id = old.prop_id));
    elsif tg_op = 'INSERT' then
      act := 'prop.on';
      det := jsonb_build_object('group', new.grp, 'disc', new.disc, 'prop', (select name from public.props where id = new.prop_id));
    else
      return null;
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
drop trigger if exists sched_uploads_audit on public.sched_uploads;
create trigger sched_uploads_audit after insert on public.sched_uploads
  for each row execute function public.audit();
drop trigger if exists zachety_audit on public.zachety;
create trigger zachety_audit after insert or delete on public.zachety
  for each row execute function public.audit();
drop trigger if exists dict_names_audit on public.dict_names;
create trigger dict_names_audit after insert or update or delete on public.dict_names
  for each row execute function public.audit();
drop trigger if exists props_audit on public.props;
create trigger props_audit after insert or update or delete on public.props
  for each row execute function public.audit();
drop trigger if exists row_props_audit on public.row_props;
create trigger row_props_audit after insert or update or delete on public.row_props
  for each row execute function public.audit();
drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function public.audit();

-- ---------- Права для API ----------
-- ---------- Личные настройки ----------
-- Настройки, которые каждый пользователь задаёт для себя (порядок и скрытые столбцы
-- сводной таблицы и т. п.). Другие пользователи их не видят и не меняют.
-- key = 'cols': {group|teacher|room: {o: [порядок столбцов], h: [скрытые]}}.
create table if not exists public.user_prefs (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key         text not null check (length(key) <= 100),
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_prefs enable row level security;
drop policy if exists user_prefs_select on public.user_prefs;
create policy user_prefs_select on public.user_prefs for select to authenticated
  using (user_id = auth.uid() and public.can_read());
drop policy if exists user_prefs_insert on public.user_prefs;
create policy user_prefs_insert on public.user_prefs for insert to authenticated
  with check (user_id = auth.uid() and public.can_read());
drop policy if exists user_prefs_update on public.user_prefs;
create policy user_prefs_update on public.user_prefs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_read());
drop policy if exists user_prefs_delete on public.user_prefs;
create policy user_prefs_delete on public.user_prefs for delete to authenticated
  using (user_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.datasets to authenticated;
grant select, insert, update, delete on public.zachety to authenticated;
grant select, insert, update, delete on public.sched_weeks to authenticated;
grant select, insert on public.sched_uploads to authenticated;
grant select, insert, delete on public.sched_seen to authenticated;
grant select, insert, update, delete on public.user_prefs to authenticated;
grant select, insert, update on public.app_state to authenticated;
grant select, insert, update, delete on public.dict_names, public.props, public.row_props to authenticated;
grant select on public.audit_log to authenticated;
revoke all on public.profiles, public.datasets, public.zachety, public.audit_log, public.sched_weeks, public.sched_uploads, public.sched_seen, public.app_state, public.user_prefs,
  public.dict_names, public.props, public.row_props from anon;

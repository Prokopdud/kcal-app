-- =============================================================================
-- kcal-app — schéma projektu kcal-app (už aplikované)
-- =============================================================================
-- Zdroj pravdy pro databázi na https://fsbuccsnbwxjxzshfndu.supabase.co.
-- Na existující projekt to nespouštěj znovu. Další změna patří do nového
-- souboru v supabase/migrations/, ne do úpravy tabulek, které už běží.
--
-- Cíl: jeden nový projekt jen pro kalorickou appku. Klient dostane jen
-- veřejný (anon/publishable) klíč. service_role do prohlížeče nepatří.
--
-- Hlavní rozhodnutí:
-- * Cíle makra (kcal, B, S, T, volitelně vláknina) si uživatel nastaví ručně
--   v Nastavení. Žádná kalkulačka TDEE. Historie se drží přes effective_from.
-- * Sdílený katalog (owner_id IS NULL) čtou všichni přihlášení, měnit ho
--   může jen service role / SQL editor. Naskenovaný OFF výrobek se uloží
--   jako vlastní potravina uživatele (žádný zápis do sdíleného katalogu
--   z klienta — bezpečnější, až bude víc účtů).
-- * Deník ukládá snímek živin v okamžiku zápisu, aby změna potraviny nebo
--   cíle nepřepsala historii.
-- * Zásoby se odečítají triggerem při zápisu do deníku (a vrací se při
--   smazání nebo zmenšení gramů).
-- * Datum jedlého dne, vah a cílů je typ date (kalendářní den, typicky
--   Europe/Prague z klienta). Časové značky jsou timestamptz.
-- * Identifikátory: lowercase snake_case, bigint generated always as identity,
--   text místo varchar, numeric místo float, auth.uid() v RLS vždy jako
--   (select auth.uid()).
-- =============================================================================

begin;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;


-- -----------------------------------------------------------------------------
-- Pomocné funkce (private)
-- -----------------------------------------------------------------------------

-- unaccent je ve skutečnosti STABLE. IMMUTABLE obal je běžný kompromis,
-- aby šel použít v generovaném sloupci a v indexu. Kdyby se měnil slovník
-- unaccent, je potřeba index přestavět.
create or replace function private.immutable_unaccent(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select extensions.unaccent(input);
$$;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.prague_today()
returns date
language sql
stable
parallel safe
set search_path = ''
as $$
  select (timezone('Europe/Prague', now()))::date;
$$;


-- -----------------------------------------------------------------------------
-- 1) profiles — účet v appce (1:1 k auth.users)
-- -----------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  timezone text not null default 'Europe/Prague',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_timezone_not_blank check (length(trim(timezone)) > 0)
);

comment on table public.profiles is
  'Profil přihlášeného uživatele. Autorizace se nikdy nebere z raw_user_meta_data.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();


-- -----------------------------------------------------------------------------
-- 2) user_goals — ručně zadané cíle s platností od data
-- -----------------------------------------------------------------------------
-- Platí řádek s největším effective_from <= daný den. Když uživatel změní
-- cíle a stávající řádek má effective_from v minulosti, appka vloží nový
-- řádek s dnešním datem. Úprava dnešního řádku přepíše jen dnešek a budoucno.
-- Vláknina je volitelná (NULL = cíl se nesleduje).

create table public.user_goals (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  effective_from date not null,
  kcal numeric not null,
  protein_g numeric not null,
  carbs_g numeric not null,
  fat_g numeric not null,
  fiber_g numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_goals_kcal_check check (kcal > 0 and kcal <= 20000),
  constraint user_goals_protein_check check (protein_g >= 0 and protein_g <= 1000),
  constraint user_goals_carbs_check check (carbs_g >= 0 and carbs_g <= 2000),
  constraint user_goals_fat_check check (fat_g >= 0 and fat_g <= 1000),
  constraint user_goals_fiber_check check (fiber_g is null or (fiber_g >= 0 and fiber_g <= 500)),
  constraint user_goals_user_from_unique unique (user_id, effective_from)
);

comment on table public.user_goals is
  'Ruční cíle makra. Historie deníku se evokuje cílem platným v daný den (effective_from).';

create index user_goals_user_from_idx
  on public.user_goals (user_id, effective_from desc);

create trigger user_goals_set_updated_at
  before update on public.user_goals
  for each row execute function private.set_updated_at();

create or replace view public.current_user_goals
  with (security_invoker = true)
as
select distinct on (user_id)
  id, user_id, effective_from, kcal, protein_g, carbs_g, fat_g, fiber_g,
  created_at, updated_at
from public.user_goals
where effective_from <= (timezone('Europe/Prague', now()))::date
order by user_id, effective_from desc;

comment on view public.current_user_goals is
  'Cíle platné dnes (Europe/Prague). security_invoker, takže platí RLS tabulky user_goals.';

create or replace function public.goals_on(p_date date)
returns setof public.user_goals
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from public.user_goals
  where user_id = (select auth.uid())
    and effective_from <= p_date
  order by effective_from desc
  limit 1;
$$;

comment on function public.goals_on(date) is
  'Cíle přihlášeného uživatele platné v zadaný kalendářní den.';


-- -----------------------------------------------------------------------------
-- 3) foods — sdílený katalog + vlastní potraviny
-- -----------------------------------------------------------------------------
-- owner_id IS NULL  = sdílená položka (builtin / ručně kurátorovaná / masový OFF import)
-- owner_id = uid    = vlastní potravina nebo osobní kopie z Open Food Facts
-- Živiny jsou vždy na 100 g. Mikronutrienty jako JSONB s kanonickými klíči
-- (stejné jako v data.js): vit_a_ug, vit_c_mg, vit_d_ug, vit_e_mg, vit_k_ug,
-- b1_mg, b2_mg, b6_mg, folate_ug, b12_ug, ca_mg, fe_mg, mg_mg, zn_mg, k_mg,
-- na_mg, se_ug, iodine_ug, choline_mg.
-- name_search = lower + unaccent (mléko → mleko) pro pg_trgm.

create table public.foods (
  id bigint generated always as identity primary key,
  owner_id uuid references public.profiles (user_id) on delete cascade,
  source text not null,
  legacy_id text,
  barcode text,
  name text not null,
  brand text,
  name_search text generated always as (
    private.immutable_unaccent(
      lower(name || ' ' || coalesce(brand, ''))
    )
  ) stored,
  kcal numeric not null,
  protein numeric,
  carbs numeric,
  fat numeric,
  fiber numeric,
  micros jsonb not null default '{}'::jsonb,
  package_g numeric,
  piece_g numeric,
  default_serving_g numeric not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint foods_source_check check (source in ('builtin', 'off', 'manual')),
  constraint foods_name_not_blank check (length(trim(name)) > 0),
  constraint foods_kcal_check check (kcal >= 0 and kcal <= 2000),
  constraint foods_protein_check check (protein is null or (protein >= 0 and protein <= 100)),
  constraint foods_carbs_check check (carbs is null or (carbs >= 0 and carbs <= 100)),
  constraint foods_fat_check check (fat is null or (fat >= 0 and fat <= 100)),
  constraint foods_fiber_check check (fiber is null or (fiber >= 0 and fiber <= 100)),
  constraint foods_package_check check (package_g is null or (package_g > 0 and package_g <= 20000)),
  constraint foods_piece_check check (piece_g is null or (piece_g > 0 and piece_g <= 5000)),
  constraint foods_serving_check check (default_serving_g > 0 and default_serving_g <= 5000),
  constraint foods_barcode_digits check (barcode is null or barcode ~ '^[0-9]{6,14}$'),
  constraint foods_shared_source_check check (
    owner_id is not null or source in ('builtin', 'off', 'manual')
  )
);

comment on table public.foods is
  'Katalog potravin. Sdílené řádky mají owner_id NULL; vlastní potraviny patří uživateli.';
comment on column public.foods.micros is
  'Mikronutrienty na 100 g, klíče viz komentář tabulky. Prázdný objekt, pokud chybí.';
comment on column public.foods.name_search is
  'Generovaný sloupec: lower(unaccent(name + brand)) pro hledání bez diakritiky.';
comment on column public.foods.legacy_id is
  'Původní id z localStorage / data.js (f1, off:859…, u…). Slouží jen k importu.';

create trigger foods_set_updated_at
  before update on public.foods
  for each row execute function private.set_updated_at();

create index foods_owner_id_idx on public.foods (owner_id);
create index foods_source_idx on public.foods (source);

create unique index foods_shared_barcode_key
  on public.foods (barcode)
  where owner_id is null and barcode is not null;

create unique index foods_user_barcode_key
  on public.foods (owner_id, barcode)
  where owner_id is not null and barcode is not null;

create unique index foods_shared_legacy_id_key
  on public.foods (legacy_id)
  where owner_id is null and legacy_id is not null;

create unique index foods_user_legacy_id_key
  on public.foods (owner_id, legacy_id)
  where owner_id is not null and legacy_id is not null;

create index foods_name_search_trgm_idx
  on public.foods using gin (name_search extensions.gin_trgm_ops);

-- Hledání: where name_search like '%' || private.immutable_unaccent(lower(dotaz)) || '%'
-- GIN trigram zvládne i substring (mleko najde Mléko polotučné).


-- -----------------------------------------------------------------------------
-- 4) recipes + recipe_items — vlastní recepty (šablony, ne snímek)
-- -----------------------------------------------------------------------------

create table public.recipes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  name text not null,
  servings numeric not null default 1,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recipes_name_not_blank check (length(trim(name)) > 0),
  constraint recipes_servings_check check (servings > 0 and servings <= 100)
);

create trigger recipes_set_updated_at
  before update on public.recipes
  for each row execute function private.set_updated_at();

create index recipes_user_id_idx on public.recipes (user_id);

create table public.recipe_items (
  id bigint generated always as identity primary key,
  recipe_id bigint not null references public.recipes (id) on delete cascade,
  food_id bigint not null references public.foods (id) on delete restrict,
  grams numeric not null,
  created_at timestamptz not null default now(),
  constraint recipe_items_grams_check check (grams > 0 and grams <= 20000)
);

create index recipe_items_recipe_id_idx on public.recipe_items (recipe_id);
create index recipe_items_food_id_idx on public.recipe_items (food_id);

comment on table public.recipes is
  'Šablona jídla. Při zápisu do deníku appka rozpadne recept na položky a uloží snímky.';


-- -----------------------------------------------------------------------------
-- 5) pantry_items — zásoby (lednice / mrazák / spíž)
-- -----------------------------------------------------------------------------

create table public.pantry_items (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  food_id bigint not null references public.foods (id) on delete restrict,
  loc text not null,
  quantity numeric not null,
  unit text not null,
  expiry date,
  opened boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pantry_loc_check check (loc in ('lednice', 'mrazak', 'spiz')),
  constraint pantry_unit_check check (unit in ('g', 'ml', 'ks')),
  constraint pantry_quantity_check check (quantity >= 0 and quantity <= 100000)
);

comment on table public.pantry_items is
  'Domácí zásoby. Trigger na diary_entries odečte množství při zápisu jídla a vrátí ho při smazání.';

create trigger pantry_items_set_updated_at
  before update on public.pantry_items
  for each row execute function private.set_updated_at();

create index pantry_items_user_loc_idx on public.pantry_items (user_id, loc);
create index pantry_items_user_food_idx on public.pantry_items (user_id, food_id);
create index pantry_items_food_id_idx on public.pantry_items (food_id);
create index pantry_items_user_expiry_idx
  on public.pantry_items (user_id, expiry)
  where expiry is not null;


-- -----------------------------------------------------------------------------
-- 6) diary_entries — deník jídel se snímkem živin
-- -----------------------------------------------------------------------------
-- kcal/protein/carbs/fat/fiber/micros jsou hodnoty ZA PORCI (už přepočtené
-- z gramů), ne na 100 g. Při úpravě gramů je appka přepočte ze
-- per_100g snímku, ne z aktuálního katalogu.

create table public.diary_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  eaten_on date not null,
  meal text not null,
  food_id bigint references public.foods (id) on delete set null,
  recipe_id bigint references public.recipes (id) on delete set null,
  grams numeric not null,
  food_name_snapshot text not null,
  kcal_per_100g numeric not null,
  protein_per_100g numeric,
  carbs_per_100g numeric,
  fat_per_100g numeric,
  fiber_per_100g numeric,
  micros_per_100g jsonb not null default '{}'::jsonb,
  kcal numeric not null,
  protein numeric,
  carbs numeric,
  fat numeric,
  fiber numeric,
  micros jsonb not null default '{}'::jsonb,
  client_legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint diary_meal_check check (meal in ('snidane', 'obed', 'svacina', 'vecere')),
  constraint diary_grams_check check (grams > 0 and grams <= 20000),
  constraint diary_kcal_check check (kcal >= 0),
  constraint diary_macros_nonneg check (
    (protein is null or protein >= 0)
    and (carbs is null or carbs >= 0)
    and (fat is null or fat >= 0)
    and (fiber is null or fiber >= 0)
  )
);

comment on table public.diary_entries is
  'Deník. eaten_on je kalendářní den z klienta (Europe/Prague). Živiny jsou snímek v okamžiku zápisu.';
comment on column public.diary_entries.client_legacy_id is
  'Původní id z localStorage (třeba d100). Unique na uživatele, aby import šel spustit znovu.';

create trigger diary_entries_set_updated_at
  before update on public.diary_entries
  for each row execute function private.set_updated_at();

create index diary_entries_user_day_idx
  on public.diary_entries (user_id, eaten_on);
create index diary_entries_user_day_meal_idx
  on public.diary_entries (user_id, eaten_on, meal);
create index diary_entries_food_id_idx on public.diary_entries (food_id);
create index diary_entries_recipe_id_idx
  on public.diary_entries (recipe_id)
  where recipe_id is not null;

create unique index diary_entries_user_legacy_id_key
  on public.diary_entries (user_id, client_legacy_id)
  where client_legacy_id is not null;


-- -----------------------------------------------------------------------------
-- 7) food_favorites + food_recents
-- -----------------------------------------------------------------------------

create table public.food_favorites (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  food_id bigint not null references public.foods (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, food_id)
);

create index food_favorites_food_id_idx on public.food_favorites (food_id);

create table public.food_recents (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  food_id bigint not null references public.foods (id) on delete cascade,
  last_used_at timestamptz not null default now(),
  use_count integer not null default 1,
  primary key (user_id, food_id),
  constraint food_recents_use_count_check check (use_count > 0)
);

create index food_recents_user_last_idx
  on public.food_recents (user_id, last_used_at desc);
create index food_recents_food_id_idx on public.food_recents (food_id);


-- -----------------------------------------------------------------------------
-- 8) weight_logs + water_logs (volitelné)
-- -----------------------------------------------------------------------------

create table public.weight_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  logged_on date not null,
  kg numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weight_logs_kg_check check (kg > 0 and kg <= 500),
  constraint weight_logs_user_day_unique unique (user_id, logged_on)
);

create trigger weight_logs_set_updated_at
  before update on public.weight_logs
  for each row execute function private.set_updated_at();

create index weight_logs_user_day_idx
  on public.weight_logs (user_id, logged_on desc);

create table public.water_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  logged_at timestamptz not null default now(),
  ml numeric not null,
  created_at timestamptz not null default now(),
  constraint water_logs_ml_check check (ml > 0 and ml <= 10000)
);

comment on table public.water_logs is
  'Jednotlivé dávky vody (třeba 250 ml). Denní součet dělá appka nebo pohled níž.';

create index water_logs_user_time_idx
  on public.water_logs (user_id, logged_at desc);

create or replace view public.water_daily_totals
  with (security_invoker = true)
as
select
  user_id,
  (timezone('Europe/Prague', logged_at))::date as logged_on,
  sum(ml) as ml
from public.water_logs
group by user_id, (timezone('Europe/Prague', logged_at))::date;

comment on view public.water_daily_totals is
  'Součet ml vody za kalendářní den v Europe/Prague. security_invoker = RLS z water_logs.';


-- -----------------------------------------------------------------------------
-- Odečítání zásob při zápisu do deníku
-- -----------------------------------------------------------------------------
-- g a ml se berou 1:1 na gramy (olej v ml ≈ g). ks se převádí přes foods.piece_g
-- (případně default_serving_g). Nejdřív otevřené položky, pak nejdřív expurují,
-- nikdy pod nulu. Chybějící zásoba deník nezablokuje.
-- Smazání nebo snížení gramů zásobu vrátí do stejné položky, případně založí
-- novou v lednici, když už řádek neexistuje.

create or replace function private.pantry_grams(item public.pantry_items, food public.foods)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case item.unit
    when 'ks' then item.quantity * coalesce(nullif(food.piece_g, 0), food.default_serving_g, 100)
    else item.quantity
  end;
$$;

create or replace function private.apply_pantry_delta(
  p_user_id uuid,
  p_food_id bigint,
  p_delta_g numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining numeric := p_delta_g;
  item public.pantry_items;
  food public.foods;
  available_g numeric;
  take_g numeric;
  piece numeric;
begin
  if p_user_id is null or p_food_id is null or p_delta_g = 0 then
    return;
  end if;

  select * into food from public.foods where id = p_food_id;
  if food.id is null then
    return;
  end if;

  piece := coalesce(nullif(food.piece_g, 0), food.default_serving_g, 100);

  if remaining > 0 then
    for item in
      select *
      from public.pantry_items
      where user_id = p_user_id
        and food_id = p_food_id
        and quantity > 0
      order by opened desc, expiry asc nulls last, id asc
    loop
      available_g := private.pantry_grams(item, food);
      if available_g <= 0 then
        continue;
      end if;
      take_g := least(available_g, remaining);
      if item.unit = 'ks' then
        update public.pantry_items
        set quantity = round((available_g - take_g) / piece, 3),
            opened = true
        where id = item.id;
      else
        update public.pantry_items
        set quantity = round(item.quantity - take_g, 3),
            opened = true
        where id = item.id;
      end if;
      remaining := remaining - take_g;
      exit when remaining <= 0;
    end loop;
    return;
  end if;

  -- Záporné delta = vrátit gramy do zásoby.
  remaining := -remaining;
  select *
  into item
  from public.pantry_items
  where user_id = p_user_id
    and food_id = p_food_id
  order by opened desc, expiry desc nulls last, id desc
  limit 1;

  if item.id is null then
    insert into public.pantry_items (user_id, food_id, loc, quantity, unit, opened)
    values (p_user_id, p_food_id, 'lednice', remaining, 'g', true);
    return;
  end if;

  if item.unit = 'ks' then
    update public.pantry_items
    set quantity = item.quantity + round(remaining / piece, 3)
    where id = item.id;
  else
    update public.pantry_items
    set quantity = item.quantity + remaining
    where id = item.id;
  end if;
end;
$$;

create or replace function private.diary_pantry_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.apply_pantry_delta(new.user_id, new.food_id, new.grams);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.food_id is not distinct from old.food_id then
      perform private.apply_pantry_delta(
        new.user_id,
        new.food_id,
        coalesce(new.grams, 0) - coalesce(old.grams, 0)
      );
    else
      perform private.apply_pantry_delta(old.user_id, old.food_id, -coalesce(old.grams, 0));
      perform private.apply_pantry_delta(new.user_id, new.food_id, coalesce(new.grams, 0));
    end if;
    return new;
  else
    perform private.apply_pantry_delta(old.user_id, old.food_id, -coalesce(old.grams, 0));
    return old;
  end if;
end;
$$;

create trigger diary_entries_pantry
  after insert or update of food_id, grams or delete
  on public.diary_entries
  for each row execute function private.diary_pantry_trigger();

-- Nedávné potraviny se aktualizují při zápisu deníku (jen insert).
create or replace function private.diary_touch_recent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.food_id is null then
    return new;
  end if;
  insert into public.food_recents (user_id, food_id, last_used_at, use_count)
  values (new.user_id, new.food_id, now(), 1)
  on conflict (user_id, food_id) do update
    set last_used_at = now(),
        use_count = public.food_recents.use_count + 1;
  return new;
end;
$$;

create trigger diary_entries_touch_recent
  after insert on public.diary_entries
  for each row execute function private.diary_touch_recent();


-- -----------------------------------------------------------------------------
-- Nový účet: jen profil. Cíle zůstávají prázdné, dokud si je uživatel
-- nenastaví v Nastavení (žádné výchozí 2800 / 170 / 320 / 80).
-- -----------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data->>'display_name', '')), '')
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();


-- -----------------------------------------------------------------------------
-- RLS — každý uživatel vidí jen svoje řádky; katalog je čitelný všem
-- přihlášeným. anon nemá přístup. auth.uid() je vždy v (select ...).
-- UPDATE politiky mají i WITH CHECK. Sloupce v USING jsou indexované.
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.user_goals enable row level security;
alter table public.foods enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_items enable row level security;
alter table public.pantry_items enable row level security;
alter table public.diary_entries enable row level security;
alter table public.food_favorites enable row level security;
alter table public.food_recents enable row level security;
alter table public.weight_logs enable row level security;
alter table public.water_logs enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- INSERT dělá trigger handle_new_user (security definer), ne klient.

create policy user_goals_select_own on public.user_goals
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_goals_insert_own on public.user_goals
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_goals_update_own on public.user_goals
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy user_goals_delete_own on public.user_goals
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy foods_select_shared_or_own on public.foods
  for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy foods_insert_own on public.foods
  for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy foods_update_own on public.foods
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy foods_delete_own on public.foods
  for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy recipes_select_own on public.recipes
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy recipes_insert_own on public.recipes
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy recipes_update_own on public.recipes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy recipes_delete_own on public.recipes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Položky receptu: přístup přes vlastnictví rodiče (index recipes.user_id).
create policy recipe_items_select_own on public.recipe_items
  for select to authenticated
  using (exists (
    select 1 from public.recipes r
    where r.id = recipe_id and r.user_id = (select auth.uid())
  ));
create policy recipe_items_insert_own on public.recipe_items
  for insert to authenticated
  with check (exists (
    select 1 from public.recipes r
    where r.id = recipe_id and r.user_id = (select auth.uid())
  ));
create policy recipe_items_update_own on public.recipe_items
  for update to authenticated
  using (exists (
    select 1 from public.recipes r
    where r.id = recipe_id and r.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.recipes r
    where r.id = recipe_id and r.user_id = (select auth.uid())
  ));
create policy recipe_items_delete_own on public.recipe_items
  for delete to authenticated
  using (exists (
    select 1 from public.recipes r
    where r.id = recipe_id and r.user_id = (select auth.uid())
  ));

create policy pantry_items_select_own on public.pantry_items
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy pantry_items_insert_own on public.pantry_items
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy pantry_items_update_own on public.pantry_items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy pantry_items_delete_own on public.pantry_items
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy diary_entries_select_own on public.diary_entries
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy diary_entries_insert_own on public.diary_entries
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy diary_entries_update_own on public.diary_entries
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy diary_entries_delete_own on public.diary_entries
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy food_favorites_select_own on public.food_favorites
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy food_favorites_insert_own on public.food_favorites
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy food_favorites_delete_own on public.food_favorites
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy food_recents_select_own on public.food_recents
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy food_recents_insert_own on public.food_recents
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy food_recents_update_own on public.food_recents
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy food_recents_delete_own on public.food_recents
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy weight_logs_select_own on public.weight_logs
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy weight_logs_insert_own on public.weight_logs
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy weight_logs_update_own on public.weight_logs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy weight_logs_delete_own on public.weight_logs
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy water_logs_select_own on public.water_logs
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy water_logs_insert_own on public.water_logs
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy water_logs_update_own on public.water_logs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy water_logs_delete_own on public.water_logs
  for delete to authenticated
  using (user_id = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- Privilegia: anon nic, authenticated jen CRUD na tabulkách appky.
-- Sdílený katalog se z klienta jen čte (zápis zablokuje RLS, protože
-- owner_id musí být auth.uid()).
-- -----------------------------------------------------------------------------

revoke all on schema public from public, anon;
grant usage on schema public to authenticated;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon;

grant select, insert, update, delete on
  public.profiles,
  public.user_goals,
  public.foods,
  public.recipes,
  public.recipe_items,
  public.pantry_items,
  public.diary_entries,
  public.food_favorites,
  public.food_recents,
  public.weight_logs,
  public.water_logs
to authenticated;

grant select on public.current_user_goals, public.water_daily_totals to authenticated;

grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.goals_on(date) to authenticated;


-- -----------------------------------------------------------------------------
-- Semínko sdíleného katalogu: 16 základních surovin z data.js (legacy_id f1–f16).
-- 100 českých výrobků z Open Food Facts sem nenačítám — typově stejný import
-- patří do samostatného datového kroku z data.js, až bude projekt založený.
-- Ukázkové zásoby (14 položek) a 72 ukázkových zápisů deníku sem NEPATŘÍ.
-- -----------------------------------------------------------------------------

insert into public.foods (
  owner_id, source, legacy_id, barcode, name,
  kcal, protein, carbs, fat, fiber, micros,
  package_g, piece_g, default_serving_g
) values
  (null, 'builtin', 'f1', null, 'Kuřecí prsa',
   110, 23.1, 0, 1.2, 0,
   '{"b6_mg":0.6,"fe_mg":0.4,"zn_mg":0.7,"se_ug":22,"b12_ug":0.3,"k_mg":256,"na_mg":45,"mg_mg":28,"choline_mg":85,"vit_d_ug":0.1}'::jsonb,
   500, null, 150),
  (null, 'builtin', 'f2', null, 'Rýže vařená',
   130, 2.7, 28, 0.3, 0.4,
   '{"b1_mg":0.02,"mg_mg":12,"k_mg":35,"fe_mg":0.2,"folate_ug":3,"na_mg":1}'::jsonb,
   250, null, 200),
  (null, 'builtin', 'f3', null, 'Vejce (celé)',
   143, 12.6, 0.7, 9.5, 0,
   '{"b12_ug":1.1,"choline_mg":250,"vit_d_ug":2,"vit_a_ug":160,"se_ug":30,"fe_mg":1.8,"zn_mg":1.3,"b2_mg":0.45,"folate_ug":47,"na_mg":142}'::jsonb,
   600, 60, 60),
  (null, 'builtin', 'f4', null, 'Bílý jogurt 1,5 %',
   57, 4.5, 5.5, 1.5, 0,
   '{"ca_mg":150,"b12_ug":0.4,"b2_mg":0.2,"iodine_ug":20,"k_mg":180,"na_mg":50,"mg_mg":15}'::jsonb,
   500, null, 200),
  (null, 'builtin', 'f5', null, 'Ovesné vločky',
   367, 13.2, 58, 7, 10,
   '{"mg_mg":130,"fe_mg":4.2,"zn_mg":3.6,"b1_mg":0.5,"folate_ug":32,"k_mg":350,"se_ug":28,"choline_mg":40}'::jsonb,
   500, null, 60),
  (null, 'builtin', 'f6', null, 'Banán',
   89, 1.1, 23, 0.3, 2.6,
   '{"k_mg":358,"b6_mg":0.4,"vit_c_mg":8.7,"mg_mg":27,"folate_ug":20}'::jsonb,
   1000, 120, 120),
  (null, 'builtin', 'f7', null, 'Cottage cheese',
   98, 11.5, 3.5, 4.3, 0,
   '{"ca_mg":83,"b12_ug":0.4,"se_ug":9,"na_mg":360,"b2_mg":0.16,"choline_mg":18}'::jsonb,
   200, null, 150),
  (null, 'builtin', 'f8', null, 'Olivový olej',
   884, 0, 0, 100, 0,
   '{"vit_e_mg":14,"vit_k_ug":60}'::jsonb,
   500, null, 10),
  (null, 'builtin', 'f9', null, 'Brokolice',
   34, 2.8, 7, 0.4, 2.6,
   '{"vit_c_mg":89,"vit_k_ug":101,"folate_ug":63,"k_mg":316,"ca_mg":47,"fe_mg":0.7,"mg_mg":21}'::jsonb,
   500, null, 150),
  (null, 'builtin', 'f10', null, 'Losos',
   208, 20, 0, 13, 0,
   '{"vit_d_ug":11,"b12_ug":3.2,"se_ug":36,"b6_mg":0.9,"choline_mg":90,"k_mg":363,"na_mg":59,"iodine_ug":14}'::jsonb,
   250, null, 150),
  (null, 'builtin', 'f11', null, 'Celozrnný chléb',
   247, 9, 41, 3.5, 6.5,
   '{"fe_mg":2.5,"mg_mg":75,"zn_mg":1.8,"b1_mg":0.35,"folate_ug":40,"se_ug":18,"na_mg":450}'::jsonb,
   500, 45, 50),
  (null, 'builtin', 'f12', null, 'Mandlové máslo',
   614, 21, 19, 56, 10,
   '{"vit_e_mg":24,"mg_mg":270,"ca_mg":260,"fe_mg":3.5,"zn_mg":3.1,"k_mg":740}'::jsonb,
   250, null, 20),
  (null, 'builtin', 'f13', null, 'Špenát syrový',
   23, 2.9, 3.6, 0.4, 2.2,
   '{"vit_k_ug":483,"vit_a_ug":469,"folate_ug":194,"fe_mg":2.7,"mg_mg":79,"k_mg":558,"vit_c_mg":28,"ca_mg":99}'::jsonb,
   200, null, 50),
  (null, 'builtin', 'f14', null, 'Tvaroh polotučný',
   110, 14, 3.5, 4.5, 0,
   '{"ca_mg":90,"b12_ug":0.5,"se_ug":12,"na_mg":40,"b2_mg":0.2}'::jsonb,
   250, null, 150),
  (null, 'builtin', 'f15', null, 'Brambory vařené',
   87, 1.9, 20, 0.1, 1.8,
   '{"k_mg":379,"vit_c_mg":13,"b6_mg":0.3,"mg_mg":22,"fe_mg":0.3}'::jsonb,
   2000, 90, 200),
  (null, 'builtin', 'f16', '8594001123452', 'Syrovátkový protein',
   380, 80, 6, 4, 0,
   '{"ca_mg":400,"b12_ug":1.5,"na_mg":250,"k_mg":500,"mg_mg":80}'::jsonb,
   900, 30, 30)
on conflict do nothing;


-- -----------------------------------------------------------------------------
-- Import z localStorage (kcal-app-state-v1)
-- -----------------------------------------------------------------------------
-- Appka po přihlášení jednou zavolá:
--   select public.import_local_state('{"diary":[...],"customFoods":[...],...}'::jsonb);
--
-- Pravidla:
-- * Přeskočí ukázkové zápisy deníku: id ve tvaru d0–d99 (v appce mají seed
--   id d16–d87 a nové zápisy začínají na d100).
-- * Vlastní potraviny (customFoods) a uložené OFF (offFoods) se upsertnou
--   podle legacy_id jako owner_id = uživatel.
-- * foodOverrides se NEAPLIKUJÍ na sdílený katalog. Snímek v deníku se spočítá
--   z katalogu sloučeného s override, aby historie seděla; další zápisy jdou
--   z čistého katalogu, případný override si uživatel znovu uloží jako vlastní
--   potravinu.
-- * Zásoby se neimportují — v localStorage vůbec nejsou, v data.js je jen
--   14 ukázkových položek s už prošlými daty.
-- * Funkce je security invoker + idempotentní (unique legacy_id).
-- * Trigger zásob při importu deníku poběží; protože zásoby jsou prázdné,
--   nic se neodečte.
--
-- Očekávaný tvar payloadu = stav z localStorage (klíče diary, customFoods,
-- offFoods, foodOverrides).

create or replace function public.import_local_state(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  foods_upserted integer := 0;
  entries_imported integer := 0;
  entries_skipped_demo integer := 0;
  entries_skipped_bad integer := 0;
  rec jsonb;
  overrides jsonb;
  food_row public.foods;
  merged jsonb;
  grams numeric;
  scale numeric;
  legacy text;
  food_pk bigint;
  inserted integer;
begin
  if uid is null then
    raise exception 'import_local_state vyžaduje přihlášení';
  end if;

  overrides := coalesce(payload->'foodOverrides', '{}'::jsonb);

  -- Vlastní a OFF potraviny.
  for rec in
    select value
    from jsonb_array_elements(
      coalesce(payload->'customFoods', '[]'::jsonb) ||
      coalesce(payload->'offFoods', '[]'::jsonb)
    )
  loop
    legacy := rec->>'id';
    if legacy is null or btrim(legacy) = '' then
      continue;
    end if;

    insert into public.foods (
      owner_id, source, legacy_id, barcode, name,
      kcal, protein, carbs, fat, fiber, micros,
      package_g, piece_g, default_serving_g
    ) values (
      uid,
      case
        when coalesce((rec->>'off')::boolean, false) or legacy like 'off:%' then 'off'
        else 'manual'
      end,
      legacy,
      nullif(regexp_replace(coalesce(rec->>'barcode', ''), '\D', '', 'g'), ''),
      left(btrim(rec->>'name'), 80),
      (rec->>'kcal')::numeric,
      (rec->>'protein')::numeric,
      (rec->>'carbs')::numeric,
      (rec->>'fat')::numeric,
      (rec->>'fiber')::numeric,
      coalesce(rec->'micros', '{}'::jsonb),
      (rec->>'package_g')::numeric,
      (rec->>'piece_g')::numeric,
      coalesce((rec->>'default_serving_g')::numeric, 100)
    )
    on conflict (owner_id, legacy_id) where owner_id is not null and legacy_id is not null
    do update set
      name = excluded.name,
      barcode = excluded.barcode,
      kcal = excluded.kcal,
      protein = excluded.protein,
      carbs = excluded.carbs,
      fat = excluded.fat,
      fiber = excluded.fiber,
      micros = excluded.micros,
      package_g = excluded.package_g,
      piece_g = excluded.piece_g,
      default_serving_g = excluded.default_serving_g,
      updated_at = now();

    foods_upserted := foods_upserted + 1;
  end loop;

  -- Deník.
  for rec in
    select value from jsonb_array_elements(coalesce(payload->'diary', '[]'::jsonb))
  loop
    legacy := rec->>'id';
    if legacy is not null and legacy ~ '^d[0-9]{1,2}$' then
      entries_skipped_demo := entries_skipped_demo + 1;
      continue;
    end if;

    if rec->>'date' is null
       or rec->>'meal' not in ('snidane', 'obed', 'svacina', 'vecere')
       or rec->>'foodId' is null then
      entries_skipped_bad := entries_skipped_bad + 1;
      continue;
    end if;

    grams := replace(coalesce(rec->>'grams', ''), ',', '.')::numeric;
    if grams is null or grams <= 0 then
      entries_skipped_bad := entries_skipped_bad + 1;
      continue;
    end if;

    -- Nejdřív vlastní / OFF, pak sdílený katalog podle legacy_id.
    select * into food_row
    from public.foods
    where legacy_id = rec->>'foodId'
      and owner_id = uid
    limit 1;

    if food_row.id is null then
      select * into food_row
      from public.foods
      where legacy_id = rec->>'foodId'
        and owner_id is null
      limit 1;
    end if;

    if food_row.id is null then
      entries_skipped_bad := entries_skipped_bad + 1;
      continue;
    end if;

    food_pk := food_row.id;
    merged := overrides -> (rec->>'foodId');
    if merged is not null then
      food_row.name := coalesce(merged->>'name', food_row.name);
      food_row.kcal := coalesce((merged->>'kcal')::numeric, food_row.kcal);
      food_row.protein := coalesce((merged->>'protein')::numeric, food_row.protein);
      food_row.carbs := coalesce((merged->>'carbs')::numeric, food_row.carbs);
      food_row.fat := coalesce((merged->>'fat')::numeric, food_row.fat);
    end if;

    scale := grams / 100.0;

    insert into public.diary_entries (
      user_id, eaten_on, meal, food_id, grams, food_name_snapshot,
      kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g,
      micros_per_100g,
      kcal, protein, carbs, fat, fiber, micros,
      client_legacy_id
    ) values (
      uid,
      (rec->>'date')::date,
      rec->>'meal',
      food_pk,
      grams,
      food_row.name,
      food_row.kcal,
      food_row.protein,
      food_row.carbs,
      food_row.fat,
      food_row.fiber,
      coalesce(food_row.micros, '{}'::jsonb),
      round(food_row.kcal * scale, 2),
      case when food_row.protein is null then null else round(food_row.protein * scale, 2) end,
      case when food_row.carbs is null then null else round(food_row.carbs * scale, 2) end,
      case when food_row.fat is null then null else round(food_row.fat * scale, 2) end,
      case when food_row.fiber is null then null else round(food_row.fiber * scale, 2) end,
      coalesce((
        select jsonb_object_agg(k, to_jsonb(round((v::text)::numeric * scale, 4)))
        from jsonb_each(coalesce(food_row.micros, '{}'::jsonb)) as x(k, v)
        where jsonb_typeof(v) = 'number'
      ), '{}'::jsonb),
      legacy
    )
    on conflict (user_id, client_legacy_id) where client_legacy_id is not null
    do nothing;

    get diagnostics inserted = row_count;
    entries_imported := entries_imported + inserted;
  end loop;

  return jsonb_build_object(
    'foods_upserted', foods_upserted,
    'entries_imported', entries_imported,
    'entries_skipped_demo', entries_skipped_demo,
    'entries_skipped_bad', entries_skipped_bad
  );
end;
$$;

comment on function public.import_local_state(jsonb) is
  'Jednorázový import kcal-app-state-v1. Přeskočí ukázkové d0–d99, zásoby neimportuje. Idempotentní.';

grant execute on function public.import_local_state(jsonb) to authenticated;


-- -----------------------------------------------------------------------------
-- Nasazení (hotovo — soubor znovu NESPOUŠTĚT)
-- -----------------------------------------------------------------------------
-- 1. Projekt kcal-app v eu-central-1 je založený a tenhle SQL už v něm běží.
-- 2. Auth je e-mail + heslo. Potvrzení e-mailu je zapnuté.
-- 3. Klient má jen project URL a publishable klíč.
-- 4. Po prvním přihlášení appka zavolá import_local_state s kcal-app-state-v1.
-- 5. 100 OFF výrobků z data.js pořád žije v klientském katalogu. Hromadný
--    import do sdíleného public.foods (owner_id NULL) je pozdější krok.
-- =============================================================================

commit;

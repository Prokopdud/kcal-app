-- Návrh pro vlastní Supabase projekt (zdarma). Appka ho sama nezapíná.
-- GitHub Pages nemá server, deník teď žije v prohlížeči.
-- Až budeš chtít synchronizaci, založ projekt na svém účtu a tenhle SQL spusť tam.
-- Klíče do repozitáře nepatří. Než zapneš zápis z webu, zapni RLS.

create table if not exists foods (
  id text primary key,
  name text not null,
  barcode text unique,
  kcal numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  fiber numeric,
  package_g numeric,
  source text not null default 'openfoodfacts'
);

create table if not exists diary_entries (
  id text primary key,
  eaten_on date not null,
  meal text not null check (meal in ('snidane','obed','svacina','vecere')),
  food_id text not null,
  grams numeric not null check (grams > 0)
);

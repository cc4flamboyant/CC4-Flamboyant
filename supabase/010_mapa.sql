-- =====================================================================
-- CC4 — local exato no mapa (alfinete) e rota
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Latitude e longitude no endereço da igreja, nos eventos da agenda e
--   nas células (opcional: sem alfinete, a rota usa o endereço digitado)
-- - O app mostra o mapa (OpenStreetMap) e abre a rota no Google Maps ou no Waze
-- =====================================================================

alter table public.churches add column if not exists lat double precision check (lat between -90 and 90);
alter table public.churches add column if not exists lng double precision check (lng between -180 and 180);
alter table public.events add column if not exists lat double precision check (lat between -90 and 90);
alter table public.events add column if not exists lng double precision check (lng between -180 and 180);

-- Os dois juntos, ou nenhum.
alter table public.churches drop constraint if exists churches_lat_lng_check;
alter table public.churches add constraint churches_lat_lng_check check ((lat is null) = (lng is null));
alter table public.events drop constraint if exists events_lat_lng_check;
alter table public.events add constraint events_lat_lng_check check ((lat is null) = (lng is null));

-- Quem já edita cada tabela passa a poder gravar o alfinete.
grant update (name, short_name, logo_url, icon_background, primary_color, welcome_text, about_text,
              address, city, pix_key, pix_name, social, features, privacy_email, privacy_text, lat, lng)
  on public.churches to authenticated;
grant update (title, description, location, starts_at, ends_at, repeat_weekly, repeat_until, remind_minutes, updated_at, lat, lng)
  on public.events to authenticated;

create extension if not exists pgcrypto;

create table if not exists public.story_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  premise text not null,
  genre text not null default 'drama',
  tone text not null default 'emosional',
  story_bible jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.story_episodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.story_projects(id) on delete cascade,
  episode_no integer not null,
  title text not null,
  summary text not null default '',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  published_at timestamptz,
  external_id text,
  created_at timestamptz not null default now(),
  unique(project_id, episode_no)
);

create table if not exists public.publish_logs (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.story_episodes(id) on delete cascade,
  platform text not null,
  status text not null,
  external_id text,
  response jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.worker_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null,
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.story_projects enable row level security;
alter table public.story_episodes enable row level security;
alter table public.publish_logs enable row level security;
alter table public.worker_runs enable row level security;

-- Worker uses the server-side Supabase key. No public policies are created.
-- Add authenticated-user policies later if a dashboard is added.

insert into public.story_projects
  (title, premise, genre, tone, story_bible, active)
select
  'Kisah Cinta Tak Terlupakan',
  'Dua orang yang pernah saling mencintai bertemu kembali setelah bertahun-tahun. Mereka membawa luka, rahasia, dan kesempatan kedua yang tidak pernah benar-benar mereka rencanakan.',
  'romance drama',
  'hangat, emosional, sinematik, penuh misteri kecil',
  jsonb_build_object(
    'characters', jsonb_build_array(
      jsonb_build_object('name','Arka','role','tokoh utama pria','traits',jsonb_build_array('tenang','setia','sulit mengungkapkan perasaan')),
      jsonb_build_object('name','Nara','role','tokoh utama wanita','traits',jsonb_build_array('cerdas','mandiri','menyimpan masa lalu'))
    ),
    'rules', jsonb_build_array(
      'Hubungan berkembang perlahan.',
      'Jaga kesinambungan waktu dan karakter.',
      'Setiap episode memiliki konflik kecil dan hook.',
      'Jangan menyelesaikan kisah dalam satu episode.'
    )
  ),
  true
where not exists (
  select 1 from public.story_projects where title = 'Kisah Cinta Tak Terlupakan'
);

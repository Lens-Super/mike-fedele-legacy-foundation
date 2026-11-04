-- Memories of Mike: private by default, explicitly approved by the administrator.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.memories_submissions (
  id uuid primary key default gen_random_uuid(),
  contributor_name text not null check (char_length(contributor_name) between 1 and 120),
  contributor_email text not null check (char_length(contributor_email) <= 254),
  title text check (title is null or char_length(title) <= 160),
  story text not null check (char_length(story) between 1 and 20000),
  permission_granted boolean not null default false check (permission_granted),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  check ((status = 'approved' and published_at is not null) or status <> 'approved')
);

create table if not exists public.memories_photos (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.memories_submissions(id) on delete cascade,
  object_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer not null check (byte_size between 1 and 4194304),
  created_at timestamptz not null default now()
);

create table if not exists public.memories_submission_rate_limits (
  bucket_key text not null,
  window_kind text not null check (window_kind in ('hour','day')),
  window_start timestamptz not null,
  submissions integer not null default 0,
  primary key (bucket_key, window_kind, window_start)
);

alter table public.memories_submissions enable row level security;
alter table public.memories_photos enable row level security;
alter table public.memories_submission_rate_limits enable row level security;

revoke all on public.memories_submissions, public.memories_photos,
  public.memories_submission_rate_limits from anon, authenticated;
grant select, update, delete on public.memories_submissions to authenticated;
grant select, insert, update, delete on public.memories_photos to authenticated;

drop policy if exists "Stephanie reads submissions" on public.memories_submissions;
create policy "Stephanie reads submissions" on public.memories_submissions
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org');
drop policy if exists "Stephanie edits submissions" on public.memories_submissions;
create policy "Stephanie edits submissions" on public.memories_submissions
  for update to authenticated
  using ((auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org')
  with check ((auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org');
drop policy if exists "Stephanie removes submissions" on public.memories_submissions;
create policy "Stephanie removes submissions" on public.memories_submissions
  for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org');

drop policy if exists "Stephanie manages photos" on public.memories_photos;
create policy "Stephanie manages photos" on public.memories_photos
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org')
  with check ((auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org');
drop policy if exists "Public sees photos for approved memories" on public.memories_photos;
create policy "Public sees photos for approved memories" on public.memories_photos
  for select to anon, authenticated
  using (exists (
    select 1 from public.memories_submissions s
    where s.id = submission_id and s.status = 'approved'
  ));

create or replace function public.get_published_memories()
returns table (
  id uuid, contributor_name text, title text, story text,
  published_at timestamptz, photos jsonb
)
language sql stable security definer
set search_path = public, extensions
as $$
  select s.id, s.contributor_name, s.title, s.story, s.published_at,
    coalesce((select jsonb_agg(jsonb_build_object('path', p.object_path, 'mime_type', p.mime_type) order by p.created_at)
              from public.memories_photos p where p.submission_id = s.id), '[]'::jsonb)
  from public.memories_submissions s
  where s.status = 'approved'
  order by s.published_at desc, s.created_at desc;
$$;
revoke all on function public.get_published_memories() from public;
grant execute on function public.get_published_memories() to anon, authenticated;

create or replace function public.is_published_memory_photo(p_path text)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memories_photos p
    join public.memories_submissions s on s.id = p.submission_id
    where p.object_path = p_path and s.status = 'approved'
  );
$$;
revoke all on function public.is_published_memory_photo(text) from public;
grant execute on function public.is_published_memory_photo(text) to anon, authenticated;

-- Atomically allows no more than 5 submissions/hour or 20/day per hashed client IP.
create or replace function public.consume_memories_submission_limit(p_bucket_key text)
returns boolean language plpgsql security definer
set search_path = public
as $$
declare
  v_hour integer;
  v_day integer;
begin
  insert into public.memories_submission_rate_limits(bucket_key, window_kind, window_start, submissions)
  values (p_bucket_key, 'hour', date_trunc('hour', now()), 1)
  on conflict (bucket_key, window_kind, window_start) do update
    set submissions = public.memories_submission_rate_limits.submissions + 1
  returning submissions into v_hour;
  insert into public.memories_submission_rate_limits(bucket_key, window_kind, window_start, submissions)
  values (p_bucket_key, 'day', date_trunc('day', now()), 1)
  on conflict (bucket_key, window_kind, window_start) do update
    set submissions = public.memories_submission_rate_limits.submissions + 1
  returning submissions into v_day;
  delete from public.memories_submission_rate_limits where window_start < now() - interval '2 days';
  return v_hour <= 5 and v_day <= 20;
end;
$$;
revoke all on function public.consume_memories_submission_limit(text) from public, anon, authenticated;
grant execute on function public.consume_memories_submission_limit(text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memories-pending', 'memories-pending', false, 4194304,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 4194304,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Stephanie reads memory photos" on storage.objects;
create policy "Stephanie reads memory photos" on storage.objects
  for select to authenticated using (
    bucket_id = 'memories-pending' and (auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org'
  );
drop policy if exists "Public reads approved memory photos" on storage.objects;
create policy "Public reads approved memory photos" on storage.objects
  for select to anon, authenticated using (
    bucket_id = 'memories-pending' and exists (
      select 1 where public.is_published_memory_photo(name)
    )
  );
drop policy if exists "Stephanie removes memory photos" on storage.objects;
create policy "Stephanie removes memory photos" on storage.objects
  for delete to authenticated using (
    bucket_id = 'memories-pending' and (auth.jwt() ->> 'email') = 'stephanie@mikefedelelegacy.org'
  );

-- Admin list/photo joins need to remain protected by the table policies above.
comment on table public.memories_submissions is 'Private submissions; only the foundation administrator can read or moderate.';
comment on table public.memories_photos is 'Photo paths stay private until the related submission is approved.';

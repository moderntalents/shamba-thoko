-- Social media marketing, Phase 1 (manual sharing; ready for official API publishing later).
--
-- * social_channels: Facebook Page, TikTok and WhatsApp Business. Not connected until an official OAuth
--   connection exists (Phase 2+). Auto-publishing is off and can only be switched on for a connected channel.
--   Access tokens are never stored here: token_secret_id only points to an encrypted Supabase Vault secret,
--   and that column is not readable from the app.
-- * social_posts: one post per promotion per platform (no duplicates). Draft posts with English and Kiswahili
--   captions are created automatically when an admin confirms a promotion's payment.
--   'shared_manually' = an admin shared it by hand. 'published' = posted automatically through the platform API;
--   the database only accepts it with method 'auto' and a platform post id, and no app function can set it.
-- * No paid advertising and no spending in this phase. Existing promotions and payments are unchanged:
--   draft creation runs in its own protected block so it can never stop a payment confirmation.

-- ---------------------------------------------------------------- channels
create table public.social_channels (
  platform text primary key check (platform in ('facebook', 'tiktok', 'whatsapp')),
  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'expired', 'error')),
  auto_publish boolean not null default false,
  require_approval boolean not null default true,
  account_name text,
  account_id text,
  token_secret_id uuid,              -- Vault secret id (Phase 2+); never exposed to the app
  token_expires_at timestamptz,
  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint social_auto_needs_connection check (not auto_publish or status = 'connected')
);
insert into public.social_channels (platform) values ('facebook'), ('tiktok'), ('whatsapp') on conflict do nothing;
alter table public.social_channels enable row level security;
create policy "admins read social channels" on public.social_channels for select to authenticated using ((select public.is_admin()));
revoke all on public.social_channels from anon, authenticated;
grant select (platform, status, auto_publish, require_approval, account_name, token_expires_at, connected_at, last_error, updated_at)
  on public.social_channels to authenticated;

-- ---------------------------------------------------------------- posts
create table public.social_posts (
  id bigint generated always as identity primary key,
  promo_id bigint references public.promo_requests (id) on delete set null,
  listing_id bigint references public.listings (id) on delete set null,
  seller uuid references public.profiles (id) on delete set null,
  platform text not null check (platform in ('facebook', 'tiktok', 'whatsapp')),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'rejected', 'queued', 'publishing', 'published', 'shared_manually', 'failed', 'cancelled')),
  method text check (method in ('manual', 'auto')),
  caption_en text not null default '' check (char_length(caption_en) <= 2200),
  caption_sw text not null default '' check (char_length(caption_sw) <= 2200),
  hashtags text[] not null default '{}',
  link text not null check (link ~ '^https://'),
  snapshot jsonb not null default '{}'::jsonb,    -- product/shop details used for the caption and the branded image
  external_post_id text,
  external_url text check (external_url is null or (external_url ~ '^https://' and char_length(external_url) <= 500)),
  last_error text,
  attempts int not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz,
  publish_key uuid not null default gen_random_uuid(), -- idempotency key for future API publishing
  admin_note text not null default '',
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  shared_at timestamptz,
  published_at timestamptz,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_published_is_automatic check (status <> 'published' or (method = 'auto' and external_post_id is not null and published_at is not null)),
  constraint social_manual_share check (status <> 'shared_manually' or (method = 'manual' and shared_at is not null))
);
create unique index social_posts_one_per_promo on public.social_posts (promo_id, platform) where promo_id is not null;
create index social_posts_status_idx on public.social_posts (status, created_at desc);
alter table public.social_posts enable row level security;
create policy "admins read social posts" on public.social_posts for select to authenticated using ((select public.is_admin()));
revoke all on public.social_posts from anon, authenticated;
grant select on public.social_posts to authenticated;

-- ---------------------------------------------------------------- caption builder
create or replace function public.social_tag(p text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(initcap(coalesce(p, '')), '[^A-Za-z0-9]', '', 'g');
$$;

create or replace function public.social_caption(p_platform text, p_lang text, s jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  sw boolean := p_lang = 'sw';
  v_name text := coalesce(nullif(s ->> 'name', ''), s ->> 'seller_name');
  v_price text := case when (s ->> 'price') is not null then 'KES ' || to_char((s ->> 'price')::int, 'FM999,999,990') || ' / ' || coalesce(s ->> 'unit', '') end;
  v_ver text := case when (s ->> 'verified')::boolean then case when sw then ' ✔ Muuzaji aliyethibitishwa' else ' ✔ Verified seller' end else '' end;
  v_head text; v_body text := nullif(btrim(coalesce(s ->> 'body', '')), ''); v_cta text; v_tags text;
  lines text[];
begin
  v_head := case s ->> 'service'
    when 'promoted_shop' then (case when sw then '🏪 Tembelea duka la ' else '🏪 Visit ' end) || (s ->> 'seller_name') || (case when sw then ' kwenye Shamba Soko' else ' on Shamba Soko' end)
    else '🌱 ' || v_name end;
  v_cta := case when sw then 'Agiza kupitia Shamba Soko: ' else 'Order on Shamba Soko: ' end || (s ->> 'link');
  v_tags := array_to_string(array(select '#' || x from unnest(public.social_hashtags(p_platform, s)) x), ' ');
  lines := array[v_head];
  if v_price is not null and (s ->> 'service') <> 'promoted_shop' then lines := lines || ('💰 ' || v_price); end if;
  lines := lines || ('📍 ' || coalesce(s ->> 'county', 'Kenya') || ' · 🏪 ' || (s ->> 'seller_name') || v_ver);
  if v_body is not null then lines := lines || v_body; end if;
  if p_platform = 'tiktok' then
    lines := lines || (case when sw then 'Tafuta Shamba Soko: shambasoko.store' else 'Find it on Shamba Soko: shambasoko.store' end);
  else
    lines := lines || v_cta;
  end if;
  if v_tags <> '' then lines := lines || v_tags; end if;
  return left(array_to_string(lines, E'\n'), 2200);
end;
$$;

create or replace function public.social_hashtags(p_platform text, s jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select case when p_platform = 'whatsapp' then '{}'::text[] else
    array_remove(array['ShambaSoko', 'KilimoBiashara',
      case s ->> 'category' when 'produce' then 'FarmFresh' when 'seedling' then 'Seedlings' when 'input' then 'FarmInputs' else 'Kilimo' end,
      'Kenya', nullif(public.social_tag(s ->> 'county'), '')]
      || case when p_platform = 'tiktok' then array['FarmTok', 'Kilimo'] else '{}'::text[] end, null) end;
$$;

-- Snapshot of what a promotion advertises (public details only: no phone numbers or payment data).
create or replace function public.social_snapshot(p_promo bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'service', r.service, 'promo', r.id,
    'name', coalesce(nullif(r.title, ''), l.name), 'body', r.body,
    'listing_id', l.id, 'price', l.price, 'unit', l.unit, 'category', l.category,
    'county', coalesce(l.county, p.county), 'seller', r.seller,
    'seller_name', coalesce(nullif(p.biz, ''), r.seller_name),
    'cover', coalesce(l.cover, l.photos -> 0 ->> 'path'),
    'verified', exists (select 1 from public.verified_sellers() v where v.seller = r.seller),
    'link', 'https://www.shambasoko.store' || case when l.id is not null then '/p/' || l.id else '/shop/' || r.seller end)
  from public.promo_requests r
  left join public.listings l on l.id = r.listing_id and not l.hidden
  left join public.profiles p on p.id = r.seller
  where r.id = p_promo;
$$;

-- Create draft posts (one per platform) for an active promotion. Existing posts are left alone (no duplicates).
create or replace function public.social_draft_for_promo(p_promo bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare s jsonb := public.social_snapshot(p_promo); n int;
begin
  if s is null or (s ->> 'seller') is null then return 0; end if;
  insert into public.social_posts (promo_id, listing_id, seller, platform, caption_en, caption_sw, hashtags, link, snapshot, history)
  select p_promo, (s ->> 'listing_id')::bigint, (s ->> 'seller')::uuid, c.platform,
         public.social_caption(c.platform, 'en', s), public.social_caption(c.platform, 'sw', s),
         public.social_hashtags(c.platform, s), s ->> 'link', s,
         jsonb_build_array(jsonb_build_object('s', 'draft', 'by', 'system', 'at', public.ms_now()))
    from public.social_channels c
  on conflict (promo_id, platform) where promo_id is not null do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Promotion status changes: drafts when it starts; unshared posts are cancelled when it stops.
-- Runs in a protected block: a problem here never blocks or changes the promotion or payment.
create or replace function public.social_on_promo_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.status = 'active' and old.status is distinct from 'active' then
      perform public.social_draft_for_promo(new.id);
    elsif old.status = 'active' and new.status <> 'active' then
      update public.social_posts set status = 'cancelled', updated_at = now(),
             history = history || jsonb_build_array(jsonb_build_object('s', 'cancelled', 'by', 'system', 'at', public.ms_now(), 'note', 'Promotion ' || new.status))
       where promo_id = new.id and status in ('draft', 'approved', 'queued', 'failed');
    end if;
  exception when others then
    raise warning 'social drafts skipped for promotion %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
create trigger promo_social_drafts after update of status on public.promo_requests
  for each row when (old.status is distinct from new.status) execute function public.social_on_promo_change();

-- ---------------------------------------------------------------- admin actions
create or replace function public.admin_social_post_action(p_id bigint, p_action text, p_caption_en text default null, p_caption_sw text default null,
  p_url text default null, p_note text default '', p_seen timestamptz default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.social_posts; ch public.social_channels; pr public.promo_requests; s jsonb;
  v_note text := left(btrim(coalesce(p_note, '')), 300);
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
  v_label text; v_re text;
begin
  perform public.require_admin();
  select * into r from public.social_posts where id = p_id for update;
  if r.id is null then raise exception 'post not found' using errcode = 'P0002'; end if;
  if p_seen is null or date_trunc('milliseconds', r.updated_at) <> date_trunc('milliseconds', p_seen) then
    raise exception 'this post changed: reload and check it again' using errcode = 'P0001';
  end if;
  select * into ch from public.social_channels where platform = r.platform;
  select * into pr from public.promo_requests where id = r.promo_id;
  v_re := case r.platform
    when 'facebook' then '^https://([a-z0-9-]+\.)*(facebook\.com|fb\.com|fb\.watch)/'
    when 'tiktok' then '^https://([a-z0-9-]+\.)*tiktok\.com/'
    else '^https://([a-z0-9-]+\.)*(whatsapp\.com|wa\.me)/' end;
  if v_url is not null then
    if char_length(v_url) > 500 or v_url !~* v_re then
      raise exception 'paste the link of the post on %', r.platform using errcode = '22023';
    end if;
  end if;

  if p_action = 'save' and r.status in ('draft', 'approved', 'rejected') then
    if char_length(btrim(coalesce(p_caption_en, ''))) < 10 or char_length(btrim(coalesce(p_caption_sw, ''))) < 10 then
      raise exception 'write both captions (English and Kiswahili)' using errcode = '22023';
    end if;
    update public.social_posts set caption_en = left(btrim(p_caption_en), 2200), caption_sw = left(btrim(p_caption_sw), 2200),
           status = 'draft', approved_by = null, approved_at = null where id = r.id;   -- edited text needs approval again
    v_label := 'edited';
  elsif p_action = 'regenerate' and r.status in ('draft', 'rejected') then
    s := public.social_snapshot(r.promo_id);
    if s is null then raise exception 'the promotion for this post no longer exists' using errcode = '22023'; end if;
    update public.social_posts set snapshot = s, link = s ->> 'link', listing_id = (s ->> 'listing_id')::bigint,
           caption_en = public.social_caption(r.platform, 'en', s), caption_sw = public.social_caption(r.platform, 'sw', s),
           hashtags = public.social_hashtags(r.platform, s), status = 'draft' where id = r.id;
    v_label := 'regenerated';
  elsif p_action = 'approve' and r.status = 'draft' then
    if pr.id is null or pr.status <> 'active' or pr.ends_at <= now() then
      raise exception 'the promotion is no longer active' using errcode = '22023';
    end if;
    update public.social_posts set status = 'approved', approved_by = (select auth.uid()), approved_at = now() where id = r.id;
    v_label := 'approved';
  elsif p_action = 'reject' and r.status in ('draft', 'approved') then
    if v_note = '' then raise exception 'add a reason' using errcode = '22023'; end if;
    update public.social_posts set status = 'rejected', approved_by = null, approved_at = null where id = r.id;
    v_label := 'rejected';
  elsif p_action = 'reopen' and r.status = 'rejected' then
    update public.social_posts set status = 'draft' where id = r.id;
    v_label := 'draft';
  elsif p_action = 'mark_shared' and (r.status = 'approved' or (r.status = 'draft' and not ch.require_approval)) then
    -- Manual sharing only. This is never recorded as automatic publishing.
    if pr.id is null or pr.status <> 'active' then raise exception 'the promotion is no longer active' using errcode = '22023'; end if;
    update public.social_posts set status = 'shared_manually', method = 'manual', shared_at = now(), external_url = v_url where id = r.id;
    v_label := 'shared_manually';
  elsif p_action = 'set_url' and r.status = 'shared_manually' then
    update public.social_posts set external_url = v_url where id = r.id;
    v_label := 'link_updated';
  elsif p_action = 'undo_shared' and r.status = 'shared_manually' then
    update public.social_posts set status = 'approved', method = null, shared_at = null, external_url = null,
           approved_by = coalesce(approved_by, (select auth.uid())), approved_at = coalesce(approved_at, now()) where id = r.id;
    v_label := 'share_undone';
  else
    raise exception 'this action is not possible now' using errcode = '22023';
  end if;
  update public.social_posts set updated_at = now(), admin_note = case when v_note <> '' then v_note else admin_note end,
         history = history || public.promo_log(v_label, 'admin', v_note) where id = r.id;
  perform public.verif_audit('social_' || v_label, null, jsonb_build_object('post', r.id, 'platform', r.platform, 'promo', r.promo_id, 'note', v_note));
end;
$$;

-- Drafts for a promotion that was already active before this feature (or after a cancelled draft set).
create or replace function public.admin_social_create_for_promo(p_promo bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare pr public.promo_requests; n int;
begin
  perform public.require_admin();
  select * into pr from public.promo_requests where id = p_promo;
  if pr.id is null or pr.status <> 'active' or pr.ends_at <= now() then raise exception 'only active promotions can be shared' using errcode = '22023'; end if;
  n := public.social_draft_for_promo(p_promo);
  perform public.verif_audit('social_drafts_created', null, jsonb_build_object('promo', p_promo, 'count', n));
  return n;
end;
$$;

create or replace function public.admin_social_channel_set(p_platform text, p_auto boolean, p_require_approval boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare ch public.social_channels;
begin
  perform public.require_admin();
  select * into ch from public.social_channels where platform = p_platform for update;
  if ch.platform is null then raise exception 'unknown platform' using errcode = '22023'; end if;
  if coalesce(p_auto, false) and ch.status <> 'connected' then
    raise exception 'connect % before turning on automatic publishing', p_platform using errcode = '22023';
  end if;
  update public.social_channels set auto_publish = coalesce(p_auto, false), require_approval = coalesce(p_require_approval, true), updated_at = now()
   where platform = p_platform;
  perform public.verif_audit('social_channel_settings', null, jsonb_build_object('platform', p_platform,
    'before', jsonb_build_object('auto', ch.auto_publish, 'approval', ch.require_approval),
    'after', jsonb_build_object('auto', coalesce(p_auto, false), 'approval', coalesce(p_require_approval, true))));
end;
$$;

-- Disconnect: stop automatic publishing and delete the stored token (if any) from Vault.
create or replace function public.admin_social_disconnect(p_platform text) returns void
language plpgsql security definer set search_path = '' as $$
declare ch public.social_channels;
begin
  perform public.require_admin();
  select * into ch from public.social_channels where platform = p_platform for update;
  if ch.platform is null then raise exception 'unknown platform' using errcode = '22023'; end if;
  if ch.token_secret_id is not null then
    execute 'delete from vault.secrets where id = $1' using ch.token_secret_id;
  end if;
  update public.social_channels set status = 'not_connected', auto_publish = false, account_name = null, account_id = null,
         token_secret_id = null, token_expires_at = null, connected_by = null, connected_at = null, last_error = null, updated_at = now()
   where platform = p_platform;
  update public.social_posts set status = 'approved', updated_at = now() where platform = p_platform and status = 'queued';
  perform public.verif_audit('social_disconnected', null, jsonb_build_object('platform', p_platform));
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.social_tag(text), public.social_caption(text, text, jsonb), public.social_hashtags(text, jsonb),
  public.social_snapshot(bigint), public.social_draft_for_promo(bigint), public.social_on_promo_change(),
  public.admin_social_post_action(bigint, text, text, text, text, text, timestamptz), public.admin_social_create_for_promo(bigint),
  public.admin_social_channel_set(text, boolean, boolean), public.admin_social_disconnect(text) from public, anon, authenticated;
grant execute on function public.admin_social_post_action(bigint, text, text, text, text, text, timestamptz), public.admin_social_create_for_promo(bigint),
  public.admin_social_channel_set(text, boolean, boolean), public.admin_social_disconnect(text) to authenticated;

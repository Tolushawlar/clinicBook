-- Clinic booking schema for the Koya assessment API.
-- Apply with psql or paste into the Supabase SQL editor.

create table if not exists clinic_slots (
  id text primary key,
  provider text not null,
  start timestamptz not null,
  "end" timestamptz not null
);

create table if not exists clinic_bookings (
  id text primary key default gen_random_uuid()::text,
  slot_id text not null references clinic_slots(id) on delete cascade,
  name text not null,
  email text not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now()
);

-- At most one confirmed booking per slot, enforced by the database itself.
create unique index if not exists clinic_bookings_one_confirmed_per_slot
  on clinic_bookings (slot_id)
  where status = 'confirmed';

create index if not exists clinic_bookings_email_created_idx
  on clinic_bookings (email, created_at, id);

create table if not exists clinic_idempotency (
  key text primary key,
  fingerprint text not null,
  status_code integer not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists clinic_attempts (
  id bigint generated always as identity primary key,
  email text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists clinic_attempts_email_time_idx
  on clinic_attempts (email, attempted_at);

alter table clinic_slots enable row level security;
alter table clinic_bookings enable row level security;
alter table clinic_idempotency enable row level security;
alter table clinic_attempts enable row level security;

create or replace function clinic_reset(p_slots jsonb)
returns void
language plpgsql
as $$
begin
  delete from clinic_bookings where true;
  delete from clinic_idempotency where true;
  delete from clinic_attempts where true;
  delete from clinic_slots where true;

  insert into clinic_slots (id, provider, start, "end")
  select
    btrim(slot->>'id'),
    slot->>'provider',
    (slot->>'start')::timestamptz,
    (slot->>'end')::timestamptz
  from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) as slot
  where coalesce(btrim(slot->>'id'), '') <> ''
  on conflict (id) do update
    set provider = excluded.provider,
        start = excluded.start,
        "end" = excluded."end";
end;
$$;

create or replace function clinic_list_slots(p_provider text default null)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'provider', s.provider,
        'start', to_jsonb(s.start),
        'end', to_jsonb(s."end"),
        'available', not exists (
          select 1
          from clinic_bookings b
          where b.slot_id = s.id and b.status = 'confirmed'
        )
      )
      order by s.start asc, s.id asc
    ),
    '[]'::jsonb
  )
  from clinic_slots s
  where p_provider is null or s.provider = p_provider;
$$;

create or replace function clinic_book(
  p_slot_id text,
  p_name text,
  p_email text,
  p_idempotency_key text,
  p_fingerprint text
)
returns jsonb
language plpgsql
as $$
declare
  v_email text;
  v_slot clinic_slots%rowtype;
  v_booking clinic_bookings%rowtype;
  v_existing clinic_idempotency%rowtype;
  v_count integer;
  v_retry integer;
  v_result jsonb;
begin
  -- Serialize requests that share an idempotency key.
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    perform pg_advisory_xact_lock(hashtextextended('clinic-idem:' || p_idempotency_key, 0));

    select * into v_existing from clinic_idempotency where key = p_idempotency_key;
    if found then
      if v_existing.fingerprint <> p_fingerprint then
        return jsonb_build_object(
          'status', 422,
          'body', jsonb_build_object('error', 'Idempotency-Key was reused with a different body')
        );
      end if;
      return jsonb_build_object('status', v_existing.status_code, 'body', v_existing.response);
    end if;
  end if;

  -- Serialize the rate-limit check per email, then count failed attempts too.
  if p_email is not null and btrim(p_email) <> '' then
    v_email := lower(btrim(p_email));
    perform pg_advisory_xact_lock(hashtextextended('clinic-email:' || v_email, 0));

    select count(*) into v_count
    from clinic_attempts
    where email = v_email
      and attempted_at > now() - interval '60 seconds';

    if v_count >= 5 then
      select greatest(
        1,
        ceil(extract(epoch from (min(attempted_at) + interval '60 seconds' - now())))
      )::integer
      into v_retry
      from clinic_attempts
      where email = v_email
        and attempted_at > now() - interval '60 seconds';

      return jsonb_build_object(
        'status', 429,
        'body', jsonb_build_object('error', 'too many booking attempts for this email'),
        'retry_after', v_retry
      );
    end if;

    insert into clinic_attempts (email) values (v_email);
  end if;

  if p_slot_id is null or btrim(p_slot_id) = '' then
    v_result := jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'slot_id is required'));
  elsif p_name is null or btrim(p_name) = '' then
    v_result := jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'name is required'));
  elsif p_email is null or btrim(p_email) = '' then
    v_result := jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'email is required'));
  elsif lower(btrim(p_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    v_result := jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'email is invalid'));
  else
    select * into v_slot from clinic_slots where id = p_slot_id;

    if not found then
      v_result := jsonb_build_object('status', 404, 'body', jsonb_build_object('error', 'slot not found'));
    elsif v_slot.start <= now() then
      v_result := jsonb_build_object('status', 400, 'body', jsonb_build_object('error', 'slot has already started'));
    else
      begin
        insert into clinic_bookings (slot_id, name, email, status)
        values (p_slot_id, btrim(p_name), lower(btrim(p_email)), 'confirmed')
        returning * into v_booking;
      exception when unique_violation then
        v_result := jsonb_build_object('status', 409, 'body', jsonb_build_object('error', 'slot is already booked'));
      end;

      if v_result is null then
        v_result := jsonb_build_object(
          'status', 201,
          'body', jsonb_build_object(
            'id', v_booking.id,
            'slot_id', v_booking.slot_id,
            'name', v_booking.name,
            'email', v_booking.email,
            'status', v_booking.status,
            'created_at', to_jsonb(v_booking.created_at)
          )
        );
      end if;
    end if;
  end if;

  -- Remember every outcome except 429 so retries replay it.
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into clinic_idempotency (key, fingerprint, status_code, response)
    values (p_idempotency_key, p_fingerprint, (v_result->>'status')::integer, v_result->'body')
    on conflict (key) do update
      set fingerprint = excluded.fingerprint,
          status_code = excluded.status_code,
          response = excluded.response;
  end if;

  return v_result;
end;
$$;

create or replace function clinic_list_bookings(
  p_email text,
  p_limit integer,
  p_cursor_created_at timestamptz default null,
  p_cursor_id text default null
)
returns jsonb
language sql
stable
as $$
  with filtered as (
    select id, slot_id, name, email, status, created_at
    from clinic_bookings
    where email = lower(btrim(p_email))
      and (
        p_cursor_created_at is null
        or created_at > p_cursor_created_at
        or (created_at = p_cursor_created_at and id > coalesce(p_cursor_id, ''))
      )
    order by created_at asc, id asc
    limit p_limit + 1
  ),
  page as (
    select * from filtered
    order by created_at asc, id asc
    limit p_limit
  )
  select jsonb_build_object(
    'bookings', coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', id,
          'slot_id', slot_id,
          'name', name,
          'email', email,
          'status', status,
          'created_at', to_jsonb(created_at)
        )
        order by created_at asc, id asc
      ) from page),
      '[]'::jsonb
    ),
    'next_cursor', (
      select case
        when (select count(*) from filtered) > p_limit
        then translate(
          replace(
            encode(
              convert_to(
                jsonb_build_object(
                  'created_at', to_jsonb(created_at),
                  'id', id
                )::text,
                'utf8'
              ),
              'base64'
            ),
            E'\n',
            ''
          ),
          '+/=',
          '-_'
        )
        else null
      end
      from page
      order by created_at desc, id desc
      limit 1
    )
  );
$$;

revoke all on function clinic_reset(jsonb) from public;
revoke all on function clinic_list_slots(text) from public;
revoke all on function clinic_book(text, text, text, text, text) from public;
revoke all on function clinic_list_bookings(text, integer, timestamptz, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function clinic_reset(jsonb) to service_role;
    grant execute on function clinic_list_slots(text) to service_role;
    grant execute on function clinic_book(text, text, text, text, text) to service_role;
    grant execute on function clinic_list_bookings(text, integer, timestamptz, text) to service_role;
  end if;
end;
$$;

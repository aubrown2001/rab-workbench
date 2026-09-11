-- RAB — Rigor Above Belief
-- Supabase / Postgres schema
--
-- The point of this schema is that an audit is NOT a blob. Claims and scores are
-- their own rows, so the questions worth asking can actually be asked:
--   which claim types get refuted most often
--   which model produces the most unsupported claims
--   whether reviewers are recording sources or just ticking boxes
--
-- Run once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- audits ----
create table if not exists audits (
  id              uuid primary key default gen_random_uuid(),
  title           text        not null,
  created_at      timestamptz not null default now(),
  created_by      text,                       -- reviewer, free text for now

  -- what was reviewed
  model_label     text,                       -- model that produced the answer under review
  response        text,
  prompt          text,
  question        text,
  answer          text,                       -- grounded answer, when Build path was used

  -- the standard it was held to (so a cleared audit is comparable to another)
  proof_standard  smallint,                   -- 1..3 source-check ticks required
  granularity     text,                       -- coarse | balanced | fine
  strictness      text,                       -- lenient | standard | harsh
  pass_mark       numeric(2,1),
  temperature     numeric(3,2),
  run_model       text,                       -- model used to generate, when Build path
  top_k           smallint,
  min_match       smallint,

  -- outcome
  verdict         text,                       -- Cleared | Partial | In review | Refuted | Below bar
  judge_avg       numeric(3,2),
  claim_count     integer default 0,
  cleared_count   integer default 0,

  payload         jsonb                       -- full state, so an audit can be reopened intact
);

create index if not exists audits_created_at_idx on audits (created_at desc);
create index if not exists audits_model_idx      on audits (model_label);
create index if not exists audits_verdict_idx    on audits (verdict);

-- ---------------------------------------------------------------- claims ----
create table if not exists claims (
  id               uuid primary key default gen_random_uuid(),
  audit_id         uuid not null references audits(id) on delete cascade,
  position         integer,
  text             text not null,
  claim_type       text,                      -- statistic | date | entity | regulation | causal | definition | general
  risk             text,                      -- high | medium | low
  status           text not null default 'unverified',
  tick_claim       boolean default false,
  tick_citation    boolean default false,
  tick_independent boolean default false,
  source_url       text,
  note             text
);

create index if not exists claims_audit_idx  on claims (audit_id);
create index if not exists claims_type_idx   on claims (claim_type);
create index if not exists claims_status_idx on claims (status);

-- ---------------------------------------------------------------- scores ----
create table if not exists scores (
  id            uuid primary key default gen_random_uuid(),
  audit_id      uuid not null references audits(id) on delete cascade,
  criterion     text not null,                -- machine id
  criterion_name text,                        -- what the rubric called it at the time
  score         numeric(2,1),
  justification text
);

create index if not exists scores_audit_idx on scores (audit_id);

-- ---------------------------------------------------------- help feedback ----
-- Verity uses ratings immediately inside the current browser visit. This table
-- keeps a durable copy so product owners can review patterns and improve the
-- help instructions over time. It does not train an AI provider's base model.
create table if not exists help_feedback (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  rating      smallint not null check (rating in (-1, 1)),
  question    text,
  response    text,
  reason      text,
  model       text,
  page        text
);

create index if not exists help_feedback_created_at_idx on help_feedback (created_at desc);

-- =========================================================== report views ===
-- Views rather than app-side aggregation: the numbers stay correct if you point
-- Metabase, Looker or a notebook at this database instead of using the app.

-- Not-cleared rate by claim type. The headline question: which kinds of claim
-- fail most often once a person actually checks them.
create or replace view v_claim_type_quality as
select
  coalesce(claim_type,'unspecified')                             as claim_type,
  count(*)                                                       as claims,
  count(*) filter (where status = 'verified')                    as verified,
  count(*) filter (where status = 'unsupported')                 as unsupported,
  count(*) filter (where status = 'refuted')                     as refuted,
  count(*) filter (where status = 'unverified')                  as unverified,
  round(100.0 * count(*) filter (where status in ('refuted','unsupported'))
        / nullif(count(*) filter (where status <> 'unverified'),0), 1) as not_cleared_pct
from claims
group by 1
order by not_cleared_pct desc nulls last;

-- Which model produces answers that survive checking. This is the number that
-- takes months to earn and is worth the whole exercise.
create or replace view v_model_quality as
select
  coalesce(a.model_label,'unspecified')                          as model_label,
  count(distinct a.id)                                           as audits,
  count(c.id)                                                    as claims,
  count(c.id) filter (where c.status in ('refuted','unsupported'))as not_cleared,
  round(100.0 * count(c.id) filter (where c.status in ('refuted','unsupported'))
        / nullif(count(c.id) filter (where c.status <> 'unverified'),0), 1) as not_cleared_pct,
  round(avg(a.judge_avg),2)                                      as avg_judge
from audits a
left join claims c on c.audit_id = a.id
group by 1
order by claims desc;

-- Reviewer discipline: a Refuted claim with no source recorded is a reviewer
-- guessing. If this number climbs, the archive is decoration.
create or replace view v_review_discipline as
select
  count(*) filter (where status in ('refuted','unsupported'))              as judged_against,
  count(*) filter (where status in ('refuted','unsupported')
                     and coalesce(trim(source_url),'') = '')               as no_source_recorded,
  round(100.0 * count(*) filter (where status in ('refuted','unsupported')
                                   and coalesce(trim(source_url),'') = '')
        / nullif(count(*) filter (where status in ('refuted','unsupported')),0), 1) as no_source_pct
from claims;

-- Volume over time.
create or replace view v_audits_weekly as
select
  date_trunc('week', created_at)::date as week,
  count(*)                             as audits,
  sum(claim_count)                     as claims,
  round(avg(judge_avg),2)              as avg_judge
from audits
group by 1
order by 1;

-- ============================================================ row security ===
-- The server talks to Supabase with a secret key and is the only writer,
-- so RLS is enabled with no public policy: nothing reaches these tables except
-- through the app's own API.
alter table audits enable row level security;
alter table claims enable row level security;
alter table scores enable row level security;
alter table help_feedback enable row level security;

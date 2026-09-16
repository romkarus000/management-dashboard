-- SQL [Bots] Funnel Metrics Daily
-- funnel_active (успех) = ВСЕ участники, кумулятивно по этапам
-- funnel_churned = только churned, точный этап отвала

WITH params AS (
  SELECT 7 AS churn_days,
         (timezone('Europe/Moscow', now()))::date AS today
),
base AS (
  SELECT
    u.tg_id,
    lower(trim(coalesce(u.survey_done::text, ''))) IN ('yes', 'done') AS has_survey,
    lower(trim(coalesce(u.goals_done::text, ''))) IN ('yes', 'done') AS has_goals,
    coalesce(nullif(regexp_replace(coalesce(u.days_no_reply::text, ''), '[^0-9-]', '', 'g'), '')::int, 0) AS days_no_reply,
    coalesce(nullif(replace(regexp_replace(coalesce(u.progress::text, ''), '[^0-9.,]', '', 'g'), ',', '.'), '')::numeric, 0) AS progress,
    CASE
      WHEN pomogator_da.parse_program_date(pc.end_date) IS NOT NULL
       AND pomogator_da.parse_program_date(pc.end_date) < (SELECT today FROM params)
      THEN true ELSE false
    END AS program_ended,
    EXISTS (
      SELECT 1 FROM pomogator_da.user_goals g
      WHERE g.tg_id = u.tg_id
        AND lower(trim(coalesce(g.type::text, ''))) = 'goal'
        AND coalesce(
          CASE
            WHEN nullif(trim(g.total_pct::text), '') ~ '^[0-9]+([.,][0-9]+)?%?$'
              THEN replace(regexp_replace(g.total_pct::text, '[^0-9.,]', '', 'g'), ',', '.')::numeric
            ELSE NULL
          END,
          0::numeric
        ) >= 100
    ) AS goal_hit
  FROM pomogator_da.users u
  LEFT JOIN pomogator_da.program_config pc
    ON pc.program_id = coalesce(nullif(btrim(u.program_id::text), ''), 'da-20')
),
staged AS (
  SELECT
    *,
    CASE
      WHEN program_ended THEN 5
      WHEN goal_hit OR progress >= 100 THEN 4
      WHEN has_goals THEN 3
      WHEN has_survey THEN 2
      ELSE 1
    END AS stage_rank,
    CASE
      WHEN program_ended THEN 'completed'
      WHEN days_no_reply >= (SELECT churn_days FROM params) THEN 'churned'
      ELSE 'active'
    END AS status
  FROM base
)
SELECT jsonb_build_object(
  'participants_total', count(*)::int,
  'participants_active', count(*) FILTER (WHERE status = 'active')::int,
  'participants_churned', count(*) FILTER (WHERE status = 'churned')::int,
  'participants_completed', count(*) FILTER (WHERE status = 'completed')::int,
  'funnel_active', jsonb_build_object(
    'entered', count(*) FILTER (WHERE stage_rank >= 1)::int,
    'survey', count(*) FILTER (WHERE stage_rank >= 2)::int,
    'goals_set', count(*) FILTER (WHERE stage_rank >= 3)::int,
    'goals_achieved', count(*) FILTER (WHERE stage_rank >= 4)::int,
    'completed', count(*) FILTER (WHERE stage_rank >= 5)::int
  ),
  'funnel_churned', jsonb_build_object(
    'entered', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 1)::int,
    'survey', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 2)::int,
    'goals_set', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 3)::int,
    'goals_achieved', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 4)::int,
    'completed', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 5)::int
  )
) AS metrics
FROM staged;

-- SCHEMA template below uses SCHEMA placeholder in repo docs; live nodes use concrete schemas

WITH params AS (
  SELECT 7 AS churn_days,
         (timezone('Europe/Moscow', now()))::date AS today
),
users_base AS (
  SELECT
    u.id AS user_id,
    u.created_at,
    ob.state_key,
    coalesce(ob.payload, '{}'::jsonb) AS payload,
    EXISTS (SELECT 1 FROM SCHEMA.messenger_identities mi WHERE mi.user_id = u.id) AS has_messenger,
    (
      SELECT max(
        CASE
          WHEN nullif(trim(mi.meta->>'last_message_at'), '') IS NULL THEN NULL
          WHEN (mi.meta->>'last_message_at') ~ '^[0-9]+$'
            THEN to_timestamp(((mi.meta->>'last_message_at')::bigint))
          ELSE (mi.meta->>'last_message_at')::timestamptz
        END
      )
      FROM SCHEMA.messenger_identities mi
      WHERE mi.user_id = u.id
    ) AS last_msg_at,
    EXISTS (
      SELECT 1 FROM SCHEMA.coaching_goals g
      WHERE g.user_id = u.id AND g.status IN ('draft', 'active', 'completed')
    ) AS has_goal,
    EXISTS (
      SELECT 1 FROM SCHEMA.coaching_goals g
      WHERE g.user_id = u.id AND g.status = 'completed'
    ) AS has_goal_done,
    EXISTS (
      SELECT 1 FROM SCHEMA.coaching_goals g
      WHERE g.user_id = u.id AND g.status IN ('draft', 'active')
    ) AS has_goal_open
  FROM SCHEMA.users u
  LEFT JOIN SCHEMA.user_onboarding ob ON ob.user_id = u.id
),
staged AS (
  SELECT
    *,
    (
      coalesce(payload->>'welcome_done', '') IN ('true', 't', '1')
      OR coalesce((payload->>'q_index')::int, 0) > 0
      OR coalesce(trim(payload->>'q1_display_name'), '') <> ''
      OR coalesce(trim(payload->>'user_gender'), '') <> ''
      OR state_key IN ('sp_funnel')
    ) AS has_survey,
    (
      has_goal
      OR coalesce(trim(payload->>'goal_approved_at'), '') <> ''
      OR coalesce(trim(payload->>'goal_phase'), '') <> ''
      OR coalesce(trim(payload->>'step1_text'), '') <> ''
    ) AS goals_set_flag,
    (has_goal_done AND NOT has_goal_open) AS is_completed,
    CASE
      WHEN last_msg_at IS NOT NULL
        THEN last_msg_at < (now() - ((SELECT churn_days FROM params) || ' days')::interval)
      ELSE created_at < (now() - ((SELECT churn_days FROM params) || ' days')::interval)
    END AS is_silent
  FROM users_base
  WHERE has_messenger
),
ranked AS (
  SELECT
    *,
    CASE
      WHEN is_completed THEN 5
      WHEN has_goal_done THEN 4
      WHEN goals_set_flag THEN 3
      WHEN has_survey THEN 2
      ELSE 1
    END AS stage_rank,
    CASE
      WHEN is_completed THEN 'completed'
      WHEN is_silent THEN 'churned'
      ELSE 'active'
    END AS status
  FROM staged
)
SELECT jsonb_build_object(
  'participants_total', count(*)::int,
  'participants_active', count(*) FILTER (WHERE status = 'active')::int,
  'participants_churned', count(*) FILTER (WHERE status = 'churned')::int,
  'participants_completed', count(*) FILTER (WHERE status = 'completed')::int,
  'debug', jsonb_build_object(
    'with_any_goal', count(*) FILTER (WHERE has_goal)::int,
    'with_any_completed_goal', count(*) FILTER (WHERE has_goal_done)::int,
    'fully_completed_no_open', count(*) FILTER (WHERE is_completed)::int
  ),
  'funnel_active', jsonb_build_object(
    'entered', count(*) FILTER (WHERE stage_rank >= 1)::int,
    'survey', count(*) FILTER (WHERE stage_rank >= 2)::int,
    'goals_set', count(*) FILTER (WHERE stage_rank >= 3)::int,
    'goals_achieved', count(*) FILTER (WHERE stage_rank >= 4)::int,
    'completed', count(*) FILTER (WHERE stage_rank >= 5)::int
  ),
  'funnel_churned', jsonb_build_object(
    'entered', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 1)::int,
    'survey', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 2)::int,
    'goals_set', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 3)::int,
    'goals_achieved', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 4)::int,
    'completed', count(*) FILTER (WHERE status = 'churned' AND stage_rank = 5)::int
  )
) AS metrics
FROM ranked;

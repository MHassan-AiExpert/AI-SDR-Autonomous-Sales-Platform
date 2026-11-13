-- =============================================================================
-- Website audits: people may attach their own audit links
--
-- Shared audit pages stay the platform's: nobody can create a share link or
-- change an audit the platform shared. Team members can still attach an audit
-- or proposal they made themselves, as before.
-- =============================================================================

create or replace function app.assets_client_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.share_token is not null and (tg_op = 'INSERT' or old.share_token is distinct from new.share_token) then
    raise exception 'Shared audits are created by the platform' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.share_token is not null then
    raise exception 'Shared audits are created by the platform' using errcode = '42501';
  end if;
  return new;
end;
$$;

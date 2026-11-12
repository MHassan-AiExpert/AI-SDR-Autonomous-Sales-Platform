-- Pin the search_path of the remaining trigger functions so they cannot be
-- redirected through schema shadowing (Supabase security advisor lint 0011).
alter function app.touch_updated_at() set search_path = '';
alter function app.track_lead_stage() set search_path = '';

-- =============================================================================
-- Inbound AI receptionist (SRS M14)
--
-- Calls to the company's number are answered by its Vapi receptionist
-- assistant, configured per call from the campaign and playbook. The
-- receptionist says it is an AI, answers from the company's notes and
-- playbook, takes messages, transfers to the team when asked, and offers a
-- meeting; callers become leads with the call recorded. When there is no
-- receptionist, calls go straight to the team's number.
-- =============================================================================

-- ---------------------------------------------------------------- campaigns
alter table public.campaigns
  add column receptionist_status              text not null default 'off' check (receptionist_status in ('off', 'live')),
  add column vapi_receptionist_assistant_id   text check (vapi_receptionist_assistant_id ~ '^[0-9a-f-]{36}$'),
  -- The Vapi phone number callers dial; its server URL is the workspace's Vapi webhook address
  add column vapi_inbound_number_id           text check (vapi_inbound_number_id ~ '^[0-9a-f-]{36}$'),
  -- Where callers are put through when they ask for a person, or when the receptionist is off
  add column receptionist_transfer_number     text check (receptionist_transfer_number ~ '^\+[1-9][0-9]{6,14}$'),
  -- Opening hours, address, FAQs the receptionist may answer from
  add column receptionist_notes               text check (length(receptionist_notes) <= 2000);
-- One campaign answers each number
create unique index campaigns_inbound_number_key on public.campaigns (workspace_id, vapi_inbound_number_id) where vapi_inbound_number_id is not null;

-- ---------------------------------------------------------------- calls
alter table public.calls drop constraint calls_outcome_check;
alter table public.calls add constraint calls_outcome_check
  check (outcome in ('booked', 'interested', 'callback', 'not_interested', 'wrong_number', 'do_not_call', 'voicemail', 'no_answer',
                     'failed', 'answered', 'transferred', 'spam'));

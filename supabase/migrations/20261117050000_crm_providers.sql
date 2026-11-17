-- =============================================================================
-- Salesforce and Pipedrive (F28)
--
-- CRM sync (F18) sent leads, deals and activity to HubSpot. A workspace now
-- chooses one CRM: HubSpot, Pipedrive or Salesforce. The sync job, the
-- schedule, the settings and the links table are shared; only the provider
-- module differs.
--
-- Links are kept per provider, so switching CRM starts the new one clean and
-- the old links stay for a switch back, instead of pointing new records at
-- ids that belong to another system.
-- =============================================================================

alter table public.integrations drop constraint integrations_tool_check;
alter table public.integrations add constraint integrations_tool_check check (tool in (
  'openai', 'anthropic', 'gemini', 'apollo', 'apify', 'zerobounce', 'instantly', 'twilio',
  'vapi', 'whatsapp', 'zoom', 'calendly', 'hubspot', 'slack', 'pandadoc', 'stripe',
  'hunter', 'pdl', 'pipedrive', 'salesforce'));

alter table public.workspaces
  add column crm_provider text not null default 'hubspot' check (crm_provider in ('hubspot', 'pipedrive', 'salesforce'));

-- Salesforce ids are 15 or 18 letters and digits; HubSpot and Pipedrive use numbers
alter table public.crm_links drop constraint crm_links_provider_check;
alter table public.crm_links add constraint crm_links_provider_check check (provider in ('hubspot', 'pipedrive', 'salesforce'));
alter table public.crm_links drop constraint crm_links_external_id_check;
alter table public.crm_links add constraint crm_links_external_id_check check (external_id ~ '^[A-Za-z0-9]{1,30}$');


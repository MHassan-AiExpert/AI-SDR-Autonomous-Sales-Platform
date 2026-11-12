import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, assignableRoles, canInvite, canManageMember, isRole, type Role } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { addMember, changeMemberRole, removeMember } from '../actions';

export const metadata: Metadata = { title: 'Team' };

type Member = { user_id: string; email: string; role: string; joined_at: string };

export default async function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace, user } = await requireWorkspace(workspaceId);
  const { data } = await supabase.rpc('workspace_members_list', { ws: workspace.id });
  const members = ((data ?? []) as Member[]).filter((m) => isRole(m.role)) as (Member & { role: Role })[];
  const grantable = assignableRoles(workspace.role);

  return (
    <>
      <h1>Team</h1>
      <section className="card" aria-labelledby="members">
        <h2 id="members">Members</h2>
        <ul className="members">
          {members.map((m) => {
            const isSelf = m.user_id === user.id;
            const editable = canManageMember(workspace.role, m.role) && !isSelf;
            return (
              <li key={m.user_id} className="member">
                <div>
                  <p className="member-email">{m.email}{isSelf ? ' (you)' : ''}</p>
                  <p className="muted">{ROLE_LABELS[m.role]}: {ROLE_DESCRIPTIONS[m.role]}</p>
                </div>
                {editable ? (
                  <div className="row">
                    <ActionForm action={changeMemberRole} className="row">
                      <input type="hidden" name="workspace_id" value={workspace.id} />
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <label className="sr-only" htmlFor={`role-${m.user_id}`}>Role for {m.email}</label>
                      <select id={`role-${m.user_id}`} name="role" defaultValue={m.role}>
                        {grantable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                      <SubmitButton variant="secondary">Change role</SubmitButton>
                    </ActionForm>
                    <ActionForm action={removeMember}>
                      <input type="hidden" name="workspace_id" value={workspace.id} />
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <SubmitButton variant="ghost">Remove</SubmitButton>
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {canInvite(workspace.role) ? (
        <section className="card stack" aria-labelledby="add">
          <h2 id="add">Add a team member</h2>
          <p className="muted">They need an account first. Ask them to sign up, then add them here by email.</p>
          <ActionForm action={addMember} className="stack" resetOnSuccess>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" required autoComplete="off" />
            </label>
            <label className="field">
              <span>Role</span>
              <select name="role" defaultValue="rep">
                {grantable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}: {ROLE_DESCRIPTIONS[r]}</option>)}
              </select>
            </label>
            <SubmitButton>Add member</SubmitButton>
          </ActionForm>
        </section>
      ) : (
        <p className="muted">Only owners and admins can add or change team members.</p>
      )}
    </>
  );
}

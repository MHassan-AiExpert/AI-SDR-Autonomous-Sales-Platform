'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/action-form';
import { FIELD_LABELS, IMPORT_FIELDS, MAX_BYTES, MAX_ROWS, buildRows, detectColumns, parseCsv, previewCounts, type ImportField } from '@/lib/csv';
import { importLeads } from '../../actions';

type Campaign = { id: string; name: string };

// The file is read in the browser so nothing is uploaded until the mapping is
// confirmed; only the mapped rows are sent to the server.
export function ImportForm({ workspaceId, campaigns }: { workspaceId: string; campaigns: Campaign[] }) {
  const [state, action] = useActionState(importLeads, {});
  const [filename, setFilename] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>>>({});
  const [fileError, setFileError] = useState('');

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileError(''); setHeaders([]); setDataRows([]);
    if (!file) return;
    if (file.size > MAX_BYTES) { setFileError('That file is larger than 5 MB. Split it and import in parts.'); return; }
    const rows = parseCsv(await file.text());
    if (rows.length < 2) { setFileError('That file has no rows under its header.'); return; }
    setFilename(file.name);
    setHeaders(rows[0]);
    setDataRows(rows.slice(1));
    setMapping(detectColumns(rows[0]));
  }

  const rows = headers.length ? buildRows(dataRows, mapping) : [];
  const counts = previewCounts(rows);
  const ready = counts.usable > 0;

  return (
    <div className="stack">
      <label className="field">
        <span>CSV file</span>
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
        <small className="muted">Up to {MAX_ROWS.toLocaleString('en-US')} rows and 5 MB. The first row must be the column headings.</small>
      </label>
      {fileError ? <p className="form-message form-error" role="alert">{fileError}</p> : null}

      {headers.length ? (
        <form action={action} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="filename" value={filename} />
          <input type="hidden" name="rows" value={JSON.stringify(rows)} />

          <fieldset className="stack">
            <legend>Match your columns</legend>
            <div className="grid-2">
              {IMPORT_FIELDS.map((f) => (
                <label key={f} className="field">
                  <span>{FIELD_LABELS[f]}</span>
                  <select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">Not in this file</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span>Add to campaign (optional)</span>
            <select name="campaign_id" defaultValue="">
              <option value="">No campaign</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>

          <section className="card stack">
            <h3>Preview</h3>
            <p>
              <strong>{counts.total.toLocaleString('en-US')}</strong> rows read.{' '}
              <strong>{counts.usable.toLocaleString('en-US')}</strong> have an email, phone or LinkedIn address.
              {counts.unusable ? <> <span className="badge badge-warn">{counts.unusable} will be skipped</span></> : null}
            </p>
            <p className="muted">Leads already here, and anyone on your suppression list, are skipped automatically.</p>
            {rows.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr>{IMPORT_FIELDS.filter((f) => mapping[f] !== undefined).map((f) => <th key={f} scope="col">{FIELD_LABELS[f]}</th>)}</tr></thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i}>{IMPORT_FIELDS.filter((f) => mapping[f] !== undefined).map((f) => <td key={f}>{r[f] ?? '—'}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          {state?.error ? <p className="form-message form-error" role="alert">{state.error}</p> : null}
          {state?.notice ? <p className="form-message form-ok" role="status">{state.notice}</p> : null}
          {ready ? <SubmitButton>Import {counts.usable.toLocaleString('en-US')} leads</SubmitButton> : <p className="muted">No row in this file has a usable contact. Check the column matching above.</p>}
        </form>
      ) : null}
    </div>
  );
}

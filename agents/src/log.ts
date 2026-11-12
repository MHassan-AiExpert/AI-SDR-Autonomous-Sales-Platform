// Structured JSON logs. Never pass credentials or full request bodies here.

type Fields = Record<string, unknown>;

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Fields = {}) {
  if (process.env.LOG_LEVEL === 'silent') return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

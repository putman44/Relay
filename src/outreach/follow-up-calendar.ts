// src/outreach/follow-up-calendar.ts
export function canonicalTimeZone(timeZone: string): string {
  if (!timeZone || (timeZone !== 'UTC' && !timeZone.includes('/'))) throw new Error('An explicit IANA time zone is required.');
  return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
}
export function localCalendarDate(at: Date, timeZone: string): string {
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid calendar timestamp.');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: canonicalTimeZone(timeZone),
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  const value = `${get('year')}-${get('month')}-${get('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Unsupported calendar date.');
  return value;
}
export function addCalendarDays(day: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(days)) throw new Error('Invalid calendar day or interval.');
  const at = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0,10) !== day) throw new Error('Invalid calendar day.');
  at.setUTCDate(at.getUTCDate() + days);
  const result = at.toISOString().slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('Unsupported resulting date.');
  return result;
}
export function followUpSchedule(initialSentAt: Date, confirmedFollowUps: Date[], timeZone: string, now: Date) {
  const zone = canonicalTimeZone(timeZone);
  if (confirmedFollowUps.length > 2 || confirmedFollowUps.some(d => !Number.isFinite(d.getTime()))) throw new Error('Invalid follow-up history.');
  const today = localCalendarDate(now, zone);
  localCalendarDate(initialSentAt, zone);
  if (confirmedFollowUps.length === 2) return { timeZone: zone, number: null, dueDate: null, isDue: false };
  const anchor = confirmedFollowUps[0] ?? initialSentAt;
  const dueDate = addCalendarDays(localCalendarDate(anchor, zone), confirmedFollowUps.length ? 5 : 4);
  return { timeZone: zone, number: confirmedFollowUps.length + 1, dueDate, isDue: today >= dueDate };
}

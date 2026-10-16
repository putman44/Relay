import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addCalendarDays, canonicalTimeZone, followUpSchedule, localCalendarDate } from '../../src/outreach/follow-up-calendar.js';

test('Follow-up calendar: first touch is four local calendar days, not 96 elapsed hours', () => {
  const sent = new Date('2026-03-07T06:59:00Z'); // March 6, 23:59 in Denver, before spring DST.
  assert.equal(localCalendarDate(sent,'America/Denver'),'2026-03-06');
  assert.deepEqual(followUpSchedule(sent,[],'America/Denver',new Date('2026-03-10T05:59:59Z')),
    { timeZone:'America/Denver',number:1,dueDate:'2026-03-10',isDue:false });
  assert.equal(followUpSchedule(sent,[],'America/Denver',new Date('2026-03-10T06:00:00Z')).isDue,true);
});
test('Follow-up calendar: second touch uses first confirmed send plus five local days across fall DST', () => {
  const initial = new Date('2026-10-20T16:00:00Z'), first = new Date('2026-10-31T05:59:00Z');
  assert.equal(localCalendarDate(first,'America/Denver'),'2026-10-30');
  const plan = followUpSchedule(initial,[first],'America/Denver',new Date('2026-11-04T07:00:00Z'));
  assert.equal(plan.dueDate,'2026-11-04'); assert.equal(plan.number,2); assert.equal(plan.isDue,true);
  assert.deepEqual(followUpSchedule(initial,[first,new Date('2026-11-04T12:00:00Z')],'America/Denver',new Date()),
    { timeZone:'America/Denver',number:null,dueDate:null,isDue:false });
});
test('Follow-up calendar: leap days, year rollover and date-line zones are calendar-safe', () => {
  assert.equal(addCalendarDays('2028-02-27',4),'2028-03-02');
  assert.equal(addCalendarDays('2026-12-30',5),'2027-01-04');
  assert.equal(localCalendarDate(new Date('2026-10-16T12:00:00Z'),'Pacific/Kiritimati'),'2026-10-17');
  assert.equal(canonicalTimeZone('UTC'),'UTC');
});
test('Follow-up calendar: invalid zones, dates, timestamps and counts reject', () => {
  for (const zone of ['', 'Denver','Invalid/Zone']) assert.throws(() => canonicalTimeZone(zone));
  assert.throws(() => addCalendarDays('2026-02-30',4)); assert.throws(() => addCalendarDays('2026-01-01',0.5));
  assert.throws(() => localCalendarDate(new Date(NaN),'UTC'));
  assert.throws(() => followUpSchedule(new Date(),[new Date(),new Date(),new Date()],'UTC',new Date()));
});

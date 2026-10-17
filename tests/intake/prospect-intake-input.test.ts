import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseProspectIntakeArgs } from '../../src/operator/prospect-intake-input.js';
import { parseProspectIntakePayload } from '../../src/intake/prospect-intake.js';

test('Prospect intake input: accepts a strict normalized prospect payload', () => {
  const requestId = randomUUID();
  const value = parseProspectIntakePayload({
    requestId,
    companyName: '  Dev By Taylor  ',
    website: 'https://devbytaylor.com',
    industry: '  Software  ',
    contactName: '',
    contactEmail: 'Taylor@DevByTaylor.com',
    primaryDiscoveryQuestion: '  How are new inquiries handled?  ',
  });
  assert.deepEqual(value, {
    requestId,
    companyName: 'Dev By Taylor',
    website: 'https://devbytaylor.com/',
    industry: 'Software',
    contactName: null,
    contactEmail: 'taylor@devbytaylor.com',
    primaryDiscoveryQuestion: 'How are new inquiries handled?',
  });
});

test('Prospect intake input: rejects unsafe URLs, invalid email and unknown fields', () => {
  const requestId = randomUUID();
  assert.throws(() => parseProspectIntakePayload({ requestId, companyName: 'A', website: 'http://devbytaylor.com' }));
  assert.throws(() => parseProspectIntakePayload({ requestId, companyName: 'A', website: 'https://devbytaylor.com',
    contactEmail: 'two@example.com,three@example.com' }));
  assert.throws(() => parseProspectIntakePayload({ requestId, companyName: 'A', website: 'https://devbytaylor.com', surprise: true }));
});

test('Prospect intake CLI: requires an input path and explicit confirmation', () => {
  assert.deepEqual(parseProspectIntakeArgs(['--input', '/tmp/prospect.json', '--confirm-create-prospect']),
    { inputPath: '/tmp/prospect.json' });
  assert.throws(() => parseProspectIntakeArgs(['--input', '/tmp/prospect.json']));
  assert.throws(() => parseProspectIntakeArgs(['--input', '/tmp/prospect.json', '--confirm-create-prospect', '--extra']));
});

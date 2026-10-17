import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseProspectIntakeArgs } from '../src/operator/prospect-intake-input.js';
import { parseProspectIntakePayload } from '../src/intake/prospect-intake.js';

async function main(): Promise<void> {
  const command = parseProspectIntakeArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(command.inputPath, 'utf8')) as unknown;
  const input = parseProspectIntakePayload(raw);
  const { db } = await import('../src/db.js');
  try {
    const { createProspectFromIntake } = await import('../src/intake/prospect-intake.js');
    const result = await createProspectFromIntake(input, db);
    console.log(JSON.stringify(result));
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Prospect intake failed.');
  process.exitCode = 1;
});

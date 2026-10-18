export type ProspectIntakeCommand = { inputPath: string };

export function parseProspectIntakeArgs(args: string[]): ProspectIntakeCommand {
  if (args.length === 3 && args[0] === '--input' && args[1]?.trim()
    && args[2] === '--confirm-create-prospect') {
    return { inputPath: args[1] };
  }
  throw new Error('Use --input /absolute/path/to/prospect.json --confirm-create-prospect.');
}

// JSON.parse messages can quote input text, so parse failures use a fixed message.
export function parseProspectIntakeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Prospect intake input is not valid JSON.');
  }
}

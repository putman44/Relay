export type ProspectIntakeCommand = { inputPath: string };

export function parseProspectIntakeArgs(args: string[]): ProspectIntakeCommand {
  if (args.length === 3 && args[0] === '--input' && args[1]?.trim()
    && args[2] === '--confirm-create-prospect') {
    return { inputPath: args[1] };
  }
  throw new Error('Use --input /absolute/path/to/prospect.json --confirm-create-prospect.');
}

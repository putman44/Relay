export type ResearchCommand = { action: 'status'; prospectId: string }
  | { action: 'start'; prospectId: string }
  | { action: 'start-safe'; prospectId: string }
  | { action: 'resume'; requestId: string }
  | { action: 'retry-pre-artifact'; requestId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseResearchArgs(args: string[]): ResearchCommand {
  if (args.length === 3 && args[0] === 'status' && args[1] === '--prospect' && UUID.test(args[2]!)) {
    return { action: 'status', prospectId: args[2]! };
  }
  if (args.length === 4 && args[0] === 'start' && args[1] === '--prospect'
    && UUID.test(args[2]!) && args[3] === '--confirm-research') {
    return { action: 'start', prospectId: args[2]! };
  }
  if (args.length === 4 && args[0] === 'start-safe' && args[1] === '--prospect'
    && UUID.test(args[2]!) && args[3] === '--confirm-research-only') {
    return { action: 'start-safe', prospectId: args[2]! };
  }
  if (args.length === 4 && args[0] === 'resume' && args[1] === '--request'
    && UUID.test(args[2]!) && args[3] === '--confirm-resume') {
    return { action: 'resume', requestId: args[2]! };
  }
  if (args.length === 4 && args[0] === 'retry-pre-artifact' && args[1] === '--request'
    && UUID.test(args[2]!) && args[3] === '--confirm-retry-pre-artifact') {
    return { action: 'retry-pre-artifact', requestId: args[2]! };
  }
  throw new Error('Use status --prospect UUID, start --prospect UUID --confirm-research, '
    + 'start-safe --prospect UUID --confirm-research-only, '
    + 'resume --request UUID --confirm-resume, or '
    + 'retry-pre-artifact --request UUID --confirm-retry-pre-artifact.');
}

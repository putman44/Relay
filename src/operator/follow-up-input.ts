import { canonicalTimeZone } from '../outreach/follow-up-calendar.js';
import { requireUuid } from '../outreach/follow-up-state.js';

export type FollowUpCommand = { action:'plan'; prospectId:string; timeZone:string }
  | { action:'draft'; prospectId:string; timeZone:string }
  | { action:'approve'; draftId:string } | { action:'send'; draftId:string };
export function parseFollowUpArgs(args: string[]): FollowUpCommand {
  const action = args[0];
  if ((action === 'plan' || action === 'draft') && args.length === (action === 'plan' ? 5 : 6)
    && args[1] === '--prospect' && args[2] && args[3] === '--time-zone' && args[4]
    && (action === 'plan' || args[5] === '--confirm-create-draft')) {
    requireUuid(args[2]); return { action,prospectId:args[2],timeZone:canonicalTimeZone(args[4]) };
  }
  if ((action === 'approve' || action === 'send') && args.length === 4 && args[1] === '--draft' && args[2]
    && args[3] === (action === 'approve' ? '--confirm-approve' : '--confirm-send')) {
    requireUuid(args[2]); return { action,draftId:args[2] };
  }
  throw new Error('Invalid follow-up command or missing explicit confirmation.');
}

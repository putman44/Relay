import type { ResearchRequest } from '../research/prospect-research.js';

// gmailDraftAllowed is the policy stored on the durable research request row.
export function researchMutationOutput(request: ResearchRequest) {
  return { id: request.id, prospectId: request.prospect_id, status: request.status,
    folderId: request.folder_id, briefId: request.brief_id, briefUrl: request.brief_url,
    gmailDraftId: request.gmail_draft_id, gmailDraftAllowed: request.gmail_draft_allowed };
}

export function researchStatusOutput(request: ResearchRequest | null) {
  return request && { ...researchMutationOutput(request), lastError: request.last_error };
}

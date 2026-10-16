import { createGmailDraftSender, type GmailDraftApi } from "./gmail-draft-sender.js";
import { verifyGmailDraftSnapshot, type GmailDraftReadApi } from "./gmail-draft-preflight.js";
import { GmailPreflightError } from "./gmail-preflight-error.js";
import type { GmailDraftSender } from "./gmail-types.js";

export const createVerifiedGmailDraftSender = (
  api: GmailDraftApi & GmailDraftReadApi,
): GmailDraftSender => async (draftId, approved) => {
  if (!approved) throw new GmailPreflightError("Gmail draft preflight requires the approved database content.");
  let verified;
  try {
    const { data } = await api.users.drafts.get({ userId: "me", id: draftId, format: "raw" });
    verified = await verifyGmailDraftSnapshot(draftId, approved, data);
  } catch (error) {
    if (error instanceof GmailPreflightError) throw error;
    // No send endpoint has been invoked. Do not expose raw API errors or MIME.
    throw new GmailPreflightError("Gmail draft preflight could not retrieve or inspect the draft.", { cause: error });
  }
  // Pass the inspected raw snapshot in the send request: a concurrent Gmail edit
  // cannot substitute different content or recipients after validation.
  return createGmailDraftSender(api, verified)(draftId);
};

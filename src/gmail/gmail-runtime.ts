// src/gmail/gmail-runtime.ts

import {
  createGmailApi,
  createGmailOAuthClient,
  loadGmailCredentials,
  type GmailEnvironment,
} from "./gmail-auth.js";
import { createGmailDraftSender } from "./gmail-draft-sender.js";
import type { GmailDraftSender } from "./gmail-types.js";

export function createProductionGmailDraftSender(
  environment: GmailEnvironment = process.env,
): GmailDraftSender {
  const credentials = loadGmailCredentials(environment);
  const oauthClient = createGmailOAuthClient(credentials);
  const gmailApi = createGmailApi(oauthClient);

  return createGmailDraftSender(gmailApi);
}

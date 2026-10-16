// src/gmail/gmail-runtime.ts

import {
  createGmailApi,
  createGmailOAuthClient,
  loadGmailCredentials,
  type GmailEnvironment,
} from "./gmail-auth.js";
import { createVerifiedGmailDraftSender } from "./gmail-verified-draft-sender.js";
import type { GmailDraftSender } from "./gmail-types.js";
import { createGmailDraftCreator, type GmailDraftCreator } from "./gmail-draft-creator.js";
import { createGmailThreadReader } from "./gmail-thread-reader.js";

export function createProductionGmailThreadReader(environment: GmailEnvironment = process.env) {
  return createGmailThreadReader(createGmailApi(createGmailOAuthClient(loadGmailCredentials(environment))));
}

export function createProductionGmailDraftCreator(
  environment: GmailEnvironment = process.env,
): GmailDraftCreator {
  const credentials = loadGmailCredentials(environment);
  const oauthClient = createGmailOAuthClient(credentials);
  return createGmailDraftCreator(createGmailApi(oauthClient));
}

export function createProductionGmailDraftSender(
  environment: GmailEnvironment = process.env,
): GmailDraftSender {
  const credentials = loadGmailCredentials(environment);
  const oauthClient = createGmailOAuthClient(credentials);
  const gmailApi = createGmailApi(oauthClient);

  return createVerifiedGmailDraftSender(gmailApi);
}

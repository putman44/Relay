// scripts/verify-gmail-api.ts

import "dotenv/config";

import type { gmail_v1 } from "googleapis";

import {
  createGmailApi,
  createGmailOAuthClient,
  loadGmailCredentials,
} from "../src/gmail/gmail-auth.js";

const draftId = process.argv[2];

if (!draftId) {
  throw new Error("Provide a Gmail draft ID");
}

async function main(draftId: string): Promise<void> {
  const credentials = loadGmailCredentials();
  const oauthClient = createGmailOAuthClient(credentials);
  const gmailApi = createGmailApi(oauthClient);

  const params: gmail_v1.Params$Resource$Users$Drafts$Get = {
    userId: "me",
    id: draftId,
    format: "metadata",
  };

  const response = await gmailApi.users.drafts.get(params);

  console.log({
    draftId: response.data.id,
    messageId: response.data.message?.id,
    threadId: response.data.message?.threadId,
  });
}

main(draftId).catch((error) => {
  console.error(error);
  process.exit(1);
});

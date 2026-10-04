// src/gmail/fake-gmail.ts
import type { GmailSendResult } from "./gmail-types.js";

export const fakeGmailSend = async (
  simulateFailure: boolean,
): Promise<GmailSendResult> => {
  if (simulateFailure) {
    return { status: "uncertain", error: "Simulated Gmail timeout" };
  }

  return {
    status: "sent",
    messageId: "TEST_MESSAGE_ID",
    threadId: "TEST_THREAD_ID",
  };
};

import PostalMime from "postal-mime";
import type { ApprovedGmailDraft } from "./gmail-types.js";
import { GmailPreflightError } from "./gmail-preflight-error.js";

export type GmailDraftSnapshot = {
  id?: string | null;
  message?: {
    id?: string | null;
    threadId?: string | null;
    labelIds?: string[] | null;
    raw?: string | null;
  };
};

export type GmailDraftReadApi = {
  users: {
    drafts: {
      get: (request: { userId: string; id: string; format: "raw" }) => Promise<{ data: GmailDraftSnapshot }>;
    };
  };
};

function stop(reason: string): never {
  throw new GmailPreflightError(`Gmail draft preflight blocked: ${reason}`);
}

const newlines = (value: string): string => value.replace(/\r\n?/g, "\n");

export const verifyGmailDraftSnapshot = async (
  draftId: string,
  approved: ApprovedGmailDraft,
  snapshot: GmailDraftSnapshot,
): Promise<{ raw: string; threadId: string }> => {
  const message = snapshot.message;
  if (snapshot.id !== draftId || !message?.id?.trim() || !message.threadId?.trim()) {
    stop("draft identity is missing or does not match.");
  }
  if (!message.labelIds?.includes("DRAFT") || message.labelIds.includes("SENT")) {
    stop("message is not an unsent Gmail draft.");
  }
  if (approved.threadId && message.threadId !== approved.threadId) {
    stop("thread does not match the stored draft.");
  }
  const raw = message.raw;
  if (!raw || raw.length > 350_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) {
    stop("raw MIME is missing, invalid, or exceeds the inspection limit.");
  }
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw.replace(/=+$/, "")) {
    stop("raw MIME encoding is malformed.");
  }
  const source = bytes.toString("utf8");
  const headerBlock = source.split(/\r?\n\r?\n/, 1)[0];
  if (!headerBlock || headerBlock.length === source.length || source.includes("\0")
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/.test(headerBlock)) {
    stop("MIME headers are malformed.");
  }
  let hasHeader = false;
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && hasHeader) continue;
    if (!/^[!\x23-\x39\x3b-\x7e]+:/.test(line)) stop("MIME header syntax is ambiguous.");
    hasHeader = true;
  }
  let email;
  try {
    email = await PostalMime.parse(bytes);
  } catch {
    return stop("MIME could not be decoded.");
  }
  const headers = email.headers;
  const count = (name: string) => headers.filter((h) => h.key === name).length;
  if (count("to") !== 1 || count("subject") !== 1 || count("content-type") !== 1
    || count("content-transfer-encoding") > 1 || count("from") > 1) {
    stop("required headers are missing or duplicated.");
  }
  if (headers.some((h) => ["cc", "bcc", "reply-to", "apparently-to"].includes(h.key) || h.key.startsWith("resent-"))) {
    stop("additional recipient or reply-routing headers require new review.");
  }
  const to = email.to;
  const recipient = to?.[0];
  if (to?.length !== 1 || !recipient || !("address" in recipient)
    || !recipient.address || recipient.address.toLowerCase() !== approved.recipientEmail.toLowerCase()) {
    stop("recipient differs from the approved recipient.");
  }
  const contentType = headers.find((h) => h.key === "content-type")?.value ?? "";
  if (!/^text\/plain(?:\s*;|\s*$)/i.test(contentType)
    || email.html !== undefined || email.attachments.length > 0) {
    stop("only reviewed plain-text drafts without attachments are supported.");
  }
  if (email.subject !== approved.subject) stop("subject differs from the approved subject.");
  if (email.text === undefined || newlines(email.text) !== newlines(approved.body)) {
    stop("body differs from the approved body.");
  }
  return { raw, threadId: message.threadId };
};

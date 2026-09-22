import { fakeGmailSend } from "./fake-gmail.js";

const success = await fakeGmailSend(false);
const failure = await fakeGmailSend(true);

console.log("Success result:");
console.log(success);

console.log("\nFailure result:");
console.log(failure);

if (success.status === "sent") {
  console.log(success.messageId);
  console.log(success.threadId);
}
if (failure.status === "uncertain") {
  console.log(failure.error);
}

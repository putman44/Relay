// tests/deployment/systemd-monitor.test.ts
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readDeploymentFile = async (name: string): Promise<string> =>
  readFile(new URL(`../../deploy/systemd/${name}`, import.meta.url), "utf8");

test("Systemd monitor: schedules only the read-only monitor", async () => {
  const [service, timer] = await Promise.all([
    readDeploymentFile("relay-outreach-monitor.service"),
    readDeploymentFile("relay-outreach-monitor.timer"),
  ]);

  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/env RELAY_ENABLE_LIVE_OUTREACH_SEND=false \/usr\/bin\/npm run monitor:outreach$/m,
  );
  assert.match(service, /^Environment=RELAY_ENABLE_LIVE_OUTREACH_SEND=false$/m);
  assert.doesNotMatch(service, /worker:outreach/);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.doesNotMatch(timer, /worker/);
});

test("Systemd monitor: applies a non-root, read-only security boundary", async () => {
  const service = await readDeploymentFile("relay-outreach-monitor.service");

  assert.match(service, /^User=relay$/m);
  assert.match(service, /^Group=relay$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=true$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
});

test("Systemd monitor: environment template contains no Gmail credentials", async () => {
  const environment = await readDeploymentFile("monitor.env.example");

  assert.match(environment, /^DATABASE_URL=postgresql:\/\//m);
  assert.match(environment, /^RELAY_ENABLE_LIVE_OUTREACH_SEND=false$/m);
  assert.doesNotMatch(environment, /GOOGLE_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)/);
});

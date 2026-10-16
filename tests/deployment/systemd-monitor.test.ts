// tests/deployment/systemd-monitor.test.ts
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readDeploymentFile = async (name: string): Promise<string> =>
  readFile(new URL(`../../deploy/systemd/${name}`, import.meta.url), "utf8");

const readRepositoryFile = async (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), "utf8");

test("Systemd monitor: schedules only the read-only monitor", async () => {
  const [service, timer] = await Promise.all([
    readDeploymentFile("relay-outreach-monitor.service"),
    readDeploymentFile("relay-outreach-monitor.timer"),
  ]);

  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/docker run .* relay-outreach-monitor:local$/m,
  );
  assert.match(service, /--env RELAY_ENABLE_LIVE_OUTREACH_SEND=false/);
  assert.match(service, /--env-file \/etc\/relay\/monitor\.env/);
  assert.match(
    service,
    /^ExecStartPre=\/usr\/bin\/docker image inspect relay-outreach-monitor:local$/m,
  );
  assert.doesNotMatch(service, /\/usr\/bin\/npm/);
  assert.doesNotMatch(service, /worker:outreach/);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.doesNotMatch(timer, /worker/);
});

test("Systemd monitor: applies host and container security boundaries", async () => {
  const service = await readDeploymentFile("relay-outreach-monitor.service");

  assert.match(service, /^User=root$/m);
  assert.match(service, /^Group=root$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=true$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.match(service, /--read-only/);
  assert.match(service, /--security-opt no-new-privileges:true/);
  assert.match(service, /--cap-drop=ALL/);
  assert.match(service, /--user 1000:1000/);
  assert.doesNotMatch(service, /--privileged/);
  assert.doesNotMatch(service, /--volume|\s-v\s/);
});

test("Systemd monitor: environment template contains no Gmail credentials", async () => {
  const environment = await readDeploymentFile("monitor.env.example");

  assert.match(environment, /^DATABASE_URL=postgresql:\/\//m);
  assert.match(environment, /^RELAY_ENABLE_LIVE_OUTREACH_SEND=false$/m);
  assert.doesNotMatch(environment, /GOOGLE_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)/);
});

test("Docker monitor: image contains only the monitor entrypoint", async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    readRepositoryFile("deploy/docker/relay-monitor.Dockerfile"),
    readRepositoryFile(".dockerignore"),
  ]);

  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["\.\/node_modules\/\.bin\/tsx", "scripts\/monitor-outreach\.ts"\]$/m,
  );
  assert.match(
    dockerfile,
    /^COPY --chown=node:node scripts\/monitor-outreach\.ts \.\/scripts\/monitor-outreach\.ts$/m,
  );
  assert.doesNotMatch(dockerfile, /run-outreach-worker|gmail-runtime/);
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
});

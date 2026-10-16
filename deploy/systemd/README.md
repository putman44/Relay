# Relay Docker + systemd monitor deployment

These files build and schedule only the read-only outreach monitor. The image
does not contain the worker entrypoint, and the unit does not install, enable,
or start the outreach worker.

## Host assumptions

- Relay source is available at `/opt/relay` for image builds and documentation.
- Docker Engine is installed and active, with the CLI at `/usr/bin/docker`.
- `/etc/relay/monitor.env` contains only the monitor environment.
- The production Postgres endpoint is reachable from a Docker bridge network.

Node.js and npm are not required on the host. The monitor runtime and locked npm
dependencies are installed inside `relay-outreach-monitor:local`.

## Build the monitor-only image

Run these commands from `/opt/relay` as an administrator:

```bash
docker build --pull --file deploy/docker/relay-monitor.Dockerfile --tag relay-outreach-monitor:local .
docker image inspect relay-outreach-monitor:local
```

The Dockerfile copies only the monitor entrypoint and its database/status
modules. It does not copy `scripts/run-outreach-worker.ts` or Gmail runtime
modules into the image.

## Install without starting

```bash
install -d -o root -g root -m 0700 /etc/relay
install -o root -g root -m 0600 deploy/systemd/monitor.env.example /etc/relay/monitor.env
install -o root -g root -m 0644 deploy/systemd/relay-outreach-monitor.service /etc/systemd/system/relay-outreach-monitor.service
install -o root -g root -m 0644 deploy/systemd/relay-outreach-monitor.timer /etc/systemd/system/relay-outreach-monitor.timer
systemctl daemon-reload
```

Replace the placeholder `DATABASE_URL` in `/etc/relay/monitor.env` before any
validation run. Do not add Gmail credentials to the monitor environment.
Use a dedicated database login with only CONNECT, schema USAGE, and SELECT on
`outreach_jobs`, `message_drafts`, and `prospects`. Filesystem restrictions do
not restrict database permissions. Docker environment files use literal
`KEY=value` lines; do not add shell quotes or `export` prefixes.

A database listening on the host's `127.0.0.1` is not reachable at that address
inside the container. Verify its network route before deployment; do not expose
Postgres publicly to work around this.

## Validate before enabling

First validate the unit definitions:

```bash
systemd-analyze verify /etc/systemd/system/relay-outreach-monitor.service /etc/systemd/system/relay-outreach-monitor.timer
```

Then run the same hardened, ephemeral container used by systemd:

```bash
docker run --pull=never --rm --name relay-outreach-monitor-validation --env-file /etc/relay/monitor.env --env RELAY_ENABLE_LIVE_OUTREACH_SEND=false --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --security-opt no-new-privileges:true --cap-drop=ALL --user 1000:1000 --pids-limit 64 --memory 256m --cpus 0.50 relay-outreach-monitor:local
```

Review the JSON and confirm the exit code is `0`. Exit `2` means Relay found an
operational alert and must be investigated before scheduling is enabled.
Before enabling the timer, also run the installed service once to verify its
systemd sandbox and Docker socket access, then inspect its result and logs:

```bash
systemctl start relay-outreach-monitor.service
systemctl show relay-outreach-monitor.service -p Result -p ExecMainStatus
journalctl -u relay-outreach-monitor.service --since today
```

The host unit runs with Docker daemon access, which is administrator-level
access. Its private network applies to the Docker CLI; the daemon creates the
monitor container with normal outbound bridge networking. No Docker socket,
host directories, or ports are mounted or published inside that container.
The service uses `--pull=never`, so scheduling cannot download a missing image.

## Enable the monitor only

```bash
systemctl enable --now relay-outreach-monitor.timer
systemctl list-timers relay-outreach-monitor.timer
journalctl -u relay-outreach-monitor.service --since today
```

Do not create or enable a worker timer until live outreach is separately
approved. See `docs/Relay_Production_Operations_Runbook.md` for response and
rollback rules.

## Update and rollback

Before replacing the image or unit, disable the timer and retain the previous
image and unit files. Do not overwrite an existing production environment file
with the example during updates.

```bash
systemctl disable --now relay-outreach-monitor.timer
systemctl stop relay-outreach-monitor.service
docker tag relay-outreach-monitor:local relay-outreach-monitor:previous
```

Build and manually validate the replacement, then validate the installed
service before re-enabling the timer. To restore the retained image:

```bash
docker tag relay-outreach-monitor:previous relay-outreach-monitor:local
```

If the unit changed, restore its saved version and run `systemctl daemon-reload`
as well. Validate once before re-enabling the timer. Stopping this monitor does
not change queue or message state.

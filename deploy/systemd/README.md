# Relay systemd monitor deployment

These files schedule only the read-only outreach monitor. They do not install,
enable, or start the outreach worker.

## Host assumptions

- Relay is deployed to `/opt/relay`.
- A non-login `relay` user and group own the deployment.
- Node.js and npm are installed system-wide, with npm at `/usr/bin/npm`.
- `/etc/relay/monitor.env` contains only the monitor environment.

Verify the npm path with `command -v npm` before installing the unit. If it is
not `/usr/bin/npm`, update `ExecStart` in the service before copying it.

## Install without starting

Run these commands as an administrator on the host:

```bash
install -d -o root -g relay -m 0750 /etc/relay
install -o root -g relay -m 0640 deploy/systemd/monitor.env.example /etc/relay/monitor.env
install -o root -g root -m 0644 deploy/systemd/relay-outreach-monitor.service /etc/systemd/system/relay-outreach-monitor.service
install -o root -g root -m 0644 deploy/systemd/relay-outreach-monitor.timer /etc/systemd/system/relay-outreach-monitor.timer
systemctl daemon-reload
```

Replace the placeholder `DATABASE_URL` in `/etc/relay/monitor.env` before any
validation run. Do not add Gmail credentials to the monitor environment.

## Validate before enabling

```bash
systemd-analyze verify /etc/systemd/system/relay-outreach-monitor.service /etc/systemd/system/relay-outreach-monitor.timer
sudo -u relay env -i PATH=/usr/bin:/bin HOME=/tmp NPM_CONFIG_CACHE=/tmp/relay-npm-cache npm --prefix /opt/relay run monitor:outreach
```

Review the JSON and confirm the exit code is `0`. Exit `2` means Relay found an
operational alert and must be investigated before scheduling is enabled.

## Enable the monitor only

```bash
systemctl enable --now relay-outreach-monitor.timer
systemctl list-timers relay-outreach-monitor.timer
journalctl -u relay-outreach-monitor.service --since today
```

Do not create or enable a worker timer until live outreach is separately
approved. See `docs/Relay_Production_Operations_Runbook.md` for response and
rollback rules.

# __TEAM__

## Your three links

| | |
|---|---|
| **Your app** | https://__TEAM__.capstone.uamishub.com |
| **Your terminal** | https://__TEAM__-console.uamishub.com |
| **Your repo** | https://github.com/UA-MIS/__TEAM__ |

Sign in to the terminal with GitHub. You land in a shell as `ubuntu` on your own virtual machine. No SSH key, no client to install.

There is **one** environment. No dev, no staging, no separate database console — if you change something, you change the live site.

---

## What you have

A virtual machine running **Ubuntu 24.04** — 4 CPU, 4 GB RAM, 30 GB disk. It is a normal Linux box and you have `sudo` with no password.

Already installed: **Node 22**, **pnpm 9.15** (this project uses pnpm, *not* npm), **MySQL 8.0** on `127.0.0.1:3306`, **MinIO** for file storage, **Caddy** as the reverse proxy, plus `git` and `gh`.

There is **no Docker** and you do not need it. The repo has a `docker-compose.yml` — that file is for running the project on a laptop. On this VM those same services are installed directly.

## Where things live

```
/opt/crimsoncopies/<service>     the deployed app services
/etc/capstone/Caddyfile          the reverse proxy config actually in use
```

Everything runs under `systemd` and starts automatically on boot:

```bash
systemctl status cc-orders-api        # check a service
journalctl -u cc-orders-api -n 50     # read its log
sudo systemctl restart cc-orders-api  # restart it
```

The app services are named `cc-*`. Also running: `mysql`, `minio`, `caddy`.

## How traffic reaches your app

```
internet  ->  Caddy on :80  ->  your app on 127.0.0.1:3000
```

Port 80 is the only way in. Your apps listen on localhost; Caddy is what makes them public. Change which port an app listens on and you must change `/etc/capstone/Caddyfile` too, or the site stops working.

> `deploy/vm/Caddyfile` in the repo is **not** the file in use — it still has placeholders in it. Sorting that out is part of your work.

## The database

MySQL runs locally, already created, with the connection string in `.env`. It is yours alone and **it is not backed up**. Two accounts are seeded so you can log in:

| Username | Password |
|---|---|
| `staff` | `staffpass123` |
| `customer` | `customerpass123` |

There are **no orders** in the database. An empty staff queue is expected.

## The components

Four Node services, each its own `systemd` unit, all listening on localhost. Caddy on `:80` is the only thing the internet can reach.

| Service | Unit | Port | What it does |
|---|---|---|---|
| orders-api | `cc-orders-api` | 4000 | the API, and the only thing that writes to MySQL |
| storefront | `cc-storefront` | 3000 | the public shop — this is what `/` serves |
| staff-console | `cc-staff-console` | 3001 | the staff side — not reachable from the internet yet |
| notify | `cc-notify` | 4100 | notifications (a stub — see below) |

Supporting them: `mysql` (3306), `minio` (9000), `caddy` (80).

**The staff console has no public URL.** It answers on `3001` inside the VM, but nothing routes to it from outside: `/staff` is a 404, and the `staff.__TEAM__.capstone.uamishub.com` vhost in the Caddyfile neither resolves nor can be issued a certificate on the current plan. From your terminal you can still reach it with `curl localhost:3001`. Publishing it is a platform change, not something you can fix in the guest — so the seeded `staff` login is for later.

Config lives in `/etc/capstone/env/<service>.env` — that is where `DATABASE_URL`, the ports and the shared `INTERNAL_API_KEY` come from. Change a value there and the service needs a restart to see it.

## Restarting things

**After changing config** in `/etc/capstone/env/`:

```bash
sudo systemctl restart cc-orders-api      # or whichever service
```

**After changing code** — the deploy builds *whatever is in the clone on this VM*. It does not fetch anything. So if the change was made anywhere else — your laptop, a pull request, a teammate's push — **pull it in first**:

```bash
cd ~/__TEAM__
git pull                              # bring the VM's clone up to date
sudo capstone-app-deploy ~/__TEAM__   # then build and publish it
```

Skip the `git pull` and you will rebuild the code you already had, watch it succeed, and see nothing change on the site. That is the most common way to lose an hour here.

The deploy builds the workspace, runs migrations, publishes to `/opt/crimsoncopies/` and restarts the `cc-*` units. It takes a while — this VM has no hardware virtualisation, so a full build is roughly half an hour. Nothing runs it for you: pushing to GitHub does **not** update the VM.

**Restart everything:**

```bash
sudo systemctl restart cc-orders-api cc-notify cc-storefront cc-staff-console
```

**Check what is running:**

```bash
systemctl status 'cc-*'
journalctl -u cc-orders-api -n 50 -f
```

Order matters if you restart by hand: `cc-orders-api` first, since the two web apps call it.

## Things that will confuse you if nobody says them

- **It's `pnpm`, not `npm`.**
- The app is a workspace — `apps/orders-api`, `apps/storefront`, `apps/staff-console`, `services/notify` — each running as its own service.
- **`services/notify` doesn't send anything.** It logs what it *would* have sent and returns success. That's how you received it.
- Database migrations run from `apps/orders-api`, not the repo root.
- **Nothing deploys automatically.** Pushing to GitHub does not update the VM; `sudo capstone-app-deploy` is what does.

## If the site is down

```bash
curl -I localhost:80          # is Caddy answering?
systemctl status caddy
systemctl status 'cc-*'       # are the app services up?
journalctl -u cc-orders-api -n 50
```

A **502** means Caddy is running but the app behind it is not. That is the most common failure and it is almost always in the app's log, not Caddy's.

## How we work

- Work is tracked on this board; pick up anything in **Ready**.
- Branches are created from a work item with **Start work**; pull requests link back automatically.
- A merged pull request moves its item to **Resolved**; a human accepts it to **Closed**.

*If something here disagrees with the machine, the machine is right — fix this page.*

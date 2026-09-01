# Your VM — what it is and how it's wired

You've inherited a running system. This is the reference sheet for it. It is short on purpose: it tells you what exists and where, not why every decision was made. Some of it you will want to change.

---

## The machine

A virtual machine running **Ubuntu 24.04**, 4 CPU, 4 GB RAM, 30 GB disk.

It is a normal Linux box. You have `sudo` with no password. There is no one else on it.

## Getting in

Open **`https://<your-team>-console.uamishub.com`** and sign in with GitHub. You land in a terminal as the user `ubuntu`. No SSH key, no client to install.

You only get in if you are a member of your team on GitHub. If you get a permission error, that's why.

## The two URLs

| URL | What it is |
|---|---|
| `https://<team>.capstone.uamishub.com` | your app, in public |
| `https://<team>-console.uamishub.com` | your terminal |

There is no other way in from the internet. Port 80 is the only door.

---

## What's already installed

| | Version | Notes |
|---|---|---|
| Node | 22 | the workspace requires >= 22 |
| pnpm | 9.15 | this project uses pnpm, **not** npm |
| MySQL | 8.0 | local, on `127.0.0.1:3306` |
| MinIO | current | S3-compatible file storage, `127.0.0.1:9000` |
| Caddy | 2.6 | the reverse proxy, owns port 80 |
| git, gh | | `gh` is the GitHub CLI |

There is **no Docker** on this machine, and you do not need it. The repo has a `docker-compose.yml` — that file is for running the project on a laptop. On this VM those same services are installed directly.

## Where things live

```
/opt/crimsoncopies/<service>     the deployed app services
/etc/capstone/Caddyfile          the reverse proxy config that is actually in use
/var/www/app/                    a placeholder page, served on :8080 as a fallback
```

## The services

Everything runs under `systemd`. Useful commands:

```bash
systemctl status cc-orders-api      # check one
journalctl -u cc-orders-api -n 50   # read its log
sudo systemctl restart cc-orders-api
```

The app services are named `cc-*`. Also running: `mysql`, `minio`, `caddy`, and `capstone-console` (that's your terminal — leave it alone).

Everything starts automatically on boot. If you reboot the VM, it comes back on its own.

## How traffic reaches your app

```
internet -> Caddy on :80 -> the app on 127.0.0.1:3000
```

Nothing else is exposed. Your apps listen on localhost only; Caddy is what makes them public. If you change which port an app listens on, you must also change `/etc/capstone/Caddyfile` or your site will stop working.

> `deploy/vm/Caddyfile` in the repo is **not** the file in use. It has placeholders in it. Sorting that out is part of your work.

---

## The database

MySQL is running locally with a database and user already created. The connection string is in `.env`. It is not shared with any other team, and it is not backed up — if you drop it, it's gone.

Two accounts are seeded so you can log in to the app:

| Username | Password |
|---|---|
| `staff` | `staffpass123` |
| `customer` | `customerpass123` |

There are **no orders** in the database. An empty staff queue is expected, not a bug.

## Getting the code

```bash
gh auth login          # choose GitHub.com, HTTPS, "login with a web browser"
git clone https://github.com/UA-MIS/<your-team>.git
```

Use the **HTTPS** clone URL. The SSH one (`git@github.com:...`) will hang and time out — this VM can only make outbound connections on port 443.

---

## Things that will confuse you if nobody tells you

- **It's `pnpm`, not `npm`.** `npm install` will not do the right thing here.
- **The app is a workspace** — `apps/orders-api`, `apps/storefront`, `apps/staff-console`, `services/notify`. They run as separate services.
- **`services/notify` doesn't send anything.** It logs what it *would* have sent and returns success. That's how you received it.
- **Database migrations must run from `apps/orders-api`**, not the repo root. They use a relative path and will fail from anywhere else.
- **Your VM has no automatic deploys.** Nothing rebuilds when you push. Getting new code onto this machine and restarting the right service is your job — that is the point of the exercise.

## If the site is down

In order:

```bash
curl -I localhost:80          # is Caddy answering?
systemctl status caddy
systemctl status 'cc-*'       # are the app services up?
journalctl -u cc-orders-api -n 50
```

A **502** means Caddy is running but the app behind it is not. That is the most common failure and it is almost always in the app's log, not in Caddy's.

---

*Written 2026-09-01. If something here disagrees with the machine, the machine is right — write down what you found.*

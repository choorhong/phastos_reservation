# Deployment on DigitalOcean

The same single-server setup as `docs/deployment.md` (Docker Compose with
`docker-compose.prod.yml`, the three apps plus Postgres, Redis, RabbitMQ
and Kafka in containers), on a DigitalOcean Droplet instead of EC2. Only
three things differ:

| | AWS (`docs/deployment.md`) | DigitalOcean (this file) |
|---|---|---|
| Images | ECR | **GitHub Container Registry** (`ghcr.io/choorhong/phastos-*`), pushed by CI with its own token |
| Deploy | Systems Manager, no open port | **SSH from GitHub Actions** with a deploy key that can only run `deploy <commit>` (`deploy/ssh-entry.sh`) |
| Backups | S3 bucket from the stack | **Cloudflare R2** (S3-compatible), keys in `.env.backup` |

Everything else is shared, and this file points back to it: configuring
`.env.production` (`deployment.md` section 4), HTTPS with Caddy or nginx
(section 5), checking the stack (section 6), restoring a backup (section 8)
and day-to-day commands (section 9). The AWS files stay in the repo
(`deploy/aws-setup.yml`, `deploy/ssm-deploy.sh`) in case of a move back.

## 1. The Droplet

**Create → Droplets:**

- **Region:** Singapore (SGP1).
- **Image:** Ubuntu 24.04 (LTS) x64.
- **Size:** Basic → Regular. **4 GB / 2 CPUs** is comfortable; **2 GB /
  1 CPU** works with 2 GB of swap (section 3), since the server never builds
  images. The stack uses about 0.9 GB at idle.
- **Authentication:** SSH key: your personal key, for your own logins.
- **Hostname:** `phastos`.
- **Advanced options:** tick **Add improved metrics monitoring and
  alerting** (free).

**Firewall:** Networking → Firewalls → Create Firewall `phastos`. Inbound:
**SSH (22)**, **HTTP (80)** and **HTTPS (443)** from all IPv4 and IPv6
addresses. Apply it to the Droplet. Port 22 has to accept GitHub's runners,
whose addresses change; logins are key-only, and CI's key can only deploy
(section 5).

**Alerts** (free), by email. The metrics agent (`do-agent`, installed by
the "improved metrics monitoring" option; check with
`systemctl is-active do-agent`) must be running, or memory and disk alerts
never fire.

- **Resource alerts** (Monitoring → Resource alerts → Create resource
  alert, for the Droplet): **Disk utilization > 80%** for 5 minutes,
  **Memory utilization > 85%** for 5 minutes, **CPU > 90%** for 10 minutes.
  There is no "Droplet is running" option in the current UI; the uptime
  check below covers it.
- **Uptime check** (Monitoring → Uptime): `https://api.phastos.app/health`,
  alert when it has been down for **2 minutes or more**. Anything shorter
  would email you after every deploy, which restarts the api for a few
  seconds.

DigitalOcean also emails you if the Droplet goes down for maintenance or
host failure. Nothing monitors failed emails or failed backups yet: check
`~/phastos-backup.log` and the notification dead-letter queues by hand.

The Droplet keeps its public IPv4 address for as long as it exists, so a
Reserved IP is optional.

## 2. DNS (Cloudflare)

Add an **A** record **`api`** pointing at the Droplet's IPv4 address,
proxy status **DNS only (grey cloud)**. The email records for
`mail.phastos.app` are already in place (`deployment.md`, section 1, DNS).
Wait until `dig +short api.phastos.app` returns the Droplet's address
before the first deploy, or Caddy's certificate request fails.

## 3. Server setup

Log in as root with your personal key, then:

```bash
apt-get update && apt-get -y upgrade

# Docker Engine + the compose plugin
curl -fsSL https://get.docker.com | sh

# A user for the app: owns the checkout, runs Docker, receives deploys
adduser --disabled-password --gecos '' deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys   # your personal key, for your own logins
chown deploy:deploy /home/deploy/.ssh/authorized_keys

# AWS CLI: backup.sh uses it to upload to R2 (S3-compatible)
snap install aws-cli --classic

# 2 GB swap: a safety margin; required on a 2 GB Droplet
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

From now on, log in as `deploy` (`ssh deploy@<ip>`; update `User` in your
`~/.ssh/config` entry). Docker group membership is root-equivalent on this
machine, so treat that login like root.

## 4. Code and configuration

As `deploy`:

```bash
cd ~
git clone https://github.com/choorhong/phastos_reservation.git
cd phastos_reservation
cp .env.production.example .env.production
chmod 600 .env.production
```

Fill in `.env.production` as in `deployment.md` section 4. On DigitalOcean:

- `IMAGE_REGISTRY=ghcr.io/choorhong` (already set in the example).
- `COMPOSE_PROFILES=proxy` for the bundled Caddy (already set).
- Leave `BACKUP_BUCKET` commented out: backups are configured in
  `.env.backup` (section 7).

Add the `dcp` alias from `deployment.md` section 5 to `~/.bashrc`.

## 5. The CI deploy key

CI gets its **own** key, separate from yours, and the server lets it run
only `deploy/ssh-entry.sh`, which accepts exactly `deploy <40-character
commit hash>`: no shell, no other commands, no port forwarding.

On your Mac:

```bash
ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f ~/.ssh/phastos_ci_deploy
cat ~/.ssh/phastos_ci_deploy.pub                 # for the server, below
ssh-keyscan -t ed25519 <droplet-ip>               # for DEPLOY_KNOWN_HOSTS, below
```

On the server, as `deploy`, add one line to `~/.ssh/authorized_keys`
(paste the public key where shown):

```
command="/home/deploy/phastos_reservation/deploy/ssh-entry.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA...paste... github-actions-deploy
```

Check the host key you scanned is really the server's: on the server,
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` must show the same
fingerprint as `ssh-keygen -lf <(ssh-keyscan -t ed25519 <droplet-ip>)` on
your Mac.

In GitHub → repo → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_SSH_KEY` | the **private** key: `cat ~/.ssh/phastos_ci_deploy` (all of it, including the BEGIN/END lines) |
| Secret | `DEPLOY_KNOWN_HOSTS` | the `ssh-keyscan` line (`<ip> ssh-ed25519 AAAA...`) |
| Variable | `DEPLOY_HOST` | the Droplet's IPv4 address |
| Variable | `DEPLOY_USER` | `deploy` |

Then save the private key in Bitwarden and delete it from your Mac
(`rm ~/.ssh/phastos_ci_deploy*`): only GitHub needs it.

Setting `DEPLOY_HOST` turns deploys on. Until then CI only builds and
pushes images.

## 6. First deploy

GitHub → Actions → **CI** → **Run workflow** (branch `master`). It runs
the tests, pushes the four images to GHCR, then the **Deploy** job SSHes
in and runs `deploy <commit>`. On the server that checks out the commit and
runs `deploy/deploy.sh`, which logs in to GHCR with the job's short-lived
token, pulls, starts everything (`migrate` first), waits until it's all
healthy, then logs out again. The job's log shows the output.

Then check it as in `deployment.md` section 6
(`curl -s https://api.phastos.app/health`).

**Images on GHCR** came out **public**, taking the repository's visibility
(checked: anonymous pulls of all four work). That's fine, since the
repository is public and the images contain no secrets, and it means a
hand-run rollback or `dcp pull` on the server needs no login. If you ever
make them private (Package settings → Change visibility), deploys still
work through the job's token, but hand-run pulls then need
`docker login ghcr.io` with a personal access token that has only
`read:packages`.

## 7. Backups to Cloudflare R2

1. **Cloudflare → R2 → Create bucket** `phastos-backups` (location: Asia-
   Pacific if offered).
2. **Bucket → Settings → Object lifecycle rules → Add rule:** prefix
   `postgres/`, delete objects 30 days after upload.
3. **R2 → Manage API tokens → Create API token:** permission **Object Read
   & Write**, restricted to the bucket `phastos-backups`. Note the **Access
   Key ID**, the **Secret Access Key** (shown once) and the **S3 endpoint**
   (`https://<account id>.r2.cloudflarestorage.com`). Save them in
   Bitwarden.
4. On the server, as `deploy`:

   ```bash
   cd ~/phastos_reservation
   cp deploy/env.backup.example .env.backup
   chmod 600 .env.backup
   nano .env.backup        # bucket, endpoint, the two keys
   ./deploy/backup.sh      # ends with "uploaded s3://phastos-backups/postgres/..."
   ```

5. The cron line from `deployment.md` section 8, as `deploy` (`crontab -e`).

`.env.backup` is separate from `.env.production` on purpose: every app
container gets `.env.production`, and none of them needs the R2 keys.

Unlike the AWS setup, an R2 token that can write can also delete, so the
server could delete backups. R2's **bucket lock** rules (bucket → Settings)
can block deletion for a set time if you want that protection.

**Restoring** works as in `deployment.md` section 8, downloading with R2's
endpoint:

```bash
set -a; source .env.backup; set +a
aws s3 ls --endpoint-url "$BACKUP_S3_ENDPOINT" --region auto --recursive "s3://$BACKUP_BUCKET/postgres/" | tail -5
aws s3 cp --endpoint-url "$BACKUP_S3_ENDPOINT" --region auto "s3://$BACKUP_BUCKET/postgres/<path>.dump" restore.dump
```

## Release flow

Work goes on **`develop`**; **`master`** only changes through pull requests
from `develop`, and every merge into `master` deploys.

| Event | CI |
|---|---|
| Push to `develop` | nothing |
| Pull request `develop` → `master` | tests + image builds, shown as checks on the PR (re-run on every new push to `develop` while the PR is open) |
| Merge into `master` | tests, images pushed to GHCR, **deploy** |

To release: open a pull request from `develop` into `master`
(`https://github.com/choorhong/phastos_reservation/compare/master...develop`),
wait for the checks, then merge with **Create a merge commit**. Squash or
rebase merges give `master` different commits from `develop`, so the next
pull request would show already-released changes again.

Protect `master` (Settings → Rules → Rulesets → New branch ruleset, target
`master`): require a pull request before merging, require the status
checks **Typecheck, unit + e2e tests** and the four **Build … image**
jobs, and block force pushes. Leave yourself out of the bypass list if
you want the rule to apply to you too.

## 8. Rolling back

Any commit CI pushed images for, on the server as `deploy` (needs GHCR
access, see section 6):

```bash
cd ~/phastos_reservation
git fetch && git checkout --detach <commit> && ./deploy/deploy.sh <commit>
```

GHCR keeps every pushed image until you delete it (no 10-image limit as on
ECR). Delete old versions from the package page now and then.

## Pausing and shutting down

**Powering off a Droplet does not stop the billing:** the machine stays
reserved for you. Only **destroying** it stops the charges, and that
deletes everything on it, including the database. So take a copy of the
data first, in either case.

### Pausing

| Option | Saves money? | Notes |
|---|---|---|
| `dcp stop` on the server | No | Takes the app offline, keeps the Droplet and its data. For a short maintenance window. |
| Power off in the console | **No** | Still billed. Not worth it. |
| **Snapshot, then destroy** | Yes, except the snapshot's storage (a few cents per GB per month) | Later, create a Droplet from the snapshot: everything comes back as it was. |
| **Final backup, then destroy** | Yes, the most | Later, rebuild from this runbook (about 30 minutes) and restore the dump (`deployment.md` section 8, with R2's endpoint as in section 7 above). Needs the R2 backups set up first. |

A Droplet created from a snapshot, or rebuilt, gets a **new IPv4 address**.
Then update the `api` DNS record, the `DEPLOY_HOST` variable and the IP in
the `DEPLOY_KNOWN_HOSTS` secret. A snapshot keeps the server's SSH host
key, so only the IP in that line changes; a rebuilt server has a new host
key, so scan it again (section 5).

Switch these off while the server is down:

- **`DEPLOY_HOST`** (GitHub variable): clear or delete it. The Deploy job
  only runs when it's set, so merges into `master` keep passing instead of
  failing to reach a server that doesn't exist.
- **The uptime check and any alerts**, or they email you continuously.
  Alerts tied to the Droplet go with it; the uptime check doesn't.
- **The `api` DNS record**, when the Droplet is destroyed. Once its IP is
  released, another DigitalOcean customer can be given it, and a record
  still pointing there would send `api.phastos.app` to their server.

### No longer needed

1. **Take a final backup** and keep a copy you control (the R2 bucket, or
   download the dump).
2. **Destroy the Droplet** and any snapshots you don't need.
3. **Remove the `api` DNS record.**
4. **GitHub:** delete the secrets `DEPLOY_SSH_KEY` and
   `DEPLOY_KNOWN_HOSTS`, and the variables `DEPLOY_HOST` and `DEPLOY_USER`.
5. **Remove the uptime check** in DigitalOcean.
6. **Revoke the production Resend key** (Resend → API Keys).

Optional: delete the AWS stack `phastos-setup` if you won't use AWS again
(it costs almost nothing; its backup bucket is kept on purpose when the
stack is deleted, so remove that separately). GitHub, GHCR and Cloudflare
cost nothing while idle; the domain renews yearly.

## If the deploy job fails

| Message | Cause |
|---|---|
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` doesn't match the server (or the Droplet was rebuilt): scan and check it again (section 5) |
| `Permission denied (publickey)` | The public key isn't in `/home/deploy/.ssh/authorized_keys`, or `DEPLOY_USER`/`DEPLOY_SSH_KEY` is wrong |
| `refused: this key only accepts ...` | Something other than the deploy job used the key; the job always sends `deploy <commit>` |
| `denied` / `unauthorized` while pulling | The packages aren't readable by the job's token: Package settings → Manage Actions access → add this repository |
| A service not healthy | The job log shows `deploy.sh`'s output; then `dcp logs <service>` on the server |

## Cost

About **$24/month** for a 4 GB Droplet (about $12 for 2 GB). GHCR is free
for this. R2's free tier (around 10 GB stored) covers the backups. Check
current prices on each provider's site.

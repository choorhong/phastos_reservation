# Deployment (single EC2 instance, self-hosted services)

Everything runs on one host with Docker Compose (`docker-compose.prod.yml`):
the three apps, plus Postgres, Redis, RabbitMQ and Kafka in containers next
to them. This is the simplest setup that works. Its main limitation is that
the one instance is a single point of failure (see "Limits" at the end).

Deploys are automatic: every push to `master` that passes CI builds the
images, pushes them to Amazon ECR, and has the instance pull and restart
them through AWS Systems Manager (section 7). The instance never builds
anything, and nothing needs SSH or stored keys to deploy.

```
internet ──80/443──► reverse proxy (bundled caddy, or your own nginx)
                          │
                          ▼ 127.0.0.1:3000
                         api ──► postgres, redis, rabbitmq, kafka
  rabbitmq ──► notification-worker ──► postgres, Resend
     kafka ──► event-consumer      ──► postgres

Only the api (127.0.0.1) and the RabbitMQ admin page (127.0.0.1:15672) are
published on the host; everything else is on the compose network only.
```

## 0. One-time AWS setup

Do this before launching the instance: it creates the instance's IAM role.

1. **Create the stack.** CloudFormation → **Create stack → With new
   resources** → **Upload a template file** → `deploy/aws-setup.yml` from
   this repo. Name it `phastos-setup`. In the same region as the instance
   (e.g. `ap-southeast-1`, Singapore).
   - Parameters: the defaults fit this repo. Set
     **CreateGitHubOidcProvider** to `false` only if IAM → Identity
     providers already lists `token.actions.githubusercontent.com` (an
     account can have only one).
   - Tick "I acknowledge that AWS CloudFormation might create IAM resources
     with custom names", then **Submit**.

   It creates:
   - four ECR repositories (`phastos-api`, `phastos-notification-worker`,
     `phastos-event-consumer`, `phastos-migrate`), each keeping the last 10
     images;
   - `phastos-github-deploy`, the role GitHub Actions assumes. Only runs on
     `master` of this repository can use it, and it can only push to those
     four repositories and run commands on instances tagged `App=phastos`;
   - `phastos-ec2`, the instance role: Systems Manager plus read-only ECR.
2. **Note the stack's Outputs:** `DeployRoleArn`, `ImageRegistry` and
   `InstanceProfileName`.
3. **Tell GitHub about it.** GitHub repo → Settings → Secrets and variables
   → Actions → **Variables** tab → add two repository variables:
   - `AWS_REGION`: e.g. `ap-southeast-1`
   - `AWS_DEPLOY_ROLE_ARN`: the `DeployRoleArn` output

   These are variables, not secrets: neither is sensitive, since the role
   can only be assumed from this repository's `master` branch. Until
   `AWS_DEPLOY_ROLE_ARN` is set, CI only builds images and never deploys.

## 1. The instance

- **Size:** at idle the whole stack uses about 0.9 GB of memory (measured
  locally: Kafka ~370 MB, RabbitMQ ~190 MB, each app 70–100 MB, Postgres
  ~70 MB). Images are built by CI, not on the instance, so it only needs
  room to run them.
  - **t3.small (2 vCPU, 2 GB)** is the minimum, with 2 GB of swap (below).
  - **t3.medium (4 GB)** is comfortable; **t3.large (8 GB)** if other apps
    share the instance.
  - Not a t3.micro (1 GB): the stack doesn't fit.
- **OS:** Ubuntu 24.04 LTS (the commands below assume it).
- **Disk:** 20 GB gp3. **8 GB is not enough.** Measured: the images alone
  are ~3.75 GB (Kafka 1.31 GB, Postgres 0.64 GB, RabbitMQ 0.39 GB, the
  three apps ~0.73 GB together, `migrate` ~0.58 GB). Ubuntu + Docker add
  ~3 GB, and a deploy briefly holds two releases' app images (+~1.3 GB)
  before `deploy.sh` removes the old ones. Use 30 GB if you will also build
  images on the instance (`--build`, ~1.5 GB of build cache). Container
  logs are capped at 3 × 10 MB per service in the compose file.
- **IAM instance profile:** `phastos-ec2` (from section 0; launch wizard →
  Advanced details → IAM instance profile). Without it the deploy can't
  reach the instance or pull images.
- **Tag:** `App` = `phastos` (launch wizard → Name and tags → Add
  additional tags). The deploy targets the instance by this tag.
- **Elastic IP:** attach one, so the address (and the DNS record that points
  at it) survives a stop/start.
- **Security group (inbound):**
  - 22 (SSH) from **your IP only**. Deploys don't use SSH at all.
  - 80 and 443 from anywhere, only if this host serves HTTPS.
  - Nothing else. Postgres, Redis, RabbitMQ and Kafka are not published at
    all, and the api listens on 127.0.0.1 only.

### DNS (Cloudflare, `phastos.app`)

The domain is registered with Cloudflare Registrar, so its DNS lives in the
Cloudflare dashboard (phastos.app → DNS → Records).

| Name | Type | Points to | Purpose |
|---|---|---|---|
| `api` | A | the Elastic IP, **DNS only (grey cloud)** | The api, `https://api.phastos.app`. Add this once the instance exists. |
| `send.mail` | CNAME | `send.forge.rmta.net` (from Resend) | Bounces + SPF for `mail.phastos.app` |
| `resend._domainkey.mail` | TXT | DKIM key (from Resend) | Signs mail from `mail.phastos.app` |
| `_dmarc` | TXT | `v=DMARC1; p=none;` | DMARC, monitor only; tighten to `p=quarantine` later |

The three email records are already in place, and `mail.phastos.app` is
verified in Resend.

- **Keep `api` on DNS only (grey cloud)**, at least at first. With
  Cloudflare's proxy on (orange cloud), Cloudflare terminates HTTPS itself,
  which can get in the way of Caddy/certbot getting their own certificate.
  It can be turned on later with SSL mode *Full (strict)*.
- **`.app` is HTTPS-only.** The whole `.app` top-level domain is on the
  browsers' HSTS preload list, so `http://api.phastos.app` never loads in a
  browser. HTTPS through Caddy or certbot (section 5) isn't optional.

## 2. Install Docker

```bash
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh        # Docker Engine + compose plugin
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version                              # check it works

sudo snap install aws-cli --classic                 # deploy.sh uses it to log in to ECR
sudo snap services amazon-ssm-agent                 # preinstalled on Ubuntu EC2 images; should be "active"

# 2 GB swap -- a safety margin; required on a 2 GB instance (t3.small)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Docker starts on boot by default, and every service is `restart:
unless-stopped`, so the stack comes back by itself after a reboot.

## 3. Get the code

As the `ubuntu` user, into its home directory: the deploy runs
`~/phastos_reservation/deploy/deploy.sh` as `ubuntu`.

```bash
cd ~
git clone https://github.com/choorhong/phastos_reservation.git
cd phastos_reservation
```

If the repository is private, add a read-only **deploy key** (GitHub → repo
→ Settings → Deploy keys) for the instance instead of copying your own key
onto it.

## 4. Configure `.env.production`

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Replace every `CHANGE_ME`:

| Variable | How to fill it |
|---|---|
| `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD` | `openssl rand -hex 24` |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `KAFKA_CLUSTER_ID` | `docker run --rm confluentinc/cp-kafka:7.6.0 kafka-storage random-uuid`. Set once, never change. |
| `RESEND_API_KEY` | A **sending-only** key from Resend, separate from your dev key |
| `EMAIL_FROM` | Already set: `Phastos <no-reply@mail.phastos.app>` (verified in Resend) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The admin account created at first start. Remove both lines once it exists. |
| `API_DOMAIN` | Already set: `api.phastos.app`. Only used by the `caddy` proxy. |
| `IMAGE_REGISTRY` | The `ImageRegistry` output from section 0, e.g. `123456789012.dkr.ecr.ap-southeast-1.amazonaws.com` |
| `COMPOSE_PROFILES` | `proxy` (default) to run the bundled Caddy; empty if the host already runs nginx (section 5) |

Never set `EMAIL_REDIRECT_TO` here. `.env.production` is gitignored, so it
only ever exists on the server.

Note: `POSTGRES_PASSWORD` is only applied when the Postgres volume is first
created. Changing it later means changing the password inside Postgres too
(`ALTER USER`), not just in this file.

## 5. Start

Pick how HTTPS reaches the api:

**A. Nothing else on this host serves 80/443:** keep `COMPOSE_PROFILES=proxy`
for the bundled Caddy, which gets and renews a Let's Encrypt certificate by
itself. Add the `api` A record (section 1, DNS) and wait until
`dig +short api.phastos.app` returns the Elastic IP before the first start,
or the certificate request fails.

**B. The host already runs nginx (e.g. for another app):** set
`COMPOSE_PROFILES=` (empty) and add a server block to the existing nginx
that proxies to the api:

```nginx
server {
    server_name api.phastos.app;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then `sudo certbot --nginx -d api.phastos.app` for the certificate.

**First start:** run the pipeline once. GitHub → Actions → **CI** → **Run
workflow** (branch `master`), or push any commit to `master`. It tests,
builds and pushes the images, then the **Deploy to EC2** job runs
`deploy/deploy.sh` on the instance: pull the images, start
Postgres/Redis/RabbitMQ/Kafka, run **`migrate`** (all database migrations,
then exits), and only then start the three apps. The job fails unless every
service ends up healthy, and its log shows the script's output.

Tip: save typing with an alias. `.env.deployed` holds the commit that's
currently deployed (`deploy.sh` writes it), so hand-run commands use the
same images.

```bash
alias dcp='docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .env.deployed'
```

## 6. Check it

```bash
dcp ps                                   # all "healthy"; migrate "Exited (0)"
dcp logs migrate                         # "... has been executed successfully"
curl -s localhost:3000/health            # from the instance
curl -s https://api.phastos.app/health   # from anywhere, once the proxy is up
```

Swagger is at `/docs` on the api.

## 7. Deploy a new version

**Automatic:** push to `master`. When the tests and image builds pass, the
**Deploy to EC2** job:

1. pushes the four images to ECR, tagged with the commit;
2. asks Systems Manager to run, on the instance tagged `App=phastos`, as
   `ubuntu`: `git checkout <commit>` in `~/phastos_reservation`, then
   `./deploy/deploy.sh <commit>`;
3. `deploy.sh` pulls the images, restarts what changed (`migrate` first,
   which only applies new migrations), waits until everything is healthy,
   removes the previous release's images and records the commit in
   `.env.deployed`.

Pull requests only run the tests and image builds; they never push images
or deploy. Only one deploy runs at a time; a newer push waits for the
current one. Expect a few seconds of api downtime while its container is
replaced.

**Re-deploy by hand:** Actions → CI → Run workflow on `master`.

**Roll back** to any of the last 10 commits (the images ECR keeps), on the
instance:

```bash
cd ~/phastos_reservation
git fetch && git checkout --detach <commit> && ./deploy/deploy.sh <commit>
```

Migrations are not rolled back automatically. The next push to `master`
deploys the new commit as usual.

**Without CI** (e.g. ECR unreachable): build on the instance instead. Needs
~1.5 GB of extra disk and a few minutes of CPU, and takes the instance off
the ECR images until the next pipeline deploy:

```bash
IMAGE_REGISTRY=local IMAGE_TAG=latest dcp up -d --build
```

**If the deploy job fails:**

| Message | Cause |
|---|---|
| `No instance matched tag App=phastos` | The tag is missing, the instance profile isn't attached, or the SSM agent is offline (Systems Manager → Fleet Manager should list the instance as Online) |
| `not found` while pulling | The images for that commit weren't pushed; check the build jobs |
| A service not healthy | The job log shows `deploy.sh`'s output; then `dcp logs <service>` on the instance |

Every deploy's full output is also in Systems Manager → **Run Command** →
Command history.

## 8. Backups

Postgres is the source of truth. Back it up daily, and keep the copies off
the instance:

```bash
# e.g. in crontab -e, at 03:00 every day (needs the AWS CLI and an
# instance role that can write to the bucket)
0 3 * * * cd ~/phastos_reservation && docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' | aws s3 cp - s3://YOUR-BUCKET/phastos/pg-$(date +\%F).dump
```

Restore with `pg_restore`. Also take EBS snapshots of the volume (AWS Data
Lifecycle Manager can schedule them).

Redis, RabbitMQ and Kafka hold short-lived data (holds, queued
notifications, events), so they are not backed up separately.

## 9. Day to day

| Task | Command |
|---|---|
| Logs of one app | `dcp logs -f --tail 100 notification-worker` |
| Restart one app | `dcp restart api` |
| Shell in Postgres | `dcp exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` |
| RabbitMQ admin page (DLQs) | From your machine, `ssh -L 15672:localhost:15672 ubuntu@<host>`, then open http://localhost:15672 |
| Stop everything (keeps data) | `dcp down` |
| Which commit is deployed | `cat .env.deployed` |
| Free disk | `docker builder prune -f` (only if you've built on the instance; deploys already remove old images) |

Never run `dcp down -v` on the server: `-v` deletes the data volumes,
including the database.

## Limits of this setup

- **One instance, no redundancy.** If it goes down, everything does, until
  it's back. Backups cover the data, not the downtime.
- **Deploys restart in place.** There's no blue/green or rolling restart,
  so each deploy has a few seconds of api downtime.
- **Single Kafka broker**, so `KAFKA_TOPIC_REPLICATION_FACTOR=1`.
- **Redis has no password.** It is only reachable on the compose network,
  never from outside the instance.
- **No monitoring or alerting yet.** At least set a CloudWatch alarm on the
  instance's status checks and disk usage.
- **Moving to managed services later** (RDS, ElastiCache, Amazon MQ, MSK)
  needs no code change: point the `*_HOST`/`KAFKA_BROKERS` variables at them
  and remove those services from the compose file.

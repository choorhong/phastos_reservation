# Deployment (single EC2 instance, self-hosted services)

Everything runs on one host with Docker Compose (`docker-compose.prod.yml`):
the three apps, plus Postgres, Redis, RabbitMQ and Kafka in containers next
to them. This is the simplest setup that works. Its main limitation is that
the one instance is a single point of failure (see "Limits" at the end).

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

## 1. The instance

- **Size:** at idle the whole stack uses about 0.9 GB of memory (measured
  locally: Kafka ~370 MB, RabbitMQ ~190 MB, each app 70–100 MB, Postgres
  ~70 MB). Building the images on the instance needs more than that.
  - **t3.medium (2 vCPU, 4 GB)** is the minimum; add 2 GB of swap (below).
  - **t3.large (8 GB)** is comfortable, and leaves room if other apps share
    the instance.
- **OS:** Ubuntu 24.04 LTS (the commands below assume it).
- **Disk:** 30 GB gp3. **8 GB is not enough.** Measured: the images alone
  are ~3.75 GB (Kafka 1.31 GB, Postgres 0.64 GB, RabbitMQ 0.39 GB, the
  three apps ~0.73 GB together, `migrate` ~0.58 GB). Ubuntu + Docker add
  ~3 GB. Each deploy keeps the old app images until pruned (+~1.3 GB), and
  building on the instance adds ~1.5 GB of build cache. 16–20 GB works if
  images are built elsewhere and old ones are pruned after each deploy.
  Container logs are capped at 3 × 10 MB per service in the compose file.
- **Elastic IP:** attach one, so the address (and the DNS record that points
  at it) survives a stop/start.
- **Security group (inbound):**
  - 22 (SSH) from **your IP only**.
  - 80 and 443 from anywhere, only if this host serves HTTPS.
  - Nothing else. Postgres, Redis, RabbitMQ and Kafka are not published at
    all, and the api listens on 127.0.0.1 only.

## 2. Install Docker

```bash
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh        # Docker Engine + compose plugin
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version                              # check it works

# 2 GB swap -- needed on a 4 GB instance for image builds
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Docker starts on boot by default, and every service is `restart:
unless-stopped`, so the stack comes back by itself after a reboot.

## 3. Get the code

```bash
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
| `EMAIL_FROM` | An address on a domain **verified in Resend** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The admin account created at first start. Remove both lines once it exists. |
| `API_DOMAIN` | Only for the `caddy` proxy, e.g. `api.example.com` |

Never set `EMAIL_REDIRECT_TO` here. `.env.production` is gitignored, so it
only ever exists on the server.

Note: `POSTGRES_PASSWORD` is only applied when the Postgres volume is first
created. Changing it later means changing the password inside Postgres too
(`ALTER USER`), not just in this file.

## 5. Start

Pick how HTTPS reaches the api:

**A. Nothing else on this host serves 80/443:** use the bundled Caddy, which
gets and renews a Let's Encrypt certificate by itself. Point the
`API_DOMAIN` DNS A record at the Elastic IP first.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production --profile proxy up -d --build
```

**B. The host already runs nginx (e.g. for another app):** leave Caddy off
and add a server block to the existing nginx that proxies to the api:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

```nginx
server {
    server_name api.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then `sudo certbot --nginx -d api.example.com` for the certificate.

Either way, the first start builds the images (a few minutes), starts
Postgres/Redis/RabbitMQ/Kafka, runs **`migrate`** (all database migrations,
then exits), and only then starts the three apps.

Tip: save typing with an alias.

```bash
alias dcp='docker compose -f docker-compose.prod.yml --env-file .env.production'
```

## 6. Check it

```bash
dcp ps                                   # all "healthy"; migrate "Exited (0)"
dcp logs migrate                         # "... has been executed successfully"
curl -s localhost:3000/health            # from the instance
curl -s https://api.example.com/health   # from anywhere, once the proxy is up
```

Swagger is at `/docs` on the api.

## 7. Deploy a new version

```bash
git pull
dcp up -d --build        # add --profile proxy if you use Caddy
```

This rebuilds the images, runs `migrate` again (it only applies new
migrations), and recreates the apps that changed. Expect a few seconds of
api downtime while its container is replaced. To undo a release, check out
the previous commit and run the same command. Migrations are not rolled back
automatically.

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
| Free disk from old images | `docker image prune -f && docker builder prune -f` |

Never run `dcp down -v` on the server: `-v` deletes the data volumes,
including the database.

## Limits of this setup

- **One instance, no redundancy.** If it goes down, everything does, until
  it's back. Backups cover the data, not the downtime.
- **Images are built on the instance.** That's simple, but it uses the
  server's CPU and memory for a few minutes per deploy. The next step up is
  having CI push the images it already builds to ECR, and having the
  instance pull them.
- **Single Kafka broker**, so `KAFKA_TOPIC_REPLICATION_FACTOR=1`.
- **Redis has no password.** It is only reachable on the compose network,
  never from outside the instance.
- **No monitoring or alerting yet.** At least set a CloudWatch alarm on the
  instance's status checks and disk usage.
- **Moving to managed services later** (RDS, ElastiCache, Amazon MQ, MSK)
  needs no code change: point the `*_HOST`/`KAFKA_BROKERS` variables at them
  and remove those services from the compose file.

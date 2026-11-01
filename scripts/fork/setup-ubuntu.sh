#!/usr/bin/env bash
# Set up a Breeze dev/test server on a fresh Ubuntu 24.04 machine
# (the local VirtualBox VM now, a VPS later). Safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/ugendarraju/breeze/main/scripts/fork/setup-ubuntu.sh | bash
#   # or, from a checkout:  bash scripts/fork/setup-ubuntu.sh
#
# Then:  cd ~/breeze && pnpm dev:app   ->  http://<server>:4321
set -euo pipefail

REPO_URL="${BREEZE_REPO_URL:-https://github.com/ugendarraju/breeze.git}"
UPSTREAM_URL="https://github.com/LanternOps/breeze.git"
DIR="${BREEZE_DIR:-$HOME/breeze}"
NODE_MAJOR=22

log() { printf '\n==> %s\n' "$*"; }

log "System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git gnupg openssl build-essential

if ! swapon --show | grep -q .; then
  log "4 GB swapfile (builds need headroom)"
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

if ! command -v docker >/dev/null; then
  log "Docker Engine"
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR"; then
  log "Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
sudo corepack enable

if [ ! -d "$DIR/.git" ]; then
  log "Clone $REPO_URL"
  git clone "$REPO_URL" "$DIR"
  git -C "$DIR" remote add upstream "$UPSTREAM_URL"
  git -C "$DIR" remote set-url --push upstream DISABLED
fi
cd "$DIR"

if [ ! -f .env ]; then
  log "Generate .env (local dev values, fresh secrets)"
  cp .env.example .env
  PGPW=$(openssl rand -hex 24); RPW=$(openssl rand -hex 32)
  sed -i \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PGPW|" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://breeze:$PGPW@localhost:5432/breeze|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$RPW|" \
    -e "s|^REDIS_URL=.*|REDIS_URL=redis://:$RPW@localhost:6379|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')|" \
    -e "s|^PARTNER_API_CURSOR_SIGNING_KEY=.*|PARTNER_API_CURSOR_SIGNING_KEY=$(openssl rand -base64 32)|" \
    -e "s|^AGENT_ENROLLMENT_SECRET=.*|AGENT_ENROLLMENT_SECRET=$(openssl rand -hex 32)|" \
    -e "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
    -e "s|^MFA_ENCRYPTION_KEY=.*|MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
    -e "s|^NODE_ENV=.*|NODE_ENV=development|" \
    -e "s|^FORCE_HTTPS=.*|FORCE_HTTPS=false|" \
    -e "s|^S3_BUCKET=.*|# S3_BUCKET=breeze  (disabled: no MinIO)|" \
    .env
  chmod 600 .env
fi

log "Postgres + Redis (Docker)"
sudo docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d --wait postgres redis

log "Dependencies"
pnpm install --frozen-lockfile

log "Database migrate + seed"
pnpm db:migrate
pnpm db:seed

log "Done. Start Breeze with:  cd $DIR && pnpm dev:app"

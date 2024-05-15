#!/usr/bin/env sh

set -e

trap cleanup EXIT

cleanup() {
  if [ "$KEEP_RUNNING" != true ]; then
    docker compose -f test/docker-compose.yml down
    docker compose -f test/docker-compose.yml rm
  fi
}
cleanup

# build all in parallel
docker compose -f test/docker-compose.yml build

docker compose -f test/docker-compose.yml up --remove-orphans -d localhardhat

sleep 15

docker compose -f test/docker-compose.yml up --remove-orphans aave

docker compose -f test/docker-compose.yml up --remove-orphans compound || true

docker compose -f test/docker-compose.yml up --remove-orphans test

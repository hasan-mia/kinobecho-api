#!/bin/sh
# Healthcheck script for container monitoring

set -e

HEALTH_URL=${HEALTH_URL:-http://localhost:3000/api/health}

RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL")

if [ "$RESPONSE" = "200" ]; then
  echo "OK: ${HEALTH_URL} returned ${RESPONSE}"
  exit 0
else
  echo "FAIL: ${HEALTH_URL} returned ${RESPONSE}"
  exit 1
fi
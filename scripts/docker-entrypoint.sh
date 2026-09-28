#!/bin/sh
set -e

echo "Running Pending Database Migrations..."
npx prisma migrate deploy

echo "Starting Application..."
if [ "$NODE_ENV" = "production" ]; then
  node dist/src/main
else
  npm run start:dev
fi
#!/bin/bash
# Prisma database setup script (PostgreSQL)

set -e

DATABASE_URL="${DATABASE_URL}"

echo "Using database URL: $DATABASE_URL"

# Generate Prisma client
npx prisma generate

# Apply migrations
echo "Running migrations..."
npx prisma migrate deploy

# Seed database
npx prisma db seed

echo "Database setup complete!"

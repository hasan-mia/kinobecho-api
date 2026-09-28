#!/usr/bin/env node
/**
 * Generates cumulative "staged" Prisma schemas from prisma/schema.prisma so that
 * `prisma migrate diff` can produce one migration folder per logical stage.
 *
 * Every stage file contains:
 *   - all enums referenced by the models present at that stage
 *   - every model introduced at or before that stage, in full
 *   - minimal *stub* models for models introduced later that are already
 *     referenced by a relation from a present model
 *
 * Stubs keep the `id` column, the FK columns of already-referenced relations, and
 * the `@@map` table name identical to the final model, so the generated SQL only
 * ever ADDs columns — never renames or drops.
 *
 * Relation names are resolved once and applied consistently to the source
 * schema and to every stage, so the last stage is a faithful, valid snapshot.
 *
 * Usage: node scripts/generate-staged-schemas.mjs [--write-source]
 *   --write-source  also rewrite prisma/schema.prisma with resolved relation
 *                   names (semantically identical, only @relation args added)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = join(root, 'prisma/schema.prisma');
const OUT_DIR = join(root, 'prisma/staged-schemas');
const WRITE_SOURCE = process.argv.includes('--write-source');

/** Model -> stage number it is introduced in. */
const STAGE_OF_MODEL = {
  Role: 1,
  Permission: 1,
  RolePermission: 1,
  RoleAuditLog: 1,
  RefreshToken: 1,
  User: 1,
  Address: 1,

  Vendor: 2,

  Category: 3,
  Product: 3,
  ProductVariant: 3,
  ProductPriceTier: 3,
  ProductImage: 3,

  Cart: 4,
  CartItem: 4,
  Order: 4,
  OrderItem: 4,
  OrderStatusHistory: 4,

  Transaction: 5,
  TransactionOrder: 5,

  Review: 6,
  Coupon: 6,

  ChatThread: 7,
  ChatMessage: 7,
  ChatParticipantState: 7,

  StorageFile: 8,
  DeviceToken: 8,
  NotificationLog: 8,
  PromotionCampaign: 8,

  WebhookEvent: 9,
  QueueEvent: 9,
  Session: 9,
};

const STAGE_FILES = [
  [1, '01_auth_rbac', 'Auth / Users / RBAC'],
  [2, '02_vendor', 'Vendor'],
  [3, '03_category_product', 'Category / Product / Variants / Price tiers / Images'],
  [4, '04_cart_order', 'Cart / Order / Order items / Status history'],
  [5, '05_transaction', 'Transactions / Settlement'],
  [6, '06_review_coupon', 'Reviews / Coupons'],
  [7, '07_chat', 'Chat threads / Messages / Participant state'],
  [8, '08_storage_notification', 'Storage / Notifications / Campaigns'],
  [9, '09_infra', 'Infra (webhook, queue, session)'],
];

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt']);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Splits a Prisma file into the preamble and the top-level `model` / `enum` blocks. */
function parse(text) {
  const lines = text.split('\n');
  const preamble = [];
  const blocks = [];
  let buffer = null;

  for (const line of lines) {
    if (buffer === null) {
      const start = /^(model|enum)\s+(\w+)\s*\{/.exec(line);
      if (start) {
        buffer = { kind: start[1], name: start[2], lines: [line] };
      } else if (blocks.length === 0) {
        preamble.push(line);
      }
      continue;
    }
    buffer.lines.push(line);
    if (/^\}/.test(line)) {
      blocks.push({ kind: buffer.kind, name: buffer.name, lines: buffer.lines });
      buffer = null;
    }
  }

  return { preamble: preamble.join('\n').trim(), blocks };
}

const parsed = parse(readFileSync(SCHEMA, 'utf8'));
const enums = new Map();
const models = new Map();

for (const block of parsed.blocks) {
  if (block.kind === 'enum') enums.set(block.name, block.lines.join('\n'));
  else models.set(block.name, block.lines.join('\n'));
}

for (const name of models.keys()) {
  if (!STAGE_OF_MODEL[name]) throw new Error(`Model "${name}" has no stage in STAGE_OF_MODEL`);
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

const FIELD_RE = /^\s{2}(\w+)\s+([\w.]+)(\[\])?(\?)?(\s+@relation\((.*)\))?(.*)$/;

/**
 * Splits a model body into its entry lines, classified as scalar, relation or
 * block attribute.
 */
function parseFields(body) {
  const inner = body.split('\n').slice(1, -1);
  const fields = [];
  const attributes = [];

  for (const raw of inner) {
    if (!raw.trim()) continue;
    if (raw.trim().startsWith('//')) continue;
    if (raw.trim().startsWith('@@')) {
      attributes.push(raw.trim());
      continue;
    }
    const m = FIELD_RE.exec(raw);
    if (!m) {
      fields.push({ raw, kind: 'raw' });
      continue;
    }
    const [, name, type, list, optional, , relArgs] = m;
    const isRelation = !SCALARS.has(type) && models.has(type);
    fields.push({
      raw,
      kind: isRelation ? 'relation' : 'scalar',
      name,
      type,
      isList: Boolean(list),
      optional: Boolean(optional),
      relationArgs: relArgs ?? null,
      ownsFk: isRelation && /fields:/.test(relArgs ?? ''),
    });
  }

  return { fields, attributes };
}

const parsedModels = new Map();
for (const [name, body] of models) {
  const { fields, attributes } = parseFields(body);
  parsedModels.set(name, { name, body, fields, attributes });
}

// ---------------------------------------------------------------------------
// Relation resolution
// ---------------------------------------------------------------------------

/**
 * Collects every relation edge. An edge is identified by the owning model + the
 * FK column list, since that is the unique anchor for a to-one relation.
 */
const edges = [];

for (const model of parsedModels.values()) {
  for (const field of model.fields) {
    if (field.kind !== 'relation') continue;
    const other = field.type;
    if (field.ownsFk) {
      edges.push({
        owner: model.name,
        other,
        field,
        isList: field.isList,
        fkFields: /fields:\s*\[([^\]]*)\]/.exec(field.relationArgs)?.[1] ?? '',
        explicit: /"([^"]+)"/.exec(field.relationArgs)?.[1] ?? null,
      });
    } else {
      edges.push({ owner: other, other: model.name, field, isList: field.isList, inverse: true });
    }
  }
}

// Group by unordered pair so ambiguous pairs get explicit names.
const byPair = new Map();
for (const edge of edges) {
  const key = [edge.owner, edge.other].sort().join('|');
  if (!byPair.has(key)) byPair.set(key, []);
  byPair.get(key).push(edge);
}

const relationNameOf = new Map(); // owning model + fkFields -> name
const needsExplicitName = new Set(); // pair keys needing a name on both sides

for (const [key, pairEdges] of byPair) {
  const owners = pairEdges.filter((e) => !e.inverse);
  if (pairEdges.length === 1 && owners.length === 1 && owners[0].explicit) {
    relationNameOf.set(`${owners[0].owner}#${owners[0].fkFields}`, owners[0].explicit);
    continue;
  }
  needsExplicitName.add(key);
  const [a, b] = key.split('|');
  let counter = 0;
  for (const edge of pairEdges) {
    if (edge.inverse) continue;
    counter += 1;
    const name = edge.explicit ?? `${a}To${b}_${counter}`;
    relationNameOf.set(`${edge.owner}#${edge.fkFields}`, name);
  }
}

/**
 * Resolved relation name for a field, or null when the pair is unambiguous and
 * the source schema already names the relation.
 *
 * An inverse field is paired with its owning counterpart by relation name when
 * one is present, otherwise with the owning field in the other model that has no
 * explicit name of its own.
 */
function nameForField(modelName, field) {
  if (field.ownsFk) {
    const key = `${modelName}#${/fields:\s*\[([^\]]*)\]/.exec(field.relationArgs)?.[1] ?? ''}`;
    return relationNameOf.get(key) ?? null;
  }

  const pair = [modelName, field.type].sort().join('|');
  if (!needsExplicitName.has(pair)) return null;

  const candidates = (byPair.get(pair) ?? []).filter(
    (e) => !e.inverse && e.other === modelName,
  );
  if (candidates.length === 0) return null;

  const explicit = /^\s*"([^"]+)"/.exec(field.relationArgs ?? '')?.[1];
  const match =
    (explicit && candidates.find((e) => e.explicit === explicit)) ||
    candidates.find((e) => !e.explicit) ||
    candidates[0];

  return relationNameOf.get(`${match.owner}#${match.fkFields}`) ?? null;
}

/** Rewrites a field line so the resolved relation name is present. */
function renderField(modelName, field) {
  if (field.kind === 'raw') return field.raw;
  if (field.kind !== 'relation') return field.raw;

  const name = nameForField(modelName, field);
  if (!name) return field.raw;

  const type = `${field.type}${field.isList ? '[]' : field.optional ? '?' : ''}`;
  // Drop any leading relation name already present in the source arguments.
  const args = (field.relationArgs ?? '').replace(/^\s*"[^"]*"\s*,?/, '').trim();
  const body = /fields:/.test(args) ? `"${name}", ${args}` : `"${name}"`;
  return `  ${field.name} ${type} @relation(${body})`;
}

/** Renders a model with all field lines normalized. */
function renderModel(model) {
  const lines = [
    `model ${model.name} {`,
    ...model.fields.map((f) => renderField(model.name, f)),
  ];
  for (const attribute of model.attributes) lines.push(`  ${attribute}`);
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** FK scalar column names a relation field declares. */
function fkColumns(field) {
  return [...(/fields:\s*\[([^\]]*)\]/.exec(field.relationArgs ?? '')?.[1] ?? '').matchAll(/\w+/g)].map(
    (m) => m[0],
  );
}

/**
 * Minimal version of a model that is not introduced yet: the `id` column, the FK
 * columns of relations to models already present, and the relation fields
 * themselves so the relation graph stays valid. Table name is preserved.
 */
function renderStub(model, present) {
  const lines = [`model ${model.name} {`];

  const idField = model.fields.find((f) => f.kind === 'scalar' && f.name === 'id');
  lines.push(`  ${idField ? idField.raw.trim() : 'id String @id @default(uuid())'}`);

  const emitted = new Set(['id']);
  const kept = [];

  for (const field of model.fields) {
    if (field.kind !== 'relation') continue;
    // A stub only keeps relations to models that already exist at this stage;
    // relations to other future stubs are dropped entirely.
    if (!present.has(field.type)) continue;

    if (field.ownsFk) {
      for (const column of fkColumns(field)) {
        const scalar = model.fields.find((f) => f.kind === 'scalar' && f.name === column);
        if (scalar && !emitted.has(column)) {
          lines.push(`  ${scalar.raw.trim()}`);
          emitted.add(column);
        }
      }
    }

    kept.push(renderField(model.name, field));
  }

  lines.push(...kept);

  for (const attribute of model.attributes) {
    if (attribute.startsWith('@@map(')) lines.push(`  ${attribute}`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Enums referenced by the given models, via field types or @default values. */
function enumsFor(names) {
  const found = new Set();
  for (const name of names) {
    const model = parsedModels.get(name);
    if (!model) continue;
    for (const field of model.fields) {
      if (field.kind === 'scalar' && enums.has(field.type)) found.add(field.type);
      for (const match of field.raw.matchAll(/@default\((\w+)\)/g)) {
        if (enums.has(match[1])) found.add(match[1]);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const HEADER = (stage, title) => `// -----------------------------------------------------------------------------
// AUTO-GENERATED by scripts/generate-staged-schemas.mjs — do not edit by hand.
// Stage ${stage}: ${title}
//
// Cumulative snapshot used only to produce staged migrations. Models introduced
// in later stages appear as id/FK-only stubs so the relation graph stays valid.
// Re-run the script after editing prisma/schema.prisma.
// -----------------------------------------------------------------------------

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`;

const MODEL_ORDER = Object.keys(STAGE_OF_MODEL).sort(
  (a, b) => STAGE_OF_MODEL[a] - STAGE_OF_MODEL[b] || a.localeCompare(b),
);

mkdirSync(OUT_DIR, { recursive: true });

for (const [stage, file, title] of STAGE_FILES) {
  const present = new Set(MODEL_ORDER.filter((n) => STAGE_OF_MODEL[n] <= stage));
  const future = MODEL_ORDER.filter((n) => STAGE_OF_MODEL[n] > stage);

  // Stubs: future models reachable by a relation from a present model.
  const stubbed = new Set();
  for (const name of present) {
    for (const field of parsedModels.get(name).fields) {
      if (field.kind === 'relation' && !present.has(field.type)) stubbed.add(field.type);
    }
  }

  const presentEnums = enumsFor([...present, ...stubbed]);
  // Enums that no model references yet still need to exist in the database, so
  // they are introduced in the final stage.
  if (stage === STAGE_FILES.at(-1)[0]) {
    for (const name of enums.keys()) presentEnums.add(name);
  }
  const sections = [HEADER(stage, title), '// --- ENUMS ---'];

  for (const name of presentEnums) sections.push(enums.get(name));

  sections.push('// --- MODELS ---');
  for (const name of MODEL_ORDER) {
    if (STAGE_OF_MODEL[name] > stage) continue;
    sections.push(renderModel(parsedModels.get(name)));
  }

  if (stubbed.size > 0) {
    sections.push('// --- STUBS (introduced in a later stage) ---');
    for (const name of MODEL_ORDER) {
      if (STAGE_OF_MODEL[name] <= stage || !stubbed.has(name)) continue;
      sections.push(renderStub(parsedModels.get(name), present));
    }
  }

  writeFileSync(join(OUT_DIR, `${file}.prisma`), `${sections.join('\n\n')}\n`);
  console.log(
    `✓ ${file}.prisma — ${present.size} models, ${stubbed.size} stubs, ${presentEnums.size} enums`,
  );
}

if (WRITE_SOURCE) {
  const header = parsed.preamble
    ? parsed.preamble
    : 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}';
  const rendered = [
    header.trim(),
    '// --- ENUMS ---',
    ...[...enums.keys()].map((name) => enums.get(name)),
    '// --- MODELS ---',
    ...MODEL_ORDER.map((name) => renderModel(parsedModels.get(name))),
  ].join('\n\n');
  writeFileSync(SCHEMA, `${rendered}\n`);
  console.log('\n✓ prisma/schema.prisma rewritten with resolved relation names');
}

console.log('\nStaged schemas written to prisma/staged-schemas');

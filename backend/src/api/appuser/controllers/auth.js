'use strict';

/**
 * Custom authentication controller for the `appuser` collection.
 *
 * Replaces the users-permissions login flow. Endpoints are mounted under
 * /api/app-auth (see routes/auth.js) and run with `auth: false` so requests
 * reach these handlers directly — we verify the bearer JWT ourselves.
 *
 * Security notes:
 *  - Passwords are hashed by the content-type lifecycle (bcrypt); this
 *    controller only ever compares with bcrypt.compare and never logs them.
 *  - The `password` field is stripped from every response via sanitizeUser().
 *  - JWTs are signed with process.env.JWT_SECRET and carry only `documentId`.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const UID = 'api::appuser.appuser';
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

const VALID_ROLES = ['editor', 'staff', 'administrator'];

/* ── helpers ──────────────────────────────────────────────────────────── */

function signToken(documentId) {
  return jwt.sign({ documentId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function normalizeRoles(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((r) => String(r).trim().toLowerCase())
    .filter((r) => VALID_ROLES.includes(r));
}

/** Remove password (and any other secret) before returning a user. */
function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    documentId: user.documentId,
    username: user.username || '',
    email: user.email || '',
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    company: user.company || '',
    roles: normalizeRoles(user.roles),
    favorites: Array.isArray(user.favorites) ? user.favorites : [],
    lists: Array.isArray(user.lists) ? user.lists : [],
    auditLog: Array.isArray(user.auditLog) ? user.auditLog : [],
    confirmed: Boolean(user.confirmed),
    blocked: Boolean(user.blocked),
  };
}

function bearerToken(ctx) {
  const header = ctx.request.header.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** Resolve the caller's appuser from the bearer token, or null. */
async function currentUser(ctx) {
  const payload = verifyToken(bearerToken(ctx));
  if (!payload || !payload.documentId) return null;
  return strapi.documents(UID).findOne({ documentId: payload.documentId });
}

function isAdministrator(user) {
  return normalizeRoles(user && user.roles).includes('administrator');
}

/* ── controller ───────────────────────────────────────────────────────── */

module.exports = {
  /** POST /api/app-auth/register — public */
  async register(ctx) {
    const body = ctx.request.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
    const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
    const company = typeof body.company === 'string' ? body.company.trim() : '';

    if (!username || !email || !password) {
      return ctx.badRequest('username, email and password are required.');
    }
    if (password.length < 6) {
      return ctx.badRequest('Password must be at least 6 characters.');
    }

    const clash = await strapi.db.query(UID).findOne({
      where: { $or: [{ email }, { username }] },
      select: ['id', 'email', 'username'],
    });
    if (clash) {
      const field = clash.email === email ? 'email' : 'username';
      return ctx.badRequest(`A user with this ${field} already exists.`);
    }

    const created = await strapi.documents(UID).create({
      data: {
        username,
        email,
        password,
        firstName,
        lastName,
        company,
        roles: [],
        favorites: [],
        lists: [],
        auditLog: [],
        confirmed: false,
        blocked: false,
      },
    });

    ctx.body = { jwt: signToken(created.documentId), user: sanitizeUser(created) };
  },

  /** POST /api/app-auth/login — public */
  async login(ctx) {
    const body = ctx.request.body || {};
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!identifier || !password) {
      return ctx.badRequest('identifier and password are required.');
    }

    const user = await strapi.db.query(UID).findOne({
      where: { $or: [{ email: identifier.toLowerCase() }, { username: identifier }] },
    });

    // Run a compare even when the user is missing to reduce timing leakage.
    const hash = (user && user.password) || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) {
      return ctx.unauthorized('Invalid identifier or password.');
    }
    if (user.blocked) {
      return ctx.forbidden('This account is blocked.');
    }

    ctx.body = { jwt: signToken(user.documentId), user: sanitizeUser(user) };
  },

  /** GET /api/app-auth/me — bearer */
  async me(ctx) {
    const user = await currentUser(ctx);
    if (!user) return ctx.unauthorized('Not authenticated.');
    ctx.body = { user: sanitizeUser(user) };
  },

  /** PUT /api/app-auth/me — bearer; self-update of profile / favorites / audit log */
  async updateMe(ctx) {
    const user = await currentUser(ctx);
    if (!user) return ctx.unauthorized('Not authenticated.');

    const body = ctx.request.body || {};
    const data = {};

    if (Array.isArray(body.favorites)) {
      data.favorites = body.favorites.map((v) => String(v)).filter(Boolean);
    }
    if (Array.isArray(body.auditLog)) {
      data.auditLog = body.auditLog;
    }
    if (Array.isArray(body.lists)) {
      data.lists = body.lists;
    }
    if (typeof body.firstName === 'string') data.firstName = body.firstName.trim();
    if (typeof body.lastName === 'string') data.lastName = body.lastName.trim();
    if (typeof body.company === 'string') data.company = body.company.trim();
    if (typeof body.password === 'string' && body.password.length >= 6) {
      data.password = body.password; // hashed by lifecycle
    }

    if (Object.keys(data).length === 0) {
      return ctx.badRequest('No updatable fields supplied.');
    }

    const updated = await strapi.documents(UID).update({
      documentId: user.documentId,
      data,
    });
    ctx.body = { user: sanitizeUser(updated) };
  },

  /** GET /api/app-auth/users — bearer + administrator */
  async listUsers(ctx) {
    const caller = await currentUser(ctx);
    if (!caller) return ctx.unauthorized('Not authenticated.');
    if (!isAdministrator(caller)) return ctx.forbidden('Administrator role required.');

    const users = await strapi.documents(UID).findMany({
      limit: 500,
      sort: 'username:asc',
    });
    ctx.body = { users: users.map(sanitizeUser) };
  },

  /** PUT /api/app-auth/users — bearer + administrator; set roles / status */
  async updateUser(ctx) {
    const caller = await currentUser(ctx);
    if (!caller) return ctx.unauthorized('Not authenticated.');
    if (!isAdministrator(caller)) return ctx.forbidden('Administrator role required.');

    const body = ctx.request.body || {};
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};

    let target = null;
    if (documentId) {
      target = await strapi.documents(UID).findOne({ documentId });
    } else if (email) {
      target = await strapi.db.query(UID).findOne({ where: { email } });
    }
    if (!target) return ctx.notFound('User not found.');

    const data = {};
    if (Array.isArray(fields.roles)) data.roles = normalizeRoles(fields.roles);
    if (typeof fields.blocked === 'boolean') data.blocked = fields.blocked;
    if (typeof fields.confirmed === 'boolean') data.confirmed = fields.confirmed;

    if (Object.keys(data).length === 0) {
      return ctx.badRequest('No valid fields to update (roles, blocked, confirmed).');
    }

    const updated = await strapi.documents(UID).update({
      documentId: target.documentId,
      data,
    });
    ctx.body = { user: sanitizeUser(updated) };
  },

  /**
   * GET /api/app-auth/export — bearer + administrator
   * Full user dump INCLUDING the bcrypt password hash, for backups. Unlike the
   * sanitized endpoints this intentionally returns the hash so a restore can
   * recreate working logins. Admin-only.
   */
  async exportUsers(ctx) {
    const caller = await currentUser(ctx);
    if (!caller) return ctx.unauthorized('Not authenticated.');
    if (!isAdministrator(caller)) return ctx.forbidden('Administrator role required.');

    const rows = await strapi.db.query(UID).findMany({ orderBy: { email: 'asc' } });
    ctx.body = { users: rows };
  },

  /**
   * POST /api/app-auth/import — bearer + administrator
   * Upsert users by email. `password` values that are already bcrypt hashes are
   * preserved verbatim (the lifecycle guard skips re-hashing). Admin-only.
   */
  async importUsers(ctx) {
    const caller = await currentUser(ctx);
    if (!caller) return ctx.unauthorized('Not authenticated.');
    if (!isAdministrator(caller)) return ctx.forbidden('Administrator role required.');

    const incoming = Array.isArray((ctx.request.body || {}).users)
      ? ctx.request.body.users
      : [];

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of incoming) {
      const email = raw && typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
      if (!email) {
        skipped += 1;
        continue;
      }

      const data = {
        username: typeof raw.username === 'string' ? raw.username : email,
        email,
        firstName: typeof raw.firstName === 'string' ? raw.firstName : (raw.first_name || ''),
        lastName: typeof raw.lastName === 'string' ? raw.lastName : (raw.last_name || ''),
        company: typeof raw.company === 'string' ? raw.company : '',
        roles: normalizeRoles(raw.roles),
        favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
        lists: Array.isArray(raw.lists) ? raw.lists : [],
        auditLog: Array.isArray(raw.auditLog) ? raw.auditLog : (Array.isArray(raw.audit_log) ? raw.audit_log : []),
        confirmed: Boolean(raw.confirmed),
        blocked: Boolean(raw.blocked),
      };
      if (typeof raw.password === 'string' && raw.password.length > 0) {
        data.password = raw.password; // bcrypt hashes pass through the lifecycle guard
      }

      const existing = await strapi.db.query(UID).findOne({ where: { email }, select: ['id', 'documentId'] });
      if (existing) {
        await strapi.documents(UID).update({ documentId: existing.documentId, data });
        updated += 1;
      } else {
        await strapi.documents(UID).create({ data });
        created += 1;
      }
    }

    ctx.body = { ok: true, created, updated, skipped };
  },
};

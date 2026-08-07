'use strict';

/**
 * appuser lifecycles
 *
 * Hash the `password` field with bcrypt before it is written, but ONLY when it
 * is a fresh plaintext value. Already-hashed bcrypt strings (e.g. the value
 * migrated verbatim from the old up_users table, or an unchanged password on a
 * partial update) are detected by their `$2a$/$2b$/$2y$` prefix and left
 * untouched so they are never double-hashed.
 */

const bcrypt = require('bcryptjs');

const BCRYPT_PREFIX = /^\$2[aby]\$/;

async function hashPasswordInData(data) {
  if (!data || typeof data.password !== 'string' || data.password.length === 0) {
    return;
  }
  if (BCRYPT_PREFIX.test(data.password)) {
    return; // already hashed — leave as-is
  }
  data.password = await bcrypt.hash(data.password, 10);
}

module.exports = {
  async beforeCreate(event) {
    await hashPasswordInData(event.params.data);
  },
  async beforeUpdate(event) {
    await hashPasswordInData(event.params.data);
  },
};

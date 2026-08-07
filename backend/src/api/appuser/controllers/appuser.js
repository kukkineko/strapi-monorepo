'use strict';

/**
 * appuser controller (core)
 *
 * Kept for content-manager/admin completeness. The public REST CRUD router is
 * intentionally NOT registered (see routes/) — all access goes through the
 * custom auth controller and the /api/app-auth routes.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::appuser.appuser');

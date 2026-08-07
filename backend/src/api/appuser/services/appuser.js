'use strict';

/**
 * appuser service (core)
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::appuser.appuser');

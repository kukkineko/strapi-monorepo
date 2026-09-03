'use strict';

/**
 * Custom auth routes for the appuser collection, mounted under /api/app-auth.
 *
 * `auth: false` disables Strapi's users-permissions auth strategy so the
 * request reaches our controller, which performs its own JWT verification.
 * No default CRUD router is registered for appuser, so these are the only
 * REST entry points to the collection.
 */

module.exports = {
  routes: [
    { method: 'POST', path: '/app-auth/register', handler: 'auth.register', config: { auth: false } },
    { method: 'POST', path: '/app-auth/login', handler: 'auth.login', config: { auth: false } },
    { method: 'GET', path: '/app-auth/me', handler: 'auth.me', config: { auth: false } },
    { method: 'PUT', path: '/app-auth/me', handler: 'auth.updateMe', config: { auth: false } },
    // POST, not DELETE: Strapi's default body parser only parses bodies for
    // POST/PUT/PATCH, and this endpoint needs the password in the body.
    { method: 'POST', path: '/app-auth/delete-me', handler: 'auth.deleteMe', config: { auth: false } },
    { method: 'PUT', path: '/app-auth/password', handler: 'auth.changePassword', config: { auth: false } },
    { method: 'GET', path: '/app-auth/users', handler: 'auth.listUsers', config: { auth: false } },
    { method: 'PUT', path: '/app-auth/users', handler: 'auth.updateUser', config: { auth: false } },
    { method: 'GET', path: '/app-auth/export', handler: 'auth.exportUsers', config: { auth: false } },
    { method: 'POST', path: '/app-auth/import', handler: 'auth.importUsers', config: { auth: false } },
  ],
};

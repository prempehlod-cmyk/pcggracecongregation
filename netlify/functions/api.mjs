import { getStore } from '@netlify/blobs';
import { createHandler } from '../lib/core.mjs';

// All church records live in one private Netlify Blobs store called "church".
// "strong" makes every read see the latest write, even from another region.
const blobs = getStore({ name: 'church', consistency: 'strong' });
const store = {
  get: (key) => blobs.get(key, { type: 'json' }),
  set: (key, value) => blobs.setJSON(key, value),
  del: (key) => blobs.delete(key),
};

const handle = createHandler(store, {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  CHURCH_NAME: process.env.CHURCH_NAME,
});

export default async (req, context) => handle(req, context);
export const config = { path: '/api/*' };

import { createHandler } from '../netlify/lib/core.mjs';
import assert from 'node:assert/strict';
// in-memory stand-in for Netlify Blobs
const mem = new Map();
const store = { get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null), set: async (k, v) => { mem.set(k, structuredClone(v)); }, del: async (k) => { mem.delete(k); } };
const handle = createHandler(store, { ADMIN_PASSWORD: 'Setup#Pass1' });
const jars = {};
async function call(who, method, path, body, extra = {}) {
  const headers = { 'X-Requested-With': 'church', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jars[who] ? { cookie: jars[who] } : {}), ...extra };
  const r = await handle(new Request('https://church.example' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), { ip: '1.2.3.4' });
  const sc = r.headers.get('set-cookie'); if (sc) { const m = /sid=([^;]*)/.exec(sc); jars[who] = m[1] ? 'sid=' + m[1] : ''; }
  let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j, r };
}
const t = (n, f) => f().then(() => console.log('ok  ', n), (e) => { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; });

await t('no session -> 401, missing header -> 403', async () => {
  assert.equal((await call('x', 'GET', '/api/state')).s, 401);
  assert.equal((await handle(new Request('https://church.example/api/login/staff', { method: 'POST', body: '{}' }))).status, 403);
  assert.equal((await handle(new Request('https://church.example/api/login/staff', { method: 'POST', body: '{}', headers: { 'X-Requested-With': 'church', origin: 'https://evil.example' } }))).status, 403);
});
await t('first login needs ADMIN_PASSWORD, wrong one fails', async () => {
  assert.equal((await call('a', 'POST', '/api/login/staff', { username: 'admin', password: 'admin123' })).s, 401);
  const noenv = createHandler(new Map() && { get: async () => null, set: async () => {}, del: async () => {} }, {});
  const r = await noenv(new Request('https://x.example/api/login/staff', { method: 'POST', headers: { 'X-Requested-With': 'church' }, body: JSON.stringify({ username: 'admin', password: 'x' }) }));
  assert.equal(r.status, 503);
});
await t('admin first login, forced password change', async () => {
  const r = await call('a', 'POST', '/api/login/staff', { username: 'admin', password: 'Setup#Pass1' }); assert.equal(r.s, 200); assert.equal(r.j.mustChange, true);
  assert.equal((await call('a', 'GET', '/api/state')).s, 403);
  assert.equal((await call('a', 'POST', '/api/me/password', { current: 'Setup#Pass1', password: 'short' })).s, 400);
  assert.equal((await call('a', 'POST', '/api/me/password', { current: 'Setup#Pass1', password: 'Church#Admin26' })).s, 200);
  const st = await call('a', 'GET', '/api/state'); assert.equal(st.s, 200); assert.equal(st.j.groups.length, 5);
  assert.equal((await call('z', 'POST', '/api/login/staff', { username: 'admin', password: 'Setup#Pass1' })).s, 401, 'setup password stops working');
});
await t('members, codes, member login, portal', async () => {
  assert.equal((await call('a', 'POST', '/api/members', { name: 'Kwame Mensah', group: 'Adults', phone: '024' })).j.id, 'M0001');
  await call('a', 'POST', '/api/members', { name: 'Ama Serwaa', group: 'Choir' });
  const c1 = (await call('a', 'POST', '/api/members/M0001/code')).j.code; assert.match(c1, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await call('m', 'POST', '/api/login/member', { id: 'M0001', code: 'AAAA-AAAA' })).s, 401);
  const ml = await call('m', 'POST', '/api/login/member', { id: 'm0001', code: c1.replace('-', '').toLowerCase() }); assert.equal(ml.s, 200);
  assert.equal((await call('m', 'GET', '/api/state')).s, 403);
  assert.equal((await call('m', 'POST', '/api/members/M0002/code')).s, 403);
  assert.equal((await call('m', 'GET', '/api/backup')).s, 403);
  await call('a', 'POST', '/api/attendance', { date: '2026-11-01', service: 'Sunday', ids: ['M0001'] });
  const pt = await call('m', 'GET', '/api/portal'); assert.equal(pt.j.attendance.length, 1); assert.equal(pt.j.member.codeHash, undefined);
  const st = await call('a', 'GET', '/api/state'); assert.equal(JSON.stringify(st.j).includes('codeHash'), false, 'no hashes leak to staff UI');
  assert.ok(st.j.groups.includes('Choir'));
  const bulk = await call('a', 'POST', '/api/codes/bulk', {}); assert.equal(bulk.j.codes.length, 1);
  assert.equal((await call('a', 'POST', '/api/members/M0001/code')).s, 200);
  assert.equal((await call('m', 'GET', '/api/portal')).s, 401, 'resetting the code ends the old member session');
});
await t('removing code / deleting member ends member session', async () => {
  const c = (await call('a', 'POST', '/api/members/M0002/code')).j.code;
  assert.equal((await call('m2', 'POST', '/api/login/member', { id: 'M0002', code: c })).s, 200);
  await call('a', 'DELETE', '/api/members/M0002/code'); assert.equal((await call('m2', 'GET', '/api/portal')).s, 401);
});
await t('staff User role limits', async () => {
  assert.equal((await call('a', 'POST', '/api/users', { username: 'treasurer', password: 'Temp#Pass12', role: 'User' })).s, 200);
  assert.equal((await call('u', 'POST', '/api/login/staff', { username: 'treasurer', password: 'Temp#Pass12' })).j.mustChange, true);
  await call('u', 'POST', '/api/me/password', { current: 'Temp#Pass12', password: 'Treas#2026x' });
  assert.equal((await call('u', 'GET', '/api/state')).s, 200);
  for (const [m, p, b] of [['GET', '/api/backup'], ['POST', '/api/users', { username: 'abc', password: 'abcdefgh' }], ['POST', '/api/codes/bulk', {}], ['PUT', '/api/settings', { churchName: 'x' }], ['POST', '/api/clear', {}]]) assert.equal((await call('u', m, p, b)).s, 403, p);
  assert.equal((await call('u', 'POST', '/api/finance', { type: 'Income', cat: 'Tithe', amount: 150.456 })).s, 200);
  assert.equal((await call('a', 'GET', '/api/state')).j.finance[0].amount, 150.46);
});
await t('password reset ends that user\'s sessions; cannot delete self / last admin', async () => {
  await call('a', 'PUT', '/api/users/treasurer/password', { password: 'Reset#Pass99' });
  assert.equal((await call('u', 'GET', '/api/state')).s, 401);
  assert.equal((await call('a', 'DELETE', '/api/users/admin')).s, 400);
  assert.equal((await call('a', 'GET', '/api/state')).s, 200);
});
await t('lockout after repeated wrong passwords', async () => {
  let last; for (let i = 0; i < 6; i++) last = await call('l', 'POST', '/api/login/staff', { username: 'treasurer', password: 'bad' + i });
  assert.equal(last.s, 429);
  assert.equal((await call('l', 'POST', '/api/login/staff', { username: 'treasurer', password: 'Reset#Pass99' })).s, 429);
});
await t('backup then restore, clear, logout', async () => {
  const bk = await call('a', 'GET', '/api/backup'); assert.equal(bk.s, 200); assert.match(bk.r.headers.get('content-disposition'), /attachment/);
  const cl=await call('a', 'POST', '/api/clear', {}); console.log('clear',cl.s,cl.j); const s0=await call('a','GET','/api/state'); console.log('state',s0.s,JSON.stringify(s0.j).slice(0,120)); assert.equal(s0.j.members.length, 0);
  const rs=await call('a', 'POST', '/api/restore', bk.j); console.log('restore',rs.s,rs.j); assert.equal(rs.s, 200);
  const st = await call('a', 'GET', '/api/state'); assert.equal(st.j.members.length, 2); assert.equal(st.j.attendance.length, 1);
  await call('a', 'POST', '/api/login/staff', { username: 'admin', password: 'Church#Admin26' }).then((r) => assert.equal(r.s, 200));
  assert.equal((await call('a', 'POST', '/api/logout', {})).s, 200); assert.equal((await call('a', 'GET', '/api/state')).s, 401);
});
await t('settings + logo validation', async () => {
  await call('a', 'POST', '/api/login/staff', { username: 'admin', password: 'Church#Admin26' });
  assert.equal((await call('a', 'PUT', '/api/settings', { churchName: 'Grace Congregation', currency: 'GHS', logo: 'javascript:alert(1)' })).s, 400);
  assert.equal((await call('a', 'PUT', '/api/settings', { churchName: 'Grace Congregation', currency: 'GHS', logo: 'data:image/png;base64,iVBORw0KGgo=' })).s, 200);
  assert.equal((await call('x', 'GET', '/api/public')).j.churchName, 'Grace Congregation');
});

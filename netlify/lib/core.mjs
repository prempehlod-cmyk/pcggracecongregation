// Church Management System: API logic. Storage is injected so it can run on Netlify Blobs or in tests.
import crypto from 'node:crypto';

const STAFF_TTL = 12 * 3600 * 1000;
const MEMBER_TTL = 4 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = ['Children', 'Youth', 'Young Adults', 'Adults', 'Seniors'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const dateStr = (v) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
const nowIso = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
const hashSecret = (secret, salt) => crypto.scryptSync(String(secret), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
function checkSecret(secret, salt, hash) {
  const a = Buffer.from(hashSecret(secret, salt), 'hex'), b = Buffer.from(String(hash || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY_SALT = newSalt(), DUMMY_HASH = hashSecret('dummy', DUMMY_SALT);
function makeCode() { let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]; return s; }
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const safeEqStr = (a, b) => { const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b))); return crypto.timingSafeEqual(x, y); };

/**
 * store: { get(key) -> json|null, set(key, json), del(key) }
 * env:   { ADMIN_PASSWORD?, CHURCH_NAME? }
 */
export function createHandler(store, env = {}) {
  return async function handle(req, ctx = {}) {
    const cache = new Map(), dirty = new Set();
    const doc = async (name, def) => {
      if (!cache.has(name)) { const v = await store.get('d/' + name); cache.set(name, v == null ? structuredClone(def) : v); }
      return cache.get(name);
    };
    const touch = (name) => dirty.add(name);
    const flush = async () => { for (const n of dirty) await store.set('d/' + n, cache.get(n)); dirty.clear(); };
    const D = {
      users: () => doc('users', { items: [] }),
      members: () => doc('members', { items: [] }),
      groups: () => doc('groups', { items: [...GROUPS] }),
      attendance: () => doc('attendance', { next: 1, items: [] }),
      finance: () => doc('finance', { next: 1, items: [] }),
      documents: () => doc('documents', { next: 1, items: [] }),
      settings: () => doc('settings', { churchName: env.CHURCH_NAME || 'Church Management System', currency: 'GHS', logo: '' }),
      audit: () => doc('audit', { items: [] }),
    };
    const audit = async (actor, action, detail = '') => { const a = await D.audit(); a.items.push({ at: nowIso(), actor, action, detail: String(detail).slice(0, 300) }); if (a.items.length > 300) a.items.splice(0, a.items.length - 300); touch('audit'); };

    /* ----- sessions & lockouts (one small record each, no shared documents) ----- */
    const createSession = async (kind, subject, ver) => {
      const token = crypto.randomBytes(32).toString('base64url');
      await store.set('s/' + sha(token), { kind, subject, ver, expires: Date.now() + (kind === 'staff' ? STAFF_TTL : MEMBER_TTL) });
      return token;
    };
    const cookieToken = () => { const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{20,80})/.exec(req.headers.get('cookie') || ''); return m ? m[1] : null; };
    const getSession = async () => {
      const t = cookieToken(); if (!t) return null;
      const key = 's/' + sha(t), s = await store.get(key);
      if (!s) return null;
      if (s.expires < Date.now()) { await store.del(key); return null; }
      if (s.kind === 'staff') {
        const u = (await D.users()).items.find((x) => x.username === s.subject);
        if (!u || (u.ver || 0) !== (s.ver || 0)) return null;
        return { kind: 'staff', name: u.username, role: u.role, mustChange: !!u.mustChange, key };
      }
      const m = (await D.members()).items.find((x) => x.id === s.subject);
      if (!m || !m.codeHash || m.codeHash.slice(0, 16) !== s.ver) return null;
      return { kind: 'member', id: m.id, name: m.name, role: 'Member', key };
    };
    const lockKey = (k) => 'a/' + sha(k);
    const lockLeft = async (k) => { const a = await store.get(lockKey(k)); return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0; };
    const noteFail = async (k, limit = 5) => {
      let a = await store.get(lockKey(k)) || { n: 0, until: 0, last: 0 };
      if (Date.now() - a.last > 3600000) a.n = 0;
      a.n++; a.last = Date.now();
      if (a.n >= limit) a.until = Date.now() + Math.min(900, 30 * Math.pow(2, a.n - limit)) * 1000;
      await store.set(lockKey(k), a);
    };
    const clearFail = (k) => store.del(lockKey(k));

    /* ----- helpers ----- */
    const sortedMembers = (items) => items.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const pubMember = (m) => ({ id: m.id, name: m.name, gender: m.gender || '', dob: m.dob || '', phone: m.phone || '', res: m.res || '', occ: m.occ || '', group: m.group || '', marital: m.marital || '', joined: m.joined || '', hasCode: !!m.codeHash, codeSet: m.codeSet || null });
    const nextMemberId = (items) => { let mx = 0; for (const m of items) { const k = /^M(\d+)$/.exec(m.id); if (k) mx = Math.max(mx, +k[1]); } return 'M' + String(mx + 1).padStart(4, '0'); };
    const ensureGroup = async (g) => { if (g) { const gr = await D.groups(); if (!gr.items.includes(g)) { gr.items.push(g); touch('groups'); } } };
    const upsertMember = async (b, members) => {
      const id = str(b.id, 20) || nextMemberId(members.items);
      need(/^[A-Za-z0-9_-]{1,20}$/.test(id), 'Member ID may use letters, numbers, - and _ only');
      const name = str(b.name, 120); need(name, 'Enter member name');
      const rec = { id, name, gender: str(b.gender, 20), dob: dateStr(b.dob), phone: str(b.phone, 40), res: str(b.res, 120), occ: str(b.occ, 120), group: str(b.group, 60), marital: str(b.marital, 20), joined: dateStr(b.joined) };
      await ensureGroup(rec.group);
      const i = members.items.findIndex((m) => m.id === id);
      if (i >= 0) { const o = members.items[i]; members.items[i] = Object.assign({}, rec, { codeSalt: o.codeSalt, codeHash: o.codeHash, codeSet: o.codeSet }); } else members.items.push(rec);
      touch('members'); return id;
    };
    const issueCode = (m) => { const code = makeCode(); m.codeSalt = newSalt(); m.codeHash = hashSecret(code, m.codeSalt); m.codeSet = nowIso().slice(0, 10); return fmtCode(code); };

    const state = async (s) => {
      const out = {
        members: sortedMembers((await D.members()).items).map(pubMember),
        groups: (await D.groups()).items,
        attendance: (await D.attendance()).items,
        finance: (await D.finance()).items,
        documents: (await D.documents()).items,
        settings: await D.settings(),
      };
      if (s.role === 'Administrator') {
        out.users = (await D.users()).items.map((u) => ({ username: u.username, role: u.role, mustChange: !!u.mustChange })).sort((a, b) => a.username.localeCompare(b.username));
        out.audit = (await D.audit()).items.slice(-100).reverse();
      }
      return out;
    };

    /* ----- routes ----- */
    const routes = [];
    const route = (method, pattern, role, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, fn });
    const ok = { ok: true };

    route('GET', '/api/public', 'public', async () => { const s = await D.settings(); return { churchName: s.churchName, logo: s.logo }; });

    route('POST', '/api/login/staff', 'public', async (c) => {
      const username = str(c.body.username, 60), password = String(c.body.password || '');
      const ipKey = 'ip:' + c.ip, uKey = 'u:' + username.toLowerCase();
      const w = Math.max(await lockLeft(ipKey), await lockLeft(uKey));
      if (w) throw new HttpError(429, `Too many attempts. Try again in ${w} seconds.`);
      const users = await D.users();
      let u = users.items.find((x) => x.username === username);
      if (!users.items.length) { // first start: the administrator password comes from the ADMIN_PASSWORD setting
        if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Setup is not finished. In Netlify, add the environment variable ADMIN_PASSWORD, then redeploy.');
        if (username === 'admin' && safeEqStr(password, env.ADMIN_PASSWORD)) {
          const salt = newSalt(); u = { username: 'admin', role: 'Administrator', salt, hash: hashSecret(password, salt), mustChange: true, ver: 0, created: nowIso() };
          users.items.push(u); touch('users');
        }
      }
      const good = u ? checkSecret(password, u.salt, u.hash) : (checkSecret(password, DUMMY_SALT, DUMMY_HASH), false);
      if (!good) { await noteFail(ipKey, 20); await noteFail(uKey); await audit(username || '?', 'login failed', c.ip); await flush(); throw new HttpError(401, 'Invalid username or password.'); }
      await clearFail(uKey); await audit(u.username, 'login', c.ip);
      return { __cookie: await createSession('staff', u.username, u.ver || 0), kind: 'staff', name: u.username, role: u.role, mustChange: !!u.mustChange };
    });

    route('POST', '/api/login/member', 'public', async (c) => {
      const id = str(c.body.id, 20).toUpperCase(), code = normCode(c.body.code);
      const ipKey = 'ip:' + c.ip, mKey = 'm:' + id;
      const w = Math.max(await lockLeft(ipKey), await lockLeft(mKey));
      if (w) throw new HttpError(429, `Too many attempts. Try again in ${w} seconds.`);
      const m = id ? (await D.members()).items.find((x) => x.id.toUpperCase() === id) : null;
      const good = m && m.codeHash ? checkSecret(code, m.codeSalt, m.codeHash) : (checkSecret(code, DUMMY_SALT, DUMMY_HASH), false);
      if (!good) { await noteFail(ipKey, 20); await noteFail(mKey); throw new HttpError(401, 'Invalid member ID or access code.'); }
      await clearFail(mKey); await audit('member ' + m.id, 'login', c.ip);
      return { __cookie: await createSession('member', m.id, m.codeHash.slice(0, 16)), kind: 'member', id: m.id, name: m.name, role: 'Member' };
    });

    route('POST', '/api/logout', 'public', async (c) => { if (c.session) await store.del(c.session.key); return { __clearCookie: true, ok: true }; });
    route('GET', '/api/me', 'any', async (c) => ({ kind: c.session.kind, name: c.session.name, id: c.session.id, role: c.session.role, mustChange: !!c.session.mustChange }));

    route('POST', '/api/me/password', 'staff', async (c) => {
      const cur = String(c.body.current || ''), pw = String(c.body.password || '');
      need(pw.length >= 8, 'Use at least 8 characters for the new password'); need(pw !== cur, 'Choose a password different from the current one');
      const users = await D.users(), u = users.items.find((x) => x.username === c.session.name);
      const key = 'u:' + u.username.toLowerCase(); const w = await lockLeft(key); if (w) throw new HttpError(429, `Too many attempts. Try again in ${w} seconds.`);
      if (!checkSecret(cur, u.salt, u.hash)) { await noteFail(key); throw new HttpError(401, 'Current password is not correct'); }
      u.salt = newSalt(); u.hash = hashSecret(pw, u.salt); u.mustChange = false; u.ver = (u.ver || 0) + 1; touch('users');
      await audit(u.username, 'changed own password');
      return { ok: true, __cookie: await createSession('staff', u.username, u.ver), kind: 'staff', name: u.username, role: u.role, mustChange: false };
    });

    route('GET', '/api/state', 'staff', (c) => state(c.session));
    route('GET', '/api/portal', 'member', async (c) => {
      const m = (await D.members()).items.find((x) => x.id === c.session.id), all = (await D.attendance()).items.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
      return { member: pubMember(m), attendance: all.filter((a) => a.ids.includes(m.id)).map((a) => ({ date: a.date, service: a.service })), totalServices: all.length, settings: { churchName: (await D.settings()).churchName } };
    });

    route('POST', '/api/members', 'staff', async (c) => { const members = await D.members(); const id = await upsertMember(c.body, members); await audit(c.session.name, 'saved member', id); return { id }; });
    route('POST', '/api/members/bulk', 'staff', async (c) => {
      const list = Array.isArray(c.body.members) ? c.body.members : []; need(list.length && list.length <= 3000, 'Provide between 1 and 3000 members');
      const members = await D.members(); let n = 0; for (const m of list) if (str(m.name)) { await upsertMember(m, members); n++; }
      await audit(c.session.name, 'imported members', n); return { imported: n };
    });
    route('DELETE', '/api/members/:id', 'staff', async (c) => { const members = await D.members(); members.items = members.items.filter((m) => m.id !== c.params.id); touch('members'); await audit(c.session.name, 'deleted member', c.params.id); return ok; });
    route('POST', '/api/members/:id/code', 'admin', async (c) => { const members = await D.members(), m = members.items.find((x) => x.id === c.params.id); need(m, 'Member not found'); const code = issueCode(m); touch('members'); await audit(c.session.name, 'issued access code', m.id); return { code }; });
    route('DELETE', '/api/members/:id/code', 'admin', async (c) => { const members = await D.members(), m = members.items.find((x) => x.id === c.params.id); need(m, 'Member not found'); delete m.codeHash; delete m.codeSalt; delete m.codeSet; touch('members'); await audit(c.session.name, 'removed access code', m.id); return ok; });
    route('POST', '/api/codes/bulk', 'admin', async (c) => {
      const members = await D.members(); const todo = sortedMembers(members.items.filter((m) => !m.codeHash));
      const codes = todo.map((m) => ({ id: m.id, name: m.name, phone: m.phone || '', code: issueCode(m) })); touch('members'); await audit(c.session.name, 'issued access codes in bulk', codes.length); return { codes };
    });

    route('POST', '/api/groups', 'staff', async (c) => { const n = str(c.body.name, 60); need(n, 'Enter a group name'); await ensureGroup(n); return ok; });
    route('PUT', '/api/groups/:name', 'staff', async (c) => {
      const old = decodeURIComponent(c.params.name), n = str(c.body.name, 60); need(n, 'Enter a group name');
      const g = await D.groups(), members = await D.members(); const i = g.items.indexOf(old);
      if (i >= 0) g.items[i] = n; else g.items.push(n); g.items = [...new Set(g.items)]; members.items.forEach((m) => { if (m.group === old) m.group = n; }); touch('groups'); touch('members'); return ok;
    });
    route('DELETE', '/api/groups/:name', 'staff', async (c) => { const g = await D.groups(); g.items = g.items.filter((x) => x !== decodeURIComponent(c.params.name)); touch('groups'); return ok; });

    route('POST', '/api/attendance', 'staff', async (c) => {
      const ids = Array.isArray(c.body.ids) ? c.body.ids.map((x) => str(x, 20)).filter(Boolean) : []; need(ids.length && ids.length <= 5000, 'Tick at least one member');
      const a = await D.attendance(); a.items.push({ id: a.next++, date: dateStr(c.body.date) || nowIso().slice(0, 10), service: str(c.body.service, 80) || 'Service', ids: [...new Set(ids)] }); touch('attendance'); return ok;
    });
    route('DELETE', '/api/attendance/:id', 'admin', async (c) => { const a = await D.attendance(); a.items = a.items.filter((x) => x.id !== Number(c.params.id)); touch('attendance'); return ok; });
    route('POST', '/api/finance', 'staff', async (c) => {
      const type = c.body.type === 'Expenditure' ? 'Expenditure' : 'Income', amount = Math.round(Number(c.body.amount) * 100) / 100;
      need(Number.isFinite(amount) && amount !== 0 && Math.abs(amount) < 1e12, 'Enter a valid amount');
      const f = await D.finance(); f.items.push({ id: f.next++, date: dateStr(c.body.date) || nowIso().slice(0, 10), type, cat: str(c.body.cat, 80), amount, desc: str(c.body.desc, 300) }); touch('finance');
      await audit(c.session.name, 'added ' + type.toLowerCase(), amount); return ok;
    });
    route('DELETE', '/api/finance/:id', 'staff', async (c) => { const f = await D.finance(); f.items = f.items.filter((x) => x.id !== Number(c.params.id)); touch('finance'); await audit(c.session.name, 'deleted transaction', c.params.id); return ok; });
    route('POST', '/api/documents', 'staff', async (c) => { const n = str(c.body.name, 200); need(n, 'Choose a file'); const d = await D.documents(); d.items.push({ id: d.next++, name: n, desc: str(c.body.desc, 300), date: nowIso().slice(0, 10) }); touch('documents'); return ok; });
    route('DELETE', '/api/documents/:id', 'staff', async (c) => { const d = await D.documents(); d.items = d.items.filter((x) => x.id !== Number(c.params.id)); touch('documents'); return ok; });

    route('PUT', '/api/settings', 'admin', async (c) => {
      const b = c.body, s = await D.settings(); s.churchName = str(b.churchName, 120) || 'Church Management System'; s.currency = str(b.currency, 8) || 'GHS';
      if (typeof b.logo === 'string') { need(b.logo === '' || (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo) && b.logo.length < 900000), 'Logo must be a PNG, JPG, GIF or WebP image under 600 KB'); s.logo = b.logo; }
      touch('settings'); await audit(c.session.name, 'changed settings'); return ok;
    });
    route('POST', '/api/users', 'admin', async (c) => {
      const u = str(c.body.username, 40), p = String(c.body.password || ''), role = c.body.role === 'Administrator' ? 'Administrator' : 'User';
      need(/^[A-Za-z0-9_.@-]{3,40}$/.test(u), 'Username: 3-40 letters, numbers, . _ @ -'); need(p.length >= 8, 'Use at least 8 characters for the password');
      const users = await D.users(); need(!users.items.some((x) => x.username === u), 'Username already exists');
      const salt = newSalt(); users.items.push({ username: u, role, salt, hash: hashSecret(p, salt), mustChange: true, ver: 0, created: nowIso() }); touch('users'); await audit(c.session.name, 'created user', u); return ok;
    });
    route('PUT', '/api/users/:username/password', 'admin', async (c) => {
      const name = decodeURIComponent(c.params.username), p = String(c.body.password || ''); need(p.length >= 8, 'Use at least 8 characters for the password');
      const users = await D.users(), u = users.items.find((x) => x.username === name); need(u, 'User not found');
      u.salt = newSalt(); u.hash = hashSecret(p, u.salt); u.mustChange = name !== c.session.name; u.ver = (u.ver || 0) + 1; touch('users'); await audit(c.session.name, 'reset password', name);
      return name === c.session.name ? { ok: true, __cookie: await createSession('staff', u.username, u.ver), kind: 'staff', name: u.username, role: u.role, mustChange: false } : ok;
    });
    route('DELETE', '/api/users/:username', 'admin', async (c) => {
      const name = decodeURIComponent(c.params.username); need(name !== c.session.name, 'You cannot delete your own account');
      const users = await D.users(), t = users.items.find((x) => x.username === name); need(t, 'User not found');
      need(!(t.role === 'Administrator' && users.items.filter((x) => x.role === 'Administrator').length <= 1), 'Keep at least one administrator');
      users.items = users.items.filter((x) => x.username !== name); touch('users'); await audit(c.session.name, 'deleted user', name); return ok;
    });

    route('GET', '/api/backup', 'admin', async (c) => {
      await audit(c.session.name, 'downloaded backup');
      return { __download: 'church-backup-' + nowIso().slice(0, 10) + '.json', app: 'churchCMS-server', version: 2, at: nowIso(), data: {
        members: (await D.members()).items, groups: (await D.groups()).items, attendance: (await D.attendance()).items, finance: (await D.finance()).items,
        documents: (await D.documents()).items, settings: await D.settings(), users: (await D.users()).items } };
    });
    route('POST', '/api/restore', 'admin', async (c) => {
      const d = c.body && c.body.data; need(d && Array.isArray(d.members) && Array.isArray(d.groups), 'That file is not a church backup');
      const users = Array.isArray(d.users) ? d.users.map((u) => ({ username: str(u.username, 40), role: u.role === 'Administrator' ? 'Administrator' : 'User', salt: u.salt, hash: u.hash, mustChange: !!(u.mustChange ?? u.must_change), ver: (u.ver || 0) + 1, created: u.created || nowIso() })) : [];
      need(!users.length || users.some((u) => u.role === 'Administrator'), 'The backup has no administrator account');
      const mem = d.members.map((m) => ({ id: str(m.id, 20), name: str(m.name, 120), gender: str(m.gender, 20), dob: str(m.dob, 10), phone: str(m.phone, 40), res: str(m.res, 120), occ: str(m.occ, 120), group: str(m.group ?? m.grp, 60), marital: str(m.marital, 20), joined: str(m.joined, 10), codeSalt: m.codeSalt ?? m.code_salt ?? undefined, codeHash: m.codeHash ?? m.code_hash ?? undefined, codeSet: m.codeSet ?? m.code_set ?? undefined })).filter((m) => m.id && m.name);
      const att = (d.attendance || []).map((a, i) => ({ id: i + 1, date: str(a.date, 10), service: str(a.service, 80), ids: typeof a.ids === 'string' ? JSON.parse(a.ids) : (a.ids || []) }));
      const fin = (d.finance || []).map((f, i) => ({ id: i + 1, date: str(f.date, 10), type: f.type === 'Expenditure' ? 'Expenditure' : 'Income', cat: str(f.cat, 80), amount: Number(f.amount) || 0, desc: str(f.desc ?? f.descr, 300) }));
      const docs = (d.documents || []).map((x, i) => ({ id: i + 1, name: str(x.name, 200), desc: str(x.desc ?? x.descr, 300), date: str(x.date, 20) }));
      const g = d.groups.map((x) => str(x.name ?? x, 60)).filter(Boolean);
      let st = d.settings || {}; if (Array.isArray(st)) st = Object.fromEntries(st.map((r) => [r.key, r.value]));
      cache.set('members', { items: mem }); cache.set('groups', { items: [...new Set(g)] }); cache.set('attendance', { next: att.length + 1, items: att }); cache.set('finance', { next: fin.length + 1, items: fin }); cache.set('documents', { next: docs.length + 1, items: docs });
      cache.set('settings', { churchName: str(st.churchName, 120) || 'Church Management System', currency: str(st.currency, 8) || 'GHS', logo: typeof st.logo === 'string' ? st.logo : '' });
      ['members', 'groups', 'attendance', 'finance', 'documents', 'settings'].forEach(touch);
      if (users.length) { cache.set('users', { items: users }); touch('users'); }
      await audit(c.session.name, 'restored backup');
      const me = users.find((u) => u.username === c.session.name);
      return me && me.role === 'Administrator' ? { ok: true, __cookie: await createSession('staff', me.username, me.ver), kind: 'staff', name: me.username, role: me.role, mustChange: false } : ok;
    });
    route('POST', '/api/clear', 'admin', async (c) => {
      cache.set('members', { items: [] }); cache.set('attendance', { next: 1, items: [] }); cache.set('finance', { next: 1, items: [] }); cache.set('documents', { next: 1, items: [] });
      ['members', 'attendance', 'finance', 'documents'].forEach(touch); await audit(c.session.name, 'cleared all church records'); return ok;
    });

    /* ----- dispatch ----- */
    const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
    const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: Object.assign({}, SEC, extra) });
    try {
      const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/';
      if (!p.startsWith('/api/')) return reply(404, { error: 'Not found' });
      if (req.method !== 'GET') {
        if (req.headers.get('x-requested-with') !== 'church') throw new HttpError(403, 'Forbidden');
        const origin = req.headers.get('origin'); if (origin) { let oh = ''; try { oh = new URL(origin).host; } catch (e) {} if (oh !== url.host) throw new HttpError(403, 'Forbidden'); }
      }
      let match = null, params = {};
      for (const r of routes) { if (r.method !== req.method) continue; const m = r.re.exec(p); if (m) { match = r; params = m.groups || {}; break; } }
      if (!match) throw new HttpError(404, 'Not found');
      const session = await getSession();
      if (match.role !== 'public') {
        if (!session) throw new HttpError(401, 'Please log in');
        if (match.role === 'staff' && session.kind !== 'staff') throw new HttpError(403, 'Not allowed');
        if (match.role === 'admin' && !(session.kind === 'staff' && session.role === 'Administrator')) throw new HttpError(403, 'Only an administrator can do this');
        if (match.role === 'member' && session.kind !== 'member') throw new HttpError(403, 'Not allowed');
        if (session.kind === 'staff' && session.mustChange && p !== '/api/me' && p !== '/api/me/password' && p !== '/api/logout') throw new HttpError(403, 'Please change your password first');
      }
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') { const text = await req.text(); if (text.length > 5e6) throw new HttpError(413, 'Request too large'); if (text) { try { body = JSON.parse(text); } catch (e) { throw new HttpError(400, 'Invalid JSON'); } } }
      const ip = ctx.ip || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
      const out = await match.fn({ params, body, session, ip });
      await flush();
      const headers = {};
      const cookie = (v, age) => `sid=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
      if (out && out.__cookie) { headers['Set-Cookie'] = cookie(out.__cookie, Math.floor((out.kind === 'staff' ? STAFF_TTL : MEMBER_TTL) / 1000)); delete out.__cookie; }
      if (out && out.__clearCookie) { headers['Set-Cookie'] = cookie('', 0); delete out.__clearCookie; }
      if (out && out.__download) { headers['Content-Disposition'] = `attachment; filename="${out.__download}"`; delete out.__download; }
      return reply(200, out, headers);
    } catch (e) {
      const status = e.status || 500; if (status === 500) console.error(e);
      return reply(status, { error: status === 500 ? 'Server error' : e.message });
    }
  };
}

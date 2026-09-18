import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [, , input] = process.argv;
if (!input) { console.error('usage: node render.mjs <brief.json>'); process.exit(2); }
const brief = JSON.parse(readFileSync(input, 'utf8'));
const outDir = dirname(resolve(input));
const stem = basename(input).replace(/\.json$/, '');
const isReview = brief.mode === 'review';

const KINDS = ['create', 'edit', 'delete'];
const RISKS = ['low', 'med', 'high'];
const EDGE_KINDS = ['new', 'existing', 'removed'];

const validate = (b) => {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  const isFile = (f) => Array.isArray(f) && KINDS.includes(f[0]) && str(f[1]) && (f[3] === undefined || str(f[3]));
  const behaviorCount = Array.isArray(b.behaviors) ? b.behaviors.length : 0;
  const isItem = (x) => Number.isInteger(x) && x >= 1 && x <= behaviorCount;
  need(str(b.title), 'title: missing');
  need(['proposal', 'review'].includes(b.mode), `mode: "${b.mode}" is not proposal or review`);
  need(str(b.user), 'user: missing');
  need(b.notes === undefined || str(b.notes), 'notes: the pasted notes verbatim, or leave it out');
  need(behaviorCount > 0, 'behaviors: empty');
  (b.behaviors || []).forEach((x, i) => {
    const at = `behaviors[${i + 1}]`;
    need(str(x.before), `${at}.before: missing`);
    need(str(x.after), `${at}.after: missing`);
    need(RISKS.includes(x.risk), `${at}.risk: "${x.risk}" is not low, med, or high`);
    need(Array.isArray(x.files) && x.files.every(isFile), `${at}.files: every entry is [kind, path] with kind create, edit, or delete`);
    if (isReview) need(str(x.verified) || str(x.why), `${at}: needs verified (the command, test, or reproduction that proves it) or why (what kept you from proving it)`);
  });
  (b.changed_files || []).forEach((f, i) => {
    const at = `changed_files[${i}]`;
    need(isFile(f), `${at}: [kind, path, note] or [kind, path, note, why] with kind create, edit, or delete`);
    if (isReview && isFile(f)) need(str(f[2]), `${at} ${f[1]}: needs a note saying what changed and why`);
  });
  (b.flows || []).forEach((f, i) => {
    const at = `flows[${i}]`;
    need(str(f.name), `${at}.name: missing`);
    need(Array.isArray(f.items) && f.items.every(isItem), `${at}.items: behavior numbers between 1 and ${behaviorCount}`);
    need((Array.isArray(f.steps) && f.steps.length) || str(f.effect), `${at}: needs steps or effect`);
  });
  (b.touched || []).forEach((t, i) => {
    need(str(t.name) && Number.isInteger(t.files), `touched[${i}]: name and a files count`);
  });
  if (b.map) {
    const layers = b.map.layers;
    need(Array.isArray(layers) && layers.length && layers.every(str), 'map.layers: a list of column titles, for example ["Entry", "Logic", "Storage"]');
    const ids = new Set();
    (b.map.nodes || []).forEach((x, i) => {
      const at = `map.nodes[${i}]`;
      need(str(x.id), `${at}.id: missing`);
      ids.add(x.id);
      need(str(x.name), `${at}.name: missing`);
      const layerOk = Array.isArray(layers) && ((typeof x.layer === 'string' && layers.includes(x.layer)) || (Number.isInteger(x.layer) && x.layer >= 0 && x.layer < layers.length));
      need(layerOk, `${at}.layer: "${x.layer}" is not one of the layer titles or a layer index`);
      need(x.changed === null || KINDS.includes(x.changed), `${at}.changed: "${x.changed}" is not create, edit, delete, or null`);
      need(Number.isInteger(x.files) || (Array.isArray(x.files) && x.files.every(str)), `${at}.files: a list of paths, for example ["src/auth/reset-limiter.ts"], or a count`);
    });
    (b.map.edges || []).forEach((e, i) => {
      const at = `map.edges[${i}]`;
      need(ids.has(e.from), `${at}.from: "${e.from}" is not a node id`);
      need(ids.has(e.to), `${at}.to: "${e.to}" is not a node id`);
      need(EDGE_KINDS.includes(e.kind), `${at}.kind: "${e.kind}" is not new, existing, or removed`);
    });
  }
  if (isReview) {
    const f = b.findings || {};
    ['blockers', 'nonBlockers'].forEach((list) => {
      need(Array.isArray(f[list]), `findings.${list}: missing (use [] when there are none)`);
      (f[list] || []).forEach((x, i) => {
        const at = `findings.${list}[${i}]`;
        need(x && typeof x === 'object' && !Array.isArray(x), `${at}: an object with title, where, items, detail`);
        if (!x || typeof x !== 'object') return;
        need(str(x.title), `${at}.title: one line naming the problem`);
        need(str(x.where), `${at}.where: file:line, or the file when there is no line`);
        need(Array.isArray(x.items) && x.items.every(isItem), `${at}.items: behavior numbers between 1 and ${behaviorCount} (use [] when it belongs to none)`);
        need(str(x.detail), `${at}.detail: the evidence and the fix`);
      });
    });
    (b.delta || []).forEach((d, i) => {
      need(['added', 'dropped', 'changed'].includes(d.kind) && str(d.text), `delta[${i}]: kind added, dropped, or changed, and text`);
    });
  } else {
    (b.questions || []).forEach((q, i) => {
      const at = `questions[${i}]`;
      need(str(q.q), `${at}.q: missing`);
      need(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4, `${at}.options: two to four`);
      need((q.options || []).includes(q.recommend), `${at}.recommend: must be one of the options, verbatim`);
    });
  }
  return errs;
};

const problems = validate(brief);
if (problems.length) {
  console.error(`${input}: ${problems.length} problem${problems.length === 1 ? '' : 's'}, nothing rendered`);
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

const historyDir = join(outDir, 'history');
const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v);
const loadHistory = () => {
  if (!existsSync(historyDir)) return [];
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.v(\\d+)\\.json$`);
  return readdirSync(historyDir)
    .map((f) => { const m = f.match(re); return m ? { v: Number(m[1]), file: join(historyDir, f) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.v - b.v)
    .map((s) => {
      let data;
      try { data = JSON.parse(readFileSync(s.file, 'utf8')); } catch (e) { console.error(`${s.file}: cannot read this saved version (${e.message.split('\n')[0]}), nothing rendered`); process.exit(1); }
      return { ...s, data, at: statSync(s.file).mtime };
    });
};
const versions = loadHistory();
const newest = versions[versions.length - 1];
const changed = !newest || stable(newest.data) !== stable(brief);
if (changed) {
  mkdirSync(historyDir, { recursive: true });
  const v = newest ? newest.v + 1 : 1;
  const file = join(historyDir, `${stem}.v${v}.json`);
  writeFileSync(file, JSON.stringify(brief, null, 2) + '\n');
  versions.push({ v, file, data: brief, at: new Date() });
}
const current = versions[versions.length - 1];

const diffVersions = (prev, next) => {
  const out = [];
  const pb = prev.behaviors || [], nb = next.behaviors || [];
  const paths = (b) => (b.files || []).map(([, p]) => p);
  const match = new Map(), taken = new Set();
  const tiers = [
    (a, b) => a.after === b.after,
    (a, b) => a.before === b.before,
    (a, b) => paths(a).some((p) => paths(b).includes(p)),
  ];
  tiers.forEach((same) => pb.forEach((a, i) => {
    if (match.has(i)) return;
    const j = nb.findIndex((b, k) => !taken.has(k) && same(a, b));
    if (j >= 0) { match.set(i, j); taken.add(j); }
  }));
  pb.forEach((a, i) => {
    if (!match.has(i)) { out.push({ kind: 'dropped', text: `${a.after} (was ${i + 1})` }); return; }
    const j = match.get(i), b = nb[j];
    const fields = [['after', 'title'], ['before', 'before'], ['risk', 'risk'], ['files', 'files'], ['test', 'test'], ['detail', 'detail']]
      .filter(([k]) => stable(a[k] ?? null) !== stable(b[k] ?? null)).map(([, name]) => name);
    const moved = i !== j ? `moved from ${i + 1}` : '';
    const what = [moved, fields.length ? `changed ${fields.join(', ')}` : ''].filter(Boolean).join(', ');
    if (what) out.push({ kind: 'changed', text: `${j + 1} ${what}: ${b.after}` });
  });
  nb.forEach((b, j) => { if (!taken.has(j)) out.push({ kind: 'added', text: `${j + 1} added: ${b.after}` }); });
  const pq = (prev.questions || []).map((q) => q.q), nq = (next.questions || []).map((q) => q.q);
  pq.filter((q) => !nq.includes(q)).forEach((q) => out.push({ kind: 'decided', text: q }));
  nq.filter((q) => !pq.includes(q)).forEach((q) => out.push({ kind: 'asked', text: q }));
  const pf = new Map((prev.changed_files || []).map((f) => [f[1], f[0]])), nf = new Map((next.changed_files || []).map((f) => [f[1], f[0]]));
  nf.forEach((k, p) => { if (!pf.has(p)) out.push({ kind: 'added', text: `file ${p}` }); else if (pf.get(p) !== k) out.push({ kind: 'changed', text: `file ${p} is now ${k}` }); });
  pf.forEach((k, p) => { if (!nf.has(p)) out.push({ kind: 'dropped', text: `file ${p}` }); });
  if (prev.user !== next.user) out.push({ kind: 'changed', text: 'summary reworded' });
  if (prev.title !== next.title) out.push({ kind: 'changed', text: `title is now ${next.title}` });
  if (stable(prev.flows || []) !== stable(next.flows || [])) out.push({ kind: 'changed', text: 'flows changed' });
  return out;
};
const whenText = (d) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const historyAll = versions.slice(1).map((s, i) => {
  const prev = versions[i];
  const notes = typeof s.data.notes === 'string' && s.data.notes !== prev.data.notes ? s.data.notes : '';
  return { v: s.v, when: whenText(s.at), notes, entries: diffVersions(prev.data, s.data) };
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const riskName = { low: 'Low', med: 'Medium', high: 'High' };
const bars = { low: 1, med: 2, high: 3 };
const fileMark = { create: '+', edit: '~', delete: '-' };
const prioIcon = (r) => `<svg class="prio" width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="8" width="3" height="6" rx="1" class="${bars[r] >= 1 ? 'on' : ''}"/><rect x="6.5" y="5" width="3" height="9" rx="1" class="${bars[r] >= 2 ? 'on' : ''}"/><rect x="11.5" y="2" width="3" height="12" rx="1" class="${bars[r] >= 3 ? 'on' : ''}"/></svg>`;
const chip = (inner, cls = '') => `<span class="chip ${cls}">${inner}</span>`;
const jump = (target, inner, cls = '') => `<a class="chip ${cls}" href="#${target}" data-jump="${target}">${inner}</a>`;
const chevron = '<button class="more" type="button" aria-label="Details"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
const caret = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const build = (brief, ctx) => {
const isReview = brief.mode === 'review';
let mapWidth = 0;
const behaviors = brief.behaviors;
const questions = brief.questions || [];
const changedFiles = brief.changed_files || [];
const samePath = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
const behaviorsFor = (path) => behaviors.map((b, i) => (b.files || []).some(([, p]) => samePath(p, path)) ? i + 1 : 0).filter(Boolean);

const findings = isReview ? {
  blockers: brief.findings.blockers.map((f, i) => ({ ...f, id: 'B' + (i + 1), blocker: true })),
  nonBlockers: [
    ...brief.findings.nonBlockers,
    ...behaviors.map((b, i) => b.verified ? null : { title: 'Needs a human check: ' + b.after, where: (b.files || []).map(([, p]) => p).join(', ') || 'no file', items: [i + 1], detail: b.why }).filter(Boolean),
  ].map((f, i) => ({ ...f, id: 'N' + (i + 1), blocker: false })),
} : { blockers: [], nonBlockers: [] };
const allFindings = [...findings.blockers, ...findings.nonBlockers];
const findingsFor = (num) => allFindings.filter((f) => f.items.includes(num));

let n = 0;
const status = (id, title) => `<label class="status" title="${title}"><input type="checkbox" id="ok-${id}" data-id="${id}"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" class="ring"/><circle cx="8" cy="8" r="6.5" class="fill"/><path d="M5 8.3l2 2 4-4.6" class="tick"/></svg></label>`;
const fileSpan = ([kind, path]) => `<span class="file"><span class="fk fk-${kind}">${fileMark[kind]}</span>${esc(path)}</span>`;
const fileLine = (files) => files.length ? `<div class="files">${files.map(fileSpan).join('')}</div>` : '';
const testChip = (t) => {
  if (t === null || t === undefined) return chip('<i class="dot-yellow"></i>No test');
  if (typeof t === 'string') return chip(`<i class="dot-green"></i>${esc(t)}`, t.length > 72 ? 'chip-long' : '');
  if (t.gap) return chip('<i class="dot-red"></i>No test', 'chip-bad');
  return '';
};
const noteBox = (id, placeholder) => `<textarea id="txt-${id}" data-id="${id}" rows="2" placeholder="${esc(placeholder)}"></textarea>`;
const detail = (id, inner, placeholder) => `
  <div class="detail" id="detail-${id}" hidden>
    ${inner}
    ${noteBox(id, placeholder)}
  </div>`;

const behaviorRows = behaviors.map((b) => {
  const id = ++n;
  const linked = findingsFor(id);
  const blockers = linked.filter((f) => f.blocker);
  const others = linked.filter((f) => !f.blocker);
  const chips = [
    chip(`${prioIcon(b.risk)}${riskName[b.risk]} risk`),
    chip(plural((b.files || []).length, 'file')),
    isReview ? (b.verified ? chip('<i class="dot-green"></i>Proven') : chip('<i class="dot-yellow"></i>Needs a human', 'chip-warn')) : testChip(b.test),
    blockers.length ? jump('finding-' + blockers[0].id, `<i class="dot-red"></i>${plural(blockers.length, 'blocker')}`, 'chip-bad') : '',
    others.length ? jump('finding-' + others[0].id, `<i class="dot-yellow"></i>${plural(others.length, 'non-blocker')}`, 'chip-warn') : '',
  ].join('');
  const proof = isReview
    ? (b.verified ? `<p class="proof"><span class="plabel">Proof</span>${esc(b.verified)}</p>` : `<p class="proof"><span class="plabel">Unproven</span>${esc(b.why)}</p>`)
    : '';
  const label = `${id}. ${b.before} -> ${b.after}`;
  return `
  <li class="row" data-row="${id}" id="row-${id}" data-section="Behavior changes" data-label="${esc(label)}">
    <div class="head">
      <div class="line">
        <span class="key">${id}</span>
        ${isReview ? '' : status(id, 'Approve')}
        <div class="main"><div class="after">${esc(b.after)}</div><div class="before"><span class="blabel">Before</span>${esc(b.before)}</div></div>
        <div class="props">${chevron}</div>
      </div>
      <div class="chips">${chips}</div>
    </div>
    ${detail(id, `${b.detail ? `<p>${esc(b.detail)}</p>` : ''}${proof}${fileLine(b.files || [])}`, isReview ? 'What should change here' : `Note on ${id}`)}
  </li>`;
}).join('');

const questionRows = questions.map((q) => {
  const id = ++n;
  const opts = (q.options || []).map((o, i) => {
    const letter = String.fromCharCode(97 + i);
    const rec = o === q.recommend;
    return `<label class="opt"><input type="radio" name="q-${id}" value="${letter}" data-id="${id}" ${rec ? 'checked' : ''}><span class="opt-l">${letter}</span><span>${esc(o)}${rec ? '<em>recommended</em>' : ''}</span></label>`;
  }).join('');
  return `
  <li class="row static" data-row="${id}">
    <div class="line">
      <span class="key">${id}</span>
      <div class="main wrap"><span class="after">${esc(q.q)}</span></div>
    </div>
    ${q.detail ? `<p class="qdetail">${esc(q.detail)}</p>` : ''}
    <div class="opts">${opts}</div>
    <div class="qnote"><textarea id="txt-${id}" data-id="${id}" rows="1" placeholder="Or type what you want instead…"></textarea></div>
  </li>`;
}).join('');

const mapNodes = (brief.map?.nodes || []).map((x) => ({
  ...x,
  layer: typeof x.layer === 'number' ? brief.map.layers[x.layer] : x.layer,
  files: Array.isArray(x.files) ? x.files : (x.files ? [plural(x.files, 'file')] : []),
}));
const referenced = new Set([
  ...behaviors.flatMap((b) => (b.files || []).map(([, p]) => p)),
  ...(brief.map?.nodes || []).flatMap((x) => Array.isArray(x.files) ? x.files : []),
]);
const explained = (path) => [...referenced].some((r) => samePath(path, r));
const unexplained = changedFiles.filter(([, p]) => !explained(p));
const ledgerRows = unexplained.map((f) => {
  const id = ++n;
  return `
  <li class="row" data-row="${id}" data-section="Files" data-label="${esc(f[1])}">
    <div class="head"><div class="line">
      <span class="key">${id}</span>
      ${isReview ? '' : status(id, 'Accept as is')}
      <div class="main">${fileSpan(f)}</div>
      <div class="props">${chip('<i class="dot-red"></i>Not explained', 'chip-bad')}${chevron}</div>
    </div></div>
    ${detail(id, '<p>No behavior line or map node names this file.</p>', isReview ? 'What should change here' : 'Tick to accept it as is, or say what it is for')}
  </li>`;
}).join('');

const group = (title, count, body, closed, action = '') => `
  <section class="group${closed ? ' closed' : ''}" data-group="${title.replace(/\W+/g, '-').toLowerCase()}">
    <header tabindex="0">${caret}<span class="gtitle">${title}</span><span class="gcount">${count}</span>${action}</header>
    <div class="gbody">${body.trim().startsWith('<li') ? `<ul>${body}</ul>` : body}</div>
  </section>`;

const fileCount = changedFiles.length || referenced.size;
const riskCounts = ['high', 'med', 'low'].map((r) => [r, behaviors.filter((b) => b.risk === r).length]).filter(([, c]) => c);
const flowRows = (brief.flows || []).map((f, i) => {
  const id = 'flow-' + i;
  const body = f.steps?.length
    ? `<ol class="steps">${f.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ol>`
    : `<p>${esc(f.effect || '')}</p>`;
  return `
  <li class="row" data-row="${id}">
    <div class="head"><div class="line">
      <span class="key"></span>
      <div class="main"><span class="after">${esc(f.name)}</span></div>
      <div class="props">${(f.items || []).map((x) => jump('row-' + x, String(x))).join('')}${chevron}</div>
    </div></div>
    <div class="detail" id="detail-${id}" hidden>${body}</div>
  </li>`;
}).join('');
const touchedRows = (brief.touched || []).map((t) => `<li class="prop"><svg class="ico" viewBox="0 0 16 16"><path d="M2 4a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="prop-v">${esc(t.name)}</span><span class="prop-n">${plural(t.files, 'file')}</span></li>`).join('');

const fileGroups = () => {
  const groups = behaviors.map((b, i) => ({ num: i + 1, name: b.after, files: [] }));
  const loose = { num: 0, name: 'No behavior change names these', files: [] };
  changedFiles.forEach(([kind, path, note, why], i) => {
    const owner = behaviorsFor(path)[0];
    (owner ? groups[owner - 1] : loose).files.push({ kind, path, note, why, i });
  });
  return [...groups, loose].filter((g) => g.files.length);
};

const fileTree = (files) => {
  const root = { dirs: new Map(), files: [] };
  files.forEach((f) => {
    const parts = f.path.split('/');
    let node = root;
    parts.slice(0, -1).forEach((p) => {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    });
    node.files.push({ ...f, name: parts[parts.length - 1] });
  });
  const count = (node) => node.files.length + [...node.dirs.values()].reduce((a, d) => a + count(d), 0);
  const fileRow = (f) => {
    const id = 'file-' + f.i;
    const nums = behaviorsFor(f.path).map((x) => jump('row-' + x, String(x))).join('');
    const why = f.why ? `<p class="fwhy"><span class="plabel">Why</span>${esc(f.why)}</p>` : '';
    return `
    <li class="row frow" data-row="${id}" id="${id}" data-section="Files" data-label="${esc(f.path)}">
      <div class="head"><div class="line">
        <span class="fk fk-${f.kind}">${fileMark[f.kind]}</span>
        <div class="main"><span class="fname">${esc(f.name)}</span>${f.note ? `<span class="fnote">${esc(f.note)}</span>` : ''}</div>
        <div class="props">${nums}${chevron}</div>
      </div></div>
      ${detail(id, `<p class="fpath">${esc(f.path)}</p>${why}`, isReview ? 'What should change in this file' : `Note on ${f.path}`)}
    </li>`;
  };
  const dirRows = (node, prefix) => [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, d]) => {
    let label = name, cur = d;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [[k, v]] = cur.dirs.entries();
      label += '/' + k;
      cur = v;
    }
    const path = prefix + label;
    return `
    <li class="dir ${cur.files.length > 10 ? 'closed' : ''}" data-dir="${esc(path)}">
      <div class="dline" tabindex="0">${caret}<span class="dname">${esc(label)}</span><span class="gcount">${count(cur)}</span></div>
      <ul>${dirRows(cur, path + '/')}${cur.files.map(fileRow).join('')}</ul>
    </li>`;
  }).join('');
  return dirRows(root, '') + root.files.map(fileRow).join('');
};

const filesByBehavior = () => `<ul class="tree">${fileGroups().map((g) => `
  <li class="dir bdir" data-dir="behavior-${g.num}">
    <div class="dline bline" tabindex="0">${caret}<span class="bnum">${g.num || ''}</span><span class="bname">${esc(g.name)}</span><span class="gcount">${plural(g.files.length, 'file')}</span></div>
    <ul>${fileTree(g.files)}</ul>
  </li>`).join('')}</ul>`;

const mapSvg = (m) => {
  if (!m || !mapNodes.length) return '';
  const layers = m.layers;
  const GAP = 76, PAD = 12, LINE = 17, HEAD = 34, VGAP = 20, TOP = 28;
  const MIN_W = 212, MAX_W = 330;
  const NAME_CH = 6.9, FILE_CH = 6.3, BADGE_CH = 5.6, LABEL_CH = 5.2;
  const badgeName = { create: 'new', edit: 'edited', delete: 'deleted' };
  const badgeW = (x) => (x.changed ? badgeName[x.changed].length * BADGE_CH + 16 : 0);
  const inCol = (l) => mapNodes.filter((x) => x.layer === l);
  const ell = (s, chars) => (s.length <= chars ? s : s.slice(0, Math.max(1, chars - 1)).trimEnd() + '…');
  const tail = (s, chars) => {
    if (s.length <= chars) return s;
    const t = s.slice(s.length - chars + 1);
    const cut = t.indexOf('/');
    return '…' + (cut > 0 && cut <= 16 ? t.slice(cut) : t);
  };

  const colW = layers.map((l) => Math.round(Math.min(MAX_W, Math.max(MIN_W, PAD * 2 + Math.max(0,
    ...inCol(l).map((x) => Math.max(x.name.length * NAME_CH + badgeW(x), ...x.files.map((f) => f.length * FILE_CH))))))));
  const colX = layers.map(() => 0);
  layers.forEach((l, i) => { if (i) colX[i] = colX[i - 1] + colW[i - 1] + GAP; });

  const pos = new Map();
  layers.forEach((l, ci) => {
    let y = TOP;
    inCol(l).forEach((x, i) => {
      const h = HEAD + (x.files.length ? x.files.length * LINE + PAD : 0);
      pos.set(x.id, { x: colX[ci], y, w: colW[ci], h, col: ci, idx: i, node: x });
      y += h + VGAP;
    });
  });
  const colBottom = layers.map((l) => Math.max(TOP, ...inCol(l).map((x) => pos.get(x.id).y + pos.get(x.id).h)));
  const edges = (m.edges || []).filter((e) => pos.has(e.from) && pos.has(e.to));
  const outs = new Map(), ins = new Map();
  edges.forEach((e) => { outs.set(e.from, [...(outs.get(e.from) || []), e]); ins.set(e.to, [...(ins.get(e.to) || []), e]); });
  const slot = (list, e, box) => box.y + box.h * (list.indexOf(e) + 1) / (list.length + 1);
  const longEdges = edges.filter((e) => pos.get(e.to).col - pos.get(e.from).col > 1);
  const busOf = (e) => Math.max(...colBottom.slice(pos.get(e.from).col + 1, pos.get(e.to).col)) + 24 + longEdges.indexOf(e) * 14;

  let minX = 0;
  const placed = [];
  const label = (e, x, y, anchor) => {
    if (!e.label) return '';
    const w = e.label.length * LABEL_CH;
    const cx = anchor === 'start' ? x + w / 2 : x;
    let ly = y;
    for (let i = 1; i <= 6 && placed.some((p) => Math.abs(p.y - ly) < 12 && Math.abs(p.x - cx) < (p.w + w) / 2 + 8); i++) {
      ly = y + (i % 2 ? 1 : -1) * 13 * Math.ceil(i / 2);
    }
    placed.push({ x: cx, y: ly, w });
    minX = Math.min(minX, cx - w / 2 - 6);
    return `<text class="elabel elabel-${e.kind}" x="${x}" y="${ly}" text-anchor="${anchor}">${esc(e.label)}</text>`;
  };

  const path = (e, d) => `<path class="edge edge-${e.kind}" d="${d}" marker-end="url(#arrow-${e.kind})"/>`;
  const paths = [], labels = [];
  const sideUse = new Map();
  edges.forEach((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const y1 = slot(outs.get(e.from), e, a), y2 = slot(ins.get(e.to), e, b);
    if (b.col - a.col === 1) {
      const x1 = a.x + a.w, x2 = b.x, c = (x2 - x1) / 2;
      paths.push(path(e, `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`));
      labels.push(label(e, (x1 + x2) / 2, (y1 + y2) / 2 - 7, 'middle'));
    } else if (b.col > a.col) {
      const x1 = a.x + a.w, x2 = b.x, bus = busOf(e), xm1 = x1 + GAP / 2, xm2 = x2 - GAP / 2;
      paths.push(path(e, `M${x1},${y1} C${xm1},${y1} ${xm1},${bus} ${xm1 + 24},${bus} L${xm2 - 24},${bus} C${xm2},${bus} ${xm2},${y2} ${x2},${y2}`));
      labels.push(label(e, (xm1 + xm2) / 2, bus - 8, 'middle'));
    } else if (a.col === b.col && b.idx === a.idx + 1) {
      const sx = a.x + a.w / 2, sy = a.y + a.h, tx = b.x + b.w / 2, ty = b.y;
      paths.push(path(e, `M${sx},${sy} C${sx},${sy + 10} ${tx},${ty - 10} ${tx},${ty}`));
      labels.push(label(e, sx + 10, (sy + ty) / 2 + 3.5, 'start'));
    } else {
      const k = sideUse.get(a.col) || 0;
      sideUse.set(a.col, k + 1);
      const off = 34 + k * 16;
      paths.push(path(e, `M${a.x},${y1} C${a.x - off},${y1} ${b.x - off},${y2} ${b.x},${y2}`));
      labels.push(label(e, a.x - off * 0.7, (y1 + y2) / 2 - 6, 'middle'));
      minX = Math.min(minX, a.x - off - 4);
    }
  });

  const nodeSvg = [...pos.values()].map(({ x, y, w, h, node }) => {
    const cls = node.changed ? `node changed-${node.changed}` : 'node';
    const inner = w - PAD * 2;
    const files = node.files.map((f, i) => {
      const shown = tail(f, Math.floor(inner / FILE_CH));
      return `<text class="file" x="${x + PAD}" y="${y + HEAD + i * LINE + 4}">${esc(shown)}${shown === f ? '' : `<title>${esc(f)}</title>`}</text>`;
    }).join('');
    const badge = node.changed ? `<text class="badge badge-${node.changed}" x="${x + w - PAD}" y="${y + 21}" text-anchor="end">${badgeName[node.changed]}</text>` : '';
    const name = ell(node.name, Math.floor((inner - badgeW(node)) / NAME_CH));
    return `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/><text class="name" x="${x + PAD}" y="${y + 21}">${esc(name)}${name === node.name ? '' : `<title>${esc(node.name)}</title>`}</text>${badge}${files}</g>`;
  }).join('');

  const height = Math.max(...colBottom, ...longEdges.map((e) => busOf(e) + 10)) + 6;
  const right = colX[layers.length - 1] + colW[layers.length - 1];
  const x0 = minX - 2, width = right - x0 + 4;
  mapWidth = Math.ceil(width);
  const layerSvg = layers.map((l, i) => `<text class="layer" x="${colX[i]}" y="14">${esc(l)}</text>`).join('');
  const marker = (k, c) => `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`;
  return `<div class="map"><svg viewBox="${x0} 0 ${width} ${height}" width="${Math.ceil(width)}" height="${Math.ceil(height)}"><defs>${marker('new', '#27a644')}${marker('existing', '#62666d')}${marker('removed', '#eb5757')}</defs>${layerSvg}${paths.join('')}${nodeSvg}${labels.join('')}</svg></div>`;
};

const findingRow = (f) => {
  const id = 'finding-' + f.id;
  const label = `${f.id} ${f.title} (${f.where})`;
  return `
  <li class="row" data-row="${id}" id="${id}" data-section="${f.blocker ? 'Blockers' : 'Non-blockers'}" data-label="${esc(label)}" data-detail="${esc(f.detail)}">
    <div class="head"><div class="line">
      <span class="key">${f.id}</span>
      ${status(id, 'Fix this')}
      <div class="main"><div class="after">${esc(f.title)}</div><div class="where">${esc(f.where)}</div></div>
      <div class="props">${f.items.map((x) => jump('row-' + x, String(x))).join('')}${chevron}</div>
    </div></div>
    ${detail(id, `<p>${esc(f.detail)}</p>`, 'How to fix it, if not as written')}
  </li>`;
};
const fixRow = (f) => {
  const id = 'fix-' + f.id;
  const source = jump('finding-' + f.id, `<i class="dot-${f.blocker ? 'red' : 'yellow'}"></i>${f.blocker ? 'Blocker' : 'Non-blocker'} ${f.id}`, f.blocker ? 'chip-bad' : '');
  return `
  <li class="row" data-row="${id}" id="${id}">
    <div class="head"><div class="line">
      <span class="key">${f.id}</span>
      <div class="main"><div class="after">${esc(f.title)}</div><div class="where">${esc(f.where)}</div></div>
      <div class="props">${source}${f.items.map((x) => jump('row-' + x, String(x))).join('')}${chevron}</div>
    </div></div>
    <div class="detail" id="detail-${id}" hidden><p>${esc(f.detail)}</p></div>
  </li>`;
};

const promptFinding = (f) => `- ${f.id} ${f.title} (${f.where})${f.items.length ? ` affects behavior ${f.items.join(', ')}` : ''}\n  ${f.detail}`;
const fixPrompt = [
  `Fix every item below from the review ${JSON.stringify(brief.title)}${brief.branch ? ' on ' + brief.branch : ''}.`,
  'Read each one, make the change it describes, then run the checks the repo defines before reporting back.',
  ...(findings.blockers.length ? ['', '## Blockers', ...findings.blockers.map(promptFinding)] : []),
  ...(findings.nonBlockers.length ? ['', '## Non-blockers', ...findings.nonBlockers.map(promptFinding)] : []),
].join('\n');

const fixesBlock = allFindings.length
  ? group('Suggested changes', allFindings.length, allFindings.map(fixRow).join(''), false,
    '<button id="copy-fixes" class="pill gaction" type="button">Copy suggested changes \u2191</button>')
  : '';

const findingsBlock = isReview
  ? group('Blockers', findings.blockers.length, findings.blockers.map(findingRow).join('') || '<p class="qdetail">None. Nothing stops this from merging.</p>')
    + group('Non-blockers', findings.nonBlockers.length, findings.nonBlockers.map(findingRow).join('') || '<p class="qdetail">None</p>')
  : '';

const deltaBlock = brief.delta?.length
  ? group('Changed since the proposal', brief.delta.length, brief.delta.map((d) => `<li class="row static"><div class="line">${chip(`<i class="dot-${{ added: 'green', dropped: 'red', changed: 'yellow' }[d.kind]}"></i>${d.kind}`)}<div class="main wrap">${esc(d.text)}</div></div></li>`).join(''))
  : '';

const dot = { added: 'green', dropped: 'red', changed: 'yellow', decided: 'green', asked: 'yellow' };
const historyBlock = ctx.history.length
  ? group('History', ctx.history.length, ctx.history.map((h) => `
  <li class="row static hist">
    <div class="line"><span class="key"></span><div class="main wrap"><span class="after">v${h.v}</span><span class="hdate">${esc(h.when)}</span></div></div>
    ${h.notes ? `<pre class="hnotes">${esc(h.notes)}</pre>` : '<p class="qdetail">Made without notes from you</p>'}
    <ul class="hlist">${h.entries.length ? h.entries.map((d) => `<li>${chip(`<i class="dot-${dot[d.kind]}"></i>${d.kind}`)}<span>${esc(d.text)}</span></li>`).join('') : '<li><span class="qdetail">No visible change</span></li>'}</ul>
  </li>`).join(''))
  : '';
const newestV = ctx.versions[ctx.versions.length - 1].v;
const verMenu = ctx.versions.length > 1
  ? `<label class="ver"><select id="ver">${ctx.versions.map((x) => `<option value="${esc(ctx.hrefFor(x.v))}"${x.v === ctx.version ? ' selected' : ''}>v${x.v}${x.v === newestV ? ' · newest' : ''}</option>`).join('')}</select>${caret}</label>`
  : `<span class="ver">v${ctx.version}</span>`;
const topRight = `${ctx.readOnly ? chip('Read only') : ''}${verMenu}`;

const notesBlock = isReview
  ? `<div class="notes"><h2>Notes</h2><textarea id="notes" rows="4" placeholder="Anything else the next agent should do. Included when you copy."></textarea><div class="notes-actions"><button id="copy" class="pill" type="button">Copy as prompt ↑</button><span class="hint">Paste into a fresh session. Only ticked and noted items are included.</span></div></div>`
  : `<div class="notes"><h2>Notes</h2><textarea id="notes" rows="4" placeholder="Anything else. Included when you copy notes."></textarea><div class="notes-actions"><button id="copy" class="pill" type="button">Copy notes ↑</button><span class="hint">Paste into chat. Anything not listed counts as approved.</span></div></div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(brief.title)}</title>
<style>
@font-face{font-family:"Inter Variable";font-weight:100 900;font-display:swap;font-style:normal;src:url(https://static.linear.app/fonts/InterVariable.woff2?v=4.1) format("woff2")}
@font-face{font-family:"Berkeley Mono";font-weight:100 900;font-display:swap;src:url(https://static.linear.app/fonts/Berkeley-Mono-Variable.woff2?v=3.2) format("woff2")}
:root{--font:"Inter Variable","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"Berkeley Mono",ui-monospace,"SF Mono",Menlo,monospace;
--window:#09090a;--pane:#121213;--card:#1a1a1b;--raised:#232325;--hover:#1a1a1b;--code:#242425;--line:#1f1f21;--chip-border:#2a2a2c;
--text:#f7f8f8;--text-2:#d0d6e0;--text-3:#8a8f98;--text-4:#62666d;--green:#27a644;--red:#eb5757;--yellow:#f0bf00;--blue:#4ea7fc;--indent:36px}
body.proposal{--indent:64px}
*{box-sizing:border-box}
html{background:var(--window);scroll-behavior:smooth}
body{margin:0;background:var(--window);color:var(--text);font:400 15px/1.6 var(--font);letter-spacing:-.011em;font-feature-settings:"cv01","ss03";-webkit-font-smoothing:antialiased;padding:8px}
.pane{background:var(--pane);border-radius:8px;min-height:calc(100vh - 16px)}
.top{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;font-size:13px;color:var(--text-3)}
.crumb{display:flex;align-items:center;gap:10px}.crumb .cur{color:var(--text)}.crumb .sep{color:var(--text-4)}
.pill{height:28px;padding:0 12px;border-radius:9999px;border:0;background:var(--raised);color:var(--text);font:510 13px/1 var(--font);display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.pill:hover{background:#2a2a2c}
.body{display:flex;gap:48px;padding:40px 56px 64px 84px}
.main-col{flex:1;min-width:0;max-width:900px}
.rail{width:300px;flex:none;padding-top:6px}
h1{font:590 24px/1.35 var(--font);letter-spacing:-.012em;margin:0 0 14px}
.lede{color:var(--text-2);margin:0 0 36px;max-width:760px}
.group{margin-bottom:28px}
.group header{display:flex;align-items:center;gap:8px;height:32px;color:var(--text-3);font-size:13px;font-weight:510;cursor:pointer;user-select:none;border-radius:4px;padding:0 4px;margin-left:-4px}
.group header:hover{background:var(--hover)}
.group header svg{transition:transform .12s}
.group.closed header svg{transform:rotate(-90deg)}
.group.closed .gbody{display:none}
.group header .gtitle{color:var(--text)}
.group header .gaction{margin-left:auto;height:24px;font-size:12px;font-weight:510}
.group ul{list-style:none;margin:0;padding:0}
.row{border-radius:6px;scroll-margin-top:24px}
.row .head{border-radius:6px;padding:4px 0;cursor:pointer}
.row .head:hover{background:var(--hover)}
.row.open .head{background:var(--hover);border-radius:6px 6px 0 0}
.row.flash .head{background:var(--raised)}
.line{display:flex;align-items:flex-start;gap:12px;min-height:36px;padding:6px 10px 2px 6px}
.key{color:var(--text-4);font-size:13px;width:18px;flex:none;text-align:right;font-variant-numeric:tabular-nums;line-height:24px}
.status{flex:none;display:inline-flex;cursor:pointer;color:var(--text-3);margin-top:4px}
.status input{position:absolute;opacity:0;width:0;height:0}
.status .ring{fill:none;stroke:currentColor;stroke-width:1.5;stroke-dasharray:2 2.2}
.status .fill{fill:var(--green);opacity:0}
.status .tick{fill:none;stroke:#fff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;opacity:0}
.status input:checked ~ svg .ring{opacity:0}
.status input:checked ~ svg .fill,.status input:checked ~ svg .tick{opacity:1}
.main{flex:1;min-width:0}
.after{color:var(--text);font-weight:500;line-height:1.5}
.before{color:var(--text-3);font-size:13px;line-height:1.5;margin-top:1px}
.blabel,.plabel{color:var(--text-4);font-size:11px;font-weight:510;text-transform:uppercase;letter-spacing:.04em;margin-right:8px}
.where{font:12px/1.5 var(--mono);color:var(--text-3);margin-top:2px}
.props{display:flex;align-items:center;gap:6px;flex:none;min-height:24px}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:4px 10px 8px var(--indent)}
.chip{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 9px;border:1px solid var(--chip-border);border-radius:9999px;background:transparent;font:500 12px/1 var(--font);color:var(--text-2);white-space:nowrap;text-decoration:none;max-width:100%;min-width:0}
.chip-long{white-space:normal;height:auto;min-height:24px;padding:4px 10px;line-height:1.5;align-items:flex-start;border-radius:12px;max-width:720px;overflow-wrap:anywhere}
.chip-long i{margin-top:5px}
a.chip:hover{border-color:var(--text-4);color:var(--text)}
.chip i{width:8px;height:8px;border-radius:50%;flex:none}
.chip-bad{color:var(--red)}.chip-warn{color:var(--yellow)}
.dot-green{background:var(--green)}.dot-red{background:var(--red)}.dot-yellow{background:var(--yellow)}
.prio rect{fill:#3a3a3c}.prio rect.on{fill:var(--text-2)}.chip .prio{margin:0 -2px}
.more{width:24px;height:24px;border:0;border-radius:4px;background:transparent;color:var(--text-4);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;margin-left:2px}
.more:hover{background:var(--raised);color:var(--text)}
.more svg{transition:transform .12s}
.row.open .more svg{transform:rotate(90deg)}
.files{display:flex;flex-wrap:wrap;gap:4px 14px;font:12px/1.6 var(--mono);color:var(--text-3);max-width:760px}
.file{min-width:0;overflow-wrap:anywhere}
.fk{display:inline-block;width:12px;color:var(--text-4);font-family:var(--mono)}
.fk-create{color:var(--green)}.fk-delete{color:var(--red)}
.detail{padding:10px 12px 12px var(--indent);display:flex;flex-direction:column;gap:10px;color:var(--text-2);font-size:14px}
.detail[hidden]{display:none}
.detail p{margin:0;max-width:720px}
.proof{font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--text-2)}
.proof .plabel{font-family:var(--font)}
textarea{width:100%;font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--chip-border);background:var(--window);color:var(--text);border-radius:8px;resize:vertical;display:block}
textarea::placeholder{color:var(--text-3)}
textarea:focus{outline:none;border-color:var(--text-4)}
.detail textarea{max-width:720px}
.handoff{margin:12px;width:calc(100% - 24px);font-family:var(--mono);font-size:12.5px}
.opts{display:flex;flex-direction:column;gap:2px;padding:2px 10px 4px 50px}
.opt{display:flex;align-items:center;gap:10px;height:30px;padding:0 8px;border-radius:6px;cursor:pointer;color:var(--text-2)}
.opt:hover{background:var(--hover)}
.opt input{position:absolute;opacity:0;width:0;height:0}
.opt-l{width:20px;height:20px;border-radius:50%;border:1px solid var(--chip-border);display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-3);flex:none}
.opt input:checked ~ .opt-l{background:var(--text);border-color:var(--text);color:var(--pane);font-weight:590}
.opt input:checked ~ span:last-child{color:var(--text)}
.opt input:focus-visible ~ .opt-l{outline:2px solid var(--blue);outline-offset:2px}
.opt em{font-style:normal;color:var(--text-4);font-size:12px;margin-left:8px}
.qdetail{margin:0;padding:0 10px 6px 62px;color:var(--text-3);font-size:13px}
.qnote{padding:4px 12px 10px 58px;max-width:780px}
.notes{margin-top:40px;padding-top:28px;border-top:1px solid var(--line)}
.notes h2{font:590 17px/1.4 var(--font);margin:0 0 12px}
.notes-actions{display:flex;align-items:center;gap:14px;margin-top:12px}
.hint{color:var(--text-3);font-size:13px}
.steps{margin:0;padding-left:18px;color:var(--text-2);max-width:720px}
.steps li{padding:2px 0}
.tree,.tree ul{list-style:none;margin:0;padding:0}
.tree ul{padding-left:18px}
.dline{display:flex;align-items:center;gap:8px;height:32px;padding:0 6px;border-radius:4px;cursor:pointer;user-select:none;color:var(--text-3);font-size:13px}
.dline:hover{background:var(--hover)}
.dline svg{transition:transform .12s;flex:none}
.dir.closed > .dline svg{transform:rotate(-90deg)}
.dir.closed > ul{display:none}
.dname{color:var(--text);font-family:var(--mono);font-size:12.5px}
.bdir > .bline{height:38px;gap:10px}
.bdir + .bdir{margin-top:4px}
.bnum{color:var(--text-4);font-size:13px;min-width:14px;font-variant-numeric:tabular-nums}
.bname{color:var(--text);font-size:14px;font-weight:500}
.fwhy{color:var(--text-2)}
.frow .line{min-height:32px;padding:4px 10px 4px 6px;align-items:flex-start}
.frow .fk,.frow .fname{line-height:22px}
.frow .fk{width:14px;text-align:center;flex:none}
.frow .main{display:flex;gap:12px;align-items:baseline;min-width:0;flex-wrap:wrap}
.fname{font-family:var(--mono);font-size:12.5px;color:var(--text)}
.fnote{color:var(--text-3);font-size:13px}
.fpath{font-family:var(--mono);font-size:12px;color:var(--text-3)}
.frow .detail{padding-left:32px}
:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.rail h3{font:400 14px/1 var(--font);color:var(--text-3);margin:0 0 10px}
.rail section + section{margin-top:26px}
.rail ul{list-style:none;margin:0;padding:0}
.prop{display:flex;align-items:center;gap:10px;height:36px;font-size:15px}
.prop svg.ico{width:16px;height:16px;flex:none;color:var(--text-3)}
.prop .prio{flex:none}
.prop-v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prop-n{color:var(--text-4);font-size:13px;font-variant-numeric:tabular-nums}
.map{padding:8px 0 6px 6px;overflow-x:auto;overscroll-behavior-x:contain}
.map svg{font-family:var(--font);display:block}
.map .layer{fill:var(--text-4);font-size:11px;font-weight:510;letter-spacing:.02em}
.map .node rect{fill:var(--card);stroke:var(--chip-border);stroke-width:1}
.map .node.changed-edit rect{stroke:var(--text-3)}
.map .node.changed-create rect{stroke:var(--green)}
.map .node.changed-delete rect{stroke:var(--red);stroke-dasharray:4 3}
.map .name{fill:var(--text);font-size:13px;font-weight:510}
.map .badge{font-size:10px;font-weight:510;fill:var(--text-3)}
.map .badge-create{fill:var(--green)}.map .badge-delete{fill:var(--red)}
.map .file{fill:var(--text-3);font-family:var(--mono);font-size:10.5px}
.map .edge{fill:none;stroke-width:1.3}
.map .edge-new{stroke:#27a644}.map .edge-existing{stroke:#62666d}.map .edge-removed{stroke:#eb5757;stroke-dasharray:4 3}
.map .elabel{font-size:10px;fill:var(--text-3);stroke:var(--pane);stroke-width:3.5px;stroke-linejoin:round;paint-order:stroke fill}.map .elabel-new{fill:#4fbf6f}
.topr{display:flex;align-items:center;gap:10px}
.ver{display:inline-flex;align-items:center;color:var(--text-2);font-weight:510;position:relative}
.ver select{appearance:none;-webkit-appearance:none;background:var(--raised);color:var(--text);border:0;border-radius:9999px;height:28px;padding:0 28px 0 12px;font:510 13px/1 var(--font);cursor:pointer}
.ver select:hover{background:#2a2a2c}
.ver svg{position:absolute;right:11px;pointer-events:none;color:var(--text-3)}
.hist{padding-bottom:10px}
.hdate{color:var(--text-4);font-size:13px;margin-left:10px;font-weight:400}
.hnotes{margin:0 10px 8px 36px;padding:10px 12px;background:var(--window);border:1px solid var(--chip-border);border-radius:8px;font:12.5px/1.55 var(--mono);color:var(--text-2);white-space:pre-wrap;max-width:720px}
.group .hlist{list-style:none;margin:0;padding:0 10px 4px 36px;display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--text-2)}
.hlist li{display:flex;align-items:center;gap:10px}
body.readonly .status,body.readonly .opt,body.readonly textarea{pointer-events:none}
body.readonly textarea:placeholder-shown,body.readonly .notes-actions,body.readonly .gaction{display:none}
@media (max-width:900px){.body{flex-direction:column;padding:32px 20px}.rail{width:auto}.line{padding:8px 6px}.chips,.detail,.opts,.qnote,.qdetail{padding-left:12px}}
</style></head><body class="${isReview ? 'review' : 'proposal'}${ctx.readOnly ? ' readonly' : ''}"><div class="pane">
<div class="top">
  <div class="crumb"><span>${isReview ? 'Review' : 'Proposal'}</span><span class="sep">›</span><span class="cur">${esc(brief.title)}</span>${brief.branch ? `<span class="sep">›</span><span>${esc(brief.branch)}</span>` : ''}</div>
  <div class="topr">${topRight}</div>
</div>
<div class="body">
<main class="main-col">
<h1>${esc(brief.title)}</h1>
<p class="lede">${esc(brief.user)}</p>
${group('Behavior changes', behaviors.length, behaviorRows)}
${findingsBlock}
${(brief.flows || []).length ? group('Flows to test', brief.flows.length, flowRows) : ''}
${fixesBlock}
${changedFiles.length ? group('Changed files', changedFiles.length, filesByBehavior(), true) : ''}
${brief.map ? group('How it fits together', mapNodes.filter((x) => x.changed).length + ' changed', mapSvg(brief.map)) : ''}
${questions.length ? group('Decide', questions.length, questionRows) : ''}
${unexplained.length ? group('Files no line explains', unexplained.length, ledgerRows) : ''}
${deltaBlock}
${historyBlock}
${notesBlock}
</main>
<aside class="rail">
  <section>
    <h3>Properties</h3>
    <ul>
      <li class="prop"><svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><span class="prop-v">${isReview ? 'Review' : 'Proposal'}</span></li>
      <li class="prop"><svg class="ico" viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span class="prop-v">${plural(behaviors.length, 'behavior change')}</span></li>
      ${isReview ? `<li class="prop"><svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5v4M8 11v.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span class="prop-v">${plural(findings.blockers.length, 'blocker')}, ${plural(findings.nonBlockers.length, 'non-blocker')}</span></li>` : ''}
      <li class="prop"><svg class="ico" viewBox="0 0 16 16"><path d="M3 2h7l3 3v9H3z M10 2v3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="prop-v">${fileCount} files, ${fileCount - unexplained.length} explained</span></li>
      ${riskCounts.map(([r, c]) => `<li class="prop">${prioIcon(r)}<span class="prop-v">${c} ${riskName[r].toLowerCase()} risk</span></li>`).join('')}
    </ul>
  </section>
  <section>
    <h3>Touched</h3>
    <ul>${touchedRows}</ul>
  </section>
</aside>
</div>
</div>
<script>
(() => {
  const isReview = document.body.classList.contains('review');
  const readOnly = document.body.classList.contains('readonly');
  const key = ${JSON.stringify(ctx.stateKey)};
  const ver = document.getElementById('ver');
  if (ver) ver.addEventListener('change', () => { location.href = ver.value; });
  if (readOnly) document.querySelectorAll('textarea').forEach((t) => { t.readOnly = true; });
  let state = {};
  try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch {} };
  const get = (id) => state[id] || {};
  const set = (id, patch) => { state[id] = { ...get(id), ...patch }; save(); };
  const toggle = (id, force) => {
    const d = document.getElementById('detail-' + id); if (!d) return;
    d.hidden = force === undefined ? !d.hidden : !force;
    document.querySelector('.row[data-row="' + id + '"]').classList.toggle('open', !d.hidden);
  };
  document.querySelectorAll('.row[data-row] .head').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('input,label,a')) return;
    toggle(h.parentElement.dataset.row);
  }));
  document.querySelectorAll('.group').forEach((g) => {
    const id = g.dataset.group;
    const st = get('group:' + id);
    if (st.closed === true) g.classList.add('closed');
    if (st.closed === false) g.classList.remove('closed');
    const flip = () => { g.classList.toggle('closed'); set('group:' + id, { closed: g.classList.contains('closed') }); };
    const h = g.querySelector('header');
    h.addEventListener('click', flip);
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  });
  document.querySelectorAll('.dir').forEach((d) => {
    const id = 'dir:' + d.dataset.dir;
    const st = get(id);
    if (st.closed === true) d.classList.add('closed');
    if (st.closed === false) d.classList.remove('closed');
    const flip = () => { d.classList.toggle('closed'); set(id, { closed: d.classList.contains('closed') }); };
    const line = d.querySelector(':scope > .dline');
    line.addEventListener('click', flip);
    line.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  });
  document.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.getElementById(a.dataset.jump); if (!target) return;
    let el = target; while (el && el !== document.body) { if (el.classList.contains('group')) el.classList.remove('closed'); if (el.classList.contains('dir')) el.classList.remove('closed'); el = el.parentElement; }
    toggle(target.dataset.row, true);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  }));
  document.querySelectorAll('input[type=checkbox][data-id]').forEach((c) => {
    c.checked = !!get(c.dataset.id).ok;
    c.addEventListener('change', () => set(c.dataset.id, { ok: c.checked }));
  });
  document.querySelectorAll('input[type=radio][data-id]').forEach((r) => {
    const st = get(r.dataset.id); if (st.pick) r.checked = st.pick === r.value;
    r.addEventListener('change', () => set(r.dataset.id, { pick: r.value }));
  });
  document.querySelectorAll('textarea[data-id]').forEach((t) => {
    const s = get(t.dataset.id);
    if (s.note) { t.value = s.note; if (document.getElementById('detail-' + t.dataset.id)) toggle(t.dataset.id, true); }
    t.addEventListener('input', () => set(t.dataset.id, { note: t.value }));
  });
  const notes = document.getElementById('notes');
  if (notes) { notes.value = get('notes').text || ''; notes.addEventListener('input', () => set('notes', { text: notes.value })); }
  const noteOf = (id) => ((document.getElementById('txt-' + id) || {}).value || '').trim();
  const proposalText = () => {
    const lines = [];
    document.querySelectorAll('.row[data-row]').forEach((r) => {
      const id = r.dataset.row; if (!/^[0-9]+$/.test(id)) return; const parts = [];
      const pick = r.querySelector('input[type=radio]:checked'); if (pick) parts.push(pick.value);
      const ok = r.querySelector('input[type=checkbox]'); if (ok && ok.checked) parts.push('ok');
      const note = noteOf(id); if (note) parts.push(note);
      if (parts.length) lines.push('- ' + id + '. ' + parts.join(', '));
    });
    const extra = (notes?.value || '').trim();
    const out = ['---', '## Notes from ' + JSON.stringify(${JSON.stringify(brief.title)}) + ' v${ctx.version}'];
    if (lines.length) out.push(...lines);
    if (extra) out.push('Other: ' + extra);
    if (!lines.length && !extra) out.push('No notes, all approved');
    out.push('---');
    return out.join('\\n');
  };
  const reviewText = () => {
    const sections = new Map();
    document.querySelectorAll('.row[data-section]').forEach((r) => {
      const id = r.dataset.row;
      const ok = r.querySelector('input[type=checkbox]');
      const ticked = !!(ok && ok.checked);
      const note = noteOf(id);
      if (!ticked && !note) return;
      const entry = ['- ' + r.dataset.label];
      if (ticked && r.dataset.detail) entry.push('  ' + r.dataset.detail);
      if (note) entry.push('  Note: ' + note);
      const list = sections.get(r.dataset.section) || [];
      list.push(entry.join('\\n'));
      sections.set(r.dataset.section, list);
    });
    const extra = (notes?.value || '').trim();
    const head = 'Changes requested from the review ' + JSON.stringify(${JSON.stringify(brief.title)}) + ' v${ctx.version}' + ${JSON.stringify(brief.branch ? ' on ' + brief.branch : '')} + '.';
    if (!sections.size && !extra) return head.replace('Changes requested', 'No changes requested');
    const out = [head, 'Apply each item below, then run the checks the repo defines before reporting back.'];
    for (const title of ['Blockers', 'Non-blockers', 'Behavior changes', 'Files']) {
      const list = sections.get(title); if (!list) continue;
      out.push('', '## ' + title, ...list);
    }
    if (extra) out.push('', '## Other', extra);
    return out.join('\\n');
  };
  const fixPrompt = ${JSON.stringify(fixPrompt).replace(/</g, '\\u003c')};
  // A page served from file:// often has no clipboard, so the text stays reachable by hand.
  const handOff = (button, text) => {
    const block = button.closest('.group, .notes') || document.body;
    let box = block.querySelector('.handoff');
    if (!box) {
      box = document.createElement('textarea');
      box.className = 'handoff';
      box.rows = 10;
      box.readOnly = true;
      block.appendChild(box);
    }
    box.value = text;
    box.focus();
    box.select();
  };
  const copyOn = (id, text) => {
    const button = document.getElementById(id); if (!button) return;
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = button.textContent;
      const said = text();
      try {
        if (!navigator.clipboard) throw new Error('no clipboard');
        await navigator.clipboard.writeText(said);
        button.textContent = 'Copied ✓';
      } catch {
        button.textContent = 'Select below to copy';
        handOff(button, said);
      }
      setTimeout(() => { button.textContent = label; }, 1800);
    });
  };
  copyOn('copy-fixes', () => fixPrompt);
  copyOn('copy', () => isReview ? reviewText() : proposalText());
})();
</script></body></html>`;

const mdFiles = (files) => (files || []).map(([k, p]) => `${fileMark[k]} \`${p}\``).join('<br>');
const mdFinding = (f) => `- **${f.id} ${f.title}** (\`${f.where}\`)${f.items.length ? ` affects ${f.items.join(', ')}` : ''}<br>${f.detail}`;
const md = [
  `## ${brief.title}`,
  '',
  brief.user || '',
  '',
  '### Behavior changes',
  '',
  '| # | After | Before | Risk | ' + (isReview ? 'Proof' : 'Test') + ' | Files |',
  '|---|---|---|---|---|---|',
  ...behaviors.map((b, i) => `| ${i + 1} | **${b.after}** | ${b.before} | ${riskName[b.risk]} | ${isReview ? (b.verified || 'unproven: ' + b.why) : (typeof b.test === 'string' ? b.test : 'no test')} | ${mdFiles(b.files)} |`),
  '',
  ...(isReview ? ['### Blockers', '', ...(findings.blockers.length ? findings.blockers.map(mdFinding) : ['none']), '', '### Non-blockers', '', ...(findings.nonBlockers.length ? findings.nonBlockers.map(mdFinding) : ['none']), ''] : []),
  ...((brief.flows || []).length ? ['### Flows to test', '', ...brief.flows.flatMap((f) => [`**${f.name}** (${(f.items || []).join(', ')})`, ...(f.steps || []).map((st, i) => `${i + 1}. ${st}`), ...(f.effect ? [f.effect] : []), '']), ] : []),
  ...(changedFiles.length ? ['### Changed files', '', ...fileGroups().flatMap((g) => [
    `**${g.num ? g.num + '. ' : ''}${g.name}** (${plural(g.files.length, 'file')})`,
    '',
    ...g.files.map((f) => `- ${fileMark[f.kind]} \`${f.path}\`${f.note ? ': ' + f.note : ''}${f.why ? ' Why: ' + f.why : ''}`),
    '',
  ])] : []),
  ...((brief.touched || []).length ? ['### Touched', '', ...brief.touched.map((t) => `- ${t.name} (${plural(t.files, 'file')})`), ''] : []),
  ...(unexplained.length ? ['### Files no line explains', '', ...unexplained.map(([k, p]) => `- ${fileMark[k]} \`${p}\``), ''] : []),
  ...((brief.delta || []).length ? ['### Changed since the proposal', '', ...brief.delta.map((d) => `- **${d.kind}** ${d.text}`), ''] : []),
].join('\n');
return { html, md, mapWidth };
};

const realDir = realpathSync(outDir);
const pageFor = (v) => v === current.v ? join(outDir, stem + '.html') : join(historyDir, `${stem}.v${v}.html`);
const htmlPath = pageFor(current.v);
const pngPath = join(outDir, stem + '.png');
const mdPath = join(outDir, stem + '.md');
let mapWidth = 0;
versions.forEach((s) => {
  const page = pageFor(s.v);
  const built = build(s.data, {
    version: s.v,
    versions,
    readOnly: s.v !== current.v,
    hrefFor: (v) => relative(dirname(page), pageFor(v)),
    history: historyAll.filter((h) => h.v <= s.v).reverse(),
    stateKey: `brief:${realDir}/${stem}:v${s.v}`,
  });
  writeFileSync(page, built.html);
  if (s.v === current.v) { writeFileSync(mdPath, built.md); mapWidth = built.mapWidth; }
});

const findPlaywright = () => {
  const req = createRequire(import.meta.url);
  const candidates = [
    () => req.resolve('playwright-core'),
    () => createRequire(join(process.cwd(), 'package.json')).resolve('playwright-core'),
  ];
  for (const c of candidates) {
    try { const p = c(); if (existsSync(p)) return p; } catch {}
  }
  return null;
};

let png = false;
const pw = findPlaywright();
if (pw) {
  try {
    const { chromium } = await import(pathToFileURL(pw).href);
    const browser = await chromium.launch();
    const shotWidth = Math.min(2400, Math.max(1400, mapWidth + 540));
    const page = await browser.newPage({ viewport: { width: shotWidth, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.addStyleTag({ content: '.main-col{max-width:none}.after,.before,.where{max-width:820px}.map{overflow-x:visible}' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: pngPath, fullPage: true });
    await browser.close();
    png = true;
  } catch (err) {
    console.error(`no png: ${err.message.split('\n')[0]}`);
  }
} else {
  console.error('no png: playwright-core not found (install it in this skill folder, or run from a project that has it)');
}

console.error(changed ? `v${current.v} saved` : `v${current.v} unchanged`);
console.log(htmlPath);
console.log(mdPath);
if (png) console.log(pngPath);

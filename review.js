const REVIEW_ID = 'recording-135';
const MAX_BATCH_BYTES = 60000;
const $ = selector => document.querySelector(selector);
const drafts = new Map();
let data, expanded = false, storagePrefix = '', storageFailed = false;
let records = [], batchParts = [], tabId;

export function draftKey(item) { return JSON.stringify([item.id, item.revision, item.hash]); }
export function draftSignature(draft) { return JSON.stringify([draft.decision, draft.comment]); }
export function uniqueVariants(values) {
  return [...new Map(values.map(value => [draftSignature(value), value])).values()];
}
export function envelope(decisions) { return { schemaVersion: 1, reviewId: REVIEW_ID, decisions }; }
export function envelopeText(value) { return '```json\n' + JSON.stringify(value, null, 2) + '\n```'; }
export function splitEnvelopes(decisions, maxBytes = MAX_BATCH_BYTES) {
  const groups = []; let current = [];
  for (const decision of decisions) {
    if (new TextEncoder().encode(envelopeText(envelope([decision]))).length > maxBytes) throw new Error(`Requirement ${decision.requirementId} is too large for one submission. Download the backup and ask the review owner to split its scope.`);
    if (current.length && new TextEncoder().encode(envelopeText(envelope([...current, decision]))).length > maxBytes) { groups.push(envelope(current)); current = []; }
    current.push(decision);
  }
  if (current.length) groups.push(envelope(current));
  return groups;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function download(name, content, json = true) {
  const url = URL.createObjectURL(new Blob([json ? JSON.stringify(content, null, 2) : content], { type: json ? 'application/json' : 'text/plain;charset=utf-8' }));
  const link = node('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function addList(parent, heading, values) {
  if (!values?.length) return;
  parent.append(node('h4', heading));
  const list = node('ul'); values.forEach(value => list.append(node('li', value))); parent.append(list);
}
function moduleId(name) { return 'module-' + data.modules.indexOf(name); }
function readRecords() {
  const found = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(storagePrefix)) continue;
      try {
        const record = JSON.parse(localStorage.getItem(key));
        if (record.schemaVersion === 1 && record.key && record.operationId && typeof record.comment === 'string') found.push({ ...record, storageKey: key });
      } catch { /* Ignore corrupt entries, never overwrite them automatically. */ }
    }
  } catch { storageFailed = true; }
  records = found;
}
function variants(item) {
  const key = draftKey(item), draft = drafts.get(item.id);
  return uniqueVariants([...records.filter(record => record.key === key), ...(draft ? [draft] : [])]);
}
function restoreDrafts() {
  readRecords();
  for (const item of data.requirements) {
    if (drafts.has(item.id)) continue;
    const matching = records.filter(record => record.key === draftKey(item)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (matching[0]) drafts.set(item.id, matching[0]);
  }
}
function persistDraft(item, decision, comment) {
  const previous = drafts.get(item.id);
  if (previous && previous.decision === decision && previous.comment === comment) return previous;
  const record = { schemaVersion: 1, key: draftKey(item), requirementId: item.id, revision: item.revision, hash: item.hash, decision, comment, operationId: crypto.randomUUID(), updatedAt: new Date().toISOString(), tabId };
  drafts.set(item.id, record);
  // A tab writes only its own branch. Other tabs and recovered versions are
  // retained independently until the reviewer explicitly resolves/clears them.
  try { localStorage.setItem(storagePrefix + encodeURIComponent(record.key) + ':' + tabId, JSON.stringify(record)); }
  catch { storageFailed = true; }
  readRecords(); updateBatchStatus(); return record;
}
function updateBatchStatus(message) {
  const count = [...drafts.values()].filter(draft => draft.decision).length;
  const conflicts = data.requirements.filter(item => variants(item).length > 1).length;
  const stale = records.filter(record => !data.requirements.some(item => draftKey(item) === record.key)).length;
  $('#draft-status').textContent = message || `${count} decisions prepared on this device. Submission not verified here.${conflicts ? ` ${conflicts} requirements have conflicting draft versions: review and choose a version before copying.` : ''}${stale ? ` ${stale} older-revision drafts are preserved in the backup, excluded from submission.` : ''}${storageFailed ? ' Device storage is unavailable or full: download a backup before leaving.' : ''}`;
}
function toDecision(item) {
  const draft = drafts.get(item.id);
  if (!draft?.decision) return null;
  if (!['approve', 'changes', 'clarify', 'defer'].includes(draft.decision)) throw new Error(`${item.id}: choose a valid decision.`);
  if (draft.key !== draftKey(item)) throw new Error(`${item.id}: this draft belongs to a different revision.`);
  if (variants(item).length > 1) throw new Error(`${item.id} has conflicting device drafts. Review its versions and choose one before copying.`);
  if (draft.decision !== 'approve' && !draft.comment.trim()) throw new Error(`${item.id}: explain the change, question or deferral before copying.`);
  return { requirementId: item.id, revision: item.revision, hash: item.hash, decision: draft.decision, operationId: draft.operationId, comment: draft.comment.trim(), title: item.title, scope: item.scope };
}
async function copyText(text, name, note) {
  try { await navigator.clipboard.writeText(text); note.textContent = 'Copied. Open the private GitHub submission, paste into its body and press Submit new issue. Submission is not verified here.'; }
  catch { download(name, text, false); note.textContent = 'Clipboard access failed. A text backup was downloaded. Open it, copy its contents and paste into the private GitHub issue body.'; }
}
function reviewForm(item) {
  if (!data.review?.enabled) return null;
  const form = node('div', null, 'review-form'); form.append(node('h4', 'Review this requirement'));
  const label = node('label', 'Your decision'); label.htmlFor = `decision-${item.id}`;
  const select = node('select'); select.id = label.htmlFor;
  for (const [value, text] of [['', 'Choose a decision'], ['approve', 'Approve this revision'], ['changes', 'Request changes'], ['clarify', 'Ask for clarification'], ['defer', 'Defer for now']]) { const option = node('option', text); option.value = value; select.append(option); }
  label.append(select); form.append(label);
  const commentLabel = node('label', 'Comments or requested changes'); commentLabel.htmlFor = `comment-${item.id}`;
  const textarea = node('textarea'); textarea.id = commentLabel.htmlFor; textarea.maxLength = 1600;
  textarea.placeholder = 'Do not include passwords or customer financial details. Drafts remain on this device until explicitly cleared.';
  commentLabel.append(textarea); form.append(commentLabel);
  const draft = drafts.get(item.id); if (draft) { select.value = draft.decision; textarea.value = draft.comment; }
  const note = node('p', 'Device-only draft, not a submitted review. Use Copy review batch above when ready.', 'form-note');
  const conflict = node('div', null, 'draft-conflict');
  function showConflict() {
    conflict.replaceChildren(); const choices = variants(item); if (choices.length < 2) return;
    conflict.append(node('p', 'Conflicting device drafts are preserved. Download a backup to keep all versions, then choose which version to submit.'));
    choices.forEach((choice, index) => {
      const preview = node('details'); preview.append(node('summary', `Version ${index + 1}: ${choice.decision || 'No decision'} (${choice.updatedAt})`), node('p', choice.comment || '(No comment)', 'draft-comment'));
      const use = node('button', `Use version ${index + 1}`); use.type = 'button';
      use.addEventListener('click', () => {
        if (!window.confirm('Use this version and remove the other local versions for this requirement? Download the draft backup first if you need to keep them. This does not delete any submitted GitHub review.')) return;
        try { for (const record of records.filter(record => record.key === draftKey(item))) localStorage.removeItem(record.storageKey); } catch { storageFailed = true; }
        drafts.set(item.id, { ...choice, tabId });
        try { localStorage.setItem(storagePrefix + encodeURIComponent(choice.key) + ':' + tabId, JSON.stringify({ ...choice, tabId, storageKey: undefined })); } catch { storageFailed = true; }
        readRecords(); render(); updateBatchStatus();
      });
      preview.append(use); conflict.append(preview);
    });
  }
  const changed = () => { persistDraft(item, select.value, textarea.value); showConflict(); note.textContent = storageFailed ? 'Not safely stored on this device. Download the draft backup now.' : 'Draft stored on this device only. Submit on GitHub to save privately. Submission not verified here.'; };
  select.addEventListener('change', changed); textarea.addEventListener('input', changed);
  const copy = node('button', 'Copy this requirement review'); copy.type = 'button';
  copy.addEventListener('click', () => { try { const decision = toDecision(item); if (!decision) throw new Error('Choose a decision first.'); copyText(envelopeText(envelope([decision])), `${item.id}-review.md`, note); } catch (error) { note.textContent = error.message; } });
  showConflict(); form.append(conflict, copy, note); return form;
}
function card(item) {
  const article = node('article', null, 'requirement'); article.id = item.id;
  const head = node('div', null, 'requirement-head'), meta = node('div', null, 'meta');
  meta.append(node('span', item.id, 'rid'), node('span', item.kind, 'kind' + (/clarif|proposal/i.test(item.kind) ? ' question' : '')), node('span', `Revision ${item.revision}`));
  head.append(meta, node('h3', item.title), node('p', item.scope, 'scope'));
  const details = node('details'); details.open = expanded; details.append(node('summary', 'Scope, acceptance checks and review'));
  const body = node('div', null, 'details');
  addList(body, 'Proposed acceptance checks', item.acceptance); addList(body, 'Dependencies and boundaries', item.dependencies);
  if (item.questions?.length) { const panel = node('div', null, 'uncertainty'); addList(panel, 'Please confirm', item.questions); body.append(panel); }
  if (item.trackerRefs?.length) { body.append(node('h4', 'Existing tracker cross-reference'), node('p', item.trackerRefs.map(ref => `${ref.id}: ${ref.title}`).join('; ')), node('p', 'Reference only. Cached tracker statuses do not establish current delivery or testing.', 'muted')); }
  const source = node('div', null, 'source'); source.append(node('strong', 'Source context'), node('p', item.sourceNote || 'Recording interval. The original conversation remains private.'), node('span', item.intervals.join(' · ') + ' (section bounds, not word-level timestamps)')); body.append(source);
  const form = reviewForm(item); if (form) body.append(form); details.append(body); article.append(head, details); return article;
}
function render(all = false) {
  const term = all ? '' : $('#search').value.trim().toLowerCase(), kind = all ? '' : $('#kind').value;
  const items = data.requirements.filter(item => (!kind || item.kind === kind) && (!term || [item.id, item.title, item.scope, ...(item.questions || [])].join(' ').toLowerCase().includes(term)));
  const fragment = document.createDocumentFragment();
  for (const module of data.modules) {
    const subset = items.filter(item => item.module === module); if (!subset.length) continue;
    const section = node('section', null, 'module'); section.id = moduleId(module);
    const heading = node('div', null, 'module-heading'); heading.append(node('h2', module), node('span', `${subset.length} review items`)); section.append(heading); subset.forEach(item => section.append(card(item))); fragment.append(section);
  }
  $('#requirements').replaceChildren(fragment); $('#results').textContent = `${items.length} of ${data.requirements.length} review items shown`; $('#empty').hidden = items.length !== 0;
}
function configureBatch() {
  $('#batch-review').hidden = !data.review?.enabled; if (!data.review?.enabled) return;
  if (!/^[\w.-]+\/[\w.-]+$/.test(data.review.repository || '')) throw new Error('Invalid review repository');
  storagePrefix = `acornia-review-v1:${REVIEW_ID}:${data.review.repository}:`; tabId = crypto.randomUUID(); restoreDrafts();
  const issueUrl = new URL(`https://github.com/${data.review.repository}/issues/new`);
  issueUrl.searchParams.set('title', '[recording-135] Requirement review batch');
  $('#open-review').href = issueUrl.href; $('#review-history').href = `https://github.com/${data.review.repository}/issues`;
  $('#copy-batch').addEventListener('click', () => {
    try {
      readRecords(); const decisions = data.requirements.map(toDecision).filter(Boolean); if (!decisions.length) throw new Error('Choose at least one decision before copying.');
      const oldParts = JSON.stringify(batchParts); batchParts = splitEnvelopes(decisions);
      const part = $('#batch-part'); if (oldParts !== JSON.stringify(batchParts)) { part.replaceChildren(); batchParts.forEach((value, index) => { const option = node('option', `Part ${index + 1} of ${batchParts.length} (${value.decisions.length} decisions)`); option.value = String(index); part.append(option); }); }
      $('#batch-part-label').hidden = batchParts.length < 2;
      const index = Number(part.value || 0); copyText(envelopeText(batchParts[index]), `recording-135-review-part-${index + 1}.md`, $('#batch-note'));
      if (batchParts.length > 1) updateBatchStatus(`Review exceeds the safe submission size and is split into ${batchParts.length} parts. Copy and submit each part using the selector. Download a backup before leaving.`);
    } catch (error) { $('#batch-note').textContent = error.message; }
  });
  $('#backup-drafts').addEventListener('click', () => { readRecords(); download('recording-135-device-drafts.json', { schemaVersion: 1, reviewId: REVIEW_ID, status: 'device-only-not-verified-submitted', exportedAt: new Date().toISOString(), storedVersions: records, currentDrafts: [...drafts.values()] }); });
  $('#clear-drafts').addEventListener('click', () => {
    if (!window.confirm('Have you submitted your review on GitHub or downloaded a backup? Clear all device-only drafts for this review, including conflicting/older versions? This does not delete GitHub reviews.')) return;
    readRecords(); try { for (const record of records) localStorage.removeItem(record.storageKey); } catch { storageFailed = true; }
    drafts.clear(); readRecords(); restoreDrafts(); render(); updateBatchStatus('Local drafts cleared where storage allowed. GitHub submission status is not verified here.');
  });
  window.addEventListener('storage', event => { if (event.key === null || event.key.startsWith(storagePrefix)) { restoreDrafts(); render(); updateBatchStatus('Device drafts changed in another tab. Your editor version is retained; conflicting versions must be reviewed before copying.'); } });
  updateBatchStatus();
}
if (typeof document !== 'undefined') {
  try {
    const response = await fetch('requirements.json'); if (!response.ok) throw new Error('Document unavailable'); data = await response.json();
    $('#source-note').textContent = data.sourceNote; $('#revision-note').textContent = data.versionLabel;
    if (data.review?.enabled) $('#persistence-note').textContent = 'Decisions are recovered on this device only, not saved as a private review. Copy your review batch, open GitHub, paste it and press Submit new issue. A GitHub account with access is required. Submission is not verified here.';
    for (const [value, label] of [[data.requirements.length, 'review items'], [data.modules.length, 'modules'], [data.durationLabel, 'recording length']]) { const stat = node('div'); stat.append(node('strong', String(value)), node('span', label)); $('#summary').append(stat); }
    for (const module of data.modules) { const link = node('a', module); link.href = '#' + moduleId(module); link.append(node('span', String(data.requirements.filter(item => item.module === module).length))); $('#modules').append(link); }
    for (const kind of [...new Set(data.requirements.map(item => item.kind))]) { const option = node('option', kind); option.value = kind; $('#kind').append(option); }
    configureBatch(); $('#search').addEventListener('input', () => render()); $('#kind').addEventListener('change', () => render());
    $('#expand').addEventListener('click', () => { expanded = !expanded; render(); $('#expand').textContent = expanded ? 'Collapse all details' : 'Expand all details'; });
    $('#print').addEventListener('click', () => window.print());
    let beforePrintExpanded;
    window.addEventListener('beforeprint', () => { beforePrintExpanded = expanded; expanded = true; render(true); });
    window.addEventListener('afterprint', () => { expanded = beforePrintExpanded ?? expanded; render(); });
    $('#export').addEventListener('click', () => download('acornia-recording-135-requirements.json', data));
    window.addEventListener('beforeunload', event => { if (storageFailed && drafts.size) { event.preventDefault(); event.returnValue = ''; } });
    render();
  } catch { $('#requirements').append(node('p', 'The requirements document could not be loaded. Please reload the page or contact the review owner.', 'error')); }
}

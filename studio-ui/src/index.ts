/**
 * Catalog F4 `studio-ui` — Section 26 Studio.
 *
 * Vanilla TS module that exports an HTML string + a stand-alone JS
 * bundle the studio-server can serve at `/`. v0 ships a minimal
 * single-page app:
 *   - top nav: Specs · Wizard · Graders · Datasets · Plugins
 *   - Specs: lists `/api/specs`, click to open the YAML in a textarea
 *     editor (no Monaco — vanilla `<textarea>` keeps deps tiny)
 *   - Wizard: walks `/api/wizard/start` → `/step` → `/compile` and
 *     POSTs to `/api/specs` to create the new spec
 *   - Graders: form-based grader builder; replays field values through
 *     `/api/grader-wizard/{start,step,compile}` for a live YAML
 *     preview with inline validation errors, then appends via
 *     `POST /api/specs/:name/graders` (or copy/paste the YAML)
 *   - Datasets: form-based eval-dataset builder; replays through
 *     `/api/dataset-wizard/{start,step,compile}` for live YAML + JSONL
 *     previews, saves the case file via `POST /api/datasets`, points
 *     an eval spec at it via `POST /api/specs/:name/dataset` — or
 *     creates a brand-new starter eval spec around it (`create:`)
 *   - Plugins: lists `/api/plugins`
 *
 * Lit + Monaco land in a follow-up; v0 keeps the UI shipping-ready
 * without any client-side build complexity.
 */

export type RenderOptions = {
  /** Title shown in the page <title> + H1. Default "CrewHaus Studio". */
  readonly title?: string;
};

export function renderStudioHtml(opts: RenderOptions = {}): string {
  const title = opts.title ?? "CrewHaus Studio";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #fff; color: #111827; }
    header { padding: 16px 32px; background: #1d3a8a; color: white; }
    header h1 { margin: 0; font-size: 22px; }
    nav { padding: 12px 32px; background: #f3f4f6; display: flex; gap: 24px; }
    nav button { background: none; border: 0; font-size: 15px; cursor: pointer; padding: 4px 0; color: #1d3a8a; }
    nav button.active { font-weight: bold; border-bottom: 2px solid #1d3a8a; }
    main { padding: 24px 32px; }
    .specs-list { list-style: none; padding: 0; }
    .specs-list li { padding: 8px 12px; cursor: pointer; border: 1px solid #ddd; margin-bottom: 4px; border-radius: 4px; }
    .specs-list li:hover { background: #f9fafb; }
    textarea { width: 100%; height: 360px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    .pane { background: #fafafa; border: 1px solid #e5e7eb; padding: 16px; margin-top: 12px; border-radius: 4px; }
    .kind-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-top: 12px; }
    .kind-card { border: 1px solid #ddd; border-radius: 4px; padding: 12px; cursor: pointer; background: #fff; text-align: left; font: inherit; }
    .kind-card:hover { background: #f9fafb; }
    .kind-card.selected { border-color: #1d3a8a; box-shadow: 0 0 0 1px #1d3a8a; }
    .kind-card strong { display: block; margin-bottom: 4px; color: #1d3a8a; }
    .field { margin-top: 12px; }
    .field label { display: block; font-weight: 600; margin-bottom: 4px; }
    .field input[type="text"], .field input[type="number"], .field select { width: 100%; max-width: 420px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font: inherit; box-sizing: border-box; }
    .field textarea { height: 90px; }
    .field .hint { color: #6b7280; font-size: 13px; margin-top: 2px; }
    .field-error { color: #b91c1c; font-size: 13px; margin-top: 4px; }
    .yaml-preview { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 4px; padding: 12px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; white-space: pre; overflow-x: auto; }
    button.primary { background: #1d3a8a; color: white; border: 0; border-radius: 4px; padding: 8px 16px; font: inherit; cursor: pointer; }
    button.primary:disabled { background: #9ca3af; cursor: not-allowed; }
    .case-row { display: flex; gap: 8px; margin-top: 8px; }
    .field .case-row input[type="text"] { width: auto; max-width: none; flex: 1; }
    .field .case-row input[type="text"][data-case-field="id"] { flex: 0 0 120px; }
    .case-row button { border: 1px solid #ddd; background: #fff; border-radius: 4px; cursor: pointer; padding: 0 10px; }
  </style>
</head>
<body>
  <header><h1>${title}</h1></header>
  <nav>
    <button id="tab-specs" class="active">Specs</button>
    <button id="tab-wizard">Wizard</button>
    <button id="tab-graders">Graders</button>
    <button id="tab-datasets">Datasets</button>
    <button id="tab-plugins">Plugins</button>
  </nav>
  <main>
    <section id="view-specs"></section>
    <section id="view-wizard" hidden></section>
    <section id="view-graders" hidden></section>
    <section id="view-datasets" hidden></section>
    <section id="view-plugins" hidden></section>
  </main>
  <script type="module">
${getStudioJs()}
  </script>
</body>
</html>`;
}

/**
 * The standalone JS bundle. Exported separately so the studio-server
 * can also serve it from `/studio.js` if the embedding host wants
 * that.
 */
export function getStudioJs(): string {
  return `
const $ = (sel) => document.querySelector(sel);
const tabs = ['specs', 'wizard', 'graders', 'datasets', 'plugins'];

function activate(name) {
  for (const t of tabs) {
    const btn = $('#tab-' + t);
    const view = $('#view-' + t);
    if (!btn || !view) continue;
    btn.classList.toggle('active', t === name);
    view.hidden = t !== name;
  }
  if (name === 'specs') renderSpecs();
  if (name === 'wizard') renderWizard();
  if (name === 'graders') renderGraders();
  if (name === 'datasets') renderDatasets();
  if (name === 'plugins') renderPlugins();
}

for (const t of tabs) {
  const btn = $('#tab-' + t);
  if (btn) btn.addEventListener('click', () => activate(t));
}

async function renderSpecs() {
  const view = $('#view-specs');
  if (!view) return;
  view.innerHTML = 'Loading…';
  try {
    const { specs } = await fetch('/api/specs').then((r) => r.json());
    if (specs.length === 0) {
      view.innerHTML = '<p>No specs yet. Use the Wizard tab to create one.</p>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'specs-list';
    for (const s of specs) {
      const li = document.createElement('li');
      li.textContent = s.name + ' (' + s.target + ')';
      li.addEventListener('click', () => openSpec(s.name));
      ul.appendChild(li);
    }
    view.replaceChildren(ul);
  } catch (err) {
    view.innerHTML = 'Error: ' + err;
  }
}

async function openSpec(name) {
  const view = $('#view-specs');
  if (!view) return;
  const { yaml } = await fetch('/api/specs/' + name).then((r) => r.json());
  view.innerHTML = '<h2>' + name + '</h2>';
  const ta = document.createElement('textarea');
  ta.value = yaml;
  view.appendChild(ta);
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    const r = await fetch('/api/specs/' + name, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: ta.value }),
    });
    save.textContent = r.ok ? 'Saved.' : 'Save failed';
    setTimeout(() => (save.textContent = 'Save'), 1500);
  });
  view.appendChild(save);
}

async function renderWizard() {
  const view = $('#view-wizard');
  if (!view) return;
  view.innerHTML = '<h2>New Spec</h2>';
  let { state, nextQuestion: q } = await fetch('/api/wizard/start', { method: 'POST' }).then((r) => r.json());
  const log = document.createElement('div');
  log.className = 'pane';
  view.appendChild(log);
  while (q !== null && q !== undefined) {
    const answer = await ask(q);
    const next = await fetch('/api/wizard/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, answer }),
    }).then((r) => r.json());
    state = next.state;
    q = next.nextQuestion;
    log.innerHTML += '<div>' + (answer.question || '') + ': <code>' + JSON.stringify(answer.value) + '</code></div>';
  }
  const compiled = await fetch('/api/wizard/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  }).then((r) => r.json());
  view.innerHTML += '<h3>Generated YAML</h3><pre>' + escapeHtml(compiled.yaml) + '</pre>';
  const create = document.createElement('button');
  create.textContent = 'Create spec';
  create.addEventListener('click', async () => {
    const r = await fetch('/api/specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: compiled.name, yaml: compiled.yaml }),
    });
    create.textContent = r.ok ? 'Created' : 'Error';
  });
  view.appendChild(create);
}

function ask(q) {
  // v0: synchronous prompts via window.prompt, mapped to the wizard
  // answer shape. studio-ui v1 will replace these with proper form UI.
  if (q.id === 'target') {
    const choices = q.choices.map((c) => c.value).join('|');
    const v = window.prompt('Target shape (' + choices + ')', 'cli') || 'cli';
    return Promise.resolve({ question: 'target', value: v });
  }
  if (q.id === 'name') {
    const v = window.prompt(q.prompt, 'my-spec') || 'my-spec';
    return Promise.resolve({ question: 'name', value: v });
  }
  if (q.id === 'model') {
    const v = window.prompt(q.prompt + ' (' + q.suggested.join(', ') + ')', q.suggested[0] || '');
    return Promise.resolve({ question: 'model', value: v });
  }
  if (q.id === 'tools') {
    const v = window.prompt(q.prompt, q.suggested.join(',')) || '';
    return Promise.resolve({ question: 'tools', value: v.split(',').map((s) => s.trim()).filter(Boolean) });
  }
  if (q.id === 'permissionMode') {
    const v = window.prompt(q.prompt + ' (default|plan|auto)', 'default') || 'default';
    return Promise.resolve({ question: 'permissionMode', value: v });
  }
}

// ---- Graders tab ----------------------------------------------------------
// Form-based grader builder. The browser holds no validation logic: field
// values are replayed through the headless state machine over HTTP
// (/api/grader-wizard/start → step×N → compile) and any 400 from /step is
// rendered inline next to the offending field.

// Mirrors the grader-builder question order per kind (kind, then the
// kind's branch — no global questions after the branch).
const GRADER_BRANCH = {
  'exact_match': ['trim', 'caseInsensitive'],
  'contains': ['substring', 'caseInsensitive'],
  'regex': ['pattern', 'flags'],
  'json_path': ['path', 'expectedJson'],
  'tool_call_sequence': ['toolCalls', 'sequenceMode'],
  'llm_judge': ['criterionName', 'criterionDescription', 'anchors', 'passingScore', 'judgeModel', 'judgeWeight'],
};

// Form field metadata per question id. Labels/hints mirror the
// grader-builder nextQuestion() prompts; 'lines' renders a textarea
// whose value is split into an array (one item per non-empty line).
const GRADER_FIELDS = {
  trim: { label: 'Trim surrounding whitespace before comparing', type: 'checkbox', checked: true },
  caseInsensitive: { label: 'Ignore case when comparing', type: 'checkbox', checked: false },
  substring: { label: 'Substring the output must contain', type: 'text', hint: 'matched literally' },
  pattern: { label: 'Regular expression the output must match', type: 'text', hint: 'JavaScript RegExp syntax, e.g. refund(ed|s)?' },
  flags: { label: 'Regex flags (optional)', type: 'text', hint: 'e.g. "i" for case-insensitive, "m" for multiline; leave empty for none', optional: true },
  path: { label: 'JSONPath that must match in the (JSON) output', type: 'text', hint: '$-rooted, e.g. $.status or $.items[*].id' },
  expectedJson: { label: 'Expected value at that path (optional, as JSON)', type: 'textarea', hint: 'e.g. "resolved" or 42 — leave empty to only require a match', optional: true },
  toolCalls: { label: 'Tool names the run must call, in order (one per line)', type: 'lines', hint: 'e.g. bash, read — names as the spec\\'s tools: list declares them' },
  sequenceMode: { label: 'How strictly should the sequence match?', type: 'select', options: ['subseq', 'exact', 'set'], hint: 'subseq (default): expected tools appear in order, others may interleave; exact: the full call list; set: order ignored' },
  criterionName: { label: 'Rubric criterion name', type: 'text', hint: 'e.g. helpfulness, accuracy' },
  criterionDescription: { label: 'What should the judge look for?', type: 'textarea', hint: 'plain language; the judge scores 1–5 against this' },
  anchors: { label: 'Anchor descriptions for scores 1–5 (optional)', type: 'lines', hint: 'five lines, worst (1) to best (5); leave empty for generic anchors', optional: true },
  passingScore: { label: 'Minimum judge score to pass (optional)', type: 'number', min: 1, max: 5, step: 0.5, hint: '1–5; defaults to 3', optional: true },
  judgeModel: { label: 'Judge model', type: 'model', suggested: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7'] },
  judgeWeight: { label: 'Weight relative to other graders (optional)', type: 'number', hint: 'positive number; leave empty to skip (default 1)', optional: true },
};

let graderState = null; // last successfully compiled state (sent to the append endpoint)

async function renderGraders() {
  const view = $('#view-graders');
  if (!view) return;
  graderState = null;
  view.innerHTML = '<h2>New Grader</h2><p>Pick a grader kind, fill in the fields, and watch the YAML preview update. Add it to an eval spec below, or copy the YAML into your spec by hand.</p>';
  const { nextQuestion: kindQ } = await fetch('/api/grader-wizard/start', { method: 'POST' }).then((r) => r.json());

  const cards = document.createElement('div');
  cards.className = 'kind-cards';
  const formWrap = document.createElement('div');
  const previewWrap = document.createElement('div');
  view.appendChild(cards);
  view.appendChild(formWrap);
  view.appendChild(previewWrap);

  for (const c of kindQ.choices) {
    const card = document.createElement('button');
    card.className = 'kind-card';
    card.dataset.kind = c.value;
    card.innerHTML = '<strong>' + escapeHtml(c.label) + '</strong>' + escapeHtml(c.description);
    card.addEventListener('click', () => {
      for (const el of cards.querySelectorAll('.kind-card')) el.classList.remove('selected');
      card.classList.add('selected');
      renderGraderForm(c.value, formWrap, previewWrap);
    });
    cards.appendChild(card);
  }
}

function graderField(qid) {
  const meta = GRADER_FIELDS[qid];
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.question = qid;
  const label = document.createElement('label');
  let input;
  if (meta.type === 'checkbox') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = meta.checked;
    label.appendChild(input);
    label.appendChild(document.createTextNode(' ' + meta.label));
    wrap.appendChild(label);
  } else if (meta.type === 'select') {
    label.textContent = meta.label;
    input = document.createElement('select');
    for (const o of meta.options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      input.appendChild(opt);
    }
    wrap.appendChild(label);
    wrap.appendChild(input);
  } else if (meta.type === 'model') {
    label.textContent = meta.label;
    input = document.createElement('input');
    input.type = 'text';
    input.value = meta.suggested[0];
    input.setAttribute('list', 'grader-models');
    let datalist = document.querySelector('#grader-models');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'grader-models';
      for (const s of meta.suggested) {
        const opt = document.createElement('option');
        opt.value = s;
        datalist.appendChild(opt);
      }
      document.body.appendChild(datalist);
    }
    wrap.appendChild(label);
    wrap.appendChild(input);
  } else if (meta.type === 'textarea' || meta.type === 'lines') {
    label.textContent = meta.label;
    input = document.createElement('textarea');
    wrap.appendChild(label);
    wrap.appendChild(input);
  } else {
    label.textContent = meta.label;
    input = document.createElement('input');
    input.type = meta.type;
    if (meta.placeholder) input.placeholder = meta.placeholder;
    if (meta.min !== undefined) input.min = meta.min;
    if (meta.max !== undefined) input.max = meta.max;
    if (meta.step !== undefined) input.step = meta.step;
    if (meta.value !== undefined) input.value = meta.value;
    wrap.appendChild(label);
    wrap.appendChild(input);
  }
  input.dataset.question = qid;
  if (meta.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = meta.hint;
    wrap.appendChild(hint);
  }
  const err = document.createElement('div');
  err.className = 'field-error';
  err.hidden = true;
  wrap.appendChild(err);
  return wrap;
}

function graderAnswerFrom(input, qid) {
  const meta = GRADER_FIELDS[qid];
  if (meta.type === 'checkbox') return { question: qid, value: input.checked };
  if (meta.type === 'select') return { question: qid, value: input.value };
  if (meta.type === 'lines') {
    const items = input.value.split('\\n').map((s) => s.trim()).filter((s) => s !== '');
    if (items.length === 0 && meta.optional) return { question: qid, value: undefined };
    return { question: qid, value: items };
  }
  const raw = input.value.trim();
  if (meta.type === 'number') {
    if (raw === '') return meta.optional ? { question: qid, value: undefined } : null;
    return { question: qid, value: Number(raw) };
  }
  if (raw === '' && meta.optional) return { question: qid, value: undefined };
  return { question: qid, value: raw };
}

function renderGraderForm(kind, formWrap, previewWrap) {
  graderState = null;
  const order = GRADER_BRANCH[kind];
  formWrap.innerHTML = '';
  previewWrap.innerHTML = '';
  const form = document.createElement('div');
  form.className = 'pane';
  for (const qid of order) form.appendChild(graderField(qid));
  formWrap.appendChild(form);

  const preview = document.createElement('pre');
  preview.className = 'yaml-preview';
  preview.textContent = '# fill in the fields to preview the grader YAML';
  const copy = document.createElement('button');
  copy.textContent = 'Copy YAML';
  copy.disabled = true;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(preview.textContent);
      copy.textContent = 'Copied.';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = preview.textContent;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      copy.textContent = 'Copied.';
    }
    setTimeout(() => (copy.textContent = 'Copy YAML'), 1500);
  });
  previewWrap.appendChild(preview);
  previewWrap.appendChild(copy);
  const attach = document.createElement('div');
  previewWrap.appendChild(attach);
  renderGraderAttach(attach);

  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => replayGrader(kind, order, form, preview, copy, attach), 400);
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();
}

async function replayGrader(kind, order, form, preview, copy, attach) {
  for (const el of form.querySelectorAll('.field-error')) {
    el.hidden = true;
    el.textContent = '';
  }
  const answers = [{ question: 'kind', value: kind }];
  for (const qid of order) {
    const input = form.querySelector('[data-question="' + qid + '"] input, [data-question="' + qid + '"] textarea, [data-question="' + qid + '"] select');
    const a = graderAnswerFrom(input, qid);
    if (a === null) {
      preview.textContent = '# ' + GRADER_FIELDS[qid].label + ' is required';
      graderState = null;
      copy.disabled = true;
      attach.querySelector('button.primary')?.setAttribute('disabled', '');
      return;
    }
    answers.push(a);
  }
  let { state } = await fetch('/api/grader-wizard/start', { method: 'POST' }).then((r) => r.json());
  for (const answer of answers) {
    const res = await fetch('/api/grader-wizard/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, answer }),
    });
    const body = await res.json();
    if (!res.ok) {
      const field = form.querySelector('[data-question="' + answer.question + '"] .field-error');
      if (field) {
        field.textContent = body.error;
        field.hidden = false;
      }
      preview.textContent = '# ' + body.error;
      graderState = null;
      copy.disabled = true;
      attach.querySelector('button.primary')?.setAttribute('disabled', '');
      return;
    }
    state = body.state;
  }
  const compiled = await fetch('/api/grader-wizard/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  }).then((r) => r.json());
  if (compiled.error) {
    preview.textContent = '# ' + compiled.error;
    graderState = null;
    copy.disabled = true;
    return;
  }
  preview.textContent = compiled.yamlBlock;
  graderState = state;
  copy.disabled = false;
  attach.querySelector('button.primary')?.removeAttribute('disabled');
}

async function renderGraderAttach(attach) {
  attach.innerHTML = '';
  const { specs } = await fetch('/api/specs').then((r) => r.json());
  const evalSpecs = specs.filter((s) => s.target === 'eval');
  const pane = document.createElement('div');
  pane.className = 'pane';
  if (evalSpecs.length === 0) {
    pane.innerHTML = '<p>No eval specs in this workspace — copy the YAML above into your eval spec\\'s <code>graders:</code> array.</p>';
    attach.appendChild(pane);
    return;
  }
  pane.innerHTML = '<strong>Add to eval spec</strong> ';
  const sel = document.createElement('select');
  for (const s of evalSpecs) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = 'Add to spec';
  add.disabled = true;
  const status = document.createElement('span');
  status.style.marginLeft = '8px';
  add.addEventListener('click', async () => {
    if (!graderState) return;
    const res = await fetch('/api/specs/' + sel.value + '/graders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: graderState }),
    });
    const body = await res.json();
    if (res.ok) {
      status.textContent = 'Added ' + body.graderName + ' to ' + body.name + '. ';
      const open = document.createElement('button');
      open.textContent = 'Open spec';
      open.addEventListener('click', () => {
        activate('specs');
        openSpec(body.name);
      });
      status.appendChild(open);
    } else {
      status.textContent = 'Error: ' + (body.error || res.status) + (body.detail ? ' — ' + body.detail : '');
    }
  });
  pane.appendChild(sel);
  pane.appendChild(document.createTextNode(' '));
  pane.appendChild(add);
  pane.appendChild(status);
  attach.appendChild(pane);
}

// ---- Datasets tab ---------------------------------------------------------
// Same replay-don't-trust pattern as the Graders tab: the browser holds no
// validation logic; field values are replayed through the headless dataset
// state machine over HTTP (/api/dataset-wizard/start → step×N → compile)
// and any 400 from /step is rendered inline next to the offending field.
// A compiled dataset is two artifacts written together: the spec's
// dataset: coordinate block and the JSONL case file the server stores
// under <workspace>/datasets/<name>/<version>/<split>.jsonl.

const DATASET_COORD_FIELDS = {
  datasetName: { label: 'Dataset name', type: 'text', hint: 'letters, digits, hyphens — becomes datasets/<name>/<version>/<split>.jsonl' },
  version: { label: 'Version', type: 'text', hint: 'path-safe, e.g. "1" or "2025-q2" — bump it instead of editing a published dataset' },
  split: { label: 'Split', type: 'select', options: ['dev', 'train', 'test'], hint: 'dev (default): the split eval runs read; test is held out for final scoring' },
};

let datasetState = null; // last successfully compiled state (sent to the save/attach endpoints)

function el(tag, props) {
  const node = document.createElement(tag);
  for (const k of Object.keys(props || {})) node[k] = props[k];
  return node;
}

async function renderDatasets() {
  const view = $('#view-datasets');
  if (!view) return;
  datasetState = null;
  const intro = el('p', { textContent: 'Pick where the cases come from, give the dataset a coordinate (name / version / split), and watch the YAML + JSONL previews update. Save the cases to the workspace and point an eval spec at them — or create a brand-new eval spec around the dataset.' });
  view.replaceChildren(el('h2', { textContent: 'New Dataset' }), intro);
  const { nextQuestion: sourceQ } = await fetch('/api/dataset-wizard/start', { method: 'POST' }).then((r) => r.json());

  const existing = el('div', { id: 'dataset-list' });
  view.appendChild(existing);
  renderDatasetList();

  const cards = el('div', { className: 'kind-cards' });
  const formWrap = el('div');
  const previewWrap = el('div');
  view.appendChild(cards);
  view.appendChild(formWrap);
  view.appendChild(previewWrap);

  for (const c of sourceQ.choices) {
    const card = el('button', { className: 'kind-card' });
    card.dataset.source = c.value;
    card.appendChild(el('strong', { textContent: c.label }));
    card.appendChild(document.createTextNode(c.description));
    card.addEventListener('click', () => {
      for (const other of cards.querySelectorAll('.kind-card')) other.classList.remove('selected');
      card.classList.add('selected');
      renderDatasetForm(c.value, formWrap, previewWrap);
    });
    cards.appendChild(card);
  }
}

async function renderDatasetList() {
  const container = $('#dataset-list');
  if (!container) return;
  container.replaceChildren();
  const { datasets } = await fetch('/api/datasets').then((r) => r.json());
  if (datasets.length === 0) return;
  const pane = el('div', { className: 'pane' });
  pane.appendChild(el('strong', { textContent: 'In this workspace' }));
  const ul = el('ul', { className: 'specs-list' });
  for (const d of datasets) {
    ul.appendChild(
      el('li', {
        textContent:
          d.name + ' @ ' + d.version + ' / ' + d.split +
          (d.cases === null ? ' — invalid file' : ' (' + d.cases + (d.cases === 1 ? ' case)' : ' cases)')),
      }),
    );
  }
  pane.appendChild(ul);
  container.appendChild(pane);
}

function datasetField(qid) {
  const meta = DATASET_COORD_FIELDS[qid];
  const wrap = el('div', { className: 'field' });
  wrap.dataset.question = qid;
  wrap.appendChild(el('label', { textContent: meta.label }));
  let input;
  if (meta.type === 'select') {
    input = el('select');
    for (const o of meta.options) input.appendChild(el('option', { value: o, textContent: o }));
  } else {
    input = el('input', { type: 'text' });
  }
  input.dataset.question = qid;
  wrap.appendChild(input);
  if (meta.hint) wrap.appendChild(el('div', { className: 'hint', textContent: meta.hint }));
  wrap.appendChild(el('div', { className: 'field-error', hidden: true }));
  return wrap;
}

function datasetCaseRow() {
  const row = el('div', { className: 'case-row' });
  const input = el('input', { type: 'text', placeholder: 'input — what the agent is prompted with' });
  input.dataset.caseField = 'input';
  const expected = el('input', { type: 'text', placeholder: 'expected_output (optional)' });
  expected.dataset.caseField = 'expected';
  const id = el('input', { type: 'text', placeholder: 'id (auto)' });
  id.dataset.caseField = 'id';
  const remove = el('button', { textContent: '✕', title: 'Remove case' });
  remove.addEventListener('click', () => {
    const editor = row.parentElement;
    row.remove();
    if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  row.appendChild(input);
  row.appendChild(expected);
  row.appendChild(id);
  row.appendChild(remove);
  return row;
}

function datasetCasesField() {
  const wrap = el('div', { className: 'field' });
  wrap.dataset.question = 'cases';
  wrap.appendChild(el('label', { textContent: 'Cases' }));
  const editor = el('div', { className: 'case-editor' });
  editor.appendChild(datasetCaseRow());
  wrap.appendChild(editor);
  const add = el('button', { textContent: '+ Add case' });
  add.style.marginTop = '8px';
  add.addEventListener('click', () => editor.appendChild(datasetCaseRow()));
  wrap.appendChild(add);
  wrap.appendChild(el('div', {
    className: 'hint',
    textContent: 'each case: input (required), expected_output (optional — llm_judge/regex graders need none), id (optional — auto-filled case-001 style)',
  }));
  wrap.appendChild(el('div', { className: 'field-error', hidden: true }));
  return wrap;
}

// Rows with every field empty are skipped, so an untouched spare row
// never blocks the preview.
function datasetCasesFrom(editor) {
  const cases = [];
  for (const row of editor.querySelectorAll('.case-row')) {
    const get = (k) => row.querySelector('[data-case-field="' + k + '"]').value;
    const input = get('input');
    const expected = get('expected');
    const id = get('id').trim();
    if (input.trim() === '' && expected.trim() === '' && id === '') continue;
    const c = { input: input };
    if (expected !== '') c.expected_output = expected;
    if (id !== '') c.id = id;
    cases.push(c);
  }
  return cases;
}

function datasetCopyButton(labelText, pre) {
  const copy = el('button', { textContent: labelText, disabled: true });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      copy.textContent = 'Copied.';
    } catch {
      const ta = el('textarea', { value: pre.textContent });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      copy.textContent = 'Copied.';
    }
    setTimeout(() => (copy.textContent = labelText), 1500);
  });
  return copy;
}

function setDatasetActionsEnabled(previewWrap, copies, enabled) {
  for (const b of copies) b.disabled = !enabled;
  for (const b of previewWrap.querySelectorAll('button.dataset-action')) {
    if (enabled) b.removeAttribute('disabled');
    else b.setAttribute('disabled', '');
  }
}

function renderDatasetForm(source, formWrap, previewWrap) {
  datasetState = null;
  formWrap.replaceChildren();
  previewWrap.replaceChildren();
  const form = el('div', { className: 'pane' });
  for (const qid of ['datasetName', 'version', 'split']) form.appendChild(datasetField(qid));
  if (source === 'manual') {
    form.appendChild(datasetCasesField());
  } else {
    const wrap = el('div', { className: 'field' });
    wrap.dataset.question = 'jsonl';
    wrap.appendChild(el('label', { textContent: 'JSONL' }));
    const ta = el('textarea', { placeholder: '{"input": "hello", "expected_output": "hi there"}' });
    ta.dataset.question = 'jsonl';
    wrap.appendChild(ta);
    wrap.appendChild(el('div', {
      className: 'hint',
      textContent: 'one JSON object per line: input required; id and metadata optional',
    }));
    wrap.appendChild(el('div', { className: 'field-error', hidden: true }));
    form.appendChild(wrap);
  }
  formWrap.appendChild(form);

  const yamlPreview = el('pre', {
    className: 'yaml-preview',
    textContent: '# fill in the fields to preview the dataset YAML',
  });
  const jsonlPreview = el('pre', {
    className: 'yaml-preview',
    textContent: '# …and the JSONL case file',
  });
  const copyYaml = datasetCopyButton('Copy YAML', yamlPreview);
  const copyJsonl = datasetCopyButton('Copy JSONL', jsonlPreview);
  previewWrap.appendChild(yamlPreview);
  previewWrap.appendChild(copyYaml);
  previewWrap.appendChild(jsonlPreview);
  previewWrap.appendChild(copyJsonl);
  const save = el('div');
  previewWrap.appendChild(save);
  const attach = el('div');
  previewWrap.appendChild(attach);
  renderDatasetSave(save);
  renderDatasetAttach(attach);

  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => replayDataset(source, form, yamlPreview, jsonlPreview, [copyYaml, copyJsonl], previewWrap), 400);
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();
}

async function replayDataset(source, form, yamlPreview, jsonlPreview, copies, previewWrap) {
  for (const errEl of form.querySelectorAll('.field-error')) {
    errEl.hidden = true;
    errEl.textContent = '';
  }
  const failTo = (qid, message) => {
    const field = form.querySelector('[data-question="' + qid + '"] .field-error');
    if (field) {
      field.textContent = message;
      field.hidden = false;
    }
    yamlPreview.textContent = '# ' + message;
    jsonlPreview.textContent = '# ' + message;
    datasetState = null;
    setDatasetActionsEnabled(previewWrap, copies, false);
  };
  const answers = [{ question: 'source', value: source }];
  for (const qid of ['datasetName', 'version']) {
    const input = form.querySelector('[data-question="' + qid + '"] input');
    if (input.value.trim() === '') return failTo(qid, DATASET_COORD_FIELDS[qid].label + ' is required');
    answers.push({ question: qid, value: input.value.trim() });
  }
  const split = form.querySelector('[data-question="split"] select');
  answers.push({ question: 'split', value: split.value });
  if (source === 'manual') {
    const cases = datasetCasesFrom(form.querySelector('.case-editor'));
    if (cases.length === 0) return failTo('cases', 'enter at least one case (input is required)');
    answers.push({ question: 'cases', value: cases });
  } else {
    const ta = form.querySelector('textarea[data-question="jsonl"]');
    if (ta.value.trim() === '') return failTo('jsonl', 'paste at least one JSONL line');
    answers.push({ question: 'jsonl', value: ta.value });
  }
  let { state } = await fetch('/api/dataset-wizard/start', { method: 'POST' }).then((r) => r.json());
  for (const answer of answers) {
    const res = await fetch('/api/dataset-wizard/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, answer }),
    });
    const body = await res.json();
    if (!res.ok) return failTo(answer.question, body.error);
    state = body.state;
  }
  const compiled = await fetch('/api/dataset-wizard/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  }).then((r) => r.json());
  if (compiled.error) {
    yamlPreview.textContent = '# ' + compiled.error;
    jsonlPreview.textContent = '# ' + compiled.error;
    datasetState = null;
    setDatasetActionsEnabled(previewWrap, copies, false);
    return;
  }
  yamlPreview.textContent = compiled.yamlBlock;
  jsonlPreview.textContent = compiled.jsonl;
  datasetState = state;
  setDatasetActionsEnabled(previewWrap, copies, true);
}

function datasetErrorText(body, res) {
  return 'Error: ' + (body.error || res.status) + (body.detail ? ' — ' + body.detail : '');
}

function renderDatasetSave(container) {
  container.replaceChildren();
  const pane = el('div', { className: 'pane' });
  pane.appendChild(el('strong', { textContent: 'Save to workspace ' }));
  const save = el('button', { className: 'primary dataset-action', textContent: 'Save dataset', disabled: true });
  const status = el('span');
  status.style.marginLeft = '8px';
  save.addEventListener('click', async () => {
    if (!datasetState) return;
    const res = await fetch('/api/datasets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: datasetState }),
    });
    const body = await res.json();
    if (res.ok) {
      status.textContent =
        (body.unchanged ? 'Already saved as ' : 'Saved ') + body.path + ' (' + body.caseCount + ' cases).';
      renderDatasetList();
    } else {
      status.textContent = datasetErrorText(body, res);
    }
  });
  pane.appendChild(save);
  pane.appendChild(status);
  container.appendChild(pane);
}

async function renderDatasetAttach(attach) {
  attach.replaceChildren();
  const { specs } = await fetch('/api/specs').then((r) => r.json());
  const evalSpecs = specs.filter((s) => s.target === 'eval');
  const pane = el('div', { className: 'pane' });

  const openSpecButton = (status, name, prefix) => {
    const open = el('button', { textContent: 'Open spec' });
    open.addEventListener('click', () => {
      activate('specs');
      openSpec(name);
    });
    status.replaceChildren(document.createTextNode(prefix), open);
  };

  if (evalSpecs.length > 0) {
    pane.appendChild(el('strong', { textContent: 'Point an eval spec at this dataset ' }));
    const sel = el('select');
    for (const s of evalSpecs) sel.appendChild(el('option', { value: s.name, textContent: s.name }));
    const set = el('button', { className: 'primary dataset-action', textContent: 'Set dataset', disabled: true });
    const status = el('span');
    status.style.marginLeft = '8px';
    set.addEventListener('click', async () => {
      if (!datasetState) return;
      const res = await fetch('/api/specs/' + sel.value + '/dataset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: datasetState }),
      });
      const body = await res.json();
      if (res.ok) {
        renderDatasetList();
        openSpecButton(status, body.name, 'Dataset set on ' + body.name + '. ');
      } else {
        status.textContent = datasetErrorText(body, res);
      }
    });
    pane.appendChild(sel);
    pane.appendChild(document.createTextNode(' '));
    pane.appendChild(set);
    pane.appendChild(status);
    pane.appendChild(el('hr'));
  }

  // Create a brand-new eval spec around the dataset — the spec wizard has
  // no eval target, so this is how the Studio authors an eval end to end:
  // Datasets tab (dataset + starter spec) → Graders tab (refine graders).
  pane.appendChild(el('strong', {
    textContent:
      evalSpecs.length > 0 ? 'Or create a new eval spec around it' : 'Create an eval spec around this dataset',
  }));
  const nameField = el('div', { className: 'field' });
  nameField.appendChild(el('label', { textContent: 'Spec name' }));
  const nameInput = el('input', { type: 'text', id: 'dataset-create-spec-name' });
  nameField.appendChild(nameInput);
  nameField.appendChild(el('div', {
    className: 'hint',
    textContent: 'letters, digits, hyphens — becomes <name>.yaml in the workspace',
  }));
  const modelField = el('div', { className: 'field' });
  modelField.appendChild(el('label', { textContent: 'Agent model' }));
  const modelInput = el('input', { type: 'text', value: 'claude-sonnet-4-6' });
  modelField.appendChild(modelInput);
  const instrField = el('div', { className: 'field' });
  instrField.appendChild(el('label', { textContent: 'Agent instructions' }));
  const instrInput = el('textarea', { value: 'Answer each case input.' });
  instrField.appendChild(instrInput);
  const create = el('button', { className: 'primary dataset-action', textContent: 'Create eval spec', disabled: true });
  const createStatus = el('span');
  createStatus.style.marginLeft = '8px';
  create.addEventListener('click', async () => {
    if (!datasetState) return;
    const name = nameInput.value.trim();
    if (name === '') {
      createStatus.textContent = 'spec name is required';
      return;
    }
    // Mirror the server's route charset up front — a name like "my eval"
    // would otherwise miss the route and surface a misleading 404.
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(name)) {
      createStatus.textContent = 'spec name must be letters, digits, and hyphens (no leading/trailing hyphen)';
      return;
    }
    const res = await fetch('/api/specs/' + encodeURIComponent(name) + '/dataset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: datasetState,
        create: { model: modelInput.value.trim(), instructions: instrInput.value },
      }),
    });
    const body = await res.json();
    if (res.ok) {
      renderDatasetList();
      openSpecButton(
        createStatus,
        body.name,
        (body.created ? 'Created ' : 'Dataset set on existing ') + body.name +
          ' (default exact_match grader — refine in the Graders tab). ',
      );
    } else {
      createStatus.textContent = datasetErrorText(body, res);
    }
  });
  pane.appendChild(nameField);
  pane.appendChild(modelField);
  pane.appendChild(instrField);
  pane.appendChild(create);
  pane.appendChild(createStatus);
  attach.appendChild(pane);
}

async function renderPlugins() {
  const view = $('#view-plugins');
  if (!view) return;
  view.innerHTML = 'Loading…';
  const { plugins } = await fetch('/api/plugins').then((r) => r.json());
  if (plugins.length === 0) {
    view.innerHTML = '<p>No plugins. Drop a folder under ~/.crewhaus/plugins/ to add one.</p>';
    return;
  }
  view.innerHTML = '<h2>Plugins</h2>';
  for (const p of plugins) {
    const card = document.createElement('div');
    card.className = 'pane';
    card.innerHTML = '<strong>' + p.name + '</strong> v' + p.version + (p.description ? ' — ' + p.description : '');
    view.appendChild(card);
  }
}

function escapeHtml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

activate('specs');
`.trim();
}

/**
 * Section 31 — multi-spec dashboard renderer. Returns an HTML fragment
 * that can be embedded in any tab. Aggregates per-spec metrics; the
 * data fetching is the caller's responsibility (keeps the renderer
 * pure + testable).
 */
export type DashboardRow = {
  readonly specName: string;
  readonly costUsdMicros: number;
  readonly passRate?: number;
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly runCount: number;
};

/**
 * Phase 2 M5.2 — MCP connector picker. Curated catalog of well-known
 * MCP servers operators may want to wire into a spec. The picker is a
 * pure renderer (returns HTML); the studio-server's
 * `addMcpServer(specPath, name, config)` endpoint handles the YAML
 * write-back via spec-patch (preserves comments + key order).
 *
 * Catalog entries match the @modelcontextprotocol/server-* reference
 * set as of 2026-Q2. New entries should cite their npm package + a
 * one-line description.
 */
export type McpConnectorOption = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly transport: "stdio" | "sse";
  readonly stdio?: { readonly command: string; readonly args?: readonly string[] };
  readonly sse?: { readonly url: string };
  /** Env var names the operator must set. Shown as a hint in the UI. */
  readonly envRefs?: readonly string[];
};

export const CURATED_MCP_SERVERS: ReadonlyArray<McpConnectorOption> = [
  {
    id: "github",
    displayName: "GitHub",
    description: "Read repos, issues, PRs; manage labels and comments.",
    transport: "stdio",
    stdio: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    },
    envRefs: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  },
  {
    id: "filesystem",
    displayName: "Filesystem",
    description: "Scoped filesystem read/write for a configured root.",
    transport: "stdio",
    stdio: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
    },
  },
  {
    id: "postgres",
    displayName: "Postgres",
    description: "Read-only SQL queries against a PostgreSQL database.",
    transport: "stdio",
    stdio: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/mydb"],
    },
  },
  {
    id: "fetch",
    displayName: "Fetch",
    description: "HTTP fetch with content-type aware parsing.",
    transport: "stdio",
    stdio: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
    },
  },
  {
    id: "memory",
    displayName: "Memory (MCP reference)",
    description: "Persistent key-value memory; reference impl from MCP team.",
    transport: "stdio",
    stdio: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
  {
    id: "slack",
    displayName: "Slack",
    description: "Channel reads, message posts, reactions (MCP reference).",
    transport: "stdio",
    stdio: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
    },
    envRefs: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
  },
];

/**
 * Render the MCP connectors picker panel — an HTML fragment listing
 * curated MCP servers with one-click "Add to spec" buttons. The wired
 * `data-connector` attribute lets the calling page handle clicks via
 * delegation and POST to /api/specs/<name>/mcp.
 */
export function renderMcpConnectorsPanel(args: {
  readonly currentSpecName?: string;
  readonly catalog?: ReadonlyArray<McpConnectorOption>;
}): string {
  const escapeHtml = (s: string): string =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const catalog = args.catalog ?? CURATED_MCP_SERVERS;
  const specSuffix = args.currentSpecName ? ` to <code>${escapeHtml(args.currentSpecName)}</code>` : "";
  const rows = catalog
    .map((c) => {
      const envHint =
        c.envRefs && c.envRefs.length > 0
          ? `<div class="connector-env">Requires env: ${c.envRefs.map((e) => `<code>${escapeHtml(e)}</code>`).join(", ")}</div>`
          : "";
      const cmdLine =
        c.transport === "stdio"
          ? `<code>${escapeHtml((c.stdio?.command ?? "") + (c.stdio?.args ? ` ${c.stdio.args.join(" ")}` : ""))}</code>`
          : `<code>${escapeHtml(c.sse?.url ?? "")}</code>`;
      return `<div class="pane connector-card" data-connector="${escapeHtml(c.id)}">
        <strong>${escapeHtml(c.displayName)}</strong>
        <span class="connector-transport">[${escapeHtml(c.transport)}]</span>
        <p>${escapeHtml(c.description)}</p>
        ${cmdLine}
        ${envHint}
        <button class="connector-add" data-id="${escapeHtml(c.id)}">+ Add${specSuffix}</button>
      </div>`;
    })
    .join("\n");
  return `<section class="connectors-panel">
    <h2>MCP Connectors</h2>
    <p class="dashboard-empty">Pick a server to wire into your spec's <code>mcp_servers:</code> block. The Add button posts to <code>/api/specs/&lt;name&gt;/mcp</code>; the studio-server uses <code>spec-patch</code> to preserve comments + key order on write-back.</p>
    ${rows}
  </section>`;
}

export function renderMultiSpecDashboard(rows: ReadonlyArray<DashboardRow>): string {
  const escapeHtml = (s: string): string =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (rows.length === 0) {
    return '<p class="dashboard-empty">No specs registered yet.</p>';
  }
  const sorted = [...rows].sort((a, b) => a.specName.localeCompare(b.specName));
  const cells = sorted
    .map((r) => {
      const cost = `$${(r.costUsdMicros / 1_000_000).toFixed(4)}`;
      const pass = r.passRate !== undefined ? `${(r.passRate * 100).toFixed(1)}%` : "—";
      const p50 = r.p50LatencyMs !== undefined ? `${r.p50LatencyMs.toFixed(0)}ms` : "—";
      const p95 = r.p95LatencyMs !== undefined ? `${r.p95LatencyMs.toFixed(0)}ms` : "—";
      return `<tr>
        <td>${escapeHtml(r.specName)}</td>
        <td>${r.runCount}</td>
        <td>${cost}</td>
        <td>${pass}</td>
        <td>${p50}</td>
        <td>${p95}</td>
      </tr>`;
    })
    .join("\n");
  return `<table class="dashboard">
  <thead>
    <tr>
      <th>Spec</th>
      <th>Runs</th>
      <th>Cost</th>
      <th>Pass-rate</th>
      <th>p50 latency</th>
      <th>p95 latency</th>
    </tr>
  </thead>
  <tbody>
${cells}
  </tbody>
</table>`;
}

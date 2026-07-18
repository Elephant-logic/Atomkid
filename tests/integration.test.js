'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
// Point persistence at a throwaway file BEFORE requiring modules that read it at load time.
process.env.PRIMITIVE_STORE = path.join(os.tmpdir(), `atomos-primitives-${process.pid}.json`);

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWithSynthesis } = require('../src/app-platform');
const { createRegistry, renderSpecToVNode } = require('../public/registry');
const { buildCoreDefs } = require('../src/core-primitives');
const store = require('../src/primitive-store');

test.after(() => { try { fs.unlinkSync(process.env.PRIMITIVE_STORE); } catch {} });

test('gap in a real build: an unknown op is synthesized, verified, registered, then validates', async () => {
  const realFetch = global.fetch, realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => ({
    output_text: JSON.stringify({
      id: 'triple', kind: 'action',
      fields: { target: { type: 'state-key', required: true } },
      reduce: 'return { [args.target]: (Number(state[args.target]) || 0) * 3 };'
    })
  }) });
  try {
    const registry = createRegistry(buildCoreDefs());
    const app = {
      title: 'T', description: 'd', state: { n: 2 }, capabilities: [],
      components: [{ id: 'b', type: 'button', label: 'Go', event: 'go' }],
      rules: [{ event: 'go', actions: [{ op: 'triple', target: 'n' }] }]
    };
    // Before: the registry has no "triple", so plain validation would reject it.
    assert.throws(() => require('../src/app-platform').validateReferences(app, registry), /Unknown action primitive: triple/);
    // After: gap-aware validation synthesizes it and the app validates.
    await validateWithSynthesis(app, registry);
    assert.equal(registry.has('triple'), true);
    assert.equal(registry.get('triple').provenance, 'synthesized');
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  }
});

test('persistence: a candidate is stored and promoted to trusted after enough uses', () => {
  const def = { id: 'quadruple', kind: 'action', provenance: 'synthesized',
    fields: { target: { type: 'state-key', required: true } },
    reduce: 'return { [args.target]: (Number(state[args.target]) || 0) * 4 };' };
  store.saveCandidate(def);
  assert.equal(store._readAll().quadruple.status, 'candidate');
  assert.equal(store.loadTrusted().find(d => d.id === 'quadruple'), undefined);
  for (let i = 0; i < store.PROMOTE_AT; i++) store.recordUse('quadruple');
  assert.equal(store._readAll().quadruple.status, 'trusted');
  assert.ok(store.loadTrusted().some(d => d.id === 'quadruple'));
});

test('render interpreter: a synthesized component spec becomes a safe virtual node', () => {
  const def = { id: 'gauge', kind: 'component',
    render: { element: 'progress', class: 'gauge', bindText: 'bind' } };
  const v = renderSpecToVNode(def, { type: 'gauge', bind: 'level' }, { level: 42 });
  assert.equal(v.tag, 'progress');
  assert.equal(v.text, '42');
  assert.ok(v.className.includes('gauge'));
});

test('render interpreter: a disallowed element falls back to div, no markup injection', () => {
  const def = { id: 'evil', kind: 'component', render: { element: 'script', text: 'label' } };
  const v = renderSpecToVNode(def, { type: 'evil', label: 'hi' }, {});
  assert.equal(v.tag, 'div');
  assert.equal(v.text, 'hi');
});

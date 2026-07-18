'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRegistry, validateDefinitionShape, validateNodeAgainstDefinition, compileTrustedReducer
} = require('../public/registry');
const { verifyPrimitive } = require('../src/verify-primitive');

// A brand-new action primitive the system did NOT ship with: "scale" multiplies a target
// state number by a literal factor. This is exactly the kind of thing the synthesizer would
// emit as data (fields + a pure reduce body), never as hardcoded runtime code.
const scale = {
  id: 'scale',
  kind: 'action',
  provenance: 'synthesized',
  status: 'candidate',
  fields: {
    target: { type: 'state-key', required: true },
    factor: { type: 'number', literal: true, required: true }
  },
  reduce: 'return { [args.target]: (Number(state[args.target]) || 0) * Number(args.factor) };'
};

test('the full loop: verify -> register -> validate an app that uses it -> execute it', () => {
  // 1. VERIFY the synthesized primitive in the sandbox before trusting it.
  const result = verifyPrimitive(scale, { state: { score: 10 }, args: { target: 'score', factor: 3 } });
  assert.equal(result.ok, true);

  // 2. REGISTER it — same operation as loading a built-in.
  const reg = createRegistry();
  reg.register(scale);
  assert.equal(reg.has('scale'), true);
  assert.ok(reg.actionOps().includes('scale'));

  // 3. VALIDATE an app node that uses it. state-key fields are checked; literal fields are not.
  const stateKeys = new Set(['score']);
  const goodNode = { op: 'scale', target: 'score', factor: 3 };
  assert.doesNotThrow(() => validateNodeAgainstDefinition(goodNode, reg.get('scale'), stateKeys, 'rule action'));
  // referencing a missing state key is rejected...
  assert.throws(() => validateNodeAgainstDefinition(
    { op: 'scale', target: 'ghost', factor: 3 }, reg.get('scale'), stateKeys, 'rule action'), /unknown state key: ghost/);
  // ...but a literal factor that is not a state key is fine (it's a value, not an identifier).
  assert.doesNotThrow(() => validateNodeAgainstDefinition(
    { op: 'scale', target: 'score', factor: 999 }, reg.get('scale'), stateKeys, 'rule action'));

  // 4. EXECUTE it through the trusted reducer, exactly as the runtime would.
  const run = compileTrustedReducer(reg.get('scale'));
  const state = { score: 10 };
  Object.assign(state, run(state, { target: 'score', factor: 3 }));
  assert.equal(state.score, 30);
  Object.assign(state, run(state, { target: 'score', factor: 2 }));
  assert.equal(state.score, 60);
});

test('the real runtime executes a registered synthesized op via executeEvent', () => {
  const runtime = require('../public/runtime-core.js');
  const reg = createRegistry();
  reg.register(scale);
  // wire the compiled trusted ops into the runtime, exactly as the studio would at startup
  const { compileTrustedOps } = require('../public/registry');
  runtime.setActionRegistry(compileTrustedOps(reg.all()));

  const app = {
    state: { score: 7 },
    rules: [{ event: 'boost', actions: [{ op: 'scale', target: 'score', factor: 3 }] }]
  };
  const state = structuredClone(app.state);
  runtime.executeEvent(app, state, 'boost');
  assert.equal(state.score, 21);

  // an op that was never registered still errors, so the registry doesn't mask mistakes
  const bad = { state: { x: 0 }, rules: [{ event: 'go', actions: [{ op: 'nonexistent', target: 'x' }] }] };
  assert.throws(() => runtime.executeEvent(bad, structuredClone(bad.state), 'go'), /Unsupported action: nonexistent/);
  runtime.setActionRegistry(null);
});

test('safety: an impure reducer (touches host globals) is rejected', () => {
  const bad = { id: 'leaky', kind: 'action', provenance: 'synthesized',
    reduce: 'return { pid: process.pid };' };
  assert.throws(() => verifyPrimitive(bad, { state: {}, args: {} }), /failed verification/);
});

test('safety: a reducer that tries to require modules is rejected', () => {
  const bad = { id: 'requires', kind: 'action', provenance: 'synthesized',
    reduce: 'const fs = require("fs"); return { x: 1 };' };
  assert.throws(() => verifyPrimitive(bad, { state: {}, args: {} }), /failed verification/);
});

test('safety: a non-deterministic reducer is rejected', () => {
  const bad = { id: 'randomish', kind: 'action', provenance: 'synthesized',
    reduce: 'return { x: Math.random() };' };
  assert.throws(() => verifyPrimitive(bad, { state: {}, args: {} }), /not deterministic/);
});

test('safety: an infinite loop is stopped by the timeout, not hung', () => {
  const bad = { id: 'spinner', kind: 'action', provenance: 'synthesized',
    reduce: 'while (true) {} return { x: 1 };' };
  assert.throws(() => verifyPrimitive(bad, { state: {}, args: {} }), /failed verification/);
});

test('safety: a reducer that returns a non-object is rejected', () => {
  const bad = { id: 'scalarish', kind: 'action', provenance: 'synthesized',
    reduce: 'return 42;' };
  assert.throws(() => verifyPrimitive(bad, { state: {}, args: {} }), /partial-state object/);
});

test('a malformed definition is rejected before it can be registered', () => {
  assert.throws(() => validateDefinitionShape({ id: '1bad', kind: 'action' }), /valid id/);
  assert.throws(() => validateDefinitionShape({ id: 'ok', kind: 'widget' }), /component.*action/);
  assert.throws(() => validateDefinitionShape({ id: 'ok', kind: 'action', fields: { x: { type: 'weird' } } }), /invalid type/);
  assert.throws(() => validateDefinitionShape({ id: 'ok', kind: 'action', provenance: 'synthesized' }), /needs a reduce body/);
});

test('synthesizer path: a stubbed model definition is parsed, verified, and registered', async () => {
  const { ensurePrimitive } = require('../src/synthesize-primitive');
  const realFetch = global.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    // model returns a valid synthesized primitive
    global.fetch = async () => ({ ok: true, json: async () => ({
      output_text: JSON.stringify({
        id: 'increment_by', kind: 'action', provenance: 'synthesized',
        fields: { target: { type: 'state-key', required: true }, amount: { type: 'number', literal: true } },
        reduce: 'return { [args.target]: (Number(state[args.target]) || 0) + Number(args.amount || 1) };'
      })
    }) });
    const reg = createRegistry();
    const def = await ensurePrimitive(reg, 'increment_by', 'add a literal amount to a state number');
    assert.equal(reg.has('increment_by'), true);
    const run = compileTrustedReducer(def);
    const state = { n: 5 };
    Object.assign(state, run(state, { target: 'n', amount: 4 }));
    assert.equal(state.n, 9);

    // model returns an IMPURE primitive -> the gate rejects it, nothing is registered
    global.fetch = async () => ({ ok: true, json: async () => ({
      output_text: JSON.stringify({ id: 'evil', kind: 'action', provenance: 'synthesized',
        reduce: 'return { pid: process.pid };' })
    }) });
    const reg2 = createRegistry();
    await assert.rejects(() => ensurePrimitive(reg2, 'evil', 'do something sneaky'), /failed verification/);
    assert.equal(reg2.has('evil'), false);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  }
});

test('a component render spec is verified for shape only (no executable code)', () => {
  const comp = { id: 'gauge', kind: 'component', provenance: 'synthesized',
    fields: { bind: { type: 'state-key', required: true }, max: { type: 'number', literal: true } },
    render: { element: 'div', bindText: 'bind' } };
  const r = verifyPrimitive(comp);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'component');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../public/runtime-core.js');
const { normalizeApplication, validateReferences } = require('../src/app-platform');

const { conditionMatches } = runtime;

// ---- runtime evaluation: the five cases from the fix plan, expressed structurally ----

test('conditionMatches evaluates equality (activeScreen=="menu")', () => {
  const c = { state: 'activeScreen', operator: 'eq', value: 'menu' };
  assert.equal(conditionMatches(c, { activeScreen: 'menu' }), true);
  assert.equal(conditionMatches(c, { activeScreen: 'play' }), false);
});

test('conditionMatches evaluates comparison (score>=100)', () => {
  const c = { state: 'score', operator: 'gte', value: 100 };
  assert.equal(conditionMatches(c, { score: 100 }), true);
  assert.equal(conditionMatches(c, { score: 99 }), false);
});

test('conditionMatches evaluates negation (!paused)', () => {
  const c = { state: 'paused', operator: 'falsy' };
  assert.equal(conditionMatches(c, { paused: false }), true);
  assert.equal(conditionMatches(c, { paused: true }), false);
  // also via {not: state-key shorthand}
  assert.equal(conditionMatches({ not: 'paused' }, { paused: true }), false);
  assert.equal(conditionMatches({ not: 'paused' }, { paused: false }), true);
});

test('conditionMatches evaluates conjunction (a && b)', () => {
  const c = { all: [{ state: 'a', operator: 'truthy' }, { state: 'b', operator: 'truthy' }] };
  assert.equal(conditionMatches(c, { a: true, b: true }), true);
  assert.equal(conditionMatches(c, { a: true, b: false }), false);
});

test('conditionMatches evaluates disjunction (a || b)', () => {
  const c = { any: [{ state: 'a', operator: 'truthy' }, { state: 'b', operator: 'truthy' }] };
  assert.equal(conditionMatches(c, { a: false, b: true }), true);
  assert.equal(conditionMatches(c, { a: false, b: false }), false);
});

test('conditionMatches treats a bare string as a truthy state-key test and nests', () => {
  assert.equal(conditionMatches('ready', { ready: 1 }), true);
  assert.equal(conditionMatches('ready', { ready: 0 }), false);
  const nested = { all: [{ any: ['a', 'b'] }, { not: 'c' }] };
  assert.equal(conditionMatches(nested, { a: true, b: false, c: false }), true);
  assert.equal(conditionMatches(nested, { a: true, b: false, c: true }), false);
});

// ---- validation: identifier positions are checked, literal values are not ----

function appWith(component, extraState = {}) {
  return normalizeApplication(structuredClone({
    title: 'T', description: 'demo',
    state: { activeScreen: 'menu', score: 0, paused: false, a: false, b: false, cells: [0, 0, 0, 0], turn: 0, gi: 0, ...extraState },
    components: [component],
    rules: []
  }));
}

test('a literal value is NOT validated as a state key', () => {
  // "menu" is not a declared state key; it is a comparison literal and must be allowed
  const app = appWith({ id: 'h', type: 'heading', text: 'Hi', visibleWhen: { state: 'activeScreen', operator: 'eq', value: 'menu' } });
  assert.doesNotThrow(() => validateReferences(app));
});

test('an unknown state key in a condition is rejected', () => {
  const app = appWith({ id: 'h', type: 'heading', text: 'Hi', visibleWhen: { state: 'ghost', operator: 'eq', value: 1 } });
  assert.throws(() => validateReferences(app), /unknown state key: ghost/);
});

test('compound conditions validate each identifier and reject unknown ones', () => {
  assert.doesNotThrow(() => validateReferences(appWith(
    { id: 'h', type: 'heading', text: 'Hi', visibleWhen: { all: [{ state: 'a', operator: 'truthy' }, { state: 'b', operator: 'truthy' }] } })));
  assert.throws(() => validateReferences(appWith(
    { id: 'h', type: 'heading', text: 'Hi', visibleWhen: { any: [{ state: 'a', operator: 'truthy' }, { state: 'ghost', operator: 'truthy' }] } })), /unknown state key: ghost/);
});

test('an unknown operator is rejected', () => {
  const app = appWith({ id: 'h', type: 'heading', text: 'Hi', enabledWhen: { state: 'a', operator: 'approximately', value: 1 } });
  assert.throws(() => validateReferences(app), /unknown operator: approximately/);
});

test('identifier fields (indexState) are still validated as state keys', () => {
  // Call validateReferences directly so normalization does not auto-create the key.
  const bad = {
    title: 'T', description: 'd', state: { cells: [0, 0, 0, 0], turn: 0 }, capabilities: [],
    components: [{ id: 'g', type: 'board', rows: 2, cols: 2, bind: 'cells', event: 'g.select', indexState: 'MISSING' }],
    rules: [{ event: 'g.select', actions: [{ op: 'set', target: 'turn', value: 1 }] }]
  };
  assert.throws(() => validateReferences(bad), /unknown state key: MISSING/);
});

test('a rule action condition is validated with the same rules', () => {
  const bad = normalizeApplication(structuredClone({
    title: 'T', description: 'd', state: { turn: 0, flag: false },
    components: [{ id: 'btn', type: 'button', label: 'Go', event: 'go' }],
    rules: [{ event: 'go', actions: [{ op: 'set', target: 'turn', value: 1, when: { state: 'ghost', operator: 'truthy' } }] }]
  }));
  assert.throws(() => validateReferences(bad), /unknown state key: ghost/);
});

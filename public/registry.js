'use strict';

// AtomOS primitive registry.
//
// A "primitive" (a component type or an action op) is described by a single self-contained
// Primitive Definition record instead of being hardcoded across the schema, runtime and
// renderer. The registry is the single source of truth: the schema handed to the model, the
// validator, and the runtime all derive from it. Registering a synthesized primitive is the
// same operation as loading a built-in one.
//
// This module is dependency-free and runs in both Node (server) and the browser (studio /
// exported apps). The stronger, sandboxed verification of *synthesized* primitives lives in
// verify-primitive.js (server-only, uses node:vm) because a browser can't sandbox as tightly.

const FIELD_TYPES = new Set(['state-key', 'string', 'number', 'boolean', 'list', 'any']);

// ---- Definition shape ----------------------------------------------------------------------

function validateDefinitionShape(def) {
  if (!def || typeof def !== 'object') throw new Error('primitive definition must be an object');
  if (typeof def.id !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(def.id)) throw new Error('primitive definition needs a valid id');
  if (def.kind !== 'component' && def.kind !== 'action') throw new Error(`primitive ${def.id}: kind must be "component" or "action"`);
  if (def.fields !== undefined) {
    if (typeof def.fields !== 'object' || Array.isArray(def.fields)) throw new Error(`primitive ${def.id}: fields must be an object`);
    for (const [name, spec] of Object.entries(def.fields)) {
      if (!spec || typeof spec !== 'object' || !FIELD_TYPES.has(spec.type)) throw new Error(`primitive ${def.id}: field "${name}" has an invalid type`);
    }
  }
  if (def.kind === 'action' && def.provenance === 'synthesized' && typeof def.reduce !== 'string') {
    throw new Error(`synthesized action ${def.id} needs a reduce body`);
  }
  return true;
}

// ---- Registry ------------------------------------------------------------------------------

function createRegistry(seed = []) {
  const map = new Map();
  const api = {
    register(def) { validateDefinitionShape(def); map.set(def.id, def); return def; },
    has(id) { return map.has(id); },
    get(id) { return map.get(id); },
    all() { return [...map.values()]; },
    kindsOf(kind) { return [...map.values()].filter(d => d.kind === kind); },
    componentTypes() { return api.kindsOf('component').map(d => d.id); },
    actionOps() { return api.kindsOf('action').map(d => d.id); }
  };
  for (const def of seed) api.register(def);
  return api;
}

// ---- Validate a spec node against its definition (semantic, identifier-aware) --------------
// Only 'state-key' fields are checked against declared state keys. Literal value fields are
// values, never identifiers — the same separation used for conditions.

function validateNodeAgainstDefinition(node, def, stateKeys, where) {
  for (const [name, spec] of Object.entries(def.fields || {})) {
    const val = node[name];
    if (spec.required && (val === undefined || val === null)) throw new Error(`${where} is missing required field: ${name}`);
    if (val === undefined || val === null) continue;
    if (spec.type === 'state-key') {
      if (typeof val !== 'string' || !stateKeys.has(val)) throw new Error(`${where} field "${name}" references unknown state key: ${val}`);
    }
  }
  return true;
}

// ---- Trusted execution ---------------------------------------------------------------------
// After a synthesized action has passed server-side verification (verify-primitive.js), its
// reducer is trusted. compileTrustedReducer instantiates it for actual use. A reducer is a
// pure (state, args) => partialState function; the result is merged into state.

function compileTrustedReducer(def) {
  if (def.kind !== 'action' || typeof def.reduce !== 'string') return null;
  // eslint-disable-next-line no-new-func
  const fn = new Function('state', 'args', `"use strict";\n${def.reduce}`);
  return (state, args) => fn(state, args || {});
}

// Build an op table { opId: (state, args) => partialState } from action definitions that carry
// a reducer (i.e. synthesized primitives). Core ops keep their fast hardcoded path.
function compileTrustedOps(defs) {
  const ops = Object.create(null);
  for (const def of defs) {
    const r = compileTrustedReducer(def);
    if (r) ops[def.id] = r;
  }
  return ops;
}

// ---- Render specs (synthesized components) -------------------------------------------------
// A synthesized component carries a restricted, declarative render spec — never HTML or JS.
// renderSpecToVNode turns (definition, node, state) into a plain virtual node the browser
// renderer knows how to mount. Element tags are whitelisted; text is either a literal field or
// a value bound from state. Nothing here can inject markup or run code.

const SAFE_ELEMENTS = new Set(['div', 'span', 'p', 'h1', 'h2', 'h3', 'label', 'button', 'progress', 'meter', 'ul', 'li', 'img']);

function renderSpecToVNode(def, node, state) {
  const spec = def && def.render;
  if (!spec || typeof spec !== 'object') return { tag: 'div', className: 'app-component', text: '', children: [] };
  const tag = SAFE_ELEMENTS.has(spec.element) ? spec.element : 'div';
  let text = '';
  if (spec.bindText && node[spec.bindText] !== undefined) text = String(state[node[spec.bindText]] ?? '');
  else if (spec.text) text = String(node[spec.text] ?? spec.text);
  const vnode = { tag, className: 'app-component ' + (typeof spec.class === 'string' ? spec.class : def.id), text, children: [] };
  if (Array.isArray(spec.children)) for (const child of spec.children) vnode.children.push(renderSpecToVNode({ id: def.id, render: child }, node, state));
  return vnode;
}

const registry = {
  FIELD_TYPES,
  validateDefinitionShape,
  createRegistry,
  validateNodeAgainstDefinition,
  compileTrustedReducer,
  compileTrustedOps,
  renderSpecToVNode
};

if (typeof module !== 'undefined' && module.exports) module.exports = registry;
if (typeof window !== 'undefined') window.AtomOSRegistry = registry;

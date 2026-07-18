'use strict';

// Verification gate for synthesized primitives (server-only; uses node:vm).
//
// A synthesized action carries a `reduce` body: a pure (state, args) => partialState function.
// Before a primitive is admitted to the registry it must pass this gate, which enforces the
// properties that let AtomOS trust generated logic without giving up determinism:
//
//   1. shape        - the definition record is well-formed (registry.validateDefinitionShape)
//   2. isolation    - the reducer runs in a vm context with NO host globals: no require, no
//                     process, no console, no timers, no network. Reaching outside (state,args)
//                     throws a ReferenceError, which fails verification.
//   3. determinism  - running the reducer twice on the same input yields identical output, so
//                     anything using Math.random / time / external entropy is rejected.
//   4. shape of out - the reducer returns a partial-state object, not undefined/array/scalar.
//   5. termination  - a wall-clock timeout rejects infinite loops.
//
// Components (render specs) are validated for shape only here; they carry no executable code.

const vm = require('node:vm');
const { validateDefinitionShape } = require('../public/registry');

const TIMEOUT_MS = 50;

function runInSandbox(reduceBody, state, args) {
  // An empty context: ECMAScript intrinsics (Object, Array, Math, JSON...) exist, but host
  // objects (require, process, console, setTimeout, fetch, globalThis.*) do not.
  const context = vm.createContext(Object.create(null));
  // Inject cloned inputs as context globals so the reducer can neither retain nor mutate
  // caller state. The invocation runs INSIDE runInContext, so the wall-clock timeout applies
  // to the reducer body itself (an infinite loop is interrupted rather than hanging the host).
  context.__state = structuredClone(state);
  context.__args = structuredClone(args);
  const script = `(function(state, args){ "use strict";\n${reduceBody}\n})(__state, __args)`;
  return vm.runInContext(script, context, { timeout: TIMEOUT_MS });
}

function verifyPrimitive(def, sample = {}) {
  validateDefinitionShape(def);

  if (def.kind === 'component') {
    // Render specs are declarative data; nothing executable to sandbox.
    return { ok: true, kind: 'component' };
  }

  // action
  if (typeof def.reduce !== 'string') {
    // A core action with no reduce body (behaviour lives in the runtime) — nothing to verify.
    return { ok: true, kind: 'action', native: true };
  }

  const state = sample.state ?? {};
  const args = sample.args ?? {};

  let first, second;
  try {
    first = runInSandbox(def.reduce, state, args);
  } catch (err) {
    throw new Error(`primitive ${def.id} failed verification: reducer threw (${err.message})`);
  }
  try {
    second = runInSandbox(def.reduce, state, args);
  } catch (err) {
    throw new Error(`primitive ${def.id} failed verification: reducer threw on re-run (${err.message})`);
  }

  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error(`primitive ${def.id} failed verification: reducer must return a partial-state object`);
  }
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`primitive ${def.id} failed verification: reducer is not deterministic`);
  }

  return { ok: true, kind: 'action', verified: true };
}

module.exports = { verifyPrimitive, TIMEOUT_MS };

'use strict';

// Seeds the registry with the primitives AtomOS already ships, derived straight from the
// existing schema so there is no duplicated list to drift. Core primitives carry no reduce
// body or field spec — their behaviour and bespoke validation stay where they are. What the
// registry adds is a single place that knows *which* primitives exist, so synthesized ones can
// join the same set and be treated identically.

const { APP_SCHEMA, ACTION_TYPES } = require('./app-schema');
const { createRegistry } = require('../public/registry');
const store = require('./primitive-store');

function componentTypeEnum() {
  // Walk the schema to find the component type enum without hardcoding it here.
  const comps = APP_SCHEMA?.properties?.components;
  const props = comps?.items?.properties || {};
  const typeEnum = props.type?.enum;
  return Array.isArray(typeEnum) ? typeEnum : [];
}

function buildCoreDefs() {
  const defs = [];
  for (const id of componentTypeEnum()) defs.push({ id, kind: 'component', provenance: 'core' });
  for (const id of ACTION_TYPES) defs.push({ id, kind: 'action', provenance: 'core' });
  return defs;
}

let shared = null;

// The shared registry: core primitives + any trusted synthesized primitives loaded from the
// store. Built once and reused.
function getRegistry() {
  if (shared) return shared;
  shared = createRegistry(buildCoreDefs());
  for (const def of store.loadTrusted()) {
    try { shared.register(def); } catch { /* skip a corrupt stored def rather than fail boot */ }
  }
  return shared;
}

module.exports = { getRegistry, buildCoreDefs, componentTypeEnum };

'use strict';

// The "synthesize" step of the self-extension loop.
//
// When the architect needs a primitive the registry lacks, buildPrimitive asks the model to
// emit a Primitive Definition (data + a pure reduce body), then runs it through the local
// sandbox verification gate BEFORE returning it. Nothing that fails verification is ever
// handed back, so a caller can trust the result enough to register it.
//
// This mirrors buildApp in app-platform.js: it needs OPENAI_API_KEY to reach the model, but
// the verification it performs is entirely local and deterministic.

const { verifyPrimitive } = require('./verify-primitive');
const { validateDefinitionShape } = require('../public/registry');

const PRIMITIVE_INSTRUCTIONS = [
  'You are the AtomOS primitive synthesizer. Return only one JSON Primitive Definition, nothing else.',
  'A definition has: id (lowercase identifier), kind ("component" or "action"), provenance "synthesized", and fields.',
  'fields maps each field name to {type, required?, literal?}. type is one of state-key, string, number, boolean, list, any.',
  'Mark a field type "state-key" when its value must name an existing state key. Mark it literal:true when it is a value, never a state key.',
  'For kind "action", also include reduce: the body of a pure function (state, args) that returns a partial-state object, e.g. "return { [args.target]: Number(state[args.target]||0) + 1 };".',
  'The reduce body must be pure and deterministic: no require, no process, no console, no timers, no network, no Math.random, no Date. It may only read state and args and return an object.',
  'For kind "component", include render: a small declarative view spec, and no reduce.'
].join(' ');

async function callModel(gapDescription) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured on Render');
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, instructions: PRIMITIVE_INSTRUCTIONS, input: `NEEDED PRIMITIVE:\n${gapDescription}` })
  });
  if (!response.ok) throw new Error(`primitive synthesis failed: HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.output_text === 'string') return data.output_text;
  for (const item of data.output || []) for (const part of item.content || []) if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
  return '';
}

function parseDefinition(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  let def;
  try { def = JSON.parse(trimmed); } catch { throw new Error('synthesizer did not return valid JSON'); }
  return def;
}

// Sample inputs used to exercise a synthesized reducer during verification. A caller with a
// concrete gap can pass a better sample (real state keys / args) for a stronger smoke test.
function defaultSample(def) {
  const state = {}, args = {};
  for (const [name, spec] of Object.entries(def.fields || {})) {
    if (spec.type === 'state-key') { state[`${name}Key`] = 0; args[name] = `${name}Key`; }
    else if (spec.type === 'number') args[name] = 1;
    else if (spec.type === 'list') args[name] = [];
    else if (spec.type === 'boolean') args[name] = false;
    else args[name] = 'x';
  }
  return { state, args };
}

async function buildPrimitive(gapDescription, sample) {
  const def = parseDefinition(await callModel(gapDescription));
  validateDefinitionShape(def);
  if (def.provenance !== 'synthesized') def.provenance = 'synthesized';
  if (!def.status) def.status = 'candidate';
  // Local, deterministic gate. Throws if the definition is impure, non-deterministic, unsafe,
  // or malformed — so only trustworthy primitives are ever returned.
  verifyPrimitive(def, sample || defaultSample(def));
  return def;
}

// Convenience: ensure a registry has a primitive, synthesizing + verifying + registering it if
// missing. Returns the definition. (Persistence to the knowledge DB is layered on by the caller.)
async function ensurePrimitive(registry, id, gapDescription, sample) {
  if (registry.has(id)) return registry.get(id);
  const def = await buildPrimitive(gapDescription, sample);
  if (def.id !== id) def.id = id;
  registry.register(def);
  return def;
}

module.exports = { buildPrimitive, ensurePrimitive, parseDefinition, PRIMITIVE_INSTRUCTIONS };

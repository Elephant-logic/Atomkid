'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../public/game-engine.js');

// A scene in Studio writes entities back to state each frame, and every re-render
// recreates the world from that state and starts a new loop. This test proves that
// splitting a run across a re-mount produces the exact same trajectory as running it
// straight through — so a re-render mid-play cannot corrupt or speed up the game.

const config = {
  gravity: 700,
  bounds: { x: 0, y: 0, width: 960, height: 480 },
  map: { cols: 10, rows: 5, tileWidth: 32, tileHeight: 32,
    tiles: [0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0, 1,1,1,1,1,1,1,1,1,1],
    solidTiles: [1] },
  entities: [{ id: 'player', x: 32, y: 32, width: 28, height: 28, vx: 0, vy: 0, speed: 150, jumpSpeed: 330, friction: 0.08,
    controls: { left: 'ArrowLeft', right: 'ArrowRight', jump: ' ' } }],
  camera: { follow: 'player', viewport: { width: 640, height: 360 } }
};

const dt = 16; // ~60fps frame
const input = { ArrowRight: true };

function runStraight(steps) {
  let world = engine.createWorld(structuredClone(config));
  for (let i = 0; i < steps; i++) world = engine.stepWorld(world, dt, input);
  return world.entities[0];
}

function runWithRemount(steps, remountAt) {
  let world = engine.createWorld(structuredClone(config));
  for (let i = 0; i < steps; i++) {
    if (i === remountAt) {
      // simulate a Studio re-render: entities are read back from state and the world is rebuilt
      world = engine.createWorld({ ...structuredClone(config), entities: world.entities.map(e => ({ ...e })) });
    }
    world = engine.stepWorld(world, dt, input);
  }
  return world.entities[0];
}

test('a re-render mid-play preserves the exact trajectory', () => {
  const straight = runStraight(40);
  const remounted = runWithRemount(40, 20);
  assert.ok(Math.abs(straight.x - remounted.x) < 1e-9, `x drift: ${straight.x} vs ${remounted.x}`);
  assert.ok(Math.abs(straight.y - remounted.y) < 1e-9, `y drift: ${straight.y} vs ${remounted.y}`);
  assert.ok(Math.abs(straight.vx - remounted.vx) < 1e-9, `vx drift`);
});

test('the player actually moves and lands on the solid floor', () => {
  const end = runStraight(120);
  assert.ok(end.x > 32, 'player should have moved right');
  assert.equal(end.grounded, true, 'player should be resting on the tile floor');
});

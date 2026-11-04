import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_BOUNDS, OBSTACLES, isWalkable, findPath } from '../src/navigation.js';

const initial = { x: 1.5, z: 1.6 };
const destinations = {
  center: { x: 0, z: 1.65 },
  window: { x: -3, z: -0.5 },
  plant: { x: 2.15, z: -1.6 },
  sofa: { x: -0.85, z: -1.25 },
  user: { x: 0.6, z: 2.25 },
};

function assertSafePath(start, end, path) {
  assert.ok(Array.isArray(path), 'destination must be reachable');
  assert.ok(path.length > 0);
  assert.deepEqual(path.at(-1), end, 'path must finish at the exact requested point');
  assert.notDeepEqual(path[0], start, 'the start is not a waypoint');
  let previous = start;
  for (const point of path) {
    // Independently sample the actual movement segments, including shortcuts.
    // Independently check the ordinary turning corridor, with a numeric margin.
    const steps = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.z - previous.z) / 0.005));
    for (let i = 0; i <= steps; i += 1) {
      const sample = {
        x: previous.x + (point.x - previous.x) * i / steps,
        z: previous.z + (point.z - previous.z) * i / steps,
      };
      assert.ok(sample.x >= NAV_BOUNDS.minX && sample.x <= NAV_BOUNDS.maxX);
      assert.ok(sample.z >= NAV_BOUNDS.minZ && sample.z <= NAV_BOUNDS.maxZ);
      for (const rect of OBSTACLES) {
        const clearance = rect.name === 'coffeeTable' ? 0.59 : 0.22;
        const inside = sample.x >= rect.minX - clearance && sample.x <= rect.maxX + clearance
          && sample.z >= rect.minZ - clearance && sample.z <= rect.maxZ + clearance;
        assert.equal(inside, false, `segment intersects ${rect.name} or its body clearance`);
      }
    }
    previous = point;
  }
}

test('the initial position can reach every semantic destination without furniture collisions', () => {
  for (const end of Object.values(destinations)) assertSafePath(initial, end, findPath(initial, end));
});

test('all semantic destinations can reach each other, including leaving the sofa approach', () => {
  for (const [name, start] of Object.entries(destinations)) {
    for (const [otherName, end] of Object.entries(destinations)) {
      if (name !== otherName) assertSafePath(start, end, findPath(start, end));
    }
  }
});

test('a diagonal route around the coffee table cannot cut through corners during simplification', () => {
  const start = { x: -1.6, z: -0.75 };
  const end = { x: 1.6, z: 1.75 };
  const path = findPath(start, end);
  assert.ok(path.length > 1, 'a direct diagonal intersects the table');
  assertSafePath(start, end, path);
});

test('invalid targets, furniture interiors and body-clearance areas are rejected', () => {
  const invalid = [
    null, {}, { x: NaN, z: 0 }, { x: 0, z: Infinity }, { x: '0', z: 2 },
    { x: 3.66, z: 2 }, { x: -3.66, z: 2 }, { x: 0, z: 2.86 },
    { x: 0, z: -2.86 }, { x: 0, z: 0.5 }, { x: 0, z: 1.1 },
    { x: -0.85, z: -2.1 }, { x: 3.1, z: -2.4 }, { x: 3.2, z: 0 },
  ];
  for (const end of invalid) {
    assert.equal(isWalkable(end), false);
    assert.equal(findPath(initial, end), null);
  }
  assert.equal(findPath({ x: -0.85, z: -2.1 }, initial), null,
    'a seated character must exit to the sofa approach before navigating');
});

test('an unobstructed route is one exact waypoint; an already-reached destination needs no movement', () => {
  assert.deepEqual(findPath(initial, destinations.center), [destinations.center]);
  assert.deepEqual(findPath(initial, initial), []);
});

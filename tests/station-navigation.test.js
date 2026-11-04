import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAvatar } from '../src/avatar.js';
import { createRoomActivities } from '../src/room-activities.js';
import { findPath, isWalkable, OBSTACLES } from '../src/navigation.js';
import { stepRoute, createPostureMotion, samplePosture } from '../src/motion.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';

const origins = {
  initial: { x: 1.5, z: 1.6 }, center: { x: 0, z: 1.65 }, window: { x: -3, z: -.5 },
  plant: { x: 2.15, z: -1.6 }, sofa: { x: -.85, z: -1.25 }, user: { x: .6, z: 2.25 },
};
const stations = createRoomActivities(new THREE.Scene()).stations;
const floorPoint = ({ x, z }) => ({ x, z });
const staging = (station) => ({ x: station.x, z: 1.62 });
function walk(start, end, options = {}) {
  const path = findPath(start, end, options);
  assert.ok(Array.isArray(path), `route ${JSON.stringify(start)} -> ${JSON.stringify(end)} is reachable`);
  let motion = { position: start, path, yaw: options.facingYaw ?? 0, speed: 0, index: 0 };
  for (let frame = 0; frame < 3600 && !motion.done; frame++) {
    motion = { ...stepRoute(motion, 1 / 60, options), path };
    assert.ok(isWalkable(motion.position, options));
    // An independent exclusion rectangle catches collision errors even if the
    // planner and its public point predicate accidentally share the same bug.
    for (const obstacle of OBSTACLES) {
      const margin = obstacle.name === 'coffeeTable' && options.clearance !== 'body' ? .59 : .22;
      const inside = motion.position.x >= obstacle.minX - margin && motion.position.x <= obstacle.maxX + margin
        && motion.position.z >= obstacle.minZ - margin && motion.position.z <= obstacle.maxZ + margin;
      assert.equal(inside, false, `body/turning clearance intersects ${obstacle.name}`);
    }
  }
  assert.equal(motion.done, true, 'route cannot deadlock while aligning with the station');
  assert.deepEqual(motion.position, end);
  assert.equal(motion.speed, 0);
}

const stationOptions = { clearance: 'body', facingYaw: Math.PI, maxSpeed: .22 };
test('all old destinations reach both real stations and return through safe turning positions', () => {
  for (const station of Object.values(stations)) {
    const point = floorPoint(station), stage = staging(station);
    assert.equal(isWalkable(point), false, 'generic clicks must not enter the long-hair turning zone');
    assert.equal(isWalkable(point, { clearance: 'body' }), true);
    assert.deepEqual(findPath(point, point, { clearance: 'body' }), []);
    for (const origin of Object.values(origins)) {
      assert.equal(findPath(origin, point), null, 'only explicit activity movement can enter a station');
      walk(origin, stage); walk(stage, point, stationOptions);
      walk(point, stage, stationOptions); walk(stage, origin);
    }
  }
  for (const [name, station] of Object.entries(stations)) {
    const other = stations[name === 'read' ? 'drink' : 'read'];
    walk(floorPoint(station), staging(station), stationOptions);
    walk(staging(station), staging(other));
    walk(staging(other), floorPoint(other), stationOptions);
  }
});

test('the real calibrated seat exits through the approach before either station and returns by the seated transition', { skip: localModelSkip }, async () => {
  const previous = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async () => loadLocalVrmFixture();
  let avatar;
  try { avatar = await createAvatar(new THREE.Scene()); }
  finally { GLTFLoader.prototype.loadAsync = previous; }
  try {
    const seat = { x: -.85, z: -1.60 - avatar.thighLength };
    assert.equal(isWalkable(seat, { clearance: 'body' }), false);
    for (const station of Object.values(stations)) {
      assert.equal(findPath(seat, floorPoint(station), { clearance: 'body' }), null);
      const rise = createPostureMotion({ from: 1, to: 0, fromPosition: seat, toPosition: origins.sofa, fromYaw: 0 });
      const stood = samplePosture(rise, 3);
      assert.equal(stood.done, true); assert.equal(stood.blend, 0);
      walk(stood.position, staging(station)); walk(staging(station), floorPoint(station), stationOptions);
      walk(floorPoint(station), staging(station), stationOptions); walk(staging(station), origins.sofa);
      const sit = createPostureMotion({ from: 0, to: 1, fromPosition: origins.sofa, toPosition: seat, fromYaw: Math.PI });
      const seated = samplePosture(sit, 3);
      assert.equal(seated.done, true); assert.equal(seated.blend, 1); assert.deepEqual(seated.position, seat);
    }
  } finally { avatar.dispose(); }
});

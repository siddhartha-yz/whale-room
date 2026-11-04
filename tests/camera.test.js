import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainRoomCamera, sampleCameraOrbit } from '../src/camera.js';

const radius = 2.553;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('reading camera follows the sofa without passing behind the back wall', () => {
  const target = { x: -.85, y: .8, z: -1.71 };
  const outside = { x: -1.57, y: 1.12, z: -4.16 };
  const safe = constrainRoomCamera(outside, target);
  assert.ok(safe.z >= -3.04);
  assert.ok(safe.x >= -3.42);
  assert.ok(Math.abs(distance(safe, target) - distance(outside, target)) < 1e-8);
  assert.equal(safe.y, outside.y);
});

test('close camera preserves the orbit and remains inside both solid walls across room positions', () => {
  for (const x of [-3, -.85, -.36, .29, 2.15]) for (const z of [-2.45, -1.71, -.5, 1.25, 2.25]) {
    const target = { x, y: .95, z };
    for (let angle = -Math.PI; angle < Math.PI; angle += Math.PI / 24) {
      const desired = { x: x + radius * Math.sin(angle), y: 1.27, z: z + radius * Math.cos(angle) };
      const safe = constrainRoomCamera(desired, target);
      assert.ok(safe.x >= -3.42 && safe.z >= -3.04);
      assert.ok(Math.abs(distance(safe, target) - distance(desired, target)) < 1e-8);
      if (desired.x >= -3.42 && desired.z >= -3.04 && angle >= -Math.PI/2 && angle <= Math.PI/2) assert.ok(distance(safe, desired) < 1e-8);
    }
  }
});

test('reframing follows a continuous legal arc rather than jumping between wall boundaries', () => {
  const point = (target, angle) => ({ x: target.x + radius*Math.sin(angle), y: target.y+.32, z: target.z + radius*Math.cos(angle) });
  for (const [target, start, end] of [[{x:-.85,y:1,z:-1.71},-2,2], [{x:-3,y:1,z:-.5},1.2,-2.27]]) {
    const from=constrainRoomCamera(point(target,start),target),to=point(target,end);
    const motion={from,to,fromTarget:target,toTarget:target};
    let previous=from;
    for(let frame=0;frame<=120;frame++){
      const sample=sampleCameraOrbit(motion,frame/120);
      assert.ok(sample.position.x>=-3.42-1e-8&&sample.position.z>=-3.04-1e-8);
      assert.ok(distance(sample.position,previous)<.12, 'no multi-metre camera boundary jump');
      assert.ok(distance(sample.position,target)>2.5);
      previous=sample.position;
    }
  }
});

test('a half-turn reframe maintains subject distance rather than cutting through the head', () => {
  const target = { x: -.85, y: .8, z: -1.71 };
  const motion = { from: { x: -.85, y: 1.12, z: -4.263 }, to: { x: -.85, y: 1.12, z: .843 }, fromTarget: target, toTarget: target };
  for (let frame = 0; frame <= 120; frame++) {
    const sample = sampleCameraOrbit(motion, frame / 120);
    const safe = constrainRoomCamera(sample.position, sample.target);
    assert.ok(distance(safe, target) > 2.5);
    assert.ok(safe.z >= -3.04 && safe.x >= -3.42);
  }
  assert.deepEqual(sampleCameraOrbit(motion, 0).target, target);
  assert.ok(distance(sampleCameraOrbit(motion, 1).position, motion.to) < 1e-8);
});

test('changing orbit radius does not switch between equivalent angle branches', () => {
  const motions = [
    { from: { x: 7.2, y: 5.2, z: 9.7 }, to: { x: 2.0886400655730477, y: .9791798373749434, z: -4.152867986882033 },
      fromTarget: { x: -.15, y: .75, z: -.2 }, toTarget: { x: 2.15, y: .6591798373749433, z: -1.6 } },
    { from: { x: 1.648639024906909, y: .9791798373749434, z: -3.04 }, to: { x: -1.9515284963613548, y: .9791798373749434, z: .026705268547270844 },
      fromTarget: { x: .29, y: .6591798373749433, z: 1.25 }, toTarget: { x: .29, y: .6591798373749433, z: 1.25 } },
  ];
  for (const motion of motions) {
    let previous = motion.from;
    for (let frame = 0; frame <= 240; frame++) {
      const t = frame / 240, sample = sampleCameraOrbit(motion, t*t*(3-2*t));
      assert.ok(Object.values(sample.position).every(Number.isFinite));
      assert.ok(sample.position.x >= -3.42-1e-8 && sample.position.z >= -3.04-1e-8);
      assert.ok(distance(sample.position, sample.target) > 2.5);
      assert.ok(distance(sample.position, previous) < .17, 'previous projection jumped 7–10 metres in these transitions');
      previous = sample.position;
    }
  }
});

test('a moving target preserves the initially chosen branch for the whole transition', () => {
  const base = {
    from: { x: -.13, y: 1.3228753834314138, z: .7403617901456854 },
    to: { x: -2.1795732554293044, y: 1.3228753834314138, z: -3.8898067717887175 },
    fromTarget: { x: -.85, y: 1.0028753834314137, z: -1.7096382098543148 },
    toTarget: { x: -.85, y: 1.0028753834314137, z: -1.7096382098543148 },
  };
  const motion = structuredClone(base);
  let previous = motion.from;
  for (let frame = 0; frame <= 120; frame++) {
    const t = frame / 120;
    // Main translates the same tween object, rather than creating a new orbit.
    for (const key of ['from', 'to', 'fromTarget', 'toTarget']) motion[key].x = base[key].x - .4*t;
    const sample = sampleCameraOrbit(motion, t*t*(3-2*t));
    assert.ok(sample.position.x >= -3.42-1e-8 && sample.position.z >= -3.04-1e-8);
    assert.ok(distance(sample.position, sample.target) > 2.5);
    assert.ok(distance(sample.position, previous) < .15, 'reselecting the branch on every frame jumps 5.10 metres');
    previous = sample.position;
  }
});

test('a wall constraint becoming inactive does not accelerate an otherwise legal orbit', () => {
  const motion = {
    from: { x: 7.2, y: 5.2, z: 9.7 }, to: { x: -.421359934426952, y: .9791798373749434, z: -1.302867986882032 },
    fromTarget: { x: -.15, y: .75, z: -.2 }, toTarget: { x: -.36, y: .6591798373749433, z: 1.25 },
  };
  let previous = motion.from;
  for (let frame = 0; frame <= 600; frame++) {
    const t = frame / 600, sample = sampleCameraOrbit(motion, t*t*(3-2*t));
    assert.ok(distance(sample.position, previous) < .1, 'clamping moving endpoints caused a .339 metre step here');
    previous = sample.position;
  }
});

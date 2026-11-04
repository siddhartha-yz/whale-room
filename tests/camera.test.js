import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainRoomCamera, sampleCameraOrbit, resolveCameraOcclusion } from '../src/camera.js';

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

const furniture = [
  { name:'sofaBack', minX:-2.4, maxX:.8, minY:.43, maxY:1.09, minZ:-2.84, maxZ:-2.60 },
  { name:'sofaRight', minX:.69, maxX:.91, minY:.235, maxY:.805, minZ:-2.80, maxZ:-1.70 },
  { name:'sofaLeft', minX:-2.51, maxX:-2.29, minY:.235, maxY:.805, minZ:-2.80, maxZ:-1.70 },
  { name:'sofaSeat', minX:-2.36, maxX:.76, minY:.32, maxY:.5, minZ:-2.615, maxZ:-1.705 },
  { name:'table', minX:-.825, maxX:.825, minY:.3825, maxY:.4675, minZ:0, maxZ:1 },
  { name:'cabinetTop', minX:3, maxX:3.8, minY:.9075, maxY:.9725, minZ:-1.65, maxZ:.75 },
  { name:'cabinetBody', minX:3.08, maxX:3.76, minY:.045, maxY:.895, minZ:-1.575, maxZ:.675 },
];

function assertSightClear(target, position, boxes = furniture, padding = .099) {
  const steps = Math.max(1, Math.ceil(distance(target, position) / .002));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const point = { x:target.x+(position.x-target.x)*t, y:target.y+(position.y-target.y)*t, z:target.z+(position.z-target.z)*t };
    for (const box of boxes) {
      const inside = point.x >= box.minX-padding && point.x <= box.maxX+padding
        && point.y >= box.minY-padding && point.y <= box.maxY+padding
        && point.z >= box.minZ-padding && point.z <= box.maxZ+padding;
      assert.equal(inside, false, `${box.name} obstructs the corrected camera ray`);
    }
  }
}

test('furniture correction is an exact no-op for a clear intended orbit', () => {
  const target={x:1.5,y:.66,z:1.6}, desired={x:2.912,y:.979,z:3.728};
  const result=resolveCameraOcclusion(desired,target,furniture);
  assert.deepEqual(result.position,desired);
  assert.equal(result.mode,'clear');
  assert.equal(result.fraction,1);
});

test('a sofa-arm obstruction is cleared by elevation while preserving subject distance', () => {
  const target={x:2.15,y:.66,z:-1.9}, desired={x:-.35,y:.98,z:-1.9};
  const result=resolveCameraOcclusion(desired,target,furniture);
  assert.equal(result.occluded,true);
  assert.equal(result.mode,'lifted');
  assert.ok(result.lift>0&&result.lift<=.65);
  assert.ok(Math.abs(distance(target,result.position)-distance(target,desired))<1e-8);
  assertSightClear(target,result.position);
});

test('a tall occluder compresses the spring arm before the near-plane clearance', () => {
  const target={x:0,y:1,z:2}, desired={x:0,y:1.32,z:-.8};
  const boxes=[{name:'tall',minX:-1,maxX:1,minY:0,maxY:3,minZ:.1,maxZ:.3}];
  const result=resolveCameraOcclusion(desired,target,boxes);
  assert.equal(result.mode,'compressed');
  assert.ok(result.fraction>0&&result.fraction<1);
  assert.ok(result.distance>1.4,'fallback retains as much arm length as the obstruction permits');
  assertSightClear(target,result.position,boxes);
});

test('correction catches immediately but releases smoothly and reaches the exact desired position', () => {
  const target={x:0,y:1,z:2}, desired={x:0,y:1.32,z:-.8};
  const boxes=[{name:'tall',minX:-1,maxX:1,minY:0,maxY:3,minZ:.1,maxZ:.3}];
  let state=resolveCameraOcclusion(desired,target,boxes);
  const blockedDistance=state.distance;
  state=resolveCameraOcclusion(desired,target,[],{previous:state});
  assert.ok(state.distance>blockedDistance&&state.distance<distance(target,desired));
  let previous=state.position;
  for(let frame=0;frame<180;frame++){
    state=resolveCameraOcclusion(desired,target,[],{previous:state});
    assert.ok(distance(state.position,previous)<.15,'release must not snap to the original orbit');
    previous=state.position;
  }
  assert.deepEqual(state.position,desired);
});

test('following the sofa side remains clear, bounded and continuous once avoiding the arm', () => {
  let state=null, previous=null;
  for(let frame=0;frame<=120;frame++){
    const target={x:2.15,y:.66,z:-1.9+.15*frame/120};
    const desired={x:target.x-2.5,y:target.y+.32,z:target.z};
    state=resolveCameraOcclusion(desired,target,furniture,{previous:state});
    assertSightClear(target,state.position);
    assert.ok(state.position.x>=-3.42&&state.position.z>=-3.04);
    assert.ok(state.distance>2.5,'ordinary sofa avoidance should not zoom into the face');
    if(previous)assert.ok(distance(state.position,previous)<.035,'avoid elevation quantisation steps');
    previous=state.position;
  }
});

test('very near a sofa arm the limited elevation falls back to a safe shortened arm', () => {
  const target={x:1.3,y:.66,z:-1.9}, desired={x:-1.2,y:.98,z:-1.9};
  const result=resolveCameraOcclusion(desired,target,furniture);
  assert.equal(result.mode,'compressed');
  assert.ok(result.distance>0&&result.distance<1);
  assertSightClear(target,result.position);
});

test('room-wide close-camera samples keep padded sight lines clear and respect wall limits', () => {
  const targets=[{x:0,y:.66,z:1.65},{x:-3,y:.66,z:-.5},{x:2.15,y:.66,z:-1.6},
    {x:-.85,y:1.003,z:-1.71},{x:.6,y:.66,z:2.25}];
  for(const target of targets)for(let step=0;step<48;step++){
    const angle=step/48*Math.PI*2;
    const desired={x:target.x+2.553*Math.sin(angle),y:target.y+.32,z:target.z+2.553*Math.cos(angle)};
    const result=resolveCameraOcclusion(desired,target,furniture);
    assert.notEqual(result.mode,'blocked');
    assert.ok(result.position.x>=-3.42-1e-8&&result.position.z>=-3.04-1e-8);
    assert.ok(Object.values(result.position).every(Number.isFinite));
    assertSightClear(target,result.position);
  }
});

test('a target inside a furniture collider is reported rather than producing NaN or an accidental zero-length arm', () => {
  const target={x:0,y:.7,z:-2.7}, desired={x:0,y:1.1,z:-1};
  const result=resolveCameraOcclusion(desired,target,furniture);
  assert.equal(result.mode,'blocked');
  assert.ok(result.distance>0);
  assert.ok(Object.values(result.position).every(Number.isFinite));
});

const closeHorizontal = Math.hypot(.72, 2.45);
const closeOrbit = (target, yaw) => ({ x:target.x+closeHorizontal*Math.sin(yaw),
  y:target.y+.32, z:target.z+closeHorizontal*Math.cos(yaw) });
function assertFramed(result, target) {
  assert.equal(result.framingUnresolved,false);
  assert.ok(result.distance>=1.1-1e-8,'minimum framing must not put the camera inside the head');
  assert.ok(result.position.x>=-3.42-1e-8&&result.position.z>=-3.04-1e-8);
  assertSightClear(target,result.position);
}

test('opting into framing is still an exact no-op for an unobstructed camera', () => {
  const target={x:1.5,y:.66,z:1.6}, desired={x:2.912,y:.979,z:3.728};
  const result=resolveCameraOcclusion(desired,target,furniture,{minimumFramingDistance:1.1});
  assert.deepEqual(result.position,desired);
  assert.equal(result.framingFallback,false);
  assert.equal(result.framingJump,false);
});

test('the reproduced sofa drag stops at its visible corridor and naturally releases', () => {
  const target={x:1.29,y:.66,z:-1.91};
  assert.ok(resolveCameraOcclusion(closeOrbit(target,-Math.PI/2),target,furniture).distance<.3,
    'this is the real near-arm head-entry regression');
  let previous=null, avoided=false;
  for(let frame=0;frame<=480;frame++){
    const yaw=frame<120?-Math.PI/2*frame/120:frame<240?-Math.PI/2
      :frame<360?-Math.PI/2*(360-frame)/120:0;
    const desired=closeOrbit(target,yaw), original={...desired};
    const result=resolveCameraOcclusion(desired,target,furniture,{previous,minimumFramingDistance:1.1});
    assertFramed(result,target);
    assert.deepEqual(desired,original,'the intended orbit must not be mutated');
    assert.equal(result.framingJump,false);
    if(previous)assert.ok(distance(result.position,previous.position)<.05,'drag clamping must not snap');
    avoided ||= result.framingFallback;
    previous=result;
  }
  assert.equal(avoided,true);
  assert.equal(previous.framingFallback,false);
  assert.deepEqual(previous.position,closeOrbit(target,0));
});

test('an already unsafe initial orbit uses one explicit safe framing fallback', () => {
  const target={x:1.29,y:.66,z:-1.91}, desired=closeOrbit(target,-Math.PI/2);
  let result=resolveCameraOcclusion(desired,target,furniture,{minimumFramingDistance:1.1});
  assertFramed(result,target);
  assert.equal(result.framingJump,true);
  assert.equal(result.framingReason,'initial-unsafe-ray');
  for(let frame=0;frame<60;frame++){
    const next=resolveCameraOcclusion(desired,target,furniture,{previous:result,minimumFramingDistance:1.1});
    assertFramed(next,target);
    assert.equal(next.framingJump,false);
    assert.ok(distance(next.position,result.position)<.05);
    result=next;
  }
});

test('a clear opposite endpoint cannot pull the camera through the cabinet sector between them', () => {
  const target={x:2.65,y:.66,z:-.4},destination=closeOrbit(target,Math.PI);
  assert.equal(resolveCameraOcclusion(destination,target,furniture).mode,'clear');
  let previous=resolveCameraOcclusion(closeOrbit(target,0),target,furniture,{minimumFramingDistance:1.1});
  for(let frame=0;frame<180;frame++){
    const result=resolveCameraOcclusion(destination,target,furniture,{previous,minimumFramingDistance:1.1});
    assertFramed(result,target);
    assert.ok(result.framingAngle<Math.PI/2,'retain the front corridor instead of crossing the blocked east sector');
    assert.ok(distance(result.position,previous.position)<.09);
    assert.equal(result.framingJump,false);
    previous=result;
  }
  assert.equal(previous.framingFallback,true);
});

test('walking along the cabinet keeps one corridor instead of flipping to its opposite side', () => {
  let previous=null;
  for(let frame=0;frame<=450;frame++){
    const target={x:2.65,y:.66,z:1.1-3*frame/450};
    const result=resolveCameraOcclusion(closeOrbit(target,Math.PI/2),target,furniture,
      {previous,minimumFramingDistance:1.1});
    assertFramed(result,target);
    assert.equal(result.framingJump,false);
    if(previous){
      assert.ok(distance(result.position,previous.position)<.08,'cabinet corners must not change elevation or radius abruptly');
      assert.ok(Math.abs(result.framingAngle-previous.framingAngle)<.06,'do not flip angular corridors');
    }
    previous=result;
  }
});

test('walking directly toward the sofa preserves framing and reports its one forced boundary correction', () => {
  let previous=null,jumps=0;
  for(let frame=0;frame<=152;frame++){
    const target={x:2.15-1.01*frame/152,y:.66,z:-1.9};
    const result=resolveCameraOcclusion(closeOrbit(target,-Math.PI/2),target,furniture,
      {previous,minimumFramingDistance:1.1});
    assertFramed(result,target);
    if(previous){
      const step=distance(result.position,previous.position);
      assert.ok(step<.3,'the forced correction remains bounded');
      if(step>.25)assert.equal(result.framingJump,true,'a visible forced correction must be observable');
    }
    if(result.framingJump){jumps++;assert.equal(result.framingReason,'corridor-became-blocked');}
    previous=result;
  }
  assert.equal(jumps,1);
});

test('a requested zoom inside the framing floor is kept out of the head', () => {
  const target={x:1.5,y:.66,z:1.6};
  const result=resolveCameraOcclusion({x:1.5,y:.7,z:1.8},target,furniture,{minimumFramingDistance:1.1});
  assertFramed(result,target);
});

test('an enclosed target reports that safe framing is impossible without claiming a clear ray', () => {
  const target={x:0,y:.7,z:-2.7},desired={x:0,y:1.1,z:-1};
  const result=resolveCameraOcclusion(desired,target,furniture,{minimumFramingDistance:1.1});
  assert.equal(result.framingUnresolved,true);
  assert.equal(result.framingReason,'no-safe-framing-ray');
  assert.equal(result.mode,'blocked');
  assert.ok(result.distance>=1.1);
});

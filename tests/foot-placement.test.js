import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAvatar } from '../src/avatar.js';
import { createFootPlacement } from '../src/foot-placement.js';
import { stepRoute } from '../src/motion.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';

async function fixture() {
  const original = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async () => loadLocalVrmFixture();
  try { return await createAvatar(new THREE.Scene()); }
  finally { GLTFLoader.prototype.loadAsync = original; }
}
function soleVertices(avatar) {
  const result = [], point = new THREE.Vector3();
  for (const side of ['left', 'right']) {
    const bones = ['Foot', 'Toes'].map(n => avatar.vrm.humanoid.getRawBoneNode(side + n));
    avatar.vrm.scene.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return;
      const indices = bones.map(b => mesh.skeleton.bones.indexOf(b)), joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
      const candidates = [];
      for (let vertex = 0; vertex < joints.count; vertex++) {
        let weight = 0;
        for (let c = 0; c < 4; c++) if (indices.includes(joints.getComponent(vertex, c))) weight += weights.getComponent(vertex, c);
        if (weight > .5) {
          mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld);
          candidates.push({ mesh, vertex, y: point.y });
        }
      }
      if (!candidates.length) return;
      const bottom = Math.min(...candidates.map(c => c.y));
      result.push(...candidates.filter(c => c.y < bottom + .012));
    });
  }
  return result;
}
function penetration(vertices, ground) {
  let depth = 0; const point = new THREE.Vector3();
  for (const {mesh, vertex} of vertices) {
    mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld);
    depth = Math.max(depth, ground(point.x, point.z) - point.y);
  }
  return depth;
}

test('unsupported skeleton retains the original gait rather than applying chibi dimensions', () => {
  const result = createFootPlacement({ scene: new THREE.Group(), humanoid: { getNormalizedBoneNode: () => null } }, new THREE.Group());
  assert.equal(result.supported, false); assert.equal(result.update(.016).weight, 0);
});

test('real chibi support feet remain planted through acceleration, braking, backwards steps and a corner', { skip: localModelSkip }, async t => {
  const summaries = [];
  for (const dt of [1/60, 1/30, .05]) for (const kind of ['straight', 'backward', 'corner']) {
    const avatar = await fixture(), vertices = soleVertices(avatar), ground = () => .0025;
    let state = {position:{x:2.4,z:-2},path:kind === 'corner' ? [{x:2.4,z:-1},{x:1.4,z:-1}] : [{x:2.4,z:kind === 'backward' ? -3.5 : 3}],index:0,yaw:0,speed:0};
    avatar.root.position.set(2.4,0,-2); avatar.update(dt); let previous = null;
    let maxSlide = 0, maxPenetration = 0, maxReachExcess = 0, minKneeForward = Infinity, maxStopGroundSlide = 0;
    for (let frame=0; frame < Math.ceil(8/dt); frame++) {
      const time = frame*dt, next=stepRoute(state,dt,{maxSpeed:kind==='backward'?.22:avatar.preferredWalkSpeed,turnSpeed:avatar.preferredTurnSpeed,stopping:time>=5,...(kind==='backward'?{facingYaw:0}:{})});
      const speed=Math.hypot(next.position.x-state.position.x,next.position.z-state.position.z)/dt; state={...state,...next};
      avatar.root.position.set(next.position.x,0,next.position.z);avatar.root.rotation.y=next.yaw;
      avatar.update(dt,{speed,walkDirection:kind==='backward'?-1:1,groundHeightAt:ground});avatar.root.updateMatrixWorld(true);
      const actual = avatar.getState().footPlacement;
      assert.equal(actual.supported,true);
      const row=actual.feet.map(f=>({...f,toe:avatar.vrm.humanoid.getRawBoneNode(f.side+'Toes').getWorldPosition(new THREE.Vector3())}));
      if(time>.4){
        maxPenetration=Math.max(maxPenetration,penetration(vertices,ground));
        for(let i=0;i<2;i++){
          const f=row[i];maxReachExcess=Math.max(maxReachExcess,f.reachExcess);minKneeForward=Math.min(minKneeForward,f.kneeForward);
          assert.ok(f.position.every(Number.isFinite));
          if(previous?.[i].phase==='support'&&f.phase==='support'&&previous[i].stepId===f.stepId){
            const slide=Math.hypot(f.toe.x-previous[i].toe.x,f.toe.z-previous[i].toe.z);maxSlide=Math.max(maxSlide,slide);
            if(time>=5&&next.done)maxStopGroundSlide=Math.max(maxStopGroundSlide,slide);
          }
        }
      }
      previous=row;
    }
    summaries.push({dt,kind,maxSlide,maxPenetration,maxReachExcess,minKneeForward,maxStopGroundSlide});
    assert.ok(maxSlide<.0015,`${kind} support motion must stay below 1.5mm/frame: ${maxSlide}`);
    assert.ok(maxPenetration<.001,`${kind} real sole must remain above the floor: ${maxPenetration}`);
    assert.ok(maxReachExcess<.0015,`${kind} should not force a stretched leg: ${maxReachExcess}`);
    assert.ok(minKneeForward>=-.0001,'knee must bend toward the front, including backwards walking');
    assert.ok(maxStopGroundSlide<.001);
    avatar.dispose();
  }
  t.diagnostic(JSON.stringify(summaries));
});

test('standing and crossing a raised rug uses real shoe geometry on both floor levels', { skip: localModelSkip }, async t => {
  const avatar=await fixture(),vertices=soleVertices(avatar),ground=(x,z)=>z>-.25&&z<.65?.0285:.0025;
  avatar.root.position.set(2.4,0,-1);let state={position:{x:2.4,z:-1},path:[{x:2.4,z:1.2}],index:0,yaw:0,speed:0};
  let maxPenetration=0,maxExcess=0,maxFootJump=0,previous=null;
  for(let frame=0;frame<12*60;frame++){
    const next=stepRoute(state,1/60,{maxSpeed:avatar.preferredWalkSpeed,turnSpeed:avatar.preferredTurnSpeed});
    const speed=Math.hypot(next.position.x-state.position.x,next.position.z-state.position.z)*60;state={...state,...next};
    avatar.root.position.set(next.position.x,0,next.position.z);avatar.update(1/60,{speed,groundHeightAt:ground});avatar.root.updateMatrixWorld(true);
    const f=avatar.getState().footPlacement;maxExcess=Math.max(maxExcess,...f.feet.map(x=>x.reachExcess));
    if(frame>30)maxPenetration=Math.max(maxPenetration,penetration(vertices,ground));
    const positions=f.feet.map(x=>avatar.vrm.humanoid.getRawBoneNode(x.side+'Foot').getWorldPosition(new THREE.Vector3()));
    if(previous)maxFootJump=Math.max(maxFootJump,...positions.map((p,i)=>p.distanceTo(previous[i])));previous=positions;
  }
  t.diagnostic(JSON.stringify({maxPenetration,maxExcess,maxFootJump}));
  assert.ok(maxPenetration<.002,`shoe must clear the rug edge: ${maxPenetration}`);
  assert.ok(maxExcess<.002,`hip support must adapt to the 26mm level difference: ${maxExcess}`);
  assert.ok(maxFootJump<.025,'the raised surface must not teleport a foot');
});

test('sitting releases foot constraints and standing blends back without a foot snap', {skip:localModelSkip},async t=>{
  const avatar=await fixture();let previous=null,maxJump=0;
  for(let frame=0;frame<10*60;frame++){
    const time=frame/60,sitBlend=time<1?0:time<2?time-1:time<4?1:time<5?5-time:0;
    avatar.update(1/60,{sitBlend});avatar.root.updateMatrixWorld(true);
    const f=avatar.getState().footPlacement;
    if(sitBlend>.001)assert.equal(f.weight,0);
    const positions=['leftFoot','rightFoot'].map(n=>avatar.vrm.humanoid.getRawBoneNode(n).getWorldPosition(new THREE.Vector3()));
    if(previous&&time>4.8)maxJump=Math.max(maxJump,...positions.map((p,i)=>p.distanceTo(previous[i])));previous=positions;
  }
  t.diagnostic(`Maximum final stand/recovery foot frame displacement: ${maxJump}`);
  assert.ok(maxJump<.014);
  assert.equal(avatar.getState().footPlacement.phase,'standing');
});

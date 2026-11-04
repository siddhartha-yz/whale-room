import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAvatar } from '../src/avatar.js';
import { createPostureMotion, samplePosture } from '../src/motion.js';
import { loadLocalVrmFixture, localModelSkip } from './vrm-fixture.js';

// Execute only the current room's furniture constructors without WebGL/canvas.
// This deliberately uses the actual tessellated cushions, including their front
// rounding and the gap between cushions, rather than an invented contact box.
// RoundedBox's tessellated arc is slightly non-convex (about 1mm here), so
// each plane is moved out to contain every mesh vertex. This conservative
// outer solid can over-report contact but cannot hide mesh penetration.
function sofaSolids() {
  const source = readFileSync(new URL('../src/room.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const sofaFabric ='), end = source.indexOf('  const rugSize =');
  assert.ok(start >= 0 && end > start);
  const scene = new THREE.Scene(), material = new THREE.MeshBasicMaterial();
  const box = (w,h,d,m,x,y,z,r=0) => {
    const mesh = new THREE.Mesh(r ? new RoundedBoxGeometry(w,h,d,3,r) : new THREE.BoxGeometry(w,h,d), m);
    mesh.position.set(x,y,z); return mesh;
  };
  const cylinder = (rt,rb,h,m,x,y,z,n=32) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,n), m);
    mesh.position.set(x,y,z); return mesh;
  };
  const sofa = Function('THREE','scene','box','cylinder','fabric','walnut',source.slice(start,end)+'\nreturn sofa;')(
    THREE,scene,box,cylinder,()=>material,material);
  sofa.updateMatrixWorld(true);
  const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3();
  return sofa.children.filter(mesh=>mesh.geometry.type==='RoundedBoxGeometry').map(mesh=>{
    const positions=mesh.geometry.attributes.position, planes=[], seen=new Set();
    for(let i=0;i<positions.count;i+=3){
      a.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions,i+1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions,i+2).applyMatrix4(mesh.matrixWorld);
      const plane=new THREE.Plane().setFromCoplanarPoints(a,b,c);
      if(plane.normal.lengthSq()<.5)continue;
      const key=[...plane.normal,plane.constant].map(x=>x.toFixed(5)).join(',');
      if(!seen.has(key)){seen.add(key);planes.push(plane);}
    }
    const points=Array.from({length:positions.count},(_,i)=>new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld));
    for(const plane of planes){let outside=0;for(const point of points)outside=Math.max(outside,plane.distanceToPoint(point));plane.constant-=outside;}
    return {bounds:new THREE.Box3().setFromObject(mesh),planes};
  });
}
const solids=sofaSolids();
function depth(point,solid){
  if(!solid.bounds.containsPoint(point))return 0;
  let max=-Infinity;
  for(const plane of solid.planes){const d=plane.distanceToPoint(point);if(d>=0)return 0;max=Math.max(max,d);}
  return -max;
}
function contactVertices(avatar){
  const humans=new Map(Object.entries(avatar.vrm.humanoid.rawHumanBones).map(([name,bone])=>[bone.node,name]));
  const vertices=[],p=new THREE.Vector3();avatar.root.updateMatrixWorld(true);
  avatar.vrm.scene.traverse(mesh=>{
    if(!mesh.isSkinnedMesh||/^hair|^head/.test(mesh.name))return;
    const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight;
    for(let index=0;index<si.count;index++){
      let strongest=0;for(let j=1;j<4;j++)if(sw.getComponent(index,j)>sw.getComponent(index,strongest))strongest=j;
      const joint=mesh.skeleton.bones[si.getComponent(index,strongest)];
      if(/WeiBa/.test(joint.name))continue; // tail springbones require browser validation
      let bone=joint,human=humans.get(bone);
      while(!human&&bone){bone=bone.parent;human=humans.get(bone);}
      mesh.getVertexPosition(index,p).applyMatrix4(mesh.matrixWorld);
      const kind=/Foot|Toes/.test(human??'')?'shoe':/UpperLeg|LowerLeg|Hand|Thumb|Index|Middle|Ring|Little/.test(human??'')?'limb'
        :mesh.name.startsWith('clothing')&&p.y<.4?'skirt':human==='hips'?'pelvis':null;
      if(kind)vertices.push({mesh,index,kind});
    }
  });return vertices;
}
async function simulate({dt,to,cancelFraction=null,recoveryTo=null,seatContactCurve=true,fromYaw=0}){
  const original=GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync=async()=>loadLocalVrmFixture();
  let avatar;
  try{avatar=await createAvatar(new THREE.Scene());}finally{GLTFLoader.prototype.loadAsync=original;}
  const vertices=contactVertices(avatar),approach={x:-.85,z:-1.25},seat={x:-.85,z:-1.60-avatar.thighLength};
  const context={groundHeightAt:()=>.0025,attentionCueEnabled:false};
  avatar.root.position.set(approach.x,0,(to?approach:seat).z);
  avatar.root.rotation.y=fromYaw;
  for(let f=0;f<120;f++)avatar.update(1/60,{...context,sitBlend:1-to});
  let motion=createPostureMotion({from:1-to,to,fromPosition:avatar.root.position,toPosition:to?seat:approach,fromYaw,seatContactCurve});
  const result={dt,to,cancelFraction,recoveryTo,skirtDepth:0,bodyDepth:0,soleError:0,ankleSpeed:0,kneeForward:Infinity,kneeDegrees:0,continuity:0};
  const p=new THREE.Vector3();let previous=null;
  function tick(pose){
    avatar.root.position.set(pose.position.x,0,pose.position.z);avatar.root.rotation.y=pose.yaw;avatar.update(dt,{...context,sitBlend:pose.blend});avatar.root.updateMatrixWorld(true);
    const foot=avatar.vrm.humanoid.getRawBoneNode('leftFoot').getWorldPosition(new THREE.Vector3());
    assert.ok(foot.toArray().every(Number.isFinite));
    if(previous)result.ankleSpeed=Math.max(result.ankleSpeed,foot.distanceTo(previous)/dt);previous=foot.clone();
    const hip=avatar.vrm.humanoid.getRawBoneNode('leftUpperLeg').getWorldPosition(new THREE.Vector3());
    const knee=avatar.vrm.humanoid.getRawBoneNode('leftLowerLeg').getWorldPosition(new THREE.Vector3());
    const axis=foot.clone().sub(hip),fraction=THREE.MathUtils.clamp(knee.clone().sub(hip).dot(axis)/axis.lengthSq(),0,1);
    const offset=knee.clone().sub(hip).addScaledVector(axis,-fraction);
    result.kneeForward=Math.min(result.kneeForward,offset.x*Math.sin(pose.yaw)+offset.z*Math.cos(pose.yaw));
    result.kneeDegrees=Math.max(result.kneeDegrees,(Math.PI-hip.clone().sub(knee).angleTo(foot.clone().sub(knee)))*180/Math.PI);
    for(const v of vertices){
      v.mesh.getVertexPosition(v.index,p).applyMatrix4(v.mesh.matrixWorld);
      if(v.kind==='shoe')result.soleError=Math.max(result.soleError,.0025-p.y);
      for(const solid of solids){const d=depth(p,solid);if(d<=.001)continue;
        if(v.kind==='skirt')result.skirtDepth=Math.max(result.skirtDepth,d);else result.bodyDepth=Math.max(result.bodyDepth,d);}
    }
  }
  const fullDuration=motion.duration+motion.turnDuration;
  const frames=Math.round(fullDuration*(cancelFraction??1)/dt);let pose;
  for(let f=1;f<=frames;f++){pose=samplePosture(motion,f*dt);tick(pose);}
  if(cancelFraction!==null){
    motion=createPostureMotion({from:pose.blend,to:recoveryTo,fromPosition:pose.position,toPosition:recoveryTo?seat:approach,fromYaw:0,recovery:true,seatContactCurve});
    const first=samplePosture(motion,0);
    result.continuity=Math.max(Math.abs(first.blend-pose.blend),Math.hypot(first.position.x-pose.position.x,first.position.z-pose.position.z));
    for(let f=1;f<=Math.ceil((motion.duration+.4)/dt);f++){pose=samplePosture(motion,f*dt);tick(pose);}
  }else for(let f=frames+1;f<=Math.ceil((fullDuration+.4)/dt);f++){pose=samplePosture(motion,f*dt);tick(pose);}
  assert.equal(pose.done,true);assert.equal(pose.blend,recoveryTo??to);
  avatar.dispose();return result;
}

test('actual skirt clears the current rounded cushion throughout sitting and standing', {skip:localModelSkip},async t=>{
  const legacy=await simulate({dt:1/60,to:1,seatContactCurve:false});
  assert.ok(legacy.skirtDepth>.05,'this real geometry probe must detect the old mid-transition intersection');
  const results=[];
  for(const dt of[1/60,1/30,.05])for(const to of[0,1]){
    const r=await simulate({dt,to});results.push(r);
    assert.equal(r.skirtDepth,0);assert.equal(r.bodyDepth,0);
    assert.ok(r.ankleSpeed<.70,'phasing must not trade skirt contact for a fast jump');
    assert.ok(r.kneeForward>=0&&r.kneeDegrees<91);
    assert.ok(r.soleError<.004,'preserve the existing millimetre-scale foot constraint handoff bound');
  }
  const halfTurn=await simulate({dt:1/60,to:1,fromYaw:Math.PI});
  assert.equal(halfTurn.skirtDepth,0);assert.equal(halfTurn.bodyDepth,0);
  assert.ok(halfTurn.kneeForward>=0&&halfTurn.kneeDegrees<91,JSON.stringify(halfTurn));
  t.diagnostic(JSON.stringify({legacySkirtDepth:legacy.skirtDepth,results}));
});

test('cancelled real posture preserves cushion clearance even at endpoint blend before root arrival', {skip:localModelSkip},async t=>{
  const results=[];
  for(const dt of[1/60,1/30,.05])for(const to of[0,1])for(const cancelFraction of[.2,.48,.58,.8])for(const recoveryTo of[0,1]){
    const r=await simulate({dt,to,cancelFraction,recoveryTo});results.push(r);
    assert.equal(r.continuity,0);assert.equal(r.skirtDepth,0);assert.equal(r.bodyDepth,0);
    assert.ok(r.ankleSpeed<.71);assert.ok(r.kneeForward>=0&&r.kneeDegrees<91);
    assert.ok(r.soleError<.004);
  }
  t.diagnostic(JSON.stringify({cases:results.length,maxAnkleSpeed:Math.max(...results.map(r=>r.ankleSpeed)),maxSoleError:Math.max(...results.map(r=>r.soleError)),maxSkirtDepth:Math.max(...results.map(r=>r.skirtDepth))}));
});

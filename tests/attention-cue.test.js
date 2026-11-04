import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLookAt, VRMLookAtBoneApplier, VRMLookAtRangeMap } from '@pixiv/three-vrm';
import { createAvatar } from '../src/avatar.js';
import { createRoomActivities } from '../src/room-activities.js';
import { localModelSkip, loadLocalVrmFixture } from './vrm-fixture.js';

async function fixture() {
  const bytes=readFileSync(new URL('../public/assets/deepseek-chibi.vrm',import.meta.url));
  const definition=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12))).extensions.VRMC_vrm.lookAt;
  const original=GLTFLoader.prototype.loadAsync, random=Math.random;
  GLTFLoader.prototype.loadAsync=async()=>{
    const gltf=loadLocalVrmFixture(),vrm=gltf.userData.vrm;
    const range=name=>new VRMLookAtRangeMap(definition[name].inputMaxValue,definition[name].outputScale);
    vrm.scene.updateMatrixWorld(true);
    vrm.lookAt=new VRMLookAt(vrm.humanoid,new VRMLookAtBoneApplier(vrm.humanoid,range('rangeMapHorizontalInner'),range('rangeMapHorizontalOuter'),range('rangeMapVerticalDown'),range('rangeMapVerticalUp')));
    vrm.lookAt.offsetFromHeadBone.fromArray(definition.offsetFromHeadBone);
    vrm.update=dt=>{vrm.humanoid.update();vrm.lookAt.update(dt);vrm.expressionManager.update();};
    return gltf;
  };
  Math.random=()=>.5;
  try{return await createAvatar(new THREE.Scene());}
  finally{GLTFLoader.prototype.loadAsync=original;Math.random=random;}
}
const worldRotation=(avatar,name)=>avatar.vrm.humanoid.getRawBoneNode(name).getWorldQuaternion(new THREE.Quaternion()).normalize();

test('real response head cue is visible in joint motion, finite, and leaves eyes and silent mouth bounded', {skip:localModelSkip},async t=>{
  const records=[];
  for(const dt of[1/60,.05])for(const sitBlend of[0,1]){
    const base=await fixture(),avatar=await fixture(),target=new THREE.Vector3(0,avatar.eyeHeight-avatar.sitDrop*sitBlend+.02,2.4);
    for(let i=0;i<Math.ceil(2/dt);i++){
      base.update(dt,{sitBlend,lookTarget:target,attentionCueEnabled:false});avatar.update(dt,{sitBlend,lookTarget:target});
    }
    base.setAttention('responding');avatar.setAttention('responding');
    let peak=0,maxFrame=0,maxEyeDelta=0,maxClosure=0,previous=null;
    for(let i=0;i<Math.ceil(3/dt);i++){
      base.update(dt,{sitBlend,lookTarget:target,attentionCueEnabled:false});avatar.update(dt,{sitBlend,lookTarget:target});
      avatar.root.updateMatrixWorld(true);base.root.updateMatrixWorld(true);
      const head=worldRotation(avatar,'head');peak=Math.max(peak,head.angleTo(worldRotation(base,'head')));
      if(previous)maxFrame=Math.max(maxFrame,head.angleTo(previous));previous=head;
      for(const side of['left','right']){
        const a=avatar.vrm.humanoid.getRawBoneNode(side+'Eye').quaternion.clone().normalize(),b=base.vrm.humanoid.getRawBoneNode(side+'Eye').quaternion.clone().normalize();
        maxEyeDelta=Math.max(maxEyeDelta,a.angleTo(b));
      }
      const state=avatar.getState(),closure=state.blink+['happyEyes','sadEyes','relaxedEyes'].reduce((s,n)=>s+(state.channels[n]??0),0);
      maxClosure=Math.max(maxClosure,closure);
      assert.ok(Number.isFinite(state.responseCuePitch));
      for(const vowel of['aa','ih','ou'])assert.equal(avatar.vrm.expressionManager.getValue(vowel),0);
      if(i*dt>2)assert.equal(state.responseCueActive,false);
    }
    records.push({dt,sitBlend,peakDegrees:peak*180/Math.PI,maxFrameDegrees:maxFrame*180/Math.PI,eyeDeltaDegrees:maxEyeDelta*180/Math.PI,maxClosure});
    assert.ok(peak>.04&&peak<.06);
    assert.ok(maxFrame<.008,'head cue must not snap, including 50ms frames');
    assert.ok(maxEyeDelta<.012,'the original gaze solver supplies only a small residual correction');
    assert.ok(maxClosure<=.980001);
    assert.ok(worldRotation(avatar,'head').angleTo(worldRotation(base,'head'))<1e-5);
    base.dispose();avatar.dispose();
  }
  t.diagnostic(JSON.stringify(records));
});

test('real avatar consumes response cues during motion, posture, props, gestures, hiding and inspection disable', {skip:localModelSkip},async()=>{
  for(const reason of['walking','turning','posture','read','drink','stretch','wave','nod','hidden','disabled']){
    const avatar=await fixture();let context={};
    if(['read','drink','stretch'].includes(reason)){
      const props=createRoomActivities(avatar.root.parent),station=props.stations[reason];
      if(station){avatar.root.position.set(station.x,0,station.z);avatar.root.rotation.y=station.yaw;for(let i=0;i<60;i++)avatar.update(1/60);}
      assert.ok(avatar.setActivity(reason,{props}));
    }
    if(['wave','nod'].includes(reason))avatar.setGesture(reason);
    if(reason==='walking')context={speed:.28};
    if(reason==='posture')context={sitBlend:.5};
    if(reason==='hidden')context={renderVisible:false};
    if(reason==='disabled')context={attentionCueEnabled:false};
    avatar.update(1/60,context);avatar.setAttention('responding');
    if(reason==='turning')avatar.root.rotation.y+=.1;
    avatar.update(reason==='hidden'?0:1/60,context);
    assert.equal(avatar.getState().responseCueActive,false,`${reason} must block the cue`);
    assert.equal(avatar.getState().responseCuePitch,0);
    avatar.setGesture('none');
    if(avatar.getState().activity){avatar.cancelActivity();for(let i=0;i<120;i++)avatar.update(1/60);}
    for(let i=0;i<90;i++){
      avatar.update(1/60,{sitBlend:0,renderVisible:true,attentionCueEnabled:true});
      assert.equal(avatar.getState().responseCuePitch,0,`${reason} must not defer the cue until after release`);
    }
    avatar.dispose();
  }
});

test('interrupting an active response clears its target immediately and never resumes it after hiding', {skip:localModelSkip},async()=>{
  const avatar=await fixture();avatar.setAttention('responding');
  for(let i=0;i<24;i++)avatar.update(1/60);
  assert.ok(avatar.getState().responseCuePitch>.03);
  avatar.setAttention('idle');
  assert.equal(avatar.getState().responseCueActive,false);assert.equal(avatar.getState().responseCuePitch,0);
  avatar.update(0,{renderVisible:false});
  for(let i=0;i<90;i++){
    avatar.update(1/60,{renderVisible:true});assert.equal(avatar.getState().responseCuePitch,0);
  }
});

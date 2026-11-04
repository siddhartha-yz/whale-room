import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceController } from '../src/face.js';

function advance(face, seconds, context) {
  let frame;
  for (let i = 0; i < Math.ceil(seconds * 120); i++) frame = face.update(1 / 120, context);
  return frame;
}
const makeFace = () => createFaceController({ random: () => 0.5 });

test('a four-minute quiet activity cannot leave happy or relaxed eyes latched shut', () => {
  for (const expression of ['happy', 'relaxed', 'sad', 'surprised']) {
    const face = makeFace();
    face.setExpression(expression);
    let closedFrames = 0;
    const frames = 240 * 120;
    for (let i = 0; i < frames; i++) {
      const result = face.update(1 / 120);
      const eyeEmotion = ['happyEyes', 'relaxedEyes', 'sadEyes'].reduce((sum, name) => sum + result.channels[name], 0);
      assert.ok(eyeEmotion + result.blink <= 1 + 1e-9, 'blink must replace the eyelid pose, not over-close it');
      if (eyeEmotion + result.blink > 0.95) closedFrames++;
    }
    assert.ok(closedFrames / frames < 0.025, 'eyes stay open apart from brief blinks');
    assert.equal(face.getState().expression, 'neutral');
    assert.ok(Object.values(face.getState().channels).every(value => value < 0.001));
  }
});

test('a newer reaction survives the expiry time of the earlier reaction', () => {
  const face = makeFace();
  face.setExpression('surprised');
  advance(face, 1.4);
  face.setExpression('happy');
  advance(face, 1.5);
  assert.equal(face.getState().expression, 'happy');
  assert.ok(face.getState().channels.happyMouth > 0.5);
  assert.ok(face.getState().channels.surprisedMouth < 0.001);
  advance(face, 7);
  assert.equal(face.getState().expression, 'neutral');
});

test('manual expression previews also return to a natural face', () => {
  const face = makeFace();
  face.setExpression('relaxed', { source: 'manual' });
  advance(face, 7);
  assert.equal(face.getState().expression, 'relaxed');
  advance(face, 6);
  assert.equal(face.getState().expression, 'neutral');
  assert.ok(face.getState().channels.relaxedEyes < 0.001);
});

test('typing clears an old emotion and has a bounded attention interval', () => {
  const face = makeFace();
  face.setExpression('sad');
  advance(face, 1);
  face.setAttention('listening');
  advance(face, 0.8);
  assert.equal(face.getState().expression, 'neutral');
  assert.equal(face.getState().attention, 'listening');
  assert.ok(face.getState().channels.sadEyes < 0.001);
  advance(face, 2.5);
  assert.equal(face.getState().attention, 'idle');
});

test('text-only thinking and responding never fabricate speech mouth motion', () => {
  const face = makeFace();
  for (const state of ['thinking', 'responding', 'listening', 'idle']) {
    face.setAttention(state);
    const result = advance(face, 0.5);
    assert.equal(result.vowels.aa, 0);
    assert.equal(result.vowels.ih, 0);
    assert.equal(result.vowels.ou, 0);
  }
  face.setSpeaking(true);
  assert.ok(advance(face, 0.5).vowels.aa > 0.04);
  face.setSpeaking(false);
  assert.ok(advance(face, 1).vowels.aa < 0.001);
  face.setAttention('thinking');
  face.reset();
  assert.equal(face.getState().attention, 'idle');
  assert.equal(face.getState().speaking, false);
});

test('changing expressions mid-blink stays within a single eyelid closure budget', () => {
  const face = makeFace();
  for (let i = 0; i < 120 * 20; i++) {
    if (i % 17 === 0) face.setExpression(['happy', 'relaxed', 'sad'][Math.floor(i / 17) % 3]);
    const result = face.update(1 / 120);
    const total = result.blink + result.channels.happyEyes + result.channels.relaxedEyes + result.channels.sadEyes;
    assert.ok(Number.isFinite(total) && total >= 0 && total <= 1 + 1e-9);
  }
});

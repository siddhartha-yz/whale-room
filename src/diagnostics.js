/** Local render inspection and optional same-origin evidence export; no model calls. */
export function installDiagnostics({ avatar, renderer, scene, camera, getWorldState, getAutonomyState = () => null, getFeedback = () => [], getSimulationTime = () => null, getRenderPresence = () => null, setPaused, step }) {
  if (new URLSearchParams(location.search).get('inspect') !== '1') return;
  const panel = document.createElement('details');
  panel.id = 'render-inspector';
  panel.open = true;
  panel.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:40;max-width:360px;width:calc(100vw - 24px);padding:10px;background:#fffffff5;border:1px solid #bbc6d6;border-radius:8px;font:11px/1.5 monospace;color:#334155;box-shadow:0 3px 12px #0002';
  function positionPanel() {
    panel.style.width = panel.open ? 'calc(100vw - 24px)' : 'fit-content';
    panel.style.top = panel.open ? '70px' : 'auto';
    panel.style.bottom = panel.open ? 'auto' : '12px';
  }
  panel.addEventListener('toggle', positionPanel);
  positionPanel();
  const heading = document.createElement('summary'); heading.textContent = '渲染检查'; panel.append(heading);
  const controls = document.createElement('div'); controls.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin:7px 0'; panel.append(controls);
  const readout = document.createElement('pre'); readout.id = 'render-readout';
  readout.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;margin:4px 0'; panel.append(readout);
  const links = document.createElement('div'); links.style.cssText = 'display:flex;gap:14px'; panel.append(links);
  const imageLink = document.createElement('a'); imageLink.textContent = '下载截图'; imageLink.hidden = true; links.append(imageLink);
  const dataLink = document.createElement('a'); dataLink.textContent = '下载记录'; dataLink.hidden = true; links.append(dataLink);
  const videoLink = document.createElement('a'); videoLink.textContent = '下载录像'; videoLink.hidden = true; links.append(videoLink);
  const exportStatus = document.createElement('div'); exportStatus.setAttribute('role', 'status');
  exportStatus.style.cssText = 'margin-top:5px'; panel.append(exportStatus);
  document.body.append(panel);
  let recording = false;
  let start = 0;
  let simulationStart = 0, simulationStoppedAt = null, steppedSeconds = 0;
  let samples = [];
  let events = [];
  let lastEventKey = '';
  let frames = 0;
  let inactiveFrames = 0;
  let closedFrames = 0;
  let closedStreak = 0;
  let longestClosedStreak = 0;
  let last = performance.now();
  let lastSample = -Infinity;
  let intervals = [];
  let stoppedAt = null;
  let previousPose = null;
  let maxStepMeters = 0;
  let maxPoseStep = 0;
  let maxYawStep = 0;
  let requestId;
  const round = value => Math.round(value * 1000) / 1000;
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }

  function button(text, handler) {
    const element = document.createElement('button'); element.type = 'button';
    element.textContent = text; element.style.cssText = 'padding:3px 6px;background:#eaf0f8;border-radius:4px';
    element.addEventListener('click', handler); controls.append(element); return element;
  }
  function summary() {
    const sorted = intervals.slice().sort((a, b) => a - b);
    return {
      durationSeconds: round(((stoppedAt ?? performance.now()) - start) / 1000),
      animationSeconds: round((simulationStoppedAt ?? getSimulationTime() ?? 0) - simulationStart), manuallySteppedSeconds: round(steppedSeconds),
      frames, inactiveFrames, closedFrames, longestClosedSeconds: round(longestClosedStreak),
      closedFraction: frames ? round(closedFrames / frames) : 0,
      maxStepMeters: round(maxStepMeters), maxPoseStep: round(maxPoseStep), maxYawStepRadians: round(maxYawStep),
      recentFrameMedianMs: round(sorted[Math.floor(sorted.length * 0.5)] || 0),
      recentFrameP95Ms: round(sorted[Math.floor(sorted.length * 0.95)] || 0),
      renderer: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures },
    };
  }
  let paused = false;
  if (setPaused && step) {
    const pauseButton = button('暂停动画', () => {
      paused = !paused; setPaused(paused);
      pauseButton.textContent = paused ? '恢复动画' : '暂停动画';
      stepButton.disabled = !paused;
      captureSample(performance.now());
    });
    const stepButton = button('前进 0.2 秒', async () => {
      stepButton.disabled = true;
      try { await step(0.2); if(recording)steppedSeconds+=0.2; } finally { stepButton.disabled = !paused; captureSample(performance.now()); }
    });
    stepButton.disabled = true;
  }
  async function persist(kind, base64, link) {
    delete link.dataset.path;
    exportStatus.textContent = '正在保存到本机…';
    try {
      const response = await fetch('/api/inspect-artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, data: base64 }) });
      if (!response.ok) {
        exportStatus.textContent = `本机保存失败（${response.status}），可尝试下载。`;
        return;
      }
      const artifact = await response.json();
      link.href = artifact.url; link.dataset.path = artifact.path;
      exportStatus.textContent = '已保存到本机。';
    } catch {
      exportStatus.textContent = '本机保存失败，可尝试下载。';
    }
  }
  async function updateExport() {
    const data = { recordedAt: new Date().toISOString(), summary: summary(), samples, events };
    const json = JSON.stringify(data);
    dataLink.href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    dataLink.download = `whale-render-${Date.now()}.json`; dataLink.hidden = false;
    const bytes = new TextEncoder().encode(json);
    await persist('json', base64(bytes), dataLink);
  }
  const recordButton = button('开始记录', () => {
    if (!recording) {
      samples = []; events = []; lastEventKey = ''; frames = 0; inactiveFrames = 0; closedFrames = 0; closedStreak = 0; longestClosedStreak = 0;
      intervals = []; start = performance.now(); stoppedAt = null; lastSample = -Infinity;
      simulationStart=getSimulationTime()||0;simulationStoppedAt=null;steppedSeconds=0;
      previousPose = null; maxStepMeters = 0; maxPoseStep = 0; maxYawStep = 0;
      recording = true; recordButton.textContent = '停止记录'; dataLink.hidden = true;
    } else {
      recording = false; stoppedAt = performance.now(); simulationStoppedAt=getSimulationTime()||0;recordButton.textContent = '开始记录'; updateExport();
    }
  });
  button('保存截图', async () => {
    // Render immediately before reading; normal production rendering does not
    // retain its drawing buffer just for this diagnostic capture.
    renderer.render(scene, camera);
    imageLink.href = renderer.domElement.toDataURL('image/png');
    imageLink.download = `whale-${avatar.getState().expression}-${Date.now()}.png`; imageLink.hidden = false;
    await persist('png', imageLink.href.split(',')[1], imageLink);
  });
  const videoButton = button('录制 8 秒', () => {
    if (!renderer.domElement.captureStream || typeof MediaRecorder === 'undefined') {
      videoButton.textContent = '录制不可用'; videoButton.disabled = true; return;
    }
    const stream = renderer.domElement.captureStream(30);
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { stream.getTracks().forEach(track => track.stop()); videoButton.textContent = '录制不可用'; return; }
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 });
    const chunks = [];
    videoButton.disabled = true; videoButton.textContent = '录制中…';
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (videoLink.href.startsWith('blob:')) URL.revokeObjectURL(videoLink.href);
      videoLink.href = URL.createObjectURL(blob); videoLink.download = `whale-motion-${Date.now()}.webm`; videoLink.hidden = false;
      await persist('webm', base64(new Uint8Array(await blob.arrayBuffer())), videoLink);
      videoButton.disabled = false; videoButton.textContent = '录制 8 秒';
    };
    recorder.onerror = () => { stream.getTracks().forEach(track => track.stop()); videoButton.disabled = false; videoButton.textContent = '重试录制'; };
    recorder.start(); setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 8000);
  });
  function tick(now) {
    requestId = requestAnimationFrame(tick);
    const interval = now - last; last = now;
    if (document.hidden) return;
    const face = avatar.getState();
    const renderActive = getRenderPresence()?.active !== false;
    if(recording&&!paused&&!renderActive){inactiveFrames++;closedStreak=0;previousPose=null;}
    if (recording && !paused && renderActive) {
      frames++;
      if (interval > 0 && interval < 2000) {
        intervals.push(interval); if (intervals.length > 3600) intervals.shift();
      }
      const closed = face.blink > 0.95;
      if (closed) { closedFrames++; closedStreak += Math.min(interval / 1000, 0.1); }
      else closedStreak = 0;
      longestClosedStreak = Math.max(longestClosedStreak, closedStreak);
      const position = avatar.root.position;
      const pose = { x: position.x, z: position.z, blend: face.sitBlend, yaw: avatar.root.rotation.y };
      if (previousPose) {
        maxStepMeters = Math.max(maxStepMeters, Math.hypot(pose.x - previousPose.x, pose.z - previousPose.z));
        maxPoseStep = Math.max(maxPoseStep, Math.abs(pose.blend - previousPose.blend));
        maxYawStep = Math.max(maxYawStep, Math.abs(Math.atan2(Math.sin(pose.yaw - previousPose.yaw), Math.cos(pose.yaw - previousPose.yaw))));
      }
      previousPose = pose;
    }
    if (now - lastSample < 500) return;
    captureSample(now);
  }
  function captureSample(now) {
    lastSample = now;
    const face = avatar.getState();
    const world = getWorldState();
    const autonomy = getAutonomyState();
    const feedback = getFeedback().slice(-8);
    const current = autonomy?.currentActivity;
    const compactAutonomy = autonomy ? {
      enabled: autonomy.enabled, status: autonomy.status, activity: autonomy.activity,
      requestCount: autonomy.requestCount,
      lastDecisionSpeechAllowed: autonomy.lastDecisionSpeechAllowed ?? null,
      lastDecisionAt: autonomy.lastDecisionAt ?? null,
      currentActivity: current ? { id: current.id, phase: current.phase, elapsedVisibleSeconds: current.elapsedVisibleSeconds, dwellComplete: current.dwellComplete } : null,
    } : null;
    const sample = {
      seconds: recording ? round((now - start) / 1000) : null,
      simulationSeconds: round(getSimulationTime() || 0), paused,
      renderPresence: getRenderPresence(),
      camera: { position: { x: round(camera.position.x), y: round(camera.position.y), z: round(camera.position.z) }, aspect: round(camera.aspect) },
      world: { position: world.position, posture: world.posture, expression: world.expression, location: world.location, gaze: world.gaze, activity: world.activity, yaw: round(avatar.root.rotation.y) },
      face: { expression: face.expression, attention: face.attention, blink: round(face.blink), speaking: face.speaking, gesture: face.gesture, sitBlend: round(face.sitBlend), walkBlend: round(face.walkBlend), gaze: face.gaze, channels: face.channels, splitRig: face.facialRig },
      activity: face.activity, activityResult: face.activityResult,
      autonomy: compactAutonomy,
    };
    const eventKey = JSON.stringify([autonomy?.status, autonomy?.activity, autonomy?.requestCount, current?.id, current?.phase, feedback.map(item=>item.id)]);
    if(recording && eventKey !== lastEventKey){
      lastEventKey=eventKey;
      events.push({ seconds:sample.seconds, autonomy, feedback });
    }
    if (recording && samples.length < 7200) samples.push(sample);
    readout.textContent = JSON.stringify({ recording, ...sample, feedback, metrics: frames ? summary() : undefined }, null, 2);
  }
  requestId = requestAnimationFrame(tick);
  window.addEventListener('pagehide', () => cancelAnimationFrame(requestId), { once: true });
}

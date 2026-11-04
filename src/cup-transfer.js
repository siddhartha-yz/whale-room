import * as THREE from 'three';

export const CUP_SPOTS = Object.freeze({ cup_inner: .42, cup_edge: .62 });
export const CUP_TRANSFER_STATION = Object.freeze({ x: .385, z: 1.24, yaw: Math.PI });
const PAD_RADIUS = .09, CUP_BASE_RADIUS = .058, HOME_Y = .5525, PAD_TOP = .4925;

/** Two fixed, opt-in cup places. This owns observed placement, never animation
 * or a teleport. The hand controller must carry the cup to a supported pose. */
export function createCupTransfer({ root, cup, coaster, home, isHeld, release }) {
  let enabled = false, spot = 'cup_inner', active = null, blocked = false;
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  const point = new THREE.Vector3(), expectedPosition = new THREE.Vector3(), expectedRotation = new THREE.Quaternion();
  function updateCup() { cup.updateWorldMatrix(true, false); }
  function spotHome(id) {
    root.updateWorldMatrix(true, false);
    return new THREE.Matrix4().multiplyMatrices(root.matrixWorld, new THREE.Matrix4().makeTranslation(CUP_SPOTS[id], HOME_Y, .90));
  }
  function placement(tx) {
    updateCup();
    const expected = tx.returning ? tx.sourceHome : tx.targetHome, id = tx.returning ? tx.source : tx.target;
    cup.matrixWorld.decompose(position, rotation, scale);expected.decompose(expectedPosition, expectedRotation, scale);
    const distance = position.distanceTo(expectedPosition), angle = rotation.angleTo(expectedRotation);
    let supportMargin = Infinity, lowest = Infinity, highest = -Infinity;
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16;
      point.set(Math.cos(a) * CUP_BASE_RADIUS, -.06, Math.sin(a) * CUP_BASE_RADIUS).applyMatrix4(cup.matrixWorld);
      root.worldToLocal(point);
      supportMargin = Math.min(supportMargin, PAD_RADIUS - Math.hypot(point.x - CUP_SPOTS[id], point.z - .90));
      lowest = Math.min(lowest, point.y);highest = Math.max(highest, point.y);
    }
    const height = Math.abs(position.y - expectedPosition.y);
    const supported = distance <= .012 && angle <= .08 && height <= .0025
      && supportMargin >= .01 && lowest >= PAD_TOP - .001 && highest <= PAD_TOP + .003;
    return { position: distance, angle, height, supportMargin, supported, stable: tx.stable >= 3 };
  }
  return {
    enable() {
      if (enabled) return true;
      if (isHeld()) return false;
      coaster.geometry.dispose();coaster.geometry = new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS, .025, 32);
      coaster.name = 'CupCoasterInner';
      const second = new THREE.Mesh(coaster.geometry, coaster.material);second.name = 'CupCoasterEdge';
      second.position.set(CUP_SPOTS.cup_edge, .48, .90);second.castShadow = second.receiveShadow = true;root.add(second);
      enabled = true;return true;
    },
    getState: () => ({ supported: enabled, spot, held: isHeld(), blocked }),
    drinkStation() {
      if (!enabled) return { x: .29, z: 1.25, yaw: Math.PI };
      updateCup();cup.getWorldPosition(position);
      return { x: position.x - .13, z: position.z + .35, yaw: Math.PI };
    },
    drinkSnapshot() { if (!enabled) return null;updateCup();return { home: cup.matrixWorld.clone(), spot }; },
    begin(destination) {
      if (!enabled || blocked || active || isHeld() || !Object.hasOwn(CUP_SPOTS, destination)) return null;
      updateCup();
      const candidate = { source: spot, target: destination, sourceHome: cup.matrixWorld.clone(), targetHome: spotHome(destination),
        returning: false, deposited: false, unchanged: destination === spot, effect: null, stable: 0, previous: null, previousRotation: null };
      if (!placement({ ...candidate, returning: true }).supported) return null;
      active = candidate;
      return active;
    },
    anchors(avatarRoot, snapshot) {
      const from = snapshot?.sourceHome ?? snapshot?.home ?? home;
      const source = new THREE.Vector3().setFromMatrixPosition(from);
      const local = p => avatarRoot.worldToLocal(p).toArray();
      return {
        cup: local(source.clone()), cupPickup: local(source.clone().add(new THREE.Vector3(0, -.0125, .18))),
        ...(snapshot?.targetHome ? { cupDestination: local(new THREE.Vector3().setFromMatrixPosition(snapshot.targetHome).add(new THREE.Vector3(0, -.0125, .18))), cupTransferNoop: snapshot.unchanged } : {}),
      };
    },
    observe() {
      if (!active || active.deposited || !isHeld()) return;
      const p = placement(active), actual = cup.getWorldPosition(new THREE.Vector3()), orientation = cup.getWorldQuaternion(new THREE.Quaternion());
      active.stable = p.supported && active.previous && actual.distanceTo(active.previous) < .001
        && orientation.angleTo(active.previousRotation) < .01 ? active.stable + 1 : 0;
      active.previous = actual;active.previousRotation = orientation;
    },
    requestReturn(tx) {
      if (tx !== active || tx.deposited) return false;
      tx.returning = true;tx.stable = 0;tx.previous = null;tx.previousRotation = null;return true;
    },
    tryDeposit(tx) {
      if (tx !== active || tx.deposited || !isHeld()) return false;
      const p = placement(tx);
      if (!p.supported || !p.stable) return false;
      // Commit together with physical release, before any hand-withdrawal or
      // completion callback can be interrupted by another user request.
      release();tx.deposited = true;
      if (!tx.returning) { spot = tx.target;tx.effect = tx.source === tx.target ? null : { type: 'cup_moved', from: tx.source, to: tx.target }; }
      home.copy(cup.matrixWorld);
      return true;
    },
    placement,
    block(tx) { if (tx === active) blocked = true; },
    finish(tx) { if (tx === active && !blocked) active = null; },
  };
}

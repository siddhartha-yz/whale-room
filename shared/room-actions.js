const roomPlaces = Object.freeze(['sofa', 'window', 'plant', 'center', 'user']);
const noTarget = Object.freeze(['none']);
export const CUP_SPOTS = Object.freeze(['cup_inner', 'cup_edge']);
export const ROOM_ACTION_TARGETS = Object.freeze({
  move_to: roomPlaces, sit: Object.freeze(['sofa', 'none']), stand: noTarget,
  wave: noTarget, nod: noTarget, look_at: roomPlaces,
  read: noTarget, drink: noTarget, stretch: noTarget, move_cup: CUP_SPOTS,
});
export const ROOM_ACTION_TYPES = Object.freeze(Object.keys(ROOM_ACTION_TARGETS));
export const ROOM_TARGET_TYPES = Object.freeze([...new Set(Object.values(ROOM_ACTION_TARGETS).flat())]);
export const MAX_ROOM_ACTIONS = 4;

export function isRoomAction(action, index, length) {
  return Boolean(action && typeof action === 'object' && !Array.isArray(action)
    && Object.hasOwn(ROOM_ACTION_TARGETS, action.type) && ROOM_ACTION_TARGETS[action.type].includes(action.target)
    && Object.keys(action).every(key => key === 'type' || key === 'target')
    && (action.type !== 'read' || index === length - 1));
}

export function isRoomActionList(value) {
  return Array.isArray(value) && value.length <= MAX_ROOM_ACTIONS
    && value.every((action, index) => isRoomAction(action, index, value.length));
}

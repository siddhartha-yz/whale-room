import { activityFeedback } from './activity-journal.js';

/** Keep execution receipts on the chat activity that actually produced them. */
export function captureChatReadingResult(run, result) {
  if (run?.source !== 'chat' || run.name !== 'read' || result?.status !== 'completed'
    || result.activity?.id !== run.activityId || result.activity?.kind !== 'read') return false;
  run.chatFeedback = activityFeedback(result.feedback);
  return true;
}

/** A draft or a pending reply keeps chat in control until a real handoff is safe. */
export function tryAdoptChatReading({ run, actual, autonomy, idle, visible, typing, chatBusy }) {
  if (!autonomy || !idle || !visible || typing || chatBusy || run?.source !== 'chat' || run.name !== 'read'
    || actual?.id !== run.id || actual?.name !== 'read' || actual.cancelling
    || !['reading', 'turning-page'].includes(actual.phase) || !Array.isArray(run.chatFeedback)) return false;

  // The controller's idle snapshot permits autonomous reading only. Change the
  // source for this synchronous attempt, then restore it if adoption is refused.
  run.source = 'autonomy';
  let adopted = false;
  try {
    adopted = autonomy.adoptActivity({ id: run.activityId, activity: '在桌边看书', feedback: run.chatFeedback }).ok;
    return adopted;
  } finally {
    if (!adopted) run.source = 'chat';
  }
}

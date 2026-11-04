/** A small, local settings view. It never interprets memory text as markup. */
export function installMemoryControls({ container, store, onMutate = () => {}, onError = () => {} }) {
  const panel = document.createElement('details');
  panel.className = 'memory-settings';
  const summary = document.createElement('summary');
  const list = document.createElement('div');
  list.className = 'memory-list';
  const empty = document.createElement('p');
  empty.textContent = '还没有记住的事。';
  const footer = document.createElement('div');
  footer.className = 'memory-actions';
  const clear = document.createElement('button');
  clear.type = 'button'; clear.textContent = '清空记忆';
  const undo = document.createElement('button');
  undo.type = 'button'; undo.textContent = '撤销删除'; undo.hidden = true;
  footer.append(clear, undo);
  panel.append(summary, list, empty, footer);
  container.insertBefore(panel, container.querySelector('.settings-links'));

  function mutate(operation) {
    onMutate();
    try { operation(); render(); }
    catch { onError('记忆没有保存成功，请稍后重试。'); }
  }
  clear.addEventListener('click', () => mutate(() => store.clear()));
  undo.addEventListener('click', () => mutate(() => store.undo()));
  panel.addEventListener('toggle', () => { if (panel.open) render(); });

  function render(snapshot = store.snapshot()) {
    const entries = snapshot.entries || [];
    summary.textContent = entries.length ? `记住的事（${entries.length}）` : '记住的事';
    list.replaceChildren();
    empty.hidden = entries.length > 0;
    clear.disabled = entries.length === 0;
    undo.hidden = !snapshot.canUndo;
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'memory-item';
      const top = document.createElement('div');
      top.className = 'memory-item-top';
      const label = document.createElement('span');
      const kind = { name: '称呼', preference: '偏好', proactive: '主动聊天' }[entry.kind] || '记忆';
      const scope = { today: '今天', session: '本次会话' }[entry.scope];
      label.textContent = scope ? `${kind} · ${scope}` : kind;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '忘掉';
      const readableValue=entry.kind==='proactive'?(entry.value==='quiet'?'不主动说话':'可以主动接话'):entry.value;
      remove.setAttribute('aria-label', `忘掉：${readableValue}`);
      remove.addEventListener('click', () => mutate(() => store.remove(entry.id)));
      top.append(label, remove);
      const value = document.createElement('div');
      value.className = 'memory-value';
      value.textContent = readableValue;
      const source = document.createElement('details');
      source.className = 'memory-source';
      const sourceLabel = document.createElement('summary'); sourceLabel.textContent = '原话';
      const quote = document.createElement('p'); quote.textContent = entry.evidence;
      source.append(sourceLabel, quote);
      row.append(top, value, source); list.append(row);
    }
  }
  render();
  return { render, destroy() { panel.remove(); } };
}

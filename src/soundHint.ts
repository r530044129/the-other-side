/**
 * "Turn the sound on" hint.
 *
 * A web page cannot read the system volume or the system mute switch (browsers do not expose them), so
 * this cannot tell that the speakers are off. What it can do:
 *  - the start veil always carries a line asking for headphones and sound (see index.html);
 *  - for the first few seconds after the music starts, a small pill repeats it;
 *  - if the page can see a problem on its own side (the browser blocked playback, the audio element is
 *    muted, or its volume is very low) the pill says so and stays until the problem is gone.
 */

export type SoundIssue = 'blocked' | 'muted' | 'quiet' | null;

const GENERIC_MS = 9000;

const TEXT: Record<'generic' | 'blocked' | 'muted' | 'quiet', string> = {
  generic: '请戴上耳机，并确认声音已打开 · 音乐是这件作品的一半',
  blocked: '浏览器拦截了声音 · 请点一下画面，并打开系统声音',
  muted: '声音被静音了 · 请取消静音，戴上耳机',
  quiet: '音量很低 · 请调高音量，戴上耳机',
};

export function createSoundHint() {
  const el = document.createElement('div');
  el.id = 'sound-hint';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="3" y="14" width="4.2" height="6.5" rx="1.6" fill="currentColor"/><rect x="16.8" y="14" width="4.2" height="6.5" rx="1.6" fill="currentColor"/></svg>' +
    '<span class="txt"></span><button type="button" aria-label="关闭提示">×</button>';
  document.body.appendChild(el);
  const txt = el.querySelector('.txt') as HTMLElement;
  const close = el.querySelector('button') as HTMLButtonElement;

  let startedAt = -1;
  let dismissedIssue: SoundIssue | 'generic' | undefined;
  let shown: keyof typeof TEXT | null = null;

  close.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissedIssue = (shown === 'generic' ? 'generic' : (shown as SoundIssue)) ?? undefined;
    el.classList.remove('show');
  });

  /**
   * @param playing  the music has been started and is running
   * @param issue    what the page can see wrong with the audio, if anything
   * @param nowMs    wall-clock time in ms
   */
  function update(playing: boolean, issue: SoundIssue, nowMs: number) {
    let want: keyof typeof TEXT | null = null;
    if (issue) {
      if (issue !== dismissedIssue) want = issue;
    } else {
      dismissedIssue = dismissedIssue === 'generic' ? 'generic' : undefined;
      if (playing) {
        if (startedAt < 0) startedAt = nowMs;
        if (nowMs - startedAt < GENERIC_MS && dismissedIssue !== 'generic') want = 'generic';
      }
    }
    if (!playing && issue !== 'blocked') want = null;
    if (want !== shown) {
      shown = want;
      if (want) txt.textContent = TEXT[want];
      el.classList.toggle('show', want !== null);
    }
  }

  return { update };
}

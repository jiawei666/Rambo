import './vendor/agent-robot-avatar/agent-robot-avatar.js';

// The avatar itself stays still until hovered. All face and head motion comes
// from the upstream component; this file only wires preview controls.
const hero = document.querySelector('#hero');
const miniature = document.querySelector('#miniature');
const waiting = [...document.querySelectorAll('.loading-avatar')];
const interactive = [hero, miniature];
const followAreas = new Map([[hero, hero], [miniature, document.querySelector('.context')]]);
const avatars = [...interactive, ...waiting];
const settleTimers = new WeakMap();
const actions = [
  ['idle', '恢复待机'], ['bored', '无聊'], ['waiting', '等待一轮'], ['waiting-wrap', '绕行等待'],
  ['input', '输入'], ['send', '发送'], ['success', '成功'], ['failure', '失落'], ['warning', '警觉'],
  ['inspect', '观察'], ['angry', '生气'], ['blocked', '受阻'], ['error', '错误'], ['surprise', '惊讶'],
  ['love', '爱心'], ['random', '老虎机'], ['sleep', '睡眠'], ['wake', '唤醒']
];
const labels = Object.fromEntries(actions);
const state = document.querySelector('#state');

function setFollowing(avatar, enabled, area = avatar) {
  const currentTimer = settleTimers.get(avatar);
  window.clearTimeout(currentTimer);
  if (enabled) {
    avatar.setAttribute('motion', 'auto');
    avatar.setPointerFollow(true);
    return;
  }

  avatar.setPointerFollow(false);
  const timer = window.setTimeout(() => {
    if (!area.matches(':hover')) avatar.setAttribute('motion', 'reduce');
    settleTimers.delete(avatar);
  }, 360);
  settleTimers.set(avatar, timer);
}

for (const avatar of avatars) {
  avatar.setAttribute('auto-sleep', '0');
  avatar.setAttribute('wake-on', 'manual');
  avatar.setAttribute('motion', waiting.includes(avatar) ? 'auto' : 'reduce');
  avatar.setPointerFollow(false);
}
for (const [avatar, area] of followAreas) {
  if (area !== avatar && avatar._onPointerMove) {
    const originalPointerMove = avatar._onPointerMove;
    avatar._onPointerMove = event => {
      if (!area.matches(':hover')) return originalPointerMove.call(avatar, event);
      const avatarRect = avatar.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      const centerX = avatarRect.left + avatarRect.width / 2;
      const centerY = avatarRect.top + avatarRect.height / 2;
      const maxAreaX = Math.max(Math.abs(areaRect.left - centerX), Math.abs(areaRect.right - centerX), 1);
      const maxAreaY = Math.max(Math.abs(areaRect.top - centerY), Math.abs(areaRect.bottom - centerY), 1);
      const size = Number(avatar.getAttribute('size')) || 28;
      const followX = size * 1.1;
      const followY = size * 0.55;
      const mappedX = Math.max(-followX, Math.min(followX, (event.clientX - centerX) * followX / maxAreaX));
      const mappedY = Math.max(-followY, Math.min(followY, (event.clientY - centerY) * followY / maxAreaY));
      return originalPointerMove.call(avatar, { clientX: centerX + mappedX, clientY: centerY + mappedY });
    };
  }
  area.addEventListener('pointerenter', () => {
    setFollowing(avatar, true, area);
    if (avatar === hero) state.textContent = '眼睛与头部跟随鼠标';
  });
  area.addEventListener('pointerleave', () => {
    setFollowing(avatar, false, area);
    if (avatar === hero) state.textContent = '静止 · 移入头像以跟随';
  });
}

hero.setPressSqueeze(true);
hero.setAntennaDrag(true);
miniature.setPressSqueeze(false);
miniature.setAntennaDrag(false);
for (const avatar of waiting) {
  avatar.setPressSqueeze(false);
  avatar.setAntennaDrag(false);
  void avatar.startWaiting();
}

for (const [action, label] of actions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = () => {
    hero.setAttribute('motion', 'auto');
    hero.setPointerFollow(hero.matches(':hover'));
    hero.play(action);
    state.textContent = `${label} · 播放中`;
  };
  document.querySelector('#actions').append(button);
}

hero.addEventListener('action-state', event => {
  const { action, phase } = event.detail;
  if (phase === 'start') {
    state.textContent = `${labels[action] || action} · 播放中`;
  } else if (phase === 'end' && !hero.matches(':hover')) {
    hero.setPointerFollow(false);
    const currentTimer = settleTimers.get(hero);
    window.clearTimeout(currentTimer);
    const timer = window.setTimeout(() => {
      if (!hero.matches(':hover')) hero.setAttribute('motion', 'reduce');
      settleTimers.delete(hero);
    }, 360);
    settleTimers.set(hero, timer);
    state.textContent = '静止 · 移入头像以跟随';
  }
});

function applyAppearance() {
  for (const avatar of avatars) {
    avatar.setAttribute('color', 'var(--robot-color)');
    avatar.setHeadRoundness(+document.querySelector('#roundness').value);
  }
}

document.querySelector('#roundness').oninput = event => {
  document.querySelector('#roundnessValue').textContent = event.target.value;
  applyAppearance();
};
document.querySelector('#size').oninput = event => {
  hero.setAttribute('size', event.target.value);
  document.querySelector('#sizeValue').textContent = `${event.target.value}px`;
};
document.querySelectorAll('[data-color]').forEach(button => {
  button.onclick = () => {
    document.documentElement.style.setProperty('--robot-color', button.dataset.color);
    document.querySelector('.swatch.chosen')?.classList.remove('chosen');
    button.classList.add('chosen');
    applyAppearance();
  };
});
document.querySelector('#theme').onclick = event => {
  document.body.classList.toggle('dark');
  event.target.textContent = document.body.classList.contains('dark') ? '切换至白天' : '切换至夜间';
};

let running = true;
document.querySelector('#waitingToggle').onclick = event => {
  running = !running;
  for (const avatar of waiting) {
    if (running) void avatar.startWaiting();
    else avatar.stopWaiting();
  }
  event.target.textContent = running ? '结束运行' : '开始运行';
  document.querySelector('#waitingLabel').textContent = running ? '正在思考' : '运行已结束';
};

applyAppearance();
if (matchMedia('(prefers-color-scheme: dark)').matches) document.querySelector('#theme').click();

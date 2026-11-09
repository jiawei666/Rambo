import { useLayoutEffect, useRef } from 'react';
import './vendor/agent-robot-avatar/agent-robot-avatar.js';
import type { AgentRobotAvatar as RobotElement } from './vendor/agent-robot-avatar/agent-robot-avatar.js';
import {
  encodeRobotAvatar, parseRobotAvatar, ROBOT_EYE_STYLES, ROBOT_HEAD_ROUNDNESS,
  type RobotEyeStyle, type RobotSelection
} from '../shared/robot-avatar';

export const ROBOT_COLORS = [
  { id: 'black', label: '黑色', value: '#08090b' },
  { id: 'brown', label: '棕色', value: '#a06b39' },
  { id: 'red', label: '红色', value: '#fb2b3e' },
  { id: 'orange', label: '橙色', value: '#fd690f' },
  { id: 'yellow', label: '黄色', value: '#f59312' },
  { id: 'green', label: '绿色', value: '#14c16f' },
  { id: 'cyan', label: '青色', value: '#13b7a2' },
  { id: 'blue', label: '蓝色', value: '#1e86fc' },
  { id: 'violet', label: '紫色', value: '#8f59f9' },
  { id: 'magenta', label: '洋红', value: '#f93498' },
  { id: 'gray', label: '灰色', value: '#959595' }
] as const;
const ROBOT_EYE_LABELS: Record<RobotEyeStyle, string> = {
  idle: '待机', happy: '开心', sad: '难过', angry: '生气',
  sleepy: '困倦', sleep: '闭眼', surprise: '惊讶'
};
export { ROBOT_EYE_STYLES, encodeRobotAvatar, parseRobotAvatar };
export type { RobotSelection };

function randomItem<T>(items: readonly T[]): T {
  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  return items[random % items.length];
}

export function createInitialRobotAvatar(): string {
  const color = ROBOT_COLORS[1 + crypto.getRandomValues(new Uint32Array(1))[0] % (ROBOT_COLORS.length - 1)].id;
  return encodeRobotAvatar({ color, eyeStyle: randomItem(ROBOT_EYE_STYLES) });
}
const SIZES = { small: 22, sidebar: 40, regular: 34, large: 48, picker: 36, preview: 96 } as const;
type PointerMovePoint = { clientX: number; clientY: number };
type RobotWithPointerHook = RobotElement & { _onPointerMove?: (event: PointerMovePoint) => void };
type RobotWithEyePose = RobotElement & {
  setState?: (state: RobotEyeStyle, options?: { duration?: number; notify?: boolean }) => unknown;
  _updateMorph?: (now: number) => unknown;
  _draw?: (now: number) => unknown;
  _sleeping?: boolean;
  _expressionLock?: boolean;
};

function syncRobotEyePose(robot: RobotElement, eyeStyle: RobotEyeStyle, animated: boolean) {
  const posedRobot = robot as RobotWithEyePose;
  // An animated avatar is about to enter the waiting action. Do not let the
  // selected sleep eye pose pause its frame loop before that action starts.
  const pose = animated && eyeStyle === 'sleep' ? 'idle' : eyeStyle;
  posedRobot.setState?.(pose, { duration: 0, notify: false });
  // setState only schedules the morph; commit it now so a newly inserted or
  // recolored avatar never paints the upstream idle-eye shape first.
  posedRobot._updateMorph?.(performance.now());
  posedRobot._draw?.(performance.now());
  if (!animated) {
    posedRobot._sleeping = false;
    posedRobot._expressionLock = false;
  }
}

export function RobotAvatar({ value, size = 'regular', animated = false, working = false, followOnHover = false }: {
  value: string;
  size?: keyof typeof SIZES;
  animated?: boolean;
  working?: boolean;
  followOnHover?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const robotRef = useRef<RobotElement | null>(null);
  const selection = parseRobotAvatar(value);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const robot = document.createElement('agent-robot-avatar') as RobotElement;
    robotRef.current = robot;
    robot.setAttribute('size', String(SIZES[size]));
    robot.setAttribute('color', `var(--avatar-ink-${selection.color}, ${ROBOT_COLORS.find(c => c.id === selection.color)?.value})`);
    robot.setAttribute('auto-sleep', '0');
    robot.setAttribute('wake-on', 'manual');
    robot.setAttribute('motion', animated || working ? 'auto' : 'reduce');
    robot.setAttribute('press-squeeze', 'false');
    robot.setAttribute('antenna-drag', 'false');
    robot.setAttribute('aria-hidden', 'true');
    container.append(robot);
    robot.setPointerFollow(false);
    robot.setPressSqueeze(false);
    robot.setAntennaDrag(false);
    robot.setHeadRoundness(ROBOT_HEAD_ROUNDNESS);
    // The upstream component appends the antenna on its first frame. A
    // shadow-root rule keeps it absent even after that deferred insertion.
    const noAntenna = document.createElement('style');
    noAntenna.textContent = '#antennaDot{display:none!important;pointer-events:none!important}';
    robot.shadowRoot?.append(noAntenna);
    syncRobotEyePose(robot, selection.eyeStyle, animated || working);
    const followArea = followOnHover
      ? container.closest<HTMLElement>('[data-avatar-follow-region]') ?? container
      : null;
    const pointerHook = robot as RobotWithPointerHook;
    const originalPointerMove = pointerHook._onPointerMove;
    if (followArea && originalPointerMove) {
      pointerHook._onPointerMove = event => {
        if (!followArea.matches(':hover')) return originalPointerMove.call(pointerHook, event);
        const avatarRect = robot.getBoundingClientRect();
        const areaRect = followArea.getBoundingClientRect();
        const centerX = avatarRect.left + avatarRect.width / 2;
        const centerY = avatarRect.top + avatarRect.height / 2;
        const maxAreaX = Math.max(Math.abs(areaRect.left - centerX), Math.abs(areaRect.right - centerX), 1);
        const maxAreaY = Math.max(Math.abs(areaRect.top - centerY), Math.abs(areaRect.bottom - centerY), 1);
        const followX = SIZES[size] * 1.1;
        const followY = SIZES[size] * 0.55;
        const mappedX = Math.max(-followX, Math.min(followX, (event.clientX - centerX) * followX / maxAreaX));
        const mappedY = Math.max(-followY, Math.min(followY, (event.clientY - centerY) * followY / maxAreaY));
        return originalPointerMove.call(pointerHook, { clientX: centerX + mappedX, clientY: centerY + mappedY });
      };
    }
    let settleTimer = 0;
    const enableFollow = () => {
      if (animated || working) return;
      window.clearTimeout(settleTimer);
      robot.setAttribute('motion', 'auto');
      robot.setPointerFollow(true);
    };
    const disableFollow = () => {
      if (animated || working) return;
      robot.setPointerFollow(false);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (!container.matches(':hover')) robot.setAttribute('motion', 'reduce');
      }, 360);
    };
    if (!animated && !working && followArea) {
      followArea.addEventListener('pointermove', enableFollow);
      followArea.addEventListener('pointerenter', enableFollow);
      followArea.addEventListener('pointerleave', disableFollow);
    } else if (animated) {
      void robot.startWaiting();
    }
    // Working avatars keep their normal eyes, autonomous gaze and blinking.
    // A slow head turn/nod adds an unmistakable work pose without waiting eyes.
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let headAnimation: Animation | undefined;
    const syncWorkMotion = () => {
      headAnimation?.cancel();
      if (!working || motionPreference.matches) return;
      const head = robot.shadowRoot?.getElementById('headMotion');
      if (!head) return;
      head.style.transformBox = 'view-box';
      head.style.transformOrigin = '120px 120px';
      headAnimation = head.animate([
        { transform: 'translate(0px, 0px) rotate(0deg)' },
        { transform: 'translate(-2px, 1px) rotate(-7deg)', offset: 0.25 },
        { transform: 'translate(0px, 3px) rotate(0deg)', offset: 0.48 },
        { transform: 'translate(2px, -1px) rotate(7deg)', offset: 0.75 },
        { transform: 'translate(0px, 0px) rotate(0deg)' }
      ], { duration: 4200, iterations: Infinity, easing: 'ease-in-out' });
      // Concurrent Bots should feel alive rather than move in lockstep.
      headAnimation.currentTime = Math.random() * 4200;
    };
    syncWorkMotion();
    motionPreference.addEventListener('change', syncWorkMotion);
    // Idle avatars stay still. The sidebar can map its whole Bot row into the original follow range.
    return () => {
      headAnimation?.cancel();
      motionPreference.removeEventListener('change', syncWorkMotion);
      window.clearTimeout(settleTimer);
      followArea?.removeEventListener('pointermove', enableFollow);
      followArea?.removeEventListener('pointerenter', enableFollow);
      followArea?.removeEventListener('pointerleave', disableFollow);
      if (followArea && originalPointerMove) pointerHook._onPointerMove = originalPointerMove;
      robot.remove();
      if (robotRef.current === robot) robotRef.current = null;
    };
  }, [size, animated, working, followOnHover]);

  useLayoutEffect(() => {
    const robot = robotRef.current;
    if (!robot) return;
    robot.setAttribute('color', `var(--avatar-ink-${selection.color}, ${ROBOT_COLORS.find(c => c.id === selection.color)?.value})`);
    syncRobotEyePose(robot, selection.eyeStyle, animated || working);
  }, [selection.color, selection.eyeStyle, animated, working]);

  return <span ref={host} className={`bot-avatar robot-avatar avatar-${size}`}
    data-avatar-color={selection.color}
    aria-hidden="true" />;
}

export function RobotAvatarPicker({ value, onChange, disabled = false, className = '' }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const selected = parseRobotAvatar(value);
  const update = (patch: Partial<RobotSelection>) => onChange(encodeRobotAvatar({ ...selected, ...patch }));
  return <div className={`avatar-picker robot-avatar-picker ${className}`}>
    <div className="avatar-eye-row" role="group" aria-label="眼睛样式">
      {ROBOT_EYE_STYLES.map(eyeStyle => (
        <button key={eyeStyle} type="button" disabled={disabled}
          className={'avatar-eye-cell' + (selected.eyeStyle === eyeStyle ? ' chosen' : '')}
          aria-label={ROBOT_EYE_LABELS[eyeStyle]} aria-pressed={selected.eyeStyle === eyeStyle}
          title={ROBOT_EYE_LABELS[eyeStyle]}
          onClick={() => update({ eyeStyle })}>
          <RobotAvatar value={encodeRobotAvatar({ ...selected, eyeStyle })} size="picker" />
        </button>
      ))}
    </div>
    <div className="avatar-color-row" role="group" aria-label="角色颜色">
      {ROBOT_COLORS.map(color => <button key={color.id} type="button" disabled={disabled}
        className={'avatar-color-cell' + (selected.color === color.id ? ' chosen' : '')}
        aria-label={color.label} aria-pressed={selected.color === color.id} title={color.label}
        onClick={() => update({ color: color.id })}>
        <span className="avatar-color-swatch" style={{
          backgroundColor: `var(--avatar-swatch-${color.id}, var(--avatar-ink-${color.id}, ${color.value}))`
        }} />
      </button>)}
    </div>
  </div>;
}

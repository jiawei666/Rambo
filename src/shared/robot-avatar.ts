export const ROBOT_COLOR_IDS = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'
] as const;
export type RobotColorId = typeof ROBOT_COLOR_IDS[number];

// Stable native selectable eye poses exposed by Agent Robot Avatar. The input
// pose is intentionally excluded as a Bot appearance.
export const ROBOT_EYE_STYLES = ['idle', 'happy', 'sad', 'angry', 'sleepy', 'sleep', 'surprise'] as const;
export type RobotEyeStyle = typeof ROBOT_EYE_STYLES[number];
export const ROBOT_HEAD_ROUNDNESS = 100;

export type RobotSelection = { color: RobotColorId; eyeStyle: RobotEyeStyle };

const legacyRobotColors: Record<string, RobotColorId> = {
  spark: 'magenta', orbit: 'blue', leaf: 'green', sun: 'yellow', moon: 'violet', wave: 'cyan'
};

export function isCurrentRobotAvatar(value: string): boolean {
  const match = /^agent-robot:v2:(\d{1,3}):([a-z]+):([a-z]+)$/.exec(value);
  return !!match && ROBOT_COLOR_IDS.includes(match[2] as RobotColorId) &&
    ROBOT_EYE_STYLES.includes(match[3] as RobotEyeStyle);
}

export function encodeRobotAvatar(value: RobotSelection): string {
  // Keep the v2 wire shape so existing rows remain readable. The first
  // numeric slot is retained for compatibility but always means circle face.
  return `agent-robot:v2:${ROBOT_HEAD_ROUNDNESS}:${value.color}:${value.eyeStyle}`;
}

export function parseRobotAvatar(value: string): RobotSelection {
  const current = /^agent-robot:v2:(\d{1,3}):([a-z]+):([a-z]+)$/.exec(value);
  if (current) {
    const color = ROBOT_COLOR_IDS.find(item => item === current[2]) ?? 'blue';
    const eyeStyle = ROBOT_EYE_STYLES.find(item => item === current[3]) ?? 'idle';
    return { color, eyeStyle };
  }
  const robot = /^agent-robot:v1:(\d{1,3}):([a-z]+)(?::[a-z]+)?$/.exec(value);
  if (robot) {
    const color = ROBOT_COLOR_IDS.find(item => item === robot[2]) ?? 'blue';
    return { color, eyeStyle: 'idle' };
  }

  const oldColor = /^grok-avatar:v1:[a-z]+:([a-z]+)$/.exec(value)?.[1];
  const color = ROBOT_COLOR_IDS.find(item => item === oldColor) ?? legacyRobotColors[value] ?? 'blue';
  return { color, eyeStyle: 'idle' };
}

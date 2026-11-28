export const pigBehavior = {
  root: {
    type: 'action',
    name: 'wander',
    nodeType: 'Wander',
    speed: 1.15,
    idleMin: 1.5,
    idleMax: 3.5,
    walkMin: 2,
    walkMax: 4,
  },
} as const;

export const sheepBehavior = {
  root: {
    type: 'action',
    name: 'wander',
    nodeType: 'Wander',
    speed: 1.0,
    idleMin: 1.5,
    idleMax: 3.5,
    walkMin: 2,
    walkMax: 4,
  },
} as const;

export const zombieBehavior = {
  root: {
    type: 'selector',
    name: 'zombie_root',
    children: [
      {
        type: 'sequence',
        name: 'combat',
        children: [
          {
            type: 'condition',
            name: 'can_see_player',
            nodeType: 'DistanceLt',
            target: 'player',
            dist: 26,
            horizontal: true,
          },
          {
            type: 'parallel',
            name: 'chase_attack',
            children: [
              {
                type: 'action',
                name: 'chase',
                nodeType: 'ChasePlayer',
                speed: 1.5225,
                stopDist: 0,
                speedFar: 1.5225,
                speedClose: 1.155,
                closeDist: 2.2,
              },
              { type: 'action', name: 'attack', nodeType: 'AttackPlayer', damage: 3, cooldown: 1.05, attackRange: 1.7 },
            ],
          },
        ],
      },
      {
        type: 'action',
        name: 'wander',
        nodeType: 'Wander',
        speed: 1.05,
        idleMin: 1.5,
        idleMax: 3.5,
        walkMin: 2,
        walkMax: 4,
      },
    ],
  },
} as const;

export const skeletonBehavior = {
  root: {
    type: 'selector',
    name: 'skeleton_root',
    children: [
      {
        type: 'sequence',
        name: 'combat',
        children: [
          {
            type: 'condition',
            name: 'can_see_player',
            nodeType: 'DistanceLt',
            target: 'player',
            dist: 26,
            horizontal: true,
          },
          {
            type: 'parallel',
            name: 'chase_attack',
            children: [
              {
                type: 'action',
                name: 'chase',
                nodeType: 'ChasePlayer',
                speed: 1.45,
                stopDist: 0,
                speedFar: 1.45,
                speedClose: 1.1,
                closeDist: 2.2,
              },
              { type: 'action', name: 'attack', nodeType: 'AttackPlayer', damage: 2, cooldown: 1.05, attackRange: 1.7 },
            ],
          },
        ],
      },
      {
        type: 'action',
        name: 'wander',
        nodeType: 'Wander',
        speed: 1.0,
        idleMin: 1.5,
        idleMax: 3.5,
        walkMin: 2,
        walkMax: 4,
      },
    ],
  },
} as const;

/** 苦力怕：发现玩家后贴近自爆（伤害由实体自爆结算，行为树只负责逼近） */
export const creeperBehavior = {
  root: {
    type: 'selector',
    name: 'creeper_root',
    children: [
      {
        type: 'sequence',
        name: 'combat',
        children: [
          {
            type: 'condition',
            name: 'can_see_player',
            nodeType: 'DistanceLt',
            target: 'player',
            dist: 24,
            horizontal: true,
          },
          {
            type: 'parallel',
            name: 'chase_attack',
            children: [
              {
                type: 'action',
                name: 'chase',
                nodeType: 'ChasePlayer',
                speed: 1.45,
                stopDist: 0,
                speedFar: 1.45,
                speedClose: 1.15,
                closeDist: 2.2,
              },
              { type: 'action', name: 'attack', nodeType: 'AttackPlayer', damage: 0, cooldown: 1.05, attackRange: 1.9 },
            ],
          },
        ],
      },
      {
        type: 'action',
        name: 'wander',
        nodeType: 'Wander',
        speed: 1.0,
        idleMin: 1.5,
        idleMax: 3.5,
        walkMin: 2,
        walkMax: 4,
      },
    ],
  },
} as const;

/** 蜘蛛：感知距离更远、移动更快，贴身撕咬 */
export const spiderBehavior = {
  root: {
    type: 'selector',
    name: 'spider_root',
    children: [
      {
        type: 'sequence',
        name: 'combat',
        children: [
          {
            type: 'condition',
            name: 'can_see_player',
            nodeType: 'DistanceLt',
            target: 'player',
            dist: 30,
            horizontal: true,
          },
          {
            type: 'parallel',
            name: 'chase_attack',
            children: [
              {
                type: 'action',
                name: 'chase',
                nodeType: 'ChasePlayer',
                speed: 1.8,
                stopDist: 0,
                speedFar: 1.8,
                speedClose: 1.4,
                closeDist: 2.2,
              },
              { type: 'action', name: 'attack', nodeType: 'AttackPlayer', damage: 3, cooldown: 1.05, attackRange: 1.8 },
            ],
          },
        ],
      },
      {
        type: 'action',
        name: 'wander',
        nodeType: 'Wander',
        speed: 1.05,
        idleMin: 1.5,
        idleMax: 3.5,
        walkMin: 2,
        walkMax: 4,
      },
    ],
  },
} as const;

/** 鱿鱼：水中缓慢游动，无攻击行为 */
export const squidBehavior = {
  root: {
    type: 'action',
    name: 'wander',
    nodeType: 'Wander',
    speed: 0.55,
    idleMin: 2,
    idleMax: 4,
    walkMin: 2,
    walkMax: 4,
  },
} as const;

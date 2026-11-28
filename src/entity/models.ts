import * as THREE from 'three';
import { BALL } from './basketball';

/**
 * 角色与生物模型：原版风格的盒装模型 + 程序化皮肤纹理。
 */

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color });

function box(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[]): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  return m;
}

/** 肢体：顶部为旋转轴心 */
function limb(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[]): THREE.Group {
  const g = new THREE.Group();
  const m = box(w, h, d, mat);
  m.position.y = -h / 2;
  g.add(m);
  return g;
}

function faceTexture(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKIN = 0xb9855c;
const SHIRT = 0x00a8a8;
const PANTS = 0x3b3b8f;
const SHOE = 0x4a4a4a;

function steveHeadMaterials(): THREE.Material[] {
  const px = (ctx: CanvasRenderingContext2D, x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  };
  const front = faceTexture((ctx) => {
    ctx.fillStyle = '#b9855c';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#3c2e1e';
    ctx.fillRect(0, 0, 8, 2);
    px(ctx, 0, 2, '#3c2e1e');
    px(ctx, 7, 2, '#3c2e1e');
    // 眼睛
    px(ctx, 2, 3, '#ffffff');
    px(ctx, 3, 3, '#523d8c');
    px(ctx, 5, 3, '#523d8c');
    px(ctx, 6, 3, '#ffffff');
    // 鼻子与嘴
    px(ctx, 3, 4, '#a06a44');
    px(ctx, 4, 4, '#a06a44');
    px(ctx, 3, 5, '#6e4a32');
    px(ctx, 4, 5, '#6e4a32');
  });
  const side = faceTexture((ctx) => {
    ctx.fillStyle = '#b9855c';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#3c2e1e';
    ctx.fillRect(0, 0, 8, 2);
    ctx.fillRect(0, 2, 1, 2);
  });
  const top = faceTexture((ctx) => {
    ctx.fillStyle = '#3c2e1e';
    ctx.fillRect(0, 0, 8, 8);
  });
  const skin = faceTexture((ctx) => {
    ctx.fillStyle = '#b9855c';
    ctx.fillRect(0, 0, 8, 8);
  });
  const mk = (t: THREE.Texture) => new THREE.MeshLambertMaterial({ map: t });
  // BoxGeometry 材质顺序: +x -x +y -y +z -z；正面朝 +z
  return [mk(side), mk(side), mk(top), mk(skin), mk(front), mk(top)];
}

export class PlayerModel {
  readonly group = new THREE.Group();
  private armL: THREE.Group;
  private armR: THREE.Group;
  private legL: THREE.Group;
  private legR: THREE.Group;
  private head: THREE.Mesh;
  private body: THREE.Mesh;

  constructor() {
    const skinM = lambert(SKIN);
    const shirtM = lambert(SHIRT);
    const pantsM = lambert(PANTS);
    const shoeM = lambert(SHOE);

    this.head = box(0.5, 0.5, 0.5, steveHeadMaterials());
    this.head.position.y = 1.75;
    this.body = box(0.5, 0.75, 0.25, shirtM);
    this.body.position.y = 1.125;

    const armMat = [shirtM, shirtM, shirtM, skinM, shirtM, shirtM];
    this.armL = limb(0.25, 0.75, 0.25, armMat);
    this.armL.position.set(-0.375, 1.5, 0);
    this.armR = limb(0.25, 0.75, 0.25, armMat);
    this.armR.position.set(0.375, 1.5, 0);

    const legMat = [pantsM, pantsM, pantsM, shoeM, pantsM, pantsM];
    this.legL = limb(0.25, 0.75, 0.25, legMat);
    this.legL.position.set(-0.125, 0.75, 0);
    this.legR = limb(0.25, 0.75, 0.25, legMat);
    this.legR.position.set(0.125, 0.75, 0);

    this.group.add(this.head, this.body, this.armL, this.armR, this.legL, this.legR);
  }

  update(pos: THREE.Vector3, yaw: number, walkPhase: number, moving: boolean, swing: number, pitch: number) {
    this.group.position.copy(pos);
    this.group.rotation.y = yaw;
    const amp = moving ? 0.75 : 0;
    const s = Math.sin(walkPhase) * amp;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    this.armL.rotation.x = -s * 0.8;
    this.armR.rotation.x = s * 0.8;
    if (swing > 0) {
      this.armR.rotation.x = -Math.sin(swing * Math.PI) * 2.1;
    }
    this.head.rotation.x = pitch * 0.6;
  }
}

export interface MobModel {
  group: THREE.Group;
  /** 第三参仅篮球使用：自旋角速度，用于分格线的轻微摆动 */
  animate(phase: number, moving: boolean, spin?: { x: number; y: number; z: number }): void;
}

/** 猪 */
export function buildPig(): MobModel {
  const group = new THREE.Group();
  const pink = lambert(0xf0a5a2);
  const darkPink = lambert(0xd87f7e);
  const body = box(0.62, 0.55, 1.0, pink);
  body.position.y = 0.72;
  const head = box(0.5, 0.5, 0.45, pink);
  head.position.set(0, 0.85, 0.68);
  const snout = box(0.26, 0.18, 0.08, darkPink);
  snout.position.set(0, 0.78, 0.94);
  const eyeM = lambert(0x1a1a1a);
  const eyeL = box(0.08, 0.08, 0.02, eyeM);
  eyeL.position.set(-0.14, 0.95, 0.91);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.14;
  const legs: THREE.Group[] = [];
  for (const [x, z] of [
    [-0.2, 0.32],
    [0.2, 0.32],
    [-0.2, -0.32],
    [0.2, -0.32],
  ] as const) {
    const leg = limb(0.2, 0.45, 0.2, pink);
    leg.position.set(x, 0.45, z);
    legs.push(leg);
    group.add(leg);
  }
  group.add(body, head, snout, eyeL, eyeR);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.7 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      legs[2].rotation.x = -s;
      legs[3].rotation.x = s;
    },
  };
}

/** 羊 */
export function buildSheep(): MobModel {
  const group = new THREE.Group();
  const wool = lambert(0xe9ecec);
  const face = lambert(0xc9b8a4);
  const legM = lambert(0x8a7a66);
  const body = box(0.72, 0.65, 1.05, wool);
  body.position.y = 0.82;
  const head = box(0.4, 0.42, 0.4, face);
  head.position.set(0, 1.0, 0.68);
  const woolCap = box(0.44, 0.2, 0.3, wool);
  woolCap.position.set(0, 1.22, 0.62);
  const eyeM = lambert(0x1a1a1a);
  const eyeL = box(0.07, 0.07, 0.02, eyeM);
  eyeL.position.set(-0.11, 1.02, 0.89);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.11;
  const legs: THREE.Group[] = [];
  for (const [x, z] of [
    [-0.24, 0.34],
    [0.24, 0.34],
    [-0.24, -0.34],
    [0.24, -0.34],
  ] as const) {
    const leg = limb(0.18, 0.5, 0.18, legM);
    leg.position.set(x, 0.5, z);
    legs.push(leg);
    group.add(leg);
  }
  group.add(body, head, woolCap, eyeL, eyeR);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.65 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      legs[2].rotation.x = -s;
      legs[3].rotation.x = s;
    },
  };
}
/** 僵尸：绿皮、双臂前伸的敌对生物 */
/** 骷髅：复用僵尸骨架，改白骨配色，手持骨箭 */
export function buildSkeleton(): MobModel {
  const group = new THREE.Group();
  const bone = lambert(0xe4e4d8);
  const boneDark = lambert(0xb9b9aa);
  const eyeM = lambert(0x1a1a1a);

  const body = box(0.5, 0.75, 0.25, boneDark);
  body.position.y = 1.125;
  // 肋骨纹理：几道白色横条
  for (let i = 0; i < 3; i++) {
    const rib = box(0.46, 0.06, 0.27, bone);
    rib.position.set(0, 0.9 + i * 0.2, 0);
    group.add(rib);
  }

  const head = box(0.5, 0.5, 0.5, bone);
  head.position.y = 1.75;
  const eyeL = box(0.1, 0.1, 0.02, eyeM);
  eyeL.position.set(-0.12, 1.8, 0.26);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.12;

  const armMat = [bone, bone, bone, bone, bone, bone];
  const arms: THREE.Group[] = [];
  for (const x of [-0.375, 0.375]) {
    const arm = limb(0.18, 0.75, 0.18, armMat);
    arm.position.set(x, 1.5, 0);
    arm.rotation.x = -Math.PI / 2.1;
    arms.push(arm);
    group.add(arm);
  }

  const legMat = [bone, bone, bone, boneDark, bone, bone];
  const legs: THREE.Group[] = [];
  for (const x of [-0.125, 0.125]) {
    const leg = limb(0.2, 0.75, 0.2, legMat);
    leg.position.set(x, 0.75, 0);
    legs.push(leg);
    group.add(leg);
  }

  group.add(body, head, eyeL, eyeR);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.72 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      arms[0].rotation.x = -Math.PI / 2.1 + Math.sin(phase * 0.5) * 0.12;
      arms[1].rotation.x = -Math.PI / 2.1 - Math.sin(phase * 0.5) * 0.12;
    },
  };
}

export function buildZombie(): MobModel {
  const group = new THREE.Group();
  const skin = lambert(0x6d9c58);
  const shirt = lambert(0x2f6d63);
  const pants = lambert(0x35357c);
  const eyeM = lambert(0x1b2a16);

  const body = box(0.5, 0.75, 0.25, shirt);
  body.position.y = 1.125;

  const head = box(0.5, 0.5, 0.5, skin);
  head.position.y = 1.75;
  const eyeL = box(0.1, 0.06, 0.02, eyeM);
  eyeL.position.set(-0.12, 1.8, 0.26);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.12;
  const mouth = box(0.22, 0.04, 0.02, lambert(0x2c3f24));
  mouth.position.set(0, 1.63, 0.26);

  const armMat = [shirt, shirt, shirt, skin, shirt, shirt];
  const arms: THREE.Group[] = [];
  for (const x of [-0.375, 0.375]) {
    const arm = limb(0.25, 0.75, 0.25, armMat);
    arm.position.set(x, 1.5, 0);
    arm.rotation.x = -Math.PI / 2.1;
    arms.push(arm);
    group.add(arm);
  }

  const legMat = [pants, pants, pants, lambert(0x2a2a2a), pants, pants];
  const legs: THREE.Group[] = [];
  for (const x of [-0.125, 0.125]) {
    const leg = limb(0.25, 0.75, 0.25, legMat);
    leg.position.set(x, 0.75, 0);
    legs.push(leg);
    group.add(leg);
  }

  group.add(body, head, eyeL, eyeR, mouth);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.72 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      arms[0].rotation.x = -Math.PI / 2.1 + Math.sin(phase * 0.5) * 0.12;
      arms[1].rotation.x = -Math.PI / 2.1 - Math.sin(phase * 0.5) * 0.12;
    },
  };
}

/** 牛：白身棕斑、双角与粉鼻 */
export function buildCow(): MobModel {
  const group = new THREE.Group();
  const brown = lambert(0x5b3f2a);
  const white = lambert(0xe8e2d5);
  const pink = lambert(0xdca0a0);
  const body = box(0.8, 0.7, 1.2, white);
  body.position.y = 0.95;
  const patch = box(0.82, 0.5, 0.5, brown);
  patch.position.set(0, 1.0, -0.3);
  const head = box(0.55, 0.5, 0.5, brown);
  head.position.set(0, 1.15, 0.78);
  const muzzle = box(0.36, 0.24, 0.1, pink);
  muzzle.position.set(0, 1.0, 1.05);
  const hornL = box(0.1, 0.16, 0.1, white);
  hornL.position.set(-0.22, 1.45, 0.78);
  const hornR = hornL.clone();
  hornR.position.x = 0.22;
  const eyeM = lambert(0x1a1a1a);
  const eyeL = box(0.08, 0.08, 0.02, eyeM);
  eyeL.position.set(-0.16, 1.22, 1.02);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.16;
  const legs: THREE.Group[] = [];
  for (const [x, z] of [
    [-0.26, 0.38],
    [0.26, 0.38],
    [-0.26, -0.38],
    [0.26, -0.38],
  ] as const) {
    const leg = limb(0.2, 0.6, 0.2, brown);
    leg.position.set(x, 0.6, z);
    legs.push(leg);
    group.add(leg);
  }
  group.add(body, patch, head, muzzle, hornL, hornR, eyeL, eyeR);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.6 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      legs[2].rotation.x = -s;
      legs[3].rotation.x = s;
    },
  };
}

/** 鸡：白羽红冠、黄喙与短腿 */
export function buildChicken(): MobModel {
  const group = new THREE.Group();
  const white = lambert(0xf2f0e8);
  const red = lambert(0xc0392b);
  const yellow = lambert(0xe8c24b);
  const eyeM = lambert(0x1a1a1a);
  const body = box(0.35, 0.35, 0.45, white);
  body.position.y = 0.35;
  const head = box(0.26, 0.26, 0.26, white);
  head.position.set(0, 0.6, 0.18);
  const beak = box(0.12, 0.08, 0.1, yellow);
  beak.position.set(0, 0.56, 0.34);
  const comb = box(0.08, 0.12, 0.18, red);
  comb.position.set(0, 0.76, 0.14);
  const wattle = box(0.08, 0.1, 0.06, red);
  wattle.position.set(0, 0.46, 0.32);
  const eyeL = box(0.05, 0.05, 0.02, eyeM);
  eyeL.position.set(-0.09, 0.64, 0.3);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.09;
  const legs: THREE.Group[] = [];
  for (const x of [-0.1, 0.1]) {
    const leg = limb(0.07, 0.28, 0.07, yellow);
    leg.position.set(x, 0.28, 0);
    legs.push(leg);
    group.add(leg);
  }
  group.add(body, head, beak, comb, wattle, eyeL, eyeR);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.8 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
    },
  };
}

/** 兔：灰褐毛、长耳与白尾 */
export function buildRabbit(): MobModel {
  const group = new THREE.Group();
  const fur = lambert(0x9c8b7a);
  const furLight = lambert(0xd9d2c5);
  const eyeM = lambert(0x1a1a1a);
  const body = box(0.4, 0.38, 0.55, fur);
  body.position.y = 0.32;
  const head = box(0.32, 0.3, 0.3, fur);
  head.position.set(0, 0.46, 0.34);
  const earL = box(0.1, 0.34, 0.08, fur);
  earL.position.set(-0.1, 0.76, 0.3);
  const earR = box(0.1, 0.34, 0.08, fur);
  earR.position.set(0.1, 0.76, 0.3);
  const tail = box(0.16, 0.16, 0.16, furLight);
  tail.position.set(0, 0.38, -0.34);
  const eyeL = box(0.06, 0.06, 0.02, eyeM);
  eyeL.position.set(-0.1, 0.5, 0.5);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.1;
  const legs: THREE.Group[] = [];
  for (const [x, z] of [
    [-0.14, 0.18],
    [0.14, 0.18],
    [-0.14, -0.18],
    [0.14, -0.18],
  ] as const) {
    const leg = limb(0.12, 0.24, 0.14, fur);
    leg.position.set(x, 0.24, z);
    legs.push(leg);
    group.add(leg);
  }
  group.add(body, head, earL, earR, tail, eyeL, eyeR);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.85 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      legs[2].rotation.x = -s;
      legs[3].rotation.x = s;
    },
  };
}

/** 苦力怕：绿皮、四足、无颈的裂口脸（内容更新：更多生物） */
export function buildCreeper(): MobModel {
  const group = new THREE.Group();
  const skin = lambert(0x5fbf4a);
  const skinDark = lambert(0x3f8a33);
  const face = lambert(0x1d2c19);
  const body = box(0.5, 0.75, 0.3, skin);
  body.position.y = 1.05;
  const head = box(0.52, 0.5, 0.42, skin);
  head.position.y = 1.75;
  const eyeL = box(0.1, 0.12, 0.02, face);
  eyeL.position.set(-0.13, 1.82, 0.22);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.13;
  const mouth = box(0.16, 0.14, 0.02, face);
  mouth.position.set(0, 1.62, 0.22);
  const legs: THREE.Group[] = [];
  for (const x of [-0.14, 0.14]) {
    for (const z of [-0.12, 0.12]) {
      const leg = limb(0.2, 0.65, 0.2, z > 0 ? skin : skinDark);
      leg.position.set(x, 0.65, z);
      legs.push(leg);
      group.add(leg);
    }
  }
  group.add(body, head, eyeL, eyeR, mouth);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.7 : 0;
      legs[0].rotation.x = s;
      legs[1].rotation.x = -s;
      legs[2].rotation.x = -s;
      legs[3].rotation.x = s;
    },
  };
}

/** 蜘蛛：黑褐躯体 + 八条分节腿 + 红色眼组 */
export function buildSpider(): MobModel {
  const group = new THREE.Group();
  const body = lambert(0x2b2118);
  const headM = lambert(0x3b2d20);
  const eyeM = lambert(0xc4302a);
  const abdomen = box(0.62, 0.42, 0.66, body);
  abdomen.position.set(0, 0.5, -0.32);
  const head = box(0.42, 0.34, 0.4, headM);
  head.position.set(0, 0.48, 0.25);
  for (const [x, y] of [
    [-0.12, 0.56],
    [0.12, 0.56],
    [-0.16, 0.48],
    [0.16, 0.48],
  ] as const) {
    const eye = box(0.06, 0.06, 0.02, eyeM);
    eye.position.set(x, y, 0.46);
    group.add(eye);
  }
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const leg = new THREE.Group();
      const upper = box(0.1, 0.1, 0.55, body);
      upper.position.set(side * 0.36, 0.08, 0.2 - i * 0.16);
      upper.rotation.y = side * (0.3 + i * 0.16);
      const lower = box(0.08, 0.42, 0.08, body);
      lower.position.set(side * 0.56, -0.2, 0.2 - i * 0.16);
      leg.add(upper, lower);
      leg.position.y = 0.5;
      legs.push(leg);
      group.add(leg);
    }
  }
  group.add(abdomen, head);
  return {
    group,
    animate(phase, moving) {
      const s = moving ? Math.sin(phase) * 0.5 : 0;
      legs.forEach((leg, i) => {
        leg.rotation.x = (i % 2 ? -s : s) * 0.6;
      });
    },
  };
}

/** 鱿鱼：紫色外套膜 + 八条触腕 + 大白眼（水中悬浮） */
export function buildSquid(): MobModel {
  const group = new THREE.Group();
  const skin = lambert(0x8a5aa8);
  const skinDark = lambert(0x6d4387);
  const eyeWhite = lambert(0xf4f0ea);
  const eyeM = lambert(0x1a1a1a);
  const mantle = box(0.55, 0.6, 0.55, skin);
  mantle.position.y = 0.52;
  const head = box(0.4, 0.28, 0.4, skinDark);
  head.position.y = 0.18;
  const eyeL = box(0.1, 0.1, 0.02, eyeWhite);
  eyeL.position.set(-0.12, 0.2, 0.21);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.12;
  const pupilL = box(0.05, 0.05, 0.02, eyeM);
  pupilL.position.set(-0.12, 0.2, 0.23);
  const pupilR = pupilL.clone();
  pupilR.position.x = 0.12;
  const tentacles: THREE.Group[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const t = limb(0.07, 0.32, 0.07, i % 2 ? skin : skinDark);
    t.position.set(Math.cos(a) * 0.16, 0.06, Math.sin(a) * 0.16);
    tentacles.push(t);
    group.add(t);
  }
  group.add(mantle, head, eyeL, eyeR, pupilL, pupilR);
  return {
    group,
    animate(phase, moving) {
      tentacles.forEach((t, i) => {
        t.rotation.x = Math.sin(phase * (moving ? 1.6 : 0.7) + i) * 0.22;
      });
    },
  };
}

/** 篮球：橙色低多边形球体 + 程序化像素分格线，零外部资源 */
export function buildBasketball(): MobModel {
  const group = new THREE.Group();
  const tex = faceTexture((ctx) => {
    ctx.fillStyle = '#d2691e';
    ctx.fillRect(0, 0, 8, 8);
    // 明暗斑块保留像素颗粒感
    ctx.fillStyle = '#b95a1a';
    ctx.fillRect(0, 0, 3, 2);
    ctx.fillRect(5, 5, 3, 2);
    ctx.fillStyle = '#e48335';
    ctx.fillRect(1, 3, 2, 2);
    ctx.fillRect(5, 1, 2, 1);
    // 深色分格线：一条经线 + 一条纬线
    ctx.fillStyle = '#2b1408';
    ctx.fillRect(3, 0, 1, 8);
    ctx.fillRect(0, 3, 8, 1);
    // 四角弧缝（阶梯像素），让球面辨识为篮球而非橙色球
    ctx.fillRect(1, 1, 1, 1);
    ctx.fillRect(2, 2, 1, 1);
    ctx.fillRect(5, 5, 1, 1);
    ctx.fillRect(6, 6, 1, 1);
    ctx.fillRect(6, 1, 1, 1);
    ctx.fillRect(5, 2, 1, 1);
    ctx.fillRect(1, 6, 1, 1);
    ctx.fillRect(2, 5, 1, 1);
  });
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  // 球体位于 group 原点；group 渲染时整体上移一个半径（见 Entity.updateBounce）
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL.RADIUS, 12, 8), mat);
  group.add(ball);
  return {
    group,
    animate(_phase, _moving, spin) {
      // 主滚动由 updateBounce 旋转 group；这里用自旋让分格线有轻微摆动
      if (spin && (spin.x || spin.y || spin.z)) {
        ball.rotation.z = Math.sin(spin.x * 0.1) * 0.04;
      }
    },
  };
}

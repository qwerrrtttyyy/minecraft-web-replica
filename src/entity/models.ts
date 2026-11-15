import * as THREE from 'three';

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
    px(ctx, 0, 2, '#3c2e1e'); px(ctx, 7, 2, '#3c2e1e');
    // 眼睛
    px(ctx, 2, 3, '#ffffff'); px(ctx, 3, 3, '#523d8c');
    px(ctx, 5, 3, '#523d8c'); px(ctx, 6, 3, '#ffffff');
    // 鼻子与嘴
    px(ctx, 3, 4, '#a06a44'); px(ctx, 4, 4, '#a06a44');
    px(ctx, 3, 5, '#6e4a32'); px(ctx, 4, 5, '#6e4a32');
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
  animate(phase: number, moving: boolean): void;
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
  for (const [x, z] of [[-0.2, 0.32], [0.2, 0.32], [-0.2, -0.32], [0.2, -0.32]] as const) {
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
  for (const [x, z] of [[-0.24, 0.34], [0.24, 0.34], [-0.24, -0.34], [0.24, -0.34]] as const) {
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

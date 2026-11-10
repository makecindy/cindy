// three ships no types, and @types/three pulls WebGPU globals into every file.
// Only the names this app imports are declared, loosely typed.
declare module 'three' {
  export const Group: any, Mesh: any, MeshStandardMaterial: any, LoadingManager: any, AnimationMixer: any, DoubleSide: any;
  export type Group = any;
  export type Mesh = any;
  export type AnimationMixer = any;
}
declare module 'three/examples/jsm/*';

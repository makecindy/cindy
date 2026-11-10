import { Group, LoadingManager, Mesh, MeshStandardMaterial, DoubleSide } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import dracoWrapper from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?raw';
import dracoWasm from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url&inline';
import { embeddedModelResourceUrl } from './modelPreviewResources';

/** Parse the selected file in memory using per-loader resource policies.
 * This never resolves sibling files or loads a decoder from a CDN. */
export async function loadPreviewModel(file: File): Promise<Group> {
  const bytes = await file.arrayBuffer();
  const manager = new LoadingManager();
  manager.setURLModifier(embeddedModelResourceUrl);
  const extension = file.name.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'glb':
    case 'gltf': {
      // Inline WASM avoids fetch(file://...) in the packaged Electron renderer.
      const wrapperUrl = URL.createObjectURL(new Blob([dracoWrapper], { type: 'text/javascript' }));
      const decoderManager = new LoadingManager();
      decoderManager.setURLModifier((url: string) => {
        if (url === 'draco_wasm_wrapper.js') return wrapperUrl;
        if (url === 'draco_decoder.wasm') return dracoWasm;
        throw new Error('Unknown model decoder resource');
      });
      const draco = new DRACOLoader(decoderManager).setDecoderPath('');
      try {
        const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
        const model = await loader.parseAsync(bytes, '');
        model.scene.animations = model.animations;
        return model.scene;
      } finally {
        draco.dispose();
        URL.revokeObjectURL(wrapperUrl);
      }
    }
    case 'obj':
      return new OBJLoader(manager).parse(new TextDecoder().decode(bytes));
    case 'fbx':
      return new FBXLoader(manager).parse(bytes, '');
    case 'dae': {
      const scene = new ColladaLoader(manager).parse(new TextDecoder().decode(bytes), '')?.scene;
      if (!scene) throw new Error('Invalid model');
      return new Group().add(scene);
    }
    case '3mf':
      return new ThreeMFLoader(manager).parse(bytes);
    case '3ds':
      return new TDSLoader(manager).parse(bytes, '');
    case 'stl':
    case 'ply': {
      const geometry = extension === 'stl'
        ? new STLLoader(manager).parse(bytes)
        : new PLYLoader(manager).parse(bytes);
      geometry.computeVertexNormals();
      const root = new Group();
      root.add(new Mesh(geometry, new MeshStandardMaterial({ roughness: 0.7, side: DoubleSide })));
      return root;
    }
    default:
      throw new Error('Unsupported model format');
  }
}

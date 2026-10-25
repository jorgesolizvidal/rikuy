// Minimal declarations for WebAssembly modules without bundled types.
declare module "draco3dgltf" {
  const draco3d: {
    createDecoderModule(options?: object): Promise<unknown>;
    createEncoderModule(options?: object): Promise<unknown>;
  };
  export default draco3d;
}

declare module "gltf-validator" {
  export function validateBytes(
    data: Uint8Array,
    options?: {
      uri?: string;
      maxIssues?: number;
      externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
    },
  ): Promise<unknown>;
}

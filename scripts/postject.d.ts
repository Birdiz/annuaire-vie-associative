/**
 * `postject` ne publie pas de types. La surface utilisee tient en une fonction : elle est
 * declaree ici plutot que desactivee par un `@ts-expect-error`, pour que le typecheck
 * garde prise sur l'appel.
 */
declare module "postject" {
  export function inject(
    filename: string,
    resourceName: string,
    resourceData: Buffer | Uint8Array,
    options?: {
      machoSegmentName?: string;
      overwrite?: boolean;
      sentinelFuse?: string;
    },
  ): Promise<void>;
}

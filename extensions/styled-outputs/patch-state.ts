export const PATCH_STATE = Symbol.for("styled-outputs:patch-state");
// Versions before patch-state tracking used this marker without retaining the
// original descriptors, so an existing live instance cannot be repaired here.
export const LEGACY_PATCH_STATE = Symbol.for("styled-outputs:patched");

export const LEGACY_PATCH_MESSAGE =
  "styled-outputs found a legacy live patch from an earlier version; restart Pi to unload it before enabling styled outputs.";

type PatchRecord = {
  proto: any;
  key: string;
  original: PropertyDescriptor | undefined;
  replacement: unknown;
};

export type PatchState = {
  owner: object;
  records: PatchRecord[];
  restore: () => void;
};

export function hasLegacyPatchState(prototypes: readonly object[]): boolean {
  return prototypes.some((proto) => Object.prototype.hasOwnProperty.call(proto, LEGACY_PATCH_STATE));
}

export function createPrototypePatchManager(owner: object) {
  const states = new Set<PatchState>();

  const restorePatchState = (proto: any): void => {
    const state = proto[PATCH_STATE] as PatchState | undefined;
    state?.restore();
  };

  const patch = (proto: any, key: string, replacement: unknown): void => {
    let state = proto[PATCH_STATE] as PatchState | undefined;
    if (!state || state.owner !== owner) {
      restorePatchState(proto);
      state = {
        owner,
        records: [],
        restore: () => {
          for (const record of state!.records.toReversed()) {
            if (record.proto[record.key] === record.replacement) {
              if (record.original) Object.defineProperty(record.proto, record.key, record.original);
              else delete record.proto[record.key];
            }
          }
          if (proto[PATCH_STATE] === state) delete proto[PATCH_STATE];
          states.delete(state!);
        },
      };
      proto[PATCH_STATE] = state;
      states.add(state);
    }
    const original = Object.getOwnPropertyDescriptor(proto, key);
    proto[key] = replacement;
    state.records.push({ proto, key, original, replacement });
  };

  return {
    patch,
    cleanup(): void {
      for (const state of [...states]) state.restore();
    },
  };
}

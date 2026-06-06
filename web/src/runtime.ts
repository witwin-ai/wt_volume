import type * as ReactTypes from 'react';
import type * as ThreeTypes from 'three';
import type * as FiberTypes from '@react-three/fiber';
import type * as DreiTypes from '@react-three/drei';

interface WitwinViewportGlobals {
  react: typeof ReactTypes;
  three: typeof ThreeTypes;
  fiber: typeof FiberTypes;
  drei?: typeof DreiTypes;
}

function shared(): WitwinViewportGlobals {
  const globals = (globalThis as { __witwin?: WitwinViewportGlobals }).__witwin;
  if (!globals?.react || !globals.three || !globals.fiber) {
    throw new Error('[wt_volume] viewport host singletons are unavailable');
  }
  return globals;
}

export const React = shared().react;
export const THREE = shared().three;
export const useCallback = React.useCallback;
export const useEffect = React.useEffect;
export const useMemo = React.useMemo;
export const useRef = React.useRef;
export const useState = React.useState;

const fiber = shared().fiber;
const drei = shared().drei;

if (!drei?.Html || !drei.Line || !drei.Text) {
  throw new Error('[wt_volume] @react-three/drei host singleton is incomplete');
}

export const useFrame = fiber.useFrame;
export const useThree = fiber.useThree;
export type ThreeEvent<TEvent = Event> = FiberTypes.ThreeEvent<TEvent>;

export const Html = drei.Html;
export const Line = drei.Line;
export const Text = drei.Text;

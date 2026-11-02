import type * as ReactTypes from 'react';

// Bundled packages that import 'react' (lucide-react) get the host's copy:
// two Reacts break hooks. The build aliases 'react' to this file.
type WitwinGlobals = { __witwin?: { react?: typeof ReactTypes } };

const React = (globalThis as WitwinGlobals).__witwin?.react;
if (!React) {
  throw new Error('[wt_volume] React host singleton is unavailable on globalThis.__witwin');
}

export default React;
export const createElement = React.createElement;
export const Fragment = React.Fragment;
export const forwardRef = React.forwardRef;
export const memo = React.memo;
export const createContext = React.createContext;
export const useContext = React.useContext;
export const useCallback = React.useCallback;
export const useEffect = React.useEffect;
export const useMemo = React.useMemo;
export const useRef = React.useRef;
export const useState = React.useState;

// Preact + htm (vendored by scripts/postinstall.js), so components are plain ES modules.
import { h, render, Fragment, createRef, createContext } from '../../vendor/preact.mjs';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext } from '../../vendor/preact-hooks.mjs';
import htm from '../../vendor/htm.mjs';

export const html = htm.bind(h);
export { h, render, Fragment, createRef, createContext, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext };

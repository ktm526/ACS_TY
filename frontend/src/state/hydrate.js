// 예시: src/state/hydrate.js
import { useHydrateAtoms } from 'jotai/utils';
import { useEffect } from 'react';
import { selectedMapAtom } from './atoms';

export function useInitialHydration(initialMap) {
    useHydrateAtoms([[selectedMapAtom, initialMap]]);
}

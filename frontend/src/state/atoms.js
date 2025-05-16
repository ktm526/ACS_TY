import { atom } from 'jotai';
import { atomWithQuery } from 'jotai-tanstack-query';
import { atomFamily } from 'jotai/utils';

const CORE = import.meta.env.VITE_CORE_BASE_URL //|| 'http://localhost:4000';
const fetchJson = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j : j.data ?? [];
};

/* ───────────────── 맵 목록 ───────────────── */
export const mapsQueryAtom = atomWithQuery(() => ({
    queryKey: ['maps'],
    queryFn: () => fetchJson(`${CORE}/api/maps`),
    staleTime: 10_000,
}));

/* ───────────────── 로봇 목록 ──────────────── */
export const robotsQueryAtom = atomWithQuery(() => ({
    queryKey: ['robots'],
    queryFn: () => fetchJson(`${CORE}/api/robots`),
    refetchInterval: 200,
}));

/* ───────────────── 선택 맵 ──────────────────
 *  1순위: is_current === true
 *  2순위: 목록 첫 번째                                   */
const _sel = atom(null);
export const selectedMapAtom = atom(
    (get) => {
        const explicit = get(_sel);
        if (explicit) return explicit;

        const list = get(mapsQueryAtom).data ?? [];
        const current = list.find((m) => m.is_current);
        return current ?? list[0] ?? null;
    },
    (_get, set, next) => set(_sel, next)
);

export const robotMapsAtomFamily = atomFamily((robotId) =>
    atomWithQuery(() => ({
        queryKey: ['robotMaps', robotId],
        queryFn: async () => {
            const r = await fetch(`${CORE}/api/robots/${robotId}/maps`);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return (await r.json()).map_files_info ?? [];
        },
        staleTime: 5000,
    }))
);
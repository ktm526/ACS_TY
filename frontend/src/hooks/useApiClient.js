// src/hooks/useApiClient.js
import { useQuery } from '@tanstack/react-query';

// 백엔드 베이스 URL (없으면 로컬호스트로 폴백)
const CORE = import.meta.env.VITE_CORE_BASE_URL || 'http://localhost:4000';

export function useLogs(params = {}) {
    return useQuery({
        queryKey: ['logs', params],
        queryFn: async () => {
            // ?start=…&end=…&amr=… 형식의 쿼리 문자열 생성
            const q = new URLSearchParams(params).toString();
            const url = `${CORE}/api/logs${q ? `?${q}` : ''}`;
            console.log('fetch logs from', url);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch logs: ${res.status}`);
            return res.json();
        },
        staleTime: 5_000, // 5초 동안은 캐시 유지
    });
}

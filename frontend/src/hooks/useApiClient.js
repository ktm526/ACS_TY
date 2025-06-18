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

export function useTaskExecutionLogs(params = {}) {
    return useQuery({
        queryKey: ['taskExecutionLogs', params],
        queryFn: async () => {
            const q = new URLSearchParams(params).toString();
            const url = `${CORE}/api/task-execution-logs${q ? `?${q}` : ''}`;
            console.log('fetch task execution logs from', url);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch task execution logs: ${res.status}`);
            const data = await res.json();
            // 백엔드에서 { logs, pagination } 형태로 반환하므로 logs 배열만 반환
            return data.logs || data;
        },
        staleTime: 5_000, // 5초 동안은 스테일 데이터로 간주하지 않음
        gcTime: 15_000, // 15초 동안 캐시 유지
        refetchInterval: 5_000, // 5초마다 자동 새로고침 (더 길게)
        refetchOnWindowFocus: false, // 창 포커스 시 새로고침 비활성화
        retry: 1, // 재시도 횟수 줄임
    });
}

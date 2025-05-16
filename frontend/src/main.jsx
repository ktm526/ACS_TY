// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import { ConfigProvider, theme } from "antd";
import { atomWithQuery } from "jotai-tanstack-query";

import { queryClientAtom } from "jotai-tanstack-query";
import App from "./App";
import "./styles/global.css";

const queryClient = new QueryClient();
const BRAND = "#192BB4";
function Hydrate() {
  hydrateAtoms([[queryClientAtom, queryClient]]);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: { colorPrimary: BRAND },
        components: {
          Card: {
            /* Layer-One Down 그림자 (전역 적용) */
            boxShadow: [
              "0px 1px  2px -2px rgba(0,0,0,0.16)",
              "0px 3px  6px  0px rgba(0,0,0,0.12)",
              "0px 5px 12px  4px rgba(0,0,0,0.09)",
            ].join(","),
            borderRadius: 8,
          },
        },
        algorithm: theme.defaultAlgorithm,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <JotaiProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </JotaiProvider>
      </QueryClientProvider>
    </ConfigProvider>
  </React.StrictMode>
);

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

type ReturnsResp = { name?: string; factor?: string; dates: string[]; ret: number[] };
type MetaResp = Record<string, any>;
type HoldingsResp = {
  factor: string;
  asof: string | null;
  months: string[];
  holdings: Record<string, string[]>;
};

function toCum(retArr: number[]) {
  let v = 1;
  return retArr.map((r) => (v *= 1 + r));
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`fetch failed ${r.status}: ${url}\n${t.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

export default function FactorDetailClient({ name }: { name?: string }) {
  const pathname = usePathname();

  // ✅ 保險：props 沒帶到就從 URL 抓最後一段
  const safeName = useMemo(() => {
    // 1. 優先使用傳入的 name，但過濾掉字串 "undefined" 或空值
    if (name && name !== "undefined" && name.trim().length > 0) {
      return name;
    }
    
    // 2. 如果 name 有問題，就自己去抓網址 (Fallback)
    if (!pathname) return "";
    const segments = pathname.split("/").filter(Boolean); // 過濾掉空字串
    const last = segments.pop();
    return last ? decodeURIComponent(last) : "";
  }, [name, pathname]);
  
  const [meta, setMeta] = useState<MetaResp | null>(null);
  const [ret, setRet] = useState<ReturnsResp | null>(null);
  const [hold, setHold] = useState<HoldingsResp | null>(null);
  const [month, setMonth] = useState<string>("");

  useEffect(() => {
    if (!safeName) {
      setMeta(null);
      setRet(null);
      setHold(null);
      setMonth("");
      return;
    }

    (async () => {
      try {
        const [m, r, h] = await Promise.all([
          fetchJson<MetaResp>(`${RAW_BASE}/data/factors/${encodeURIComponent(safeName)}.json`).catch(() => null),
          fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(safeName)}.json`).catch(() => null),
          fetchJson<HoldingsResp>(`${RAW_BASE}/data/holdings/${encodeURIComponent(safeName)}.json`).catch(() => null),
        ]);

        setMeta(m);
        setRet(r);
        setHold(h);

        const months = h?.months || [];
        setMonth(months.length ? months[months.length - 1] : "");
      } catch (e) {
        setMeta(null);
        setRet(null);
        setHold(null);
        setMonth("");
      }
    })();
  }, [safeName]);

  const holdingsList = useMemo(() => {
    if (!hold || !month) return [];
    return hold.holdings?.[month] || [];
  }, [hold, month]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{safeName || "-"}</h1>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700 border border-blue-200">
              因子詳情
            </span>
          </div>
          <Link href="/" className="text-sm font-semibold text-blue-600 hover:underline">
            ← 回首頁
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 space-y-8">
        {/* Meta */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-3">選股邏輯</h2>
          {!meta ? (
            <div className="text-slate-400">找不到 factors/{safeName}.json（可能尚未匯出）</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">顯示名稱</div>
                  <div className="font-semibold">{meta.display_name ?? "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">分類</div>
                  <div className="font-semibold">{meta.category ?? "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">再平衡</div>
                  <div className="font-semibold">{meta.rebalance ?? "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">投資宇宙</div>
                  <div className="font-semibold">{meta.universe ?? "-"}</div>
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 border border-slate-100 p-4">
                <div className="text-xs text-slate-500 font-bold mb-2">持有規則</div>
                <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {meta.holding_rule ?? "-"}
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 border border-slate-100 p-4">
                <div className="text-xs text-slate-500 font-bold mb-2">參數</div>
                <pre className="text-xs text-slate-700 overflow-auto">
{JSON.stringify(meta.params ?? {}, null, 2)}
                </pre>
              </div>

              {meta.timing_notes && (
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-4">
                  <div className="text-xs text-slate-500 font-bold mb-2">時間對齊</div>
                  <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {meta.timing_notes}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Returns chart */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-3">歷史表現（累積報酬）</h2>
          {!ret?.dates?.length ? (
            <div className="text-slate-400">找不到 returns/{safeName}.json（可能尚未匯出）</div>
          ) : (
            <div className="w-full h-[380px]">
              <Plot
                data={[
                  {
                    x: ret.dates,
                    y: toCum(ret.ret || []),
                    type: "scatter",
                    mode: "lines",
                    name: safeName,
                  },
                ] as any}
                layout={{
                  autosize: true,
                  margin: { l: 40, r: 20, t: 20, b: 40 },
                  showlegend: false,
                  xaxis: { gridcolor: "#f1f5f9" },
                  yaxis: { gridcolor: "#f1f5f9" },
                }}
                style={{ width: "100%", height: "100%" }}
                useResizeHandler
                config={{ displayModeBar: false }}
              />
            </div>
          )}
        </section>

        {/* Holdings */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h2 className="text-lg font-bold text-slate-800">選股名單（可回看）</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase text-slate-400 tracking-wider">月份</span>
              <select
                className="rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 bg-slate-50"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                disabled={!hold?.months?.length}
              >
                {(hold?.months || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!hold ? (
            <div className="text-slate-400">找不到 holdings/{safeName}.json（指數或尚未匯出）</div>
          ) : (
            <>
              <div className="text-xs text-slate-500 mb-3">
                asof: {hold.asof ?? "-"}　|　本月持股數：{holdingsList.length}
              </div>

              {holdingsList.length === 0 ? (
                <div className="text-slate-400">此月份無持股（或資料缺漏）</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {holdingsList.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-sm font-semibold text-slate-700"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

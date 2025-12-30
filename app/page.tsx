"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

/** =========================
 * GitHub data source config
 * ========================= */
const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";

// raw file base (fast, CORS ok)
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

type ReturnsResp = {
  name?: string;
  factor?: string;
  dates: string[];
  ret: number[];
};

type MetricRow = {
  factor: string;
  ann_return: number;
  ann_vol: number;
  sharpe: number | null;
  maxdd: number;
};

type GlobalWaveResp = {
  factor: string;
  summary: {
    trough: { n_events: number; n_6m: number; n_12m: number; avg_6m: number | null; avg_12m: number | null };
    peak: { n_events: number; n_6m: number; n_12m: number; avg_6m: number | null; avg_12m: number | null };
  };
  events?: { type: "trough" | "peak"; date: string; r_6m: number | null; r_12m: number | null }[];
};

function toCum(retArr: number[]) {
  let v = 1;
  return retArr.map((r) => (v *= 1 + r));
}

function fmtPct(x: number | null | undefined) {
  if (x === null || x === undefined || Number.isNaN(x as any)) return "-";
  return `${(x * 100).toFixed(2)}%`;
}

function safeNum(x: number | null | undefined) {
  if (x === null || x === undefined || Number.isNaN(x as any)) return null;
  return x;
}

// === 固定因子顏色（你可以依喜好調整）===
// 微調了 Top300 的顏色以符合新的藍色系主題
const FACTOR_COLORS: Record<string, string> = {
  High_yield: "#ff7f0e",
  PB_low: "#c49c94",
  PE_low: "#7f7f7f",
  Momentum_01: "#bcbd22",
  Momentum_03: "#8c564b",
  Momentum_06: "#f1c40f",
  High_yoy: "#4e79a7",
  Margin_growth: "#2ca02c",
  EPS_growth: "#76b7b2",
  Low_beta: "#e377c2",
  Top300: "#2563eb", // 改為亮藍色以配合主題
};

function makeDiscreteColorscale(colorList: string[]) {
  const n = colorList.length;
  const cs: [number, string][] = [];
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    cs.push([a, colorList[i]]);
    cs.push([b, colorList[i]]);
  }
  return cs;
}

function parseDate(s: string) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clipByRange(d: ReturnsResp, start: string, end: string): ReturnsResp {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return d;

  const outDates: string[] = [];
  const outRet: number[] = [];
  for (let i = 0; i < d.dates.length; i++) {
    const di = parseDate(d.dates[i]);
    if (!di) continue;
    if (di >= s && di <= e) {
      outDates.push(d.dates[i]);
      outRet.push(d.ret[i]);
    }
  }
  return { ...d, dates: outDates, ret: outRet };
}

function maxDrawdownFromReturns(ret: number[]) {
  let peak = 1;
  let nav = 1;
  let maxdd = 0; 
  for (const r of ret) {
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    const dd = nav / peak - 1;
    if (dd < maxdd) maxdd = dd;
  }
  return maxdd;
}

function calcMetricsFromDailyRet(factor: string, ret: number[], rfAnnual: number, freq = 252): MetricRow {
  if (!ret.length) {
    return { factor, ann_return: 0, ann_vol: 0, sharpe: null, maxdd: 0 };
  }

  let nav = 1;
  for (const r of ret) nav *= 1 + r;
  const n = ret.length;
  const ann_return = Math.pow(nav, freq / n) - 1;

  const mean = ret.reduce((a, b) => a + b, 0) / n;
  const var_ = ret.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, n - 1);
  const ann_vol = Math.sqrt(var_ * freq);

  const rfDaily = rfAnnual / freq;
  const ex = ret.map((r) => r - rfDaily);
  const exMean = ex.reduce((a, b) => a + b, 0) / n;
  const exVar = ex.reduce((a, r) => a + (r - exMean) ** 2, 0) / Math.max(1, n - 1);
  const exVol = Math.sqrt(exVar * freq);

  const sharpe = exVol === 0 ? null : (exMean * freq) / exVol;
  const maxdd = maxDrawdownFromReturns(ret);

  return { factor, ann_return, ann_vol, sharpe, maxdd };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`fetch failed ${r.status}: ${url}\n${t.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

type ManifestResp = { factors: string[] };

async function listFactorsFromGithub(): Promise<string[]> {
  const url = `${RAW_BASE}/data/manifest.json`;
  const m = await fetchJson<ManifestResp>(url);
  const names = (m?.factors || []).filter((x) => typeof x === "string" && x.trim().length > 0);
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

export default function Home() {
  const [factors, setFactors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(["Top300"]);
  const [start, setStart] = useState("2003-01-01");
  const [end, setEnd] = useState("2025-12-31");
  const [rf, setRf] = useState(0.0);

  const [series, setSeries] = useState<Record<string, ReturnsResp>>({});
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [heatmap, setHeatmap] = useState<any>(null);

  // ===== Global Wave =====
  const [gwSelected, setGwSelected] = useState<string[]>(["Top300", "PE_low", "PB_low"]);
  const [gwData, setGwData] = useState<Record<string, GlobalWaveResp>>({});
  const [gwLoading, setGwLoading] = useState(false);
  const [gwHorizon, setGwHorizon] = useState<6 | 12>(6);
  const [gwBenchmark, setGwBenchmark] = useState<string>("Top300");
  const [benchSeries, setBenchSeries] = useState<ReturnsResp | null>(null);

  // Load Factor List
  useEffect(() => {
    (async () => {
      try {
        const list = await listFactorsFromGithub();
        setFactors(list);
        if (list.length) {
          if (!selected.length || !list.includes(selected[0])) setSelected([list[0]]);
          const defaults = ["Top300", "PE_low", "PB_low"].filter((x) => list.includes(x));
          setGwSelected(defaults.length ? defaults : list.slice(0, Math.min(3, list.length)));
          setGwBenchmark(list.includes("Top300") ? "Top300" : list[0]);
        }
      } catch (e) { setFactors([]); }
    })();
  }, []);

  // Load Returns & Metrics
  useEffect(() => {
    (async () => {
      if (!selected.length) { setSeries({}); setMetrics([]); return; }
      try {
        const pairs = await Promise.all(
          selected.map(async (f) => {
            const url = `${RAW_BASE}/data/returns/${encodeURIComponent(f)}.json`;
            const d = await fetchJson<ReturnsResp>(url);
            const factorName = d.factor || d.name || f;
            const normalized: ReturnsResp = { factor: factorName, dates: d.dates || [], ret: d.ret || [] };
            const clipped = clipByRange(normalized, start, end);
            return [f, clipped] as const;
          })
        );
        const obj: Record<string, ReturnsResp> = {};
        for (const [f, d] of pairs) obj[f] = d;
        setSeries(obj);

        const rows: MetricRow[] = selected.map((f) => {
          const d = obj[f];
          return calcMetricsFromDailyRet(f, d?.ret || [], rf, 252);
        });
        setMetrics(rows);
      } catch (e) { setSeries({}); setMetrics([]); }
    })();
  }, [selected, start, end, rf]);

  // Load Heatmap
  useEffect(() => {
    (async () => {
      try {
        const d = await fetchJson<any>(`${RAW_BASE}/data/heatmap/heatmap_12m.json`);
        setHeatmap(d);
      } catch (e) { setHeatmap(null); }
    })();
  }, []);

  // Load Global Wave Data
  useEffect(() => {
    (async () => {
      if (!gwSelected.length) { setGwData({}); return; }
      setGwLoading(true);
      try {
        const pairs = await Promise.all(
          gwSelected.map(async (f) => {
            const d = await fetchJson<GlobalWaveResp>(`${RAW_BASE}/data/global_wave/${encodeURIComponent(f)}.json`);
            return [f, d] as const;
          })
        );
        const obj: Record<string, GlobalWaveResp> = {};
        for (const [f, d] of pairs) obj[f] = d;
        setGwData(obj);
      } catch (e) { setGwData({}); } finally { setGwLoading(false); }
    })();
  }, [gwSelected]);

  // Load GW Benchmark
  useEffect(() => {
    (async () => {
      if (!gwBenchmark) { setBenchSeries(null); return; }
      try {
        const d = await fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(gwBenchmark)}.json`);
        const normalized: ReturnsResp = { factor: d.factor || d.name || gwBenchmark, dates: d.dates || [], ret: d.ret || [] };
        setBenchSeries(normalized);
      } catch (e) { setBenchSeries(null); }
    })();
  }, [gwBenchmark]);

  // --- Memos ---
  const chartData = useMemo(() => {
    return selected.map((f) => {
      const d = series[f];
      if (!d || !d.dates?.length) return null;
      return { x: d.dates, y: toCum(d.ret || []), type: "scatter", mode: "lines", name: f };
    }).filter(Boolean);
  }, [series, selected]);

  const gwBar = useMemo(() => {
    const x = gwSelected;
    const key = gwHorizon === 6 ? "avg_6m" : "avg_12m";
    const troughY = x.map((f) => safeNum((gwData[f]?.summary?.trough as any)?.[key] ?? null));
    const peakY = x.map((f) => safeNum((gwData[f]?.summary?.peak as any)?.[key] ?? null));
    return [
      { name: `波谷後 +${gwHorizon}M`, y: troughY, x, type: "bar", marker: { color: "#10b981" } },
      { name: `波峰後 +${gwHorizon}M`, y: peakY, x, type: "bar", marker: { color: "#f43f5e" } },
    ];
  }, [gwSelected, gwData, gwHorizon]);

  const gwSignalTraces = useMemo(() => {
    if (!benchSeries?.dates?.length || !benchSeries?.ret?.length) return null;
    const x = benchSeries.dates;
    const y = toCum(benchSeries.ret);
    const eventPool: { type: "trough" | "peak"; date: string }[] = [];
    const anyFactor = Object.keys(gwData)[0];
    if (anyFactor && gwData[anyFactor]?.events?.length) {
      for (const e of gwData[anyFactor].events || []) {
        if (e?.date && (e.type === "trough" || e.type === "peak")) eventPool.push({ type: e.type, date: e.date });
      }
    }
    const peaksX: string[] = [], peaksY: number[] = [], troughX: string[] = [], troughY: number[] = [];
    for (const e of eventPool) {
      const idx = x.findIndex((d) => d >= e.date);
      if (idx === -1) continue;
      if (e.type === "peak") { peaksX.push(x[idx]); peaksY.push(y[idx]); }
      else { troughX.push(x[idx]); troughY.push(y[idx]); }
    }
    const shapes = eventPool.map((e) => ({
      type: "line", xref: "x", yref: "paper", x0: e.date, x1: e.date, y0: 0, y1: 1,
      line: { width: 1, color: e.type === "peak" ? "rgba(244,63,94,0.3)" : "rgba(16,185,129,0.3)", dash: "dot" },
    }));
    const traces = [
      { type: "scatter", mode: "lines", name: `基準指數 (${gwBenchmark})`, x, y, line: { width: 2, color: "#3b82f6" } },
      { type: "scatter", mode: "markers", name: "波峰 (Peak)", x: peaksX, y: peaksY, marker: { symbol: "triangle-down", size: 10, color: "#f43f5e", line: { width: 1, color: "#fff" } } },
      { type: "scatter", mode: "markers", name: "波谷 (Trough)", x: troughX, y: troughY, marker: { symbol: "triangle-up", size: 10, color: "#10b981", line: { width: 1, color: "#fff" } } },
    ];
    return { traces, shapes };
  }, [benchSeries, gwData, gwBenchmark]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
      
      {/* Header - Sticky with Blur */}
      <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-700 to-indigo-600">
              因子投資系統
            </h1>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700 border border-blue-200">
              NTHU
            </span>
          </div>
          <div className="text-xs text-slate-500 font-medium hidden sm:block">
            Data: CMoney
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        
        {/* === 第一部分：區間表現分析 (Flex Layout for Side-by-Side) === */}
        <div className="flex flex-col lg:flex-row gap-8 mb-12">
          
          {/* 左側：控制面板 (Full Height) */}
          <section className="lg:w-1/3 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col gap-6">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-white">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
              </span>
              <h2 className="text-lg font-bold text-slate-800">系統控制</h2>
            </div>

            {/* 因子選擇 */}
            <div>
              <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-2 block">選擇因子</label>
              <div className="custom-scrollbar max-h-[320px] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 shadow-inner">
                {factors.map((f) => (
                  <label key={f} className="flex items-center gap-3 py-2 cursor-pointer hover:bg-slate-100 rounded px-2 transition-colors">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      checked={selected.includes(f)}
                      onChange={(e) => {
                        if (e.target.checked) setSelected([...selected, f]);
                        else setSelected(selected.filter((x) => x !== f));
                      }}
                    />
                    <span className="text-sm font-medium text-slate-700">{f}</span>
                  </label>
                ))}
                {factors.length === 0 && <div className="text-sm text-slate-500 p-2">載入中...</div>}
              </div>
            </div>

            {/* 日期選擇 (日曆) */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-1 block">開始日期</label>
                <input 
                  type="date" 
                  className="w-full rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 bg-slate-50"
                  value={start} 
                  onChange={(e) => setStart(e.target.value)} 
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-1 block">結束日期</label>
                <input 
                  type="date" 
                  className="w-full rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 bg-slate-50"
                  value={end} 
                  onChange={(e) => setEnd(e.target.value)} 
                />
              </div>
            </div>

            {/* 無風險利率 */}
            <div>
              <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-1 block">無風險利率 (Rf)</label>
              <div className="relative">
                <input
                  className="w-full rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 pl-3 pr-8"
                  type="number"
                  step="0.01"
                  value={rf}
                  onChange={(e) => setRf(parseFloat(e.target.value || "0"))}
                />
                <span className="absolute right-3 top-2 text-slate-400 text-sm">%</span>
              </div>
            </div>
          </section>

          {/* 右側：圖表與數據 */}
          <div className="lg:w-2/3 flex flex-col gap-6">
            
            {/* 圖表卡片 */}
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="mb-4">
                <h2 className="text-lg font-bold text-slate-800">累積報酬走勢</h2>
                <p className="text-sm text-slate-500">區間累積績效比較</p>
              </div>
              <div className="w-full h-[400px]">
                <Plot
                  data={chartData as any}
                  layout={{ 
                    autosize: true, 
                    margin: { l: 40, r: 20, t: 20, b: 40 },
                    showlegend: true,
                    legend: { orientation: "h", y: 1.1 },
                    xaxis: { gridcolor: "#f1f5f9" },
                    yaxis: { gridcolor: "#f1f5f9" }
                  }}
                  style={{ width: "100%", height: "100%" }}
                  useResizeHandler
                  config={{ displayModeBar: false }}
                />
              </div>
            </section>

            {/* 績效指標表格 */}
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-base font-semibold text-slate-800">績效指標分析</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-white text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-semibold">因子名稱</th>
                      <th className="px-6 py-3 font-semibold">年化報酬</th>
                      <th className="px-6 py-3 font-semibold">年化波動</th>
                      <th className="px-6 py-3 font-semibold">夏普比率</th>
                      <th className="px-6 py-3 font-semibold">最大回撤</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {metrics.map((row) => (
                      <tr key={row.factor} className="hover:bg-blue-50/50 transition-colors">
                        <td className="px-6 py-3 font-medium text-slate-900">{row.factor}</td>
                        <td className={`px-6 py-3 font-bold ${row.ann_return >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {(row.ann_return * 100).toFixed(2)}%
                        </td>
                        <td className="px-6 py-3 text-slate-600">{(row.ann_vol * 100).toFixed(2)}%</td>
                        <td className="px-6 py-3 text-slate-600">{row.sharpe === null ? "-" : row.sharpe.toFixed(2)}</td>
                        <td className="px-6 py-3 text-rose-600">{(row.maxdd * 100).toFixed(2)}%</td>
                      </tr>
                    ))}
                    {metrics.length === 0 && (
                      <tr><td colSpan={5} className="px-6 py-8 text-center text-slate-400">暫無資料</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>

        {/* === 第二部分：熱力圖 (Distinct Section) === */}
        <section className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 mb-12">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-6 gap-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">因子表現熱力圖</h2>
              <p className="text-sm text-slate-500 mt-1">近 12 個月因子績效排名（每月由上至下排序，顏色代表不同因子）</p>
            </div>
          </div>
          
          <div className="rounded-xl border border-slate-100 overflow-hidden bg-white">
            {!heatmap?.months ? (
              <div className="h-[600px] flex items-center justify-center text-slate-400 animate-pulse">
                資料讀取中...
              </div>
            ) : (
              (() => {
                const months: string[] = heatmap.months;
                const rankedFactors: string[][] = heatmap.ranked_factors;
                const rankedReturns: (number | null)[][] = heatmap.ranked_returns;
                const N = rankedFactors?.[0]?.length ?? 0;
                const factorList: string[] = heatmap.factors && Array.isArray(heatmap.factors) ? heatmap.factors : Array.from(new Set(rankedFactors.flat()));
                const factorToCode: Record<string, number> = {};
                factorList.forEach((f, i) => (factorToCode[f] = i));
                const colors = factorList.map((f) => FACTOR_COLORS[f] || "#d1d5db");
                const colorscale = makeDiscreteColorscale(colors);
                const z: number[][] = Array.from({ length: N }, () => Array(months.length).fill(0));
                const text: string[][] = Array.from({ length: N }, () => Array(months.length).fill(""));

                for (let col = 0; col < months.length; col++) {
                  for (let row = 0; row < N; row++) {
                    const fname = rankedFactors[col]?.[row] ?? "";
                    const r = rankedReturns?.[col]?.[row];
                    z[row][col] = factorToCode[fname] ?? -1;
                    const pct = r === null || r === undefined ? "NA" : `${((r as number) * 100).toFixed(2)}%`;
                    text[row][col] = `<span style="font-weight:bold">${fname}</span><br>${pct}`;
                  }
                }
                const y = Array.from({ length: N }, (_, i) => i + 1);

                return (
                  <Plot
                    data={[{
                      type: "heatmap", z, x: months, y, text,
                      texttemplate: "%{text}", textfont: { size: 10, color: "black" },
                      constraintext: "both", hovertemplate: "月份: %{x}<br>排名: %{y}<br>%{text}<extra></extra>",
                      colorscale, showscale: false, zmin: 0, zmax: factorList.length - 1,
                    }] as any}
                    layout={{
                      margin: { l: 40, r: 20, t: 20, b: 80 },
                      height: 700,
                      xaxis: { type: "category", tickangle: -45 },
                      yaxis: { autorange: "reversed", tickmode: "array", tickvals: y },
                    }}
                    style={{ width: "100%" }}
                    config={{ displayModeBar: false }}
                  />
                );
              })()
            )}
          </div>
        </section>

        {/* === 第三部分：Global Wave (Distinct Section) === */}
        <section className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 border-b border-slate-100 pb-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Global Wave</h2>
              <p className="text-sm text-slate-500 mt-1">分析歷史波峰 (Peak) 與波谷 (Trough) 訊號後的因子表現</p>
            </div>
            
            {/* Horizon Toggle */}
            <div className="bg-slate-100 p-1 rounded-lg inline-flex">
              <button 
                onClick={() => setGwHorizon(6)} 
                className={`px-4 py-1.5 text-sm font-bold rounded-md transition-all ${gwHorizon === 6 ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                +6 個月
              </button>
              <button 
                onClick={() => setGwHorizon(12)} 
                className={`px-4 py-1.5 text-sm font-bold rounded-md transition-all ${gwHorizon === 12 ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                +12 個月
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* GW Sidebar */}
            <div className="lg:col-span-4 flex flex-col gap-6">
               <div className="bg-slate-50 rounded-xl p-5 border border-slate-100">
                  <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-3">比較因子</h3>
                  <div className="max-h-60 overflow-y-auto custom-scrollbar pr-2 space-y-1">
                    {factors.map((f) => (
                      <label key={`gw-${f}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-white hover:shadow-sm cursor-pointer transition-all">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          checked={gwSelected.includes(f)}
                          onChange={(e) => {
                            if (e.target.checked) setGwSelected([...gwSelected, f]);
                            else setGwSelected(gwSelected.filter((x) => x !== f));
                          }}
                        />
                        <span className="text-sm font-medium text-slate-700">{f}</span>
                      </label>
                    ))}
                  </div>
               </div>
            </div>

            {/* GW Bar Chart */}
            <div className="lg:col-span-8">
               <div className="bg-white rounded-xl border border-slate-100 p-4 h-full flex flex-col justify-center">
                 {gwLoading ? (
                   <div className="text-center text-slate-400 py-10">讀取中...</div>
                 ) : gwSelected.length === 0 ? (
                   <div className="text-center text-slate-400 py-10">請選擇至少一個因子進行比較</div>
                 ) : (
                    <Plot
                      data={gwBar as any}
                      layout={{
                        barmode: "group",
                        margin: { l: 60, r: 20, t: 20, b: 80 },
                        height: 350,
                        yaxis: { tickformat: ".1%", gridcolor: "#f1f5f9" },
                        xaxis: { tickangle: -30 },
                        legend: { orientation: "h", y: 1.2, x: 0 },
                      }}
                      style={{ width: "100%" }}
                      config={{ displayModeBar: false }}
                    />
                 )}
               </div>
            </div>
          </div>

          {/* GW Summary Table */}
          <div className="mt-8">
            <h3 className="text-sm font-bold uppercase text-slate-500 tracking-wider mb-3">數據摘要</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-600 font-semibold">
                  <tr>
                    <th className="px-4 py-3">因子名稱</th>
                    <th className="px-4 py-3 text-emerald-600">波谷後 +6M</th>
                    <th className="px-4 py-3 text-emerald-600">波谷後 +12M</th>
                    <th className="px-4 py-3 text-rose-600">波峰後 +6M</th>
                    <th className="px-4 py-3 text-rose-600">波峰後 +12M</th>
                    <th className="px-4 py-3">波谷次數</th>
                    <th className="px-4 py-3">波峰次數</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {gwSelected.map((f) => {
                    const d = gwData[f];
                    const tr = d?.summary?.trough;
                    const pk = d?.summary?.peak;
                    return (
                      <tr key={`gw-row-${f}`} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-medium">{f}</td>
                        <td className="px-4 py-3">{fmtPct(tr?.avg_6m ?? null)}</td>
                        <td className="px-4 py-3">{fmtPct(tr?.avg_12m ?? null)}</td>
                        <td className="px-4 py-3">{fmtPct(pk?.avg_6m ?? null)}</td>
                        <td className="px-4 py-3">{fmtPct(pk?.avg_12m ?? null)}</td>
                        <td className="px-4 py-3">{tr?.n_events ?? "-"}</td>
                        <td className="px-4 py-3">{pk?.n_events ?? "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* GW Signal Chart (Dark Theme for Contrast) */}
          <div className="mt-10 p-1 bg-slate-100 rounded-2xl">
            <div className="bg-slate-900 rounded-xl p-6 shadow-inner text-slate-200">
              <div className="flex flex-col md:flex-row items-center justify-between mb-4 gap-4">
                <div>
                  <h3 className="text-lg font-bold text-white">訊號歷史回測</h3>
                  <p className="text-xs text-slate-400">藍線：基準指數｜紅▼：波峰訊號｜綠▲：波谷訊號</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 font-bold uppercase">基準指數</span>
                  <select 
                    className="rounded bg-slate-800 border-slate-700 text-sm text-white focus:ring-blue-500"
                    value={gwBenchmark} 
                    onChange={(e) => setGwBenchmark(e.target.value)}
                  >
                    {factors.map((f) => <option key={`bench-${f}`} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
              
              {!gwSignalTraces ? (
                <div className="h-[400px] flex items-center justify-center text-slate-600">讀取中...</div>
              ) : (
                <Plot
                  data={gwSignalTraces.traces as any}
                  layout={{
                    margin: { l: 50, r: 20, t: 20, b: 50 },
                    height: 420,
                    xaxis: { type: "date", gridcolor: "#334155", tickcolor: "#94a3b8", tickfont: {color: "#cbd5e1"} },
                    yaxis: { title: "累積報酬", gridcolor: "#334155", tickcolor: "#94a3b8", tickfont: {color: "#cbd5e1"}, titlefont: {color: "#cbd5e1"} },
                    paper_bgcolor: "rgba(0,0,0,0)",
                    plot_bgcolor: "rgba(0,0,0,0)",
                    legend: { orientation: "h", y: 1.1, font: { color: "#e2e8f0" } },
                    shapes: gwSignalTraces.shapes,
                  }}
                  style={{ width: "100%" }}
                  useResizeHandler
                  config={{ displayModeBar: false }}
                />
              )}
            </div>
          </div>
        </section>
      </main>

      <style jsx global>{`
        /* 自定義滾動條樣式，讓列表更精緻 */
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: #cbd5e1;
          border-radius: 20px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background-color: #94a3b8;
        }
      `}</style>
    </div>
  );
}
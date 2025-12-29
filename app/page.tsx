"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

/** =========================
 * GitHub 資料來源配置
 * ========================= */
const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";
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
  Top300: "#3b82f6", // 加強藍色
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
  if (!ret.length) return { factor, ann_return: 0, ann_vol: 0, sharpe: null, maxdd: 0 };
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
  if (!r.ok) throw new Error(`fetch failed ${r.status}`);
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

  const [gwSelected, setGwSelected] = useState<string[]>(["Top300", "PE_low", "PB_low"]);
  const [gwData, setGwData] = useState<Record<string, GlobalWaveResp>>({});
  const [gwLoading, setGwLoading] = useState(false);
  const [gwHorizon, setGwHorizon] = useState<6 | 12>(6);
  const [gwBenchmark, setGwBenchmark] = useState<string>("Top300");
  const [benchSeries, setBenchSeries] = useState<ReturnsResp | null>(null);

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
        const rows: MetricRow[] = selected.map((f) => calcMetricsFromDailyRet(f, obj[f]?.ret || [], rf, 252));
        setMetrics(rows);
      } catch (e) { setSeries({}); setMetrics([]); }
    })();
  }, [selected, start, end, rf]);

  useEffect(() => {
    (async () => {
      try {
        const d = await fetchJson<any>(`${RAW_BASE}/data/heatmap/heatmap_12m.json`);
        setHeatmap(d);
      } catch (e) { setHeatmap(null); }
    })();
  }, []);

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

  useEffect(() => {
    (async () => {
      if (!gwBenchmark) { setBenchSeries(null); return; }
      try {
        const d = await fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(gwBenchmark)}.json`);
        setBenchSeries({ factor: d.factor || d.name || gwBenchmark, dates: d.dates || [], ret: d.ret || [] });
      } catch (e) { setBenchSeries(null); }
    })();
  }, [gwBenchmark]);

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
      { name: `Trough +${gwHorizon}M`, y: troughY, x, type: "bar", marker: { color: "#10b981" } },
      { name: `Peak +${gwHorizon}M`, y: peakY, x, type: "bar", marker: { color: "#f43f5e" } },
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
      { type: "scatter", mode: "lines", name: `基準指數 (${gwBenchmark})`, x, y, line: { width: 2.5, color: "#2563eb" } },
      { type: "scatter", mode: "markers", name: "波峰 (Peak)", x: peaksX, y: peaksY, marker: { symbol: "triangle-down", size: 12, color: "#f43f5e" } },
      { type: "scatter", mode: "markers", name: "波谷 (Trough)", x: troughX, y: troughY, marker: { symbol: "triangle-up", size: 12, color: "#10b981" } },
    ];
    return { traces, shapes };
  }, [benchSeries, gwData, gwBenchmark]);

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans antialiased">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
              因子投資系統
            </h1>
            <p className="text-sm font-medium text-slate-500 mt-1 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              專業資產管理分析平台 | 資料來源：alfred0630
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-blue-50 text-blue-600 text-xs font-bold rounded-full border border-blue-100 uppercase">PRO Terminal</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10 space-y-12">
        
        {/* 第一區塊：區間表現分析 */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* 控制台面板 */}
          <div className="lg:col-span-4 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 ring-1 ring-slate-900/5">
            <h2 className="text-lg font-bold border-left-4 border-blue-600 pl-3 flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"></path></svg>
              系統控制
            </h2>
            
            <div className="mt-6 space-y-5">
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">因子選擇</label>
                <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/50 p-2 custom-scrollbar">
                  {factors.map((f) => (
                    <label key={f} className="group flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-white hover:shadow-sm cursor-pointer transition-all">
                      <input type="checkbox" className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300" checked={selected.includes(f)} onChange={(e) => e.target.checked ? setSelected([...selected, f]) : setSelected(selected.filter(x => x !== f))} />
                      <span className="text-sm font-medium text-slate-700 group-hover:text-blue-600">{f}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">開始日期</label>
                  <input type="date" className="mt-2 w-full rounded-xl border-slate-200 bg-white px-3 py-2.5 text-sm font-medium shadow-sm focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all" value={start} onChange={(e) => setStart(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">結束日期</label>
                  <input type="date" className="mt-2 w-full rounded-xl border-slate-200 bg-white px-3 py-2.5 text-sm font-medium shadow-sm focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all" value={end} onChange={(e) => setEnd(e.target.value)} />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">無風險利率 (Rf)</label>
                <div className="relative mt-2">
                  <input type="number" step="0.01" className="w-full rounded-xl border-slate-200 bg-white pl-3 pr-10 py-2.5 text-sm font-medium shadow-sm focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" value={rf} onChange={(e) => setRf(parseFloat(e.target.value || "0"))} />
                  <span className="absolute right-3 top-2.5 text-slate-400 text-sm">%</span>
                </div>
              </div>
            </div>
          </div>

          {/* 圖表與指標區 */}
          <div className="lg:col-span-8 space-y-6">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 ring-1 ring-slate-900/5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-slate-800">區間績效走勢</h2>
              </div>
              <Plot data={chartData as any} layout={{ autosize: true, margin: { l: 40, r: 20, t: 10, b: 40 }, hovermode: "x unified", legend: { orientation: "h", y: 1.1 }, xaxis: { gridcolor: "#f1f5f9" }, yaxis: { gridcolor: "#f1f5f9" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)" }} style={{ width: "100%", height: "400px" }} useResizeHandler />
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden ring-1 ring-slate-900/5">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider">績效核心指標</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-white text-slate-500">
                    <tr>
                      <th className="px-6 py-4 font-bold uppercase tracking-tighter">因子名稱</th>
                      <th className="px-6 py-4 font-bold uppercase tracking-tighter">年化報酬</th>
                      <th className="px-6 py-4 font-bold uppercase tracking-tighter">年化波動</th>
                      <th className="px-6 py-4 font-bold uppercase tracking-tighter">夏普比率</th>
                      <th className="px-6 py-4 font-bold uppercase tracking-tighter">最大回撤</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {metrics.map((row) => (
                      <tr key={row.factor} className="hover:bg-blue-50/30 transition-colors">
                        <td className="px-6 py-4 font-bold text-slate-900">{row.factor}</td>
                        <td className="px-6 py-4 font-semibold text-emerald-600">{(row.ann_return * 100).toFixed(2)}%</td>
                        <td className="px-6 py-4 text-slate-600">{(row.ann_vol * 100).toFixed(2)}%</td>
                        <td className="px-6 py-4"><span className="px-2 py-1 bg-slate-100 rounded-md font-mono font-bold text-slate-700">{row.sharpe?.toFixed(2) || "-"}</span></td>
                        <td className="px-6 py-4 text-rose-600">{(row.maxdd * 100).toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        {/* 第二區塊：因子表現熱力圖 */}
        <section className="bg-white rounded-3xl shadow-lg border border-slate-200 p-8 ring-1 ring-slate-900/5">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl font-bold text-slate-900 tracking-tight">因子表現熱力圖</h2>
              <p className="text-slate-500 mt-1 font-medium">近 12 個月因子報酬排名對比（每月由上至下排序）</p>
            </div>
            <div className="flex items-center gap-4 text-xs font-bold text-slate-400">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-slate-200"></span> 固定顏色對應因子</span>
            </div>
          </div>

          {!heatmap?.months ? (
            <div className="py-20 text-center animate-pulse text-slate-400 font-medium">數據加載中，請稍候...</div>
          ) : (
            (() => {
              const months = heatmap.months;
              const rankedFactors = heatmap.ranked_factors;
              const rankedReturns = heatmap.ranked_returns;
              const N = rankedFactors?.[0]?.length ?? 0;
              const factorList = heatmap.factors || Array.from(new Set(rankedFactors.flat()));
              const factorToCode = {};
              factorList.forEach((f, i) => factorToCode[f] = i);
              const colors = factorList.map((f) => FACTOR_COLORS[f] || "#e2e8f0");
              const colorscale = makeDiscreteColorscale(colors);
              const z = Array.from({ length: N }, () => Array(months.length).fill(0));
              const text = Array.from({ length: N }, () => Array(months.length).fill(""));

              for (let col = 0; col < months.length; col++) {
                for (let row = 0; row < N; row++) {
                  const fname = rankedFactors[col]?.[row] ?? "";
                  const r = rankedReturns?.[col]?.[row];
                  z[row][col] = factorToCode[fname] ?? -1;
                  const pct = r === null || r === undefined ? "NA" : `${(r * 100).toFixed(1)}%`;
                  text[row][col] = `<b style="font-size:11px">${fname}</b><br>${pct}`;
                }
              }
              const yArr = Array.from({ length: N }, (_, i) => i + 1);

              return (
                <div className="rounded-xl overflow-hidden border border-slate-100">
                  <Plot data={[{ type: "heatmap", z, x: months, y: yArr, text, texttemplate: "%{text}", textfont: { size: 10, color: "black" }, colorscale, showscale: false, hovertemplate: "%{text}<extra></extra>" }] as any} layout={{ margin: { l: 40, r: 10, t: 10, b: 80 }, height: 600, xaxis: { type: "category", tickangle: -45, fixedrange: true }, yaxis: { autorange: "reversed", tickmode: "array", tickvals: yArr, fixedrange: true }, paper_bgcolor: "white" }} style={{ width: "100%" }} config={{ displayModeBar: false }} />
                </div>
              );
            })()
          )}
        </section>

        {/* 第三區塊：Global Wave */}
        <section className="bg-white rounded-3xl shadow-lg border border-slate-200 p-8 ring-1 ring-slate-900/5 overflow-hidden">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 border-b border-slate-100 pb-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Global Wave</h2>
              <p className="text-slate-500 mt-1 font-medium font-chinese">歷史波峰/波谷訊號後驗與多因子預期報酬對比</p>
            </div>
            
            <div className="flex bg-slate-100 p-1 rounded-xl">
              <button onClick={() => setGwHorizon(6)} className={`px-6 py-2 text-sm font-bold rounded-lg transition-all ${gwHorizon === 6 ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>+6M 展望</button>
              <button onClick={() => setGwHorizon(12)} className={`px-6 py-2 text-sm font-bold rounded-lg transition-all ${gwHorizon === 12 ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>+12M 展望</button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-4 bg-slate-50 rounded-2xl p-6 border border-slate-100">
              <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">分析因子群</h3>
              <div className="grid grid-cols-1 gap-2 max-h-80 overflow-y-auto pr-2 custom-scrollbar">
                {factors.map((f) => (
                  <label key={`gw-${f}`} className="flex items-center gap-3 py-2 px-4 bg-white rounded-xl border border-slate-200 cursor-pointer hover:border-blue-400 transition-colors">
                    <input type="checkbox" className="w-4 h-4 rounded text-indigo-600 border-slate-300" checked={gwSelected.includes(f)} onChange={(e) => e.target.checked ? setGwSelected([...gwSelected, f]) : setGwSelected(gwSelected.filter(x => x !== f))} />
                    <span className="text-sm font-semibold text-slate-700">{f}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="lg:col-span-8">
              <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-inner">
                <Plot data={gwBar as any} layout={{ barmode: "group", margin: { l: 50, r: 20, t: 20, b: 80 }, height: 380, yaxis: { tickformat: ".1%", gridcolor: "#f1f5f9" }, xaxis: { type: "category", tickangle: -30 }, legend: { orientation: "h", y: 1.15 } }} style={{ width: "100%" }} />
              </div>
            </div>
          </div>

          {/* 訊號歷史位置圖 */}
          <div className="mt-12">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <span className="w-1.5 h-6 bg-blue-600 rounded-full"></span>
                Global Wave 訊號歷史位置 (對齊基準)
              </h3>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-400 uppercase">分析基準:</span>
                <select className="bg-slate-100 border-none rounded-lg text-sm font-bold text-blue-600 px-4 py-2 focus:ring-2 focus:ring-blue-500" value={gwBenchmark} onChange={(e) => setGwBenchmark(e.target.value)}>
                  {factors.map((f) => <option key={`bench-${f}`} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
            
            <div className="bg-slate-900 rounded-2xl p-6 shadow-2xl border border-slate-800">
              {!gwSignalTraces ? (
                <div className="h-[400px] flex items-center justify-center text-slate-500 italic">加載圖表數據中...</div>
              ) : (
                <Plot data={gwSignalTraces.traces as any} layout={{ margin: { l: 50, r: 20, t: 20, b: 60 }, height: 420, xaxis: { type: "date", gridcolor: "#1e293b", tickfont: { color: "#94a3b8" } }, yaxis: { gridcolor: "#1e293b", tickfont: { color: "#94a3b8" } }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", legend: { font: { color: "#cbd5e1" }, orientation: "h", y: 1.1 }, shapes: gwSignalTraces.shapes }} style={{ width: "100%" }} useResizeHandler />
              )}
            </div>
            <p className="mt-4 text-xs text-slate-400 italic">註：平均績效採計事件日後之區間報酬；訊號圖標記採對齊交易日處理。本平台數據僅供學術與參考用途。</p>
          </div>
        </section>
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>
    </div>
  );
}
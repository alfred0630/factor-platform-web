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
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

// Types
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

type ManifestResp = {
  factors: string[];
};

// Helpers
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
  Momenton_01: "#bcbd22",
  Momenton_03: "#8c564b",
  Momenton_06: "#f1c40f",
  High_yoy: "#4e79a7",
  Margin_growth: "#2ca02c",
  EPS_growth: "#76b7b2",
  Low_beta: "#e377c2",
  Top300: "#9c755f",
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

  // Heatmap
  const [heatmap, setHeatmap] = useState<any>(null);

  // Global Wave
  const [gwSelected, setGwSelected] = useState<string[]>(["Top300", "PE_low", "PB_low"]);
  const [gwData, setGwData] = useState<Record<string, GlobalWaveResp>>({});
  const [gwLoading, setGwLoading] = useState(false);
  const [gwHorizon, setGwHorizon] = useState<6 | 12>(6);
  const [gwBenchmark, setGwBenchmark] = useState<string>("Top300");
  const [benchSeries, setBenchSeries] = useState<ReturnsResp | null>(null);

  /** Data Fetching Effects */
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
      } catch (e) {
        setFactors([]);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      if (!selected.length) {
        setSeries({});
        setMetrics([]);
        return;
      }
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
      } catch (e) {
        setSeries({});
        setMetrics([]);
      }
    })();
  }, [selected, start, end, rf]);

  useEffect(() => {
    (async () => {
      try {
        const d = await fetchJson<any>(`${RAW_BASE}/data/heatmap/heatmap_12m.json`);
        setHeatmap(d);
      } catch (e) {
        setHeatmap(null);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      if (!gwSelected.length) {
        setGwData({});
        return;
      }
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
      } catch (e) {
        setGwData({});
      } finally {
        setGwLoading(false);
      }
    })();
  }, [gwSelected]);

  useEffect(() => {
    (async () => {
      if (!gwBenchmark) {
        setBenchSeries(null);
        return;
      }
      try {
        const d = await fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(gwBenchmark)}.json`);
        const normalized: ReturnsResp = { factor: d.factor || d.name || gwBenchmark, dates: d.dates || [], ret: d.ret || [] };
        setBenchSeries(normalized);
      } catch (e) {
        setBenchSeries(null);
      }
    })();
  }, [gwBenchmark]);

  /** Computations for Charts */
  const chartData = useMemo(() => {
    return selected
      .map((f) => {
        const d = series[f];
        if (!d || !d.dates?.length) return null;
        const cum = toCum(d.ret || []);
        return { x: d.dates, y: cum, type: "scatter" as const, mode: "lines" as const, name: f };
      })
      .filter(Boolean);
  }, [series, selected]);

  const gwBar = useMemo(() => {
    const x = gwSelected;
    const key = gwHorizon === 6 ? "avg_6m" : "avg_12m";
    const troughY = x.map((f) => safeNum((gwData[f]?.summary?.trough as any)?.[key] ?? null));
    const peakY = x.map((f) => safeNum((gwData[f]?.summary?.peak as any)?.[key] ?? null));

    return [
      { name: `Trough +${gwHorizon}M`, y: troughY, x, type: "bar" as const, marker: { color: "#22c55e" } },
      { name: `Peak +${gwHorizon}M`, y: peakY, x, type: "bar" as const, marker: { color: "#ef4444" } },
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
    const peaksX: string[] = [];
    const peaksY: number[] = [];
    const troughX: string[] = [];
    const troughY: number[] = [];

    for (const e of eventPool) {
      const idx = x.findIndex((d) => d >= e.date);
      if (idx === -1) continue;
      if (e.type === "peak") {
        peaksX.push(x[idx]);
        peaksY.push(y[idx]);
      } else {
        troughX.push(x[idx]);
        troughY.push(y[idx]);
      }
    }
    const shapes: any[] = eventPool.map((e) => ({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: e.date,
      x1: e.date,
      y0: 0,
      y1: 1,
      line: {
        width: 1,
        color: e.type === "peak" ? "rgba(239,68,68,0.25)" : "rgba(34,197,94,0.25)",
        dash: "dot",
      },
    }));
    const traces: any[] = [
      {
        type: "scatter",
        mode: "lines",
        name: `Benchmark (${gwBenchmark})`,
        x,
        y,
        line: { width: 2, color: "#2563eb" },
        hovertemplate: "%{x}<br>Cum: %{y:.2f}<extra></extra>",
      },
      {
        type: "scatter",
        mode: "markers",
        name: "GW Peak",
        x: peaksX,
        y: peaksY,
        marker: { symbol: "triangle-down", size: 12, color: "#ef4444", line: { width: 1, color: "#111827" } },
        hovertemplate: "Peak<br>%{x}<extra></extra>",
      },
      {
        type: "scatter",
        mode: "markers",
        name: "GW Trough",
        x: troughX,
        y: troughY,
        marker: { symbol: "triangle-up", size: 12, color: "#22c55e", line: { width: 1, color: "#111827" } },
        hovertemplate: "Trough<br>%{x}<extra></extra>",
      },
    ];
    return { traces, shapes };
  }, [benchSeries, gwData, gwBenchmark]);

  // UI Components helpers
  const SectionHeader = ({ title, sub }: { title: string; sub?: string }) => (
    <div className="mb-4 flex flex-col md:flex-row md:items-end md:justify-between gap-2 border-b border-gray-100 pb-2">
      <h2 className="text-xl font-bold text-gray-800 tracking-tight">{title}</h2>
      {sub && <span className="text-xs text-gray-500 font-medium">{sub}</span>}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-gray-900 font-sans selection:bg-blue-100">
      <div className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
        
        {/* Header */}
        <header className="mb-10 flex flex-col gap-4 border-b border-gray-200 pb-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">多因子投資系統</h1>
            <p className="mt-1 text-sm text-gray-500 font-medium">Quantitative Multi-Factor Investment Dashboard</p>
          </div>
          <div className="flex flex-col items-end gap-1">
             <div className="text-xs font-mono text-gray-400 bg-gray-100 px-2 py-1 rounded">
               Data: {GH_OWNER}/{GH_REPO}
             </div>
             <p className="text-[10px] text-gray-400">Next.js • Plotly • Tailwind</p>
          </div>
        </header>

        {/* Main Grid Layout */}
        <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
          
          {/* ================= SECTION 1: Config & Performance ================= */}
          
          {/* Sidebar Config */}
          <div className="md:col-span-4 lg:col-span-3 flex flex-col gap-6">
            <div className="rounded-xl bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-gray-200/60 sticky top-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-4">Parameter Settings</h3>
              
              <div className="space-y-5">
                {/* Factor Selection */}
                <div>
                  <label className="text-sm font-semibold text-gray-700 block mb-2">Select Factors</label>
                  <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50/50 p-2 scrollbar-thin scrollbar-thumb-gray-300">
                    {factors.map((f) => (
                      <label key={f} className="flex items-center gap-3 px-2 py-1.5 hover:bg-white rounded transition-colors cursor-pointer group">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 transition-all"
                          checked={selected.includes(f)}
                          onChange={(e) => {
                            if (e.target.checked) setSelected([...selected, f]);
                            else setSelected(selected.filter((x) => x !== f));
                          }}
                        />
                        <span className="text-sm text-gray-600 group-hover:text-gray-900">{f}</span>
                      </label>
                    ))}
                    {factors.length === 0 && <div className="text-sm text-gray-400 p-2">Loading factors...</div>}
                  </div>
                </div>

                {/* Date Inputs */}
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Start Date</label>
                    <input 
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none bg-white" 
                        type="date"
                        value={start} onChange={(e) => setStart(e.target.value)} 
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">End Date</label>
                    <input 
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none bg-white" 
                        type="date"
                        value={end} onChange={(e) => setEnd(e.target.value)} 
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Risk Free Rate (Ann.)</label>
                    <input
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none bg-white"
                      type="number"
                      step="0.01"
                      value={rf}
                      onChange={(e) => setRf(parseFloat(e.target.value || "0"))}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Performance Charts & Metrics */}
          <div className="md:col-span-8 lg:col-span-9 flex flex-col gap-6">
            <div className="rounded-xl bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-gray-200/60 min-h-[500px]">
              <SectionHeader title="Cumulative Performance" sub="Backtest Returns based on selected range" />
              
              <div className="w-full bg-white rounded-lg overflow-hidden border border-gray-100">
                <Plot
                  data={chartData as any}
                  layout={{ 
                    autosize: true, 
                    margin: { l: 50, r: 20, t: 30, b: 40 },
                    showlegend: true,
                    legend: { orientation: 'h', y: 1.1 },
                    plot_bgcolor: "#fff",
                    paper_bgcolor: "#fff",
                    font: { family: 'inherit', color: '#333' },
                    xaxis: { gridcolor: '#f3f4f6' },
                    yaxis: { gridcolor: '#f3f4f6', tickformat: '.0%' }
                  }}
                  style={{ width: "100%", height: "450px" }}
                  useResizeHandler
                  config={{ displayModeBar: false }}
                />
              </div>
            </div>

            {/* Metrics Table */}
            <div className="rounded-xl bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-gray-200/60">
              <h3 className="text-base font-bold text-gray-800 mb-4">Performance Metrics</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/50">
                      <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase tracking-wider">Factor</th>
                      <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase tracking-wider text-right">Ann Return</th>
                      <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase tracking-wider text-right">Ann Vol</th>
                      <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase tracking-wider text-right">Sharpe</th>
                      <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase tracking-wider text-right">MaxDD</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {metrics.map((row) => (
                      <tr key={row.factor} className="hover:bg-blue-50/30 transition-colors group">
                        <td className="py-3 px-4 font-medium text-gray-900">{row.factor}</td>
                        <td className={`py-3 px-4 text-right tabular-nums font-medium ${row.ann_return > 0 ? "text-green-600" : "text-red-600"}`}>
                            {(row.ann_return * 100).toFixed(2)}%
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-gray-600">{(row.ann_vol * 100).toFixed(2)}%</td>
                        <td className="py-3 px-4 text-right tabular-nums text-gray-600">{row.sharpe === null ? "-" : row.sharpe.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right tabular-nums text-red-500">{(row.maxdd * 100).toFixed(2)}%</td>
                      </tr>
                    ))}
                    {metrics.length === 0 && (
                      <tr><td className="py-8 text-center text-gray-400 italic" colSpan={5}>No data available</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ================= SECTION 2: Heatmap ================= */}
          
          <div className="md:col-span-12 mt-4">
             <div className="rounded-xl bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-gray-200/60">
              <SectionHeader title="Factor Ranking Heatmap" sub="Recent 12 months performance ranking (Top to Bottom)" />

              {!heatmap?.months ? (
                <div className="py-12 text-center text-sm text-gray-400 animate-pulse">Loading heatmap data...</div>
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
                      const pct = r === null || r === undefined || Number.isNaN(r as any) ? "NA" : `${((r as number) * 100).toFixed(2)}%`;
                      text[row][col] = `<span style="font-size:10px; font-weight:520">${fname}</span><br><span style="font-size:11px; font-weight:530">${pct}</span>`;
                    }
                  }
                  const y = Array.from({ length: N }, (_, i) => i + 1);

                  return (
                    <div className="mt-2 w-full overflow-hidden rounded-lg">
                      <Plot
                        data={[
                          {
                            type: "heatmap",
                            z, x: months, y, text,
                            texttemplate: "%{text}",
                            textfont: { size: 9, color: "black" },
                            constraintext: "both",
                            hovertemplate: "Month: %{x}<br>Rank: %{y}<br>%{text}<extra></extra>",
                            colorscale, zmin: 0, zmax: factorList.length - 1, showscale: false,
                          },
                        ] as any}
                        layout={{
                          margin: { l: 50, r: 20, t: 20, b: 80 },
                          height: 650,
                          xaxis: { type: "category", tickangle: -35 },
                          yaxis: { autorange: "reversed", tickmode: "array", tickvals: y },
                          font: { family: 'inherit' },
                          plot_bgcolor: "#fff",
                          paper_bgcolor: "#fff",
                        }}
                        style={{ width: "100%" }}
                        useResizeHandler
                        config={{ displayModeBar: false }}
                      />
                    </div>
                  );
                })()
              )}
            </div>
          </div>

          {/* ================= SECTION 3: Global Wave ================= */}
          
          <div className="md:col-span-12 mt-4">
             <div className="rounded-xl bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-gray-200/60">
              <SectionHeader title="Global Wave Analysis" sub="Macro/Cycle Signal Backtesting" />
              
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 mt-6">
                
                {/* Left: GW Controls */}
                <div className="lg:col-span-4 space-y-6">
                   <div className="rounded-lg bg-gray-50 p-4 border border-gray-200">
                      <div className="flex items-center justify-between mb-3">
                         <span className="text-sm font-semibold text-gray-700">Comparison Factors</span>
                         {/* Pill Toggle */}
                         <div className="flex bg-white rounded-md border border-gray-300 p-0.5 shadow-sm">
                            <button 
                                onClick={() => setGwHorizon(6)} 
                                className={`px-3 py-1 text-xs font-medium rounded ${gwHorizon === 6 ? "bg-gray-800 text-white shadow-sm" : "text-gray-500 hover:text-gray-900"}`}
                            >
                                +6M
                            </button>
                            <button 
                                onClick={() => setGwHorizon(12)} 
                                className={`px-3 py-1 text-xs font-medium rounded ${gwHorizon === 12 ? "bg-gray-800 text-white shadow-sm" : "text-gray-500 hover:text-gray-900"}`}
                            >
                                +12M
                            </button>
                         </div>
                      </div>
                      <div className="max-h-60 overflow-y-auto pr-1 space-y-1 scrollbar-thin scrollbar-thumb-gray-300">
                          {factors.map((f) => (
                            <label key={`gw-${f}`} className="flex items-center gap-3 px-2 py-1.5 hover:bg-white rounded cursor-pointer transition-colors">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                                checked={gwSelected.includes(f)}
                                onChange={(e) => {
                                  if (e.target.checked) setGwSelected([...gwSelected, f]);
                                  else setGwSelected(gwSelected.filter((x) => x !== f));
                                }}
                              />
                              <span className="text-sm text-gray-700">{f}</span>
                            </label>
                          ))}
                      </div>
                      <p className="mt-3 text-[10px] text-gray-400">Select 3-5 factors for clear comparison.</p>
                   </div>
                </div>

                {/* Right: GW Bar Chart */}
                <div className="lg:col-span-8">
                  <div className="h-full min-h-[300px] rounded-lg border border-gray-100 bg-white p-2">
                     {gwLoading ? (
                        <div className="flex h-full items-center justify-center text-sm text-gray-400">Loading Wave Data...</div>
                     ) : gwSelected.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-sm text-gray-400">Select factors on the left to compare</div>
                     ) : (
                        <Plot
                            data={gwBar as any}
                            layout={{
                              barmode: "group",
                              margin: { l: 60, r: 20, t: 20, b: 60 },
                              height: 320,
                              yaxis: { tickformat: ".0%", zeroline: true, gridcolor: '#f3f4f6' },
                              xaxis: { tickangle: -20, type: "category" },
                              legend: { orientation: "h", y: 1.15, x: 0 },
                              plot_bgcolor: "#fff",
                              paper_bgcolor: "#fff",
                              font: { family: 'inherit' }
                            }}
                            style={{ width: "100%" }}
                            config={{ displayModeBar: false }}
                        />
                     )}
                  </div>
                </div>
              </div>

              {/* Summary Table */}
              <div className="mt-8">
                 <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">Signal Statistics Summary</h3>
                 <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-sm text-left bg-white">
                      <thead className="bg-gray-50">
                        <tr className="divide-x divide-gray-200">
                          <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase">Factor</th>
                          <th className="py-3 px-4 font-semibold text-xs text-green-700 uppercase bg-green-50/50 text-right">Trough +6M</th>
                          <th className="py-3 px-4 font-semibold text-xs text-green-700 uppercase bg-green-50/50 text-right">Trough +12M</th>
                          <th className="py-3 px-4 font-semibold text-xs text-red-700 uppercase bg-red-50/50 text-right">Peak +6M</th>
                          <th className="py-3 px-4 font-semibold text-xs text-red-700 uppercase bg-red-50/50 text-right">Peak +12M</th>
                          <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase text-center">N(Trough)</th>
                          <th className="py-3 px-4 font-semibold text-xs text-gray-500 uppercase text-center">N(Peak)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {gwSelected.map((f) => {
                          const d = gwData[f];
                          const tr = d?.summary?.trough;
                          const pk = d?.summary?.peak;
                          return (
                            <tr key={`gw-row-${f}`} className="hover:bg-gray-50 transition-colors">
                              <td className="py-2 px-4 font-medium text-gray-900 border-r border-gray-100">{f}</td>
                              <td className="py-2 px-4 text-right tabular-nums text-green-700 bg-green-50/10">{fmtPct(tr?.avg_6m ?? null)}</td>
                              <td className="py-2 px-4 text-right tabular-nums text-green-700 bg-green-50/10 border-r border-gray-100">{fmtPct(tr?.avg_12m ?? null)}</td>
                              <td className="py-2 px-4 text-right tabular-nums text-red-700 bg-red-50/10">{fmtPct(pk?.avg_6m ?? null)}</td>
                              <td className="py-2 px-4 text-right tabular-nums text-red-700 bg-red-50/10 border-r border-gray-100">{fmtPct(pk?.avg_12m ?? null)}</td>
                              <td className="py-2 px-4 text-center tabular-nums text-gray-600">{tr?.n_events ?? "-"}</td>
                              <td className="py-2 px-4 text-center tabular-nums text-gray-600">{pk?.n_events ?? "-"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                 </div>
              </div>

              {/* Signals Chart */}
              <div className="mt-8 p-4 rounded-xl bg-gray-50 border border-gray-200">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                     <div>
                        <h4 className="text-sm font-bold text-gray-800">Historical Signals & Benchmark</h4>
                        <p className="text-xs text-gray-500 mt-1">
                          <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1"></span>Peak Events
                          <span className="inline-block w-2 h-2 rounded-full bg-green-500 ml-3 mr-1"></span>Trough Events
                        </p>
                     </div>
                     <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-500 uppercase">Benchmark</span>
                        <select 
                            className="text-sm rounded border border-gray-300 px-3 py-1.5 focus:ring-1 focus:ring-blue-500 bg-white" 
                            value={gwBenchmark} 
                            onChange={(e) => setGwBenchmark(e.target.value)}
                        >
                          {factors.map((f) => <option key={`bench-${f}`} value={f}>{f}</option>)}
                        </select>
                     </div>
                  </div>

                  <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    {!gwSignalTraces ? (
                        <div className="h-64 flex items-center justify-center text-sm text-gray-400">Loading chart...</div>
                    ) : (
                        <Plot
                            data={gwSignalTraces.traces as any}
                            layout={{
                            margin: { l: 50, r: 20, t: 20, b: 40 },
                            height: 400,
                            xaxis: { type: "date", gridcolor: '#f3f4f6' },
                            yaxis: { title: "Cumulative", rangemode: "tozero" as const, gridcolor: '#f3f4f6' },
                            legend: { orientation: "h", y: 1.12, x: 0 },
                            shapes: gwSignalTraces.shapes,
                            plot_bgcolor: "#fff",
                            paper_bgcolor: "#fff",
                            font: { family: 'inherit' }
                            }}
                            style={{ width: "100%" }}
                            useResizeHandler
                            config={{ displayModeBar: false }}
                        />
                    )}
                  </div>
              </div>

            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

/** =========================
 *  GitHub data source config
 *  ========================= */
const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";

// raw file base (fast, CORS ok)
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

// GitHub API (to list files)
const GH_API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;

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
  Top300: "#9c755f",
};

// 把顏色變成離散 colorscale（讓 code 對應固定顏色）
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
  // safe ISO date
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
  // drawdown on cumulative NAV
  let peak = 1;
  let nav = 1;
  let maxdd = 0; // negative
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

  // ann return by compounded daily mean (more stable than avg * 252)
  let nav = 1;
  for (const r of ret) nav *= 1 + r;
  const n = ret.length;

  const ann_return = Math.pow(nav, freq / n) - 1;

  // ann vol
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
  // Use GitHub contents API to list /data/returns
  // It returns array of items with name: "<factor>.json"
  const url = `${GH_API_BASE}/data/returns?ref=${encodeURIComponent(GH_BRANCH)}`;
  const items = await fetchJson<any[]>(url);

  const names = (items || [])
    .filter((x) => x?.type === "file" && typeof x?.name === "string" && x.name.toLowerCase().endsWith(".json"))
    .map((x) => x.name.replace(/\.json$/i, ""))
    .filter(Boolean);

  // sort stable
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

  // Heatmap data
  const [heatmap, setHeatmap] = useState<any>(null);

  // ===== Global Wave（獨立選因子）=====
  const [gwSelected, setGwSelected] = useState<string[]>(["Top300", "PE_low", "PB_low"]);
  const [gwData, setGwData] = useState<Record<string, GlobalWaveResp>>({});
  const [gwLoading, setGwLoading] = useState(false);

  // horizon selector: 6m / 12m
  const [gwHorizon, setGwHorizon] = useState<6 | 12>(6);

  // benchmark selector (for signals chart)
  const [gwBenchmark, setGwBenchmark] = useState<string>("Top300");
  const [benchSeries, setBenchSeries] = useState<ReturnsResp | null>(null);

  /** =========================
   * Load factor list (GitHub)
   * ========================= */
  useEffect(() => {
    (async () => {
      try {
        const list = await listFactorsFromGithub();
        setFactors(list);

        if (list.length) {
          // init perf selected
          if (!selected.length || !list.includes(selected[0])) setSelected([list[0]]);

          // init gw compare selection
          const defaults = ["Top300", "PE_low", "PB_low"].filter((x) => list.includes(x));
          setGwSelected(defaults.length ? defaults : list.slice(0, Math.min(3, list.length)));

          // init benchmark
          setGwBenchmark(list.includes("Top300") ? "Top300" : list[0]);
        }
      } catch (e) {
        setFactors([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** =========================
   * Load returns (raw github)
   * and compute metrics on client
   * ========================= */
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
            // normalize: our exporter may store {name, dates, ret}
            const factorName = d.factor || d.name || f;
            const normalized: ReturnsResp = { factor: factorName, dates: d.dates || [], ret: d.ret || [] };
            const clipped = clipByRange(normalized, start, end);
            return [f, clipped] as const;
          })
        );

        const obj: Record<string, ReturnsResp> = {};
        for (const [f, d] of pairs) obj[f] = d;
        setSeries(obj);

        // metrics (client)
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

  /** =========================
   * Heatmap
   * ========================= */
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

  /** =========================
   * Global wave compare
   * ========================= */
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

  /** =========================
   * Benchmark series for GW signals chart
   * ========================= */
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

  // Chart data (perf)
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

  // Global Wave bar chart data (user selects horizon: +6m or +12m)
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

  // Global Wave signals on benchmark cumulative chart
  const gwSignalTraces = useMemo(() => {
    if (!benchSeries?.dates?.length || !benchSeries?.ret?.length) return null;

    const x = benchSeries.dates;
    const y = toCum(benchSeries.ret);

    // events: union from any loaded global wave factor
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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="text-2xl font-semibold">Factor Investing Dashboard (MVP)</h1>
        <p className="mt-1 text-sm text-gray-600">
          資料來源：GitHub（{GH_OWNER}/{GH_REPO}）｜ 前端：Next.js（本機 3000 / GitHub Pages）
        </p>

        {/* grid：第1排 Sidebar+區間績效，第2排 Heatmap，第3排 Global Wave */}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-12">
          {/* ================= Sidebar（只在第一排） ================= */}
          <div className="md:col-span-4 rounded-2xl bg-white p-4 shadow-sm border">
            <h2 className="text-lg font-semibold">設定</h2>

            <div className="mt-4">
              <div className="text-sm font-medium">選因子（可多選）</div>
              <div className="mt-2 max-h-40 overflow-auto rounded-xl border p-2">
                {factors.map((f) => (
                  <label key={f} className="flex items-center gap-2 py-1 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(f)}
                      onChange={(e) => {
                        if (e.target.checked) setSelected([...selected, f]);
                        else setSelected(selected.filter((x) => x !== f));
                      }}
                    />
                    {f}
                  </label>
                ))}
                {factors.length === 0 && <div className="text-sm text-gray-500">因子清單讀取失敗（檢查 GitHub repo /data/returns）</div>}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <div>
                <div className="text-sm font-medium">Start</div>
                <input className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>

              <div>
                <div className="text-sm font-medium">End</div>
                <input className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>

              <div>
                <div className="text-sm font-medium">rf（年化）</div>
                <input
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  type="number"
                  step="0.01"
                  value={rf}
                  onChange={(e) => setRf(parseFloat(e.target.value || "0"))}
                />
              </div>
            </div>

            <div className="mt-4 text-xs text-gray-500">* Global Wave 區塊會在下方獨立選因子（不跟這裡同步）。</div>
          </div>

          {/* ================= 區間績效（第一排右側） ================= */}
          <div className="md:col-span-8 rounded-2xl bg-white p-4 shadow-sm border">
            <h2 className="text-lg font-semibold">區間績效</h2>

            <div className="mt-3">
              <Plot
                data={chartData as any}
                layout={{ title: "Cumulative Return", autosize: true, margin: { l: 50, r: 20, t: 50, b: 40 } }}
                style={{ width: "100%", height: "420px" }}
                useResizeHandler
              />
            </div>

            <h3 className="mt-6 text-base font-semibold">指標（前端即時計算）</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 text-left">Factor</th>
                    <th className="py-2 text-left">Ann Return</th>
                    <th className="py-2 text-left">Ann Vol</th>
                    <th className="py-2 text-left">Sharpe</th>
                    <th className="py-2 text-left">MaxDD</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((row) => (
                    <tr key={row.factor} className="border-b last:border-0">
                      <td className="py-2">{row.factor}</td>
                      <td className="py-2">{(row.ann_return * 100).toFixed(2)}%</td>
                      <td className="py-2">{(row.ann_vol * 100).toFixed(2)}%</td>
                      <td className="py-2">{row.sharpe === null ? "-" : row.sharpe.toFixed(2)}</td>
                      <td className="py-2">{(row.maxdd * 100).toFixed(2)}%</td>
                    </tr>
                  ))}
                  {metrics.length === 0 && (
                    <tr>
                      <td className="py-3 text-gray-500" colSpan={5}>
                        沒有指標資料（可能是日期範圍沒有資料或資料載入失敗）
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ================= Heatmap（第二排，跨整排） ================= */}
          <div className="md:col-span-12 rounded-2xl bg-white p-4 shadow-sm border">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">近 12 月因子報酬排名</h2>
              <div className="text-xs text-gray-500">顏色固定對應因子｜每月由上到下排序</div>
            </div>

            {!heatmap?.months ? (
              <div className="mt-3 text-sm text-gray-500">熱力圖資料讀取中…（GitHub: data/heatmap/heatmap_12m.json）</div>
            ) : (
              (() => {
                const months: string[] = heatmap.months;
                const rankedFactors: string[][] = heatmap.ranked_factors;
                const rankedReturns: (number | null)[][] = heatmap.ranked_returns;

                const N = rankedFactors?.[0]?.length ?? 0;

                const factorList: string[] =
                  heatmap.factors && Array.isArray(heatmap.factors) ? heatmap.factors : Array.from(new Set(rankedFactors.flat()));

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

                    text[row][col] =
                      `<span style="font-size:10px; font-weight:520">${fname}</span><br>` +
                      `<span style="font-size:11px; font-weight:530">${pct}</span>`;
                  }
                }

                const y = Array.from({ length: N }, (_, i) => i + 1);

                return (
                  <div className="mt-3">
                    <Plot
                      data={[
                        {
                          type: "heatmap",
                          z,
                          x: months,
                          y,
                          text,
                          texttemplate: "%{text}",
                          textfont: { size: 9, color: "black" },
                          constraintext: "both",
                          hovertemplate: "Month: %{x}<br>Rank: %{y}<br>%{text}<extra></extra>",
                          colorscale,
                          zmin: 0,
                          zmax: factorList.length - 1,
                          showscale: false,
                        },
                      ] as any}
                      layout={{
                        margin: { l: 50, r: 20, t: 20, b: 90 },
                        height: 720,
                        xaxis: { type: "category", tickangle: -35 },
                        yaxis: { autorange: "reversed", tickmode: "array", tickvals: y },
                      }}
                      style={{ width: "100%" }}
                    />
                  </div>
                );
              })()
            )}
          </div>

          {/* ================= Global Wave（第三排，跨整排） ================= */}
          <div className="md:col-span-12 rounded-2xl bg-white p-4 shadow-sm border">
            <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
              <h2 className="text-lg font-semibold">Global Wave</h2>
              <div className="text-xs text-gray-500">先選 +6M / +12M，再比較多因子；下方圖顯示歷史 Peak / Trough 訊號</div>
            </div>

            {/* Controls */}
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-5">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">比較因子（可多選）</div>

                  {/* horizon toggle */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Horizon</span>
                    <div className="inline-flex rounded-xl border bg-white p-1">
                      <button onClick={() => setGwHorizon(6)} className={`px-3 py-1 text-sm rounded-lg ${gwHorizon === 6 ? "bg-black text-white" : ""}`}>
                        +6M
                      </button>
                      <button onClick={() => setGwHorizon(12)} className={`px-3 py-1 text-sm rounded-lg ${gwHorizon === 12 ? "bg-black text-white" : ""}`}>
                        +12M
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-2 max-h-48 overflow-auto rounded-xl border p-2">
                  {factors.map((f) => (
                    <label key={`gw-${f}`} className="flex items-center gap-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={gwSelected.includes(f)}
                        onChange={(e) => {
                          if (e.target.checked) setGwSelected([...gwSelected, f]);
                          else setGwSelected(gwSelected.filter((x) => x !== f));
                        }}
                      />
                      {f}
                    </label>
                  ))}
                  {factors.length === 0 && <div className="text-sm text-gray-500">因子清單讀取失敗</div>}
                </div>

                <div className="mt-2 text-xs text-gray-500">建議選 3–8 個最清楚（太多會擠）。</div>
              </div>

              <div className="md:col-span-7">
                <div className="rounded-2xl border bg-gray-50 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">平均績效比較（{gwHorizon}M）</div>
                    <div className="text-xs text-gray-500">綠：Trough 後｜紅：Peak 後</div>
                  </div>

                  {gwLoading ? (
                    <div className="text-sm text-gray-500 mt-4">Global Wave 讀取中…（GitHub: data/global_wave/*.json）</div>
                  ) : gwSelected.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-4">請在左側勾選至少一個因子。</div>
                  ) : (
                    <Plot
                      data={gwBar as any}
                      layout={{
                        barmode: "group",
                        margin: { l: 70, r: 20, t: 20, b: 120 },
                        height: 360,
                        yaxis: { tickformat: ".0%", zeroline: true },
                        xaxis: { tickangle: -35, type: "category" },
                        legend: { orientation: "h" as const, y: 1.15, x: 0 },
                      }}
                      style={{ width: "100%" }}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Summary table */}
            <h3 className="mt-6 text-base font-semibold">Summary</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 text-left">Factor</th>
                    <th className="py-2 text-left">Trough +6M</th>
                    <th className="py-2 text-left">Trough +12M</th>
                    <th className="py-2 text-left">Peak +6M</th>
                    <th className="py-2 text-left">Peak +12M</th>
                    <th className="py-2 text-left">n(Trough)</th>
                    <th className="py-2 text-left">n(Peak)</th>
                  </tr>
                </thead>
                <tbody>
                  {gwSelected.map((f) => {
                    const d = gwData[f];
                    const tr = d?.summary?.trough;
                    const pk = d?.summary?.peak;
                    return (
                      <tr key={`gw-row-${f}`} className="border-b last:border-0">
                        <td className="py-2">{f}</td>
                        <td className="py-2">{fmtPct(tr?.avg_6m ?? null)}</td>
                        <td className="py-2">{fmtPct(tr?.avg_12m ?? null)}</td>
                        <td className="py-2">{fmtPct(pk?.avg_6m ?? null)}</td>
                        <td className="py-2">{fmtPct(pk?.avg_12m ?? null)}</td>
                        <td className="py-2">{tr?.n_events ?? "-"}</td>
                        <td className="py-2">{pk?.n_events ?? "-"}</td>
                      </tr>
                    );
                  })}
                  {gwSelected.length > 0 && Object.keys(gwData).length === 0 && !gwLoading && (
                    <tr>
                      <td className="py-3 text-gray-500" colSpan={7}>
                        沒有 global wave 資料（確認 GitHub 上 data/global_wave/*.json 是否存在）
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Signals chart */}
            <div className="mt-8 rounded-2xl border bg-gray-50 p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-sm font-semibold">Global Wave 訊號歷史位置</div>
                  <div className="text-xs text-gray-500">藍線：Benchmark 累積報酬｜紅▼：Peak｜綠▲：Trough｜淡虛線：事件日期</div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Benchmark</span>
                  <select className="rounded-xl border px-3 py-2 text-sm bg-white" value={gwBenchmark} onChange={(e) => setGwBenchmark(e.target.value)}>
                    {factors.map((f) => (
                      <option key={`bench-${f}`} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!gwSignalTraces ? (
                <div className="mt-3 text-sm text-gray-500">圖表讀取中…（需要 returns + global wave events）</div>
              ) : (
                <div className="mt-3">
                  <Plot
                    data={gwSignalTraces.traces as any}
                    layout={{
                      margin: { l: 70, r: 20, t: 20, b: 60 },
                      height: 420,
                      xaxis: { type: "date" },
                      yaxis: { title: "Cumulative", rangemode: "tozero" as const },
                      legend: { orientation: "h" as const, y: 1.12, x: 0 },
                      shapes: gwSignalTraces.shapes,
                    }}
                    style={{ width: "100%" }}
                    useResizeHandler
                  />
                </div>
              )}
            </div>

            <div className="mt-3 text-xs text-gray-500">
              註：平均績效使用事件日之後的區間報酬（(date, date+6M] / (date, date+12M]）。訊號圖上若事件日非交易日，會對齊到「事件日之後第一個交易日」。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

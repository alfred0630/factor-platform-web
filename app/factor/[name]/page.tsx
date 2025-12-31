import React from "react";
import FactorDetailClient from "./FactorDetailClient";

const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

type ManifestResp = { factors: string[] };

// ✅ 靜態匯出必須提供所有 [name]
export async function generateStaticParams() {
  const url = `${RAW_BASE}/data/manifest.json`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const m = (await res.json()) as ManifestResp;
  const factors = (m?.factors || [])
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .map((name) => ({ name }));

  return factors;
}

// （可選）更保險：避免被判定成 dynamic
export const dynamic = "force-static";

export default function Page({ params }: { params: { name: string } }) {
  // params.name 在 Next 會是已解碼或半解碼，這裡統一 decode 一次
  const name = decodeURIComponent(params.name);
  return <FactorDetailClient name={name} />;
}

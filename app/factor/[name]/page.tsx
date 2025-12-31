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
  try {
    const res = await fetch(url);
    if (!res.ok) return [];

    const m = (await res.json()) as ManifestResp;
    const factors = (m?.factors || [])
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .map((name) => ({ name }));

    return factors;
  } catch (e) {
    console.error("Generate params failed:", e);
    return [];
  }
}

export const dynamic = "force-static";

// 🔴 重點修改在這裡：Next.js 15 中 params 是 Promise
type Props = {
  params: Promise<{ name: string }>;
};

export default async function Page({ params }: Props) {
  // 1. 等待 params 解析
  const resolvedParams = await params;
  
  // 2. 解析後再取 name
  const name = decodeURIComponent(resolvedParams.name);

  return <FactorDetailClient name={name} />;
}
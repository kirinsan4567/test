#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data/market.csv の「ドル円レート」「10年国債金利（長期金利）」列を、
外部の一次データから月末営業日の値で自動更新する。

- ドル円 : FRED DEXJPUS（日次）→ 各月の月末営業日
- 10年国債: 財務省 jgbcme_all.csv（全期間）＋ jgbcme.csv（今年分）→ 月末営業日

既存行は該当2列だけ更新。まだCSVに無い「完了した月」があれば、
年月・ドル円・10年国債だけ入れた行を末尾に追加（他列は空欄＝手で埋める）。
GitHub Actions 上で実行する前提（ネット接続あり）。
"""

import csv
import io
import sys
from datetime import datetime, timezone

import pandas as pd
import requests

MARKET = "data/market.csv"
FX_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXJPUS"
JGB_ALL = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv"
JGB_CUR = "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv"


def month_end_map_from_daily(df, date_col, val_col, ndigits):
    df = df.copy()
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df[val_col] = pd.to_numeric(df[val_col], errors="coerce")
    df = df.dropna(subset=[date_col, val_col])
    df["_ym"] = df[date_col].dt.to_period("M").astype(str)
    m = df.sort_values(date_col).groupby("_ym").tail(1)
    return {k: round(float(v), ndigits) for k, v in zip(m["_ym"], m[val_col])}


def fetch_fx():
    r = requests.get(FX_URL, timeout=30)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.content.decode("utf-8")))
    return month_end_map_from_daily(df, df.columns[0], df.columns[1], 2)


def norm_col(c):
    s = str(c).strip().lower()
    for w in ("years", "year", "年", "y"):
        s = s.replace(w, "")
    return s.strip()


def fetch_jgb():
    frames = []
    for u in (JGB_ALL, JGB_CUR):
        try:
            r = requests.get(u, timeout=30)
            r.raise_for_status()
            try:
                text = r.content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = r.content.decode("shift_jis", errors="replace")
            frames.append(pd.read_csv(io.StringIO(text)))
        except Exception as e:
            print("JGB取得スキップ:", u, e, file=sys.stderr)
    if not frames:
        raise RuntimeError("JGBデータを取得できませんでした")
    df = pd.concat(frames, ignore_index=True)
    date_col = df.columns[0]
    ten = next((c for c in df.columns if norm_col(c) == "10"), None)
    if ten is None and len(df.columns) > 10:
        ten = df.columns[10]
    return month_end_map_from_daily(df, date_col, ten, 3)


def main():
    fx = fetch_fx()
    jgb = fetch_jgb()
    print(f"取得: ドル円 {len(fx)}件 / 10年国債 {len(jgb)}件")

    rows = list(csv.reader(open(MARKET, newline="", encoding="utf-8")))
    h = rows[0]
    i_fx = next(j for j, x in enumerate(h) if "ドル円" in x)
    i_jgb = next(j for j, x in enumerate(h) if "10年国債" in x)
    existing = {r[0].strip() for r in rows[1:] if r and r[0].strip()}

    changed = 0
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        ym = r[0].strip()
        if ym in fx and (len(r) <= i_fx or r[i_fx] != f"{fx[ym]:.2f}"):
            r[i_fx] = f"{fx[ym]:.2f}"; changed += 1
        if ym in jgb and (len(r) <= i_jgb or r[i_jgb] != f"{jgb[ym]:.3f}"):
            r[i_jgb] = f"{jgb[ym]:.3f}"; changed += 1

    now_ym = datetime.now(timezone.utc).strftime("%Y-%m")
    new_months = sorted((set(fx) & set(jgb)) - existing)
    appended = 0
    for ym in new_months:
        if ym >= now_ym:      # 進行中の月は未確定なので追加しない
            continue
        row = [""] * len(h)
        row[0] = ym
        row[i_fx] = f"{fx[ym]:.2f}"
        row[i_jgb] = f"{jgb[ym]:.3f}"
        rows.append(row)
        appended += 1

    with open(MARKET, "w", newline="", encoding="utf-8") as f:
        csv.writer(f, quoting=csv.QUOTE_MINIMAL).writerows(rows)

    print(f"更新セル: {changed} / 追加行: {appended}")
    for r in [x for x in rows[1:] if x and x[0].strip()][-3:]:
        print("  ", r[0].strip(), "ドル円=", r[i_fx], "10年=", r[i_jgb])


if __name__ == "__main__":
    main()

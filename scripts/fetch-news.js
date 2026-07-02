// scripts/fetch-news.js
// KIRIN Insights ニュース収集スクリプト
// 役割: 複数RSSを巡回 → 整形 → タグ付け → 重複除去 → data/news.json に「追記」保存
//
// 設計方針:
//  - キーワードはグループ化したタグで付与（複数タグOK）。
//  - 同じ記事は出さない（URL正規化して名寄せ。同記事が複数フィードに出たらタグを統合）。
//  - 過去分はストック（既存JSONに追記、最新順、上限 MAX_ITEMS 件で打ち切り）。
//  - フィードが1本死んでも全体は止めない（自動スキップ）。
//
// フィードの type:
//  - "google": Google ニュース検索RSS。リンクは news.google.com のリダイレクトURL
//              （ブラウザのクリックでは本物の記事に飛ぶ）。媒体名はタイトル末尾から抽出。
//  - 省略時 : 各媒体の公式RSS（"direct"扱い）。リンクは実URL。媒体名は name を使用。

import fs from "fs";
import path from "path";
import Parser from "rss-parser";

const parser = new Parser({ timeout: 15000 });

const OUT_PATH = "data/news.json";
const MAX_ITEMS = 1200; // ストック上限（古いものから捨てる）

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────
// 1) フィード一覧
//   ⚠️ 確認は手動でしなくてOK。Actionを1回回して、ログの
//      「OK <名前> (N件)」/「SKIP <名前>: ...」で生死が分かります。
//      死んでるものを後から消すだけ。
// ───────────────────────────────────────────────────────────
const FEEDS = [
  // ── Google ニュース site: 検索（媒体を絞る）──────────────
  { name: "ブルームバーグ", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:bloomberg.co.jp 不動産 金利 マンション 地価 市況&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "日銀",          type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:boj.or.jp 金融政策 金利 住宅ローン&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "ロイター",      type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:reuters.com 日本 不動産 住宅&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "国交省",        type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:mlit.go.jp 不動産 住宅 地価 統計&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "住宅新報",      type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:jutaku-s.com ニュース&hl=ja&gl=JP&ceid=JP:ja") },

  // ── 横断検索（媒体を絞らず広く拾う）──────────────────────
  { name: "不動産市況", type: "google", url: encodeURI("https://news.google.com/rss/search?q=不動産 マンション 地価 市況&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "金融政策",   type: "google", url: encodeURI("https://news.google.com/rss/search?q=日銀 金融政策 金利 住宅ローン&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "住宅ローン(横断)", type: "google", url: encodeURI("https://news.google.com/rss/search?q=住宅ローン 金利 借り換え 変動金利 固定金利&hl=ja&gl=JP&ceid=JP:ja") },

  // ── ハードニュース（一般紙・通信社。速報性の高い記事を増やす）────
  { name: "日本経済新聞", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:nikkei.com 住宅ローン 金利 不動産 マンション&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "NHK",         type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:www3.nhk.or.jp 金利 住宅ローン 不動産 日銀&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "時事通信",     type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:jiji.com 日銀 金利 不動産 住宅&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "産経ニュース",  type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:sankei.com 日銀 金利 不動産 住宅ローン マンション&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "47NEWS",       type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:47news.jp 日銀 金利 不動産 住宅ローン&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "みんかぶ",      type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:minkabu.jp 金利 不動産 REIT 日銀&hl=ja&gl=JP&ceid=JP:ja") },

  // ── 業界・プレス（開発・デベロッパー・物流施設）──────────────
  { name: "PR TIMES",      type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:prtimes.jp 不動産 マンション 再開発 デベロッパー&hl=ja&gl=JP&ceid=JP:ja") },

  // ── デベロッパー各社（社名で広く収集し、発表語フィルタで厳選）──────
  //   ※公式サイト限定(site:)はGoogleが公式プレスを索引せず取りこぼすため、社名検索に戻す。
  //   dev は絞り込みボタン用の短縮名。採用・人事・株価はマイナス検索で除外。
  //   PR TIMES（https://prtimes.jp/topics/keywords/正式社名）を各社に横展開。
  //   直RSSが構造的に壊れて読めない回があっても（XMLエンティティ不正等）SKIPされるだけなので、
  //   確実版としてGoogle検索スコープ（site:prtimes.jp "正式社名"）も併用する。
  { name: "三井不動産",     type: "google", kind: "press", dev: "三井", url: encodeURI('https://news.google.com/rss/search?q="三井不動産" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（三井不動産）", kind: "press", dev: "三井", url: encodeURI("https://prtimes.jp/topics/keywords/三井不動産") },
  { name: "PR TIMES（三井不動産）", type: "google", kind: "press", dev: "三井", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "三井不動産"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "三菱地所",       type: "google", kind: "press", dev: "三菱", url: encodeURI('https://news.google.com/rss/search?q="三菱地所" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（三菱地所）", kind: "press", dev: "三菱", url: encodeURI("https://prtimes.jp/topics/keywords/三菱地所") },
  { name: "PR TIMES（三菱地所）", type: "google", kind: "press", dev: "三菱", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "三菱地所"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "野村不動産",     type: "google", kind: "press", dev: "野村", url: encodeURI('https://news.google.com/rss/search?q="野村不動産" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  // 野村不動産：事業会社とホールディングスでPR TIMES上のキーワードページが分かれているため両方収集。
  { name: "PR TIMES（野村不動産）", kind: "press", dev: "野村", url: encodeURI("https://prtimes.jp/topics/keywords/野村不動産") },
  { name: "PR TIMES（野村不動産）", type: "google", kind: "press", dev: "野村", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "野村不動産"&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（野村不動産ホールディングス）", kind: "press", dev: "野村", url: encodeURI("https://prtimes.jp/topics/keywords/野村不動産ホールディングス") },
  { name: "PR TIMES（野村不動産ホールディングス）", type: "google", kind: "press", dev: "野村", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "野村不動産ホールディングス"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "東急不動産",     type: "google", kind: "press", dev: "東急", url: encodeURI('https://news.google.com/rss/search?q="東急不動産" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（東急不動産）", kind: "press", dev: "東急", url: encodeURI("https://prtimes.jp/topics/keywords/東急不動産") },
  { name: "PR TIMES（東急不動産）", type: "google", kind: "press", dev: "東急", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "東急不動産"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "東京建物",       type: "google", kind: "press", dev: "東建", url: encodeURI('https://news.google.com/rss/search?q="東京建物" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（東京建物）", kind: "press", dev: "東建", url: encodeURI("https://prtimes.jp/topics/keywords/東京建物") },
  { name: "PR TIMES（東京建物）", type: "google", kind: "press", dev: "東建", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "東京建物"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "森ビル",         type: "google", kind: "press", dev: "森",   url: encodeURI('https://news.google.com/rss/search?q="森ビル" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（森ビル）", kind: "press", dev: "森", url: encodeURI("https://prtimes.jp/topics/keywords/森ビル") },
  { name: "PR TIMES（森ビル）", type: "google", kind: "press", dev: "森", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "森ビル"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "住友不動産",     type: "google", kind: "press", dev: "住友", url: encodeURI('https://news.google.com/rss/search?q="住友不動産" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（住友不動産）", kind: "press", dev: "住友", url: encodeURI("https://prtimes.jp/topics/keywords/住友不動産") },
  { name: "PR TIMES（住友不動産）", type: "google", kind: "press", dev: "住友", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "住友不動産"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "日鉄興和不動産",  type: "google", kind: "press", dev: "日鉄", url: encodeURI('https://news.google.com/rss/search?q="日鉄興和不動産" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（日鉄興和不動産）", kind: "press", dev: "日鉄", url: encodeURI("https://prtimes.jp/topics/keywords/日鉄興和不動産") },
  { name: "PR TIMES（日鉄興和不動産）", type: "google", kind: "press", dev: "日鉄", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "日鉄興和不動産"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "大和ハウス工業",  type: "google", kind: "press", dev: "大和", url: encodeURI('https://news.google.com/rss/search?q="大和ハウス工業" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（大和ハウス工業）", kind: "press", dev: "大和", url: encodeURI("https://prtimes.jp/topics/keywords/大和ハウス工業") },
  { name: "PR TIMES（大和ハウス工業）", type: "google", kind: "press", dev: "大和", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "大和ハウス工業"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "積水ハウス",     type: "google", kind: "press", dev: "積水", url: encodeURI('https://news.google.com/rss/search?q="積水ハウス" -採用 -人事 -株価&hl=ja&gl=JP&ceid=JP:ja') },
  { name: "PR TIMES（積水ハウス）", kind: "press", dev: "積水", url: encodeURI("https://prtimes.jp/topics/keywords/積水ハウス") },
  { name: "PR TIMES（積水ハウス）", type: "google", kind: "press", dev: "積水", url: encodeURI('https://news.google.com/rss/search?q=site:prtimes.jp "積水ハウス"&hl=ja&gl=JP&ceid=JP:ja') },

  { name: "日刊工業新聞",  type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:nikkan.co.jp 不動産 再開発 建設 住宅&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "ニュースイッチ", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:newswitch.jp 不動産 再開発 建設 住宅&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "LNEWS",         type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:lnews.jp 物流施設 不動産 開発&hl=ja&gl=JP&ceid=JP:ja") },

  // ── コラム・読み物（不動産関連のものだけタグ厳選で残る）──────
  { name: "ゴールドオンライン", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:gentosha-go.com 不動産 マンション 相続 不動産投資 住宅ローン&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "Forbes JAPAN",   type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:forbesjapan.com 不動産 デベロッパー 再開発 マンション&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "マイナビニュース", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:news.mynavi.jp 住宅ローン 金利 不動産 マンション&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "CNET Japan",     type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:japan.cnet.com 不動産 再開発 スマートシティ&hl=ja&gl=JP&ceid=JP:ja") },

  // ── 不動産・建設の専門メディア（Google site: 検索）──────────
  //   公式RSSが無い媒体もここで拾える。リンクはGoogleリダイレクト・要約なし。
  //   ログのヒット件数を見て、0件/SKIPは削除してください。
  { name: "R.E.port",        type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:re-port.net 不動産 マンション 地価&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "全国賃貸住宅新聞", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:zenchin.com 賃貸 不動産 住宅&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "健美家",          type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:kenbiya.com/ar&hl=ja&gl=JP&ceid=JP:ja") },
  // 不動産経済研究所: タイトルが「日刊不動産経済通信」ばかりで実記事が拾えないため一旦停止。
  //   正しい「最新記事一覧」やRSSのURLが分かれば差し替えます。
  // { name: "不動産経済研究所", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:fudousankeizai.co.jp マンション 不動産&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "楽待新聞",        type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:rakumachi.jp 不動産 投資 金利&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "建設通信新聞",    type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:kensetsunews.com 不動産 住宅 再開発&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "日刊建設工業新聞", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:decn.co.jp 不動産 住宅 再開発&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "建設新聞",        type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:kensetsu-sinbun.co.jp 不動産 住宅&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "日経不動産マーケット情報", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:nfm.nikkeibp.co.jp 不動産 マンション 再開発 金利&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "住宅産業新聞(sjt)", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:sjt.co.jp/news&hl=ja&gl=JP&ceid=JP:ja") },

  // ── 各媒体の公式RSS（実URL＋要約文が取れる。type省略＝direct）──
  //   要約は direct フィードのみ採用（Googleの説明欄は関連記事リストで使えないため）。
  //   死んでいれば自動スキップ。ログのヒット件数を見て取捨選択してください。
  { name: "SUUMOジャーナル",   url: "https://suumo.jp/journal/feed/" },
  { name: "ITmedia ビジネス",  url: "https://rss.itmedia.co.jp/rss/2.0/business.xml" },
  { name: "東洋経済オンライン", url: "https://toyokeizai.net/list/feed/rss" },

  // ── 官公庁 追加（一次情報。Google site: 検索で拾う）──────
  { name: "財務省",   type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:mof.go.jp 住宅ローン控除 金利 予算&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "金融庁",   type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:fsa.go.jp 住宅ローン 金利 銀行&hl=ja&gl=JP&ceid=JP:ja") },

  // ── プレスリリース配信プラットフォーム 追加（press扱いは不動産関連語で厳選済みのPRESS_SIGNALに依存）──
  { name: "＠Press",      type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:atpress.ne.jp 不動産 マンション 再開発&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "共同通信PRワイヤー", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:kyodonewsprwire.jp 不動産 マンション 住宅ローン&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "Dream News",   type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:dreamnews.jp 不動産 マンション&hl=ja&gl=JP&ceid=JP:ja") },

  // ── 専門メディア 追加（Tier2相当。件数の主力を狙う）─────────
  { name: "不動産経済研究所", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:fudousankeizai.co.jp&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "日刊不動産経済通信", type: "google", url: encodeURI("https://news.google.com/rss/search?q=\"日刊不動産経済通信\"&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "LIFULL HOME'S PRESS", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:homes.co.jp/cont 住宅ローン マンション&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "日経クロステック建設", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:xtech.nikkei.com 建設 再開発 マンション&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "新建築オンライン", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:shinkenchiku.online&hl=ja&gl=JP&ceid=JP:ja") },
  { name: "ダイヤモンド・オンライン", type: "google", url: encodeURI("https://news.google.com/rss/search?q=site:diamond.jp 住宅ローン 金利 不動産&hl=ja&gl=JP&ceid=JP:ja") },
];

// ───────────────────────────────────────────────────────────
// 2) タグ（キーワードのグループ化）
//   タイトルにキーワードを含むグループのラベルを全部付ける（複数可）。
// ───────────────────────────────────────────────────────────
const TAG_GROUPS = [
  { label: "金利・日銀",   keywords: ["日銀", "利上げ", "利下げ", "政策金利", "金融政策", "金利", "変動金利", "固定金利"] },
  { label: "住宅ローン",   keywords: ["住宅ローン", "繰上返済", "繰り上げ返済", "借入", "借り入れ", "団信", "フラット35", "控除", "減税"] },
  { label: "不動産・市場", keywords: ["不動産", "マンション", "タワマン", "タワーマンション", "戸建", "新築", "中古", "分譲", "地価", "住宅価格", "市況", "賃貸", "湾岸"] },
  { label: "開発・デベロッパー", keywords: ["デベロッパー", "ディベロッパー", "再開発", "都市開発", "大規模開発", "竣工", "着工", "三井不動産", "三菱地所", "住友不動産", "野村不動産", "東急不動産", "森ビル", "大和ハウス", "積水ハウス", "住友林業", "東京建物", "日鉄興和不動産"] }
];

// ───────────────────────────────────────────────────────────
// ヘルパー
// ───────────────────────────────────────────────────────────

// URL正規化（重複判定キー）: ハッシュとトラッキングパラメータを除去
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    const drop = [...u.searchParams.keys()].filter(
      k => /^utm_|^gclid$|^fbclid$|^yclid$|^ref$|^cmpid$/i.test(k)
    );
    drop.forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return (raw || "").trim();
  }
}

const tidy = s => (s || "").replace(/\s+/g, " ").trim();

// 転載アグリゲーター（同一記事を量産する。名寄せ時は元媒体を優先）
const AGGREGATORS = ["Yahoo", "ヤフー", "au Webポータル", "auサービス", "Excite", "エキサイト", "SmartNews", "スマートニュース", "livedoor", "ライブドア", "goo", "BIGLOBE", "ニフティ", "Infoseek", "dメニュー"];
const isAgg = s => AGGREGATORS.some(a => (s || "").includes(a));

// 重複時の優先順位: 各社サイト・報道(2) > PR TIMES(1) > アグリゲーター(0)
function rank(src) {
  if (isAgg(src)) return 0;
  if (/PR\s?TIMES/i.test(src || "")) return 1;
  return 2;
}

// タイトル正規化キー（全半角・記号・末尾の（媒体名）を除去して比較）
function titleKey(t) {
  let s = (t || "").normalize("NFKC");
  s = s.replace(/[(（][^()（）]*[)）]\s*$/u, "");   // 末尾の括弧（媒体名等）を1つ除去
  s = s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase(); // 記号・空白を全部落とす
  return s;
}

const stripTags = s => (s || "").replace(/<[^>]*>/g, " ");
function cleanSummary(raw, max = 140) {
  let s = tidy(stripTags(raw));
  if (s.length > max) s = s.slice(0, max).trim() + "…";
  return s;
}

// Google ニュースのタイトルは「記事タイトル - 媒体名」。媒体名を切り出す。
function splitGoogleTitle(rawTitle) {
  const t = rawTitle || "";
  const idx = t.lastIndexOf(" - ");
  if (idx > 0) return { title: t.slice(0, idx), source: t.slice(idx + 3) };
  return { title: t, source: "" };
}

// タグ判定（複数返す）
function detectTags(title) {
  const t = title || "";
  const tags = TAG_GROUPS.filter(g => g.keywords.some(k => t.includes(k))).map(g => g.label);
  return tags.length ? tags : ["その他"];
}

// 短縮デベロッパー名タグ（正式名→短縮）。物件名やプレスに付与。
const DEV_SHORT = [
  ["三井不動産", "三井"], ["三菱地所", "三菱"], ["野村不動産ホールディングス", "野村"], ["野村不動産", "野村"],
  ["住友不動産", "住友"], ["東京建物", "東建"], ["日鉄興和不動産", "日鉄"], ["東急不動産", "東急"], ["森ビル", "森"],
  ["大和ハウス工業", "大和"], ["大和ハウス", "大和"], ["積水ハウス", "積水"]
];

// マンションブランド名からもデベロッパーを推定する。
// 実際の記事タイトルは「三井不動産、○○を発売」より「パークコート○○発売」のように
// 社名を出さずブランド名だけのことが非常に多いため、これが無いと開発者タグが付かない。
const BRAND_SHORT = [
  // 三井不動産
  ["パークコート", "三井"], ["パークホームズ", "三井"], ["パークタワー", "三井"], ["パークシティ", "三井"],
  ["パークアクシス", "三井"], ["パークリュクス", "三井"], ["パークマンション", "三井"],
  // 三菱地所
  ["パークハウス", "三菱"], ["パークワンズ", "三菱"],
  // 野村不動産
  ["プラウドタワー", "野村"], ["プラウド", "野村"], ["オハナ", "野村"],
  // 住友不動産
  ["シティハウス", "住友"], ["シティテラス", "住友"], ["シティタワー", "住友"], ["グランドヒルズ", "住友"], ["ガーデンハウス", "住友"],
  // 東急不動産
  ["ブランズ", "東急"],
  // 東急リバブル（東急不動産とは別タグで管理）
  ["ルジェンテ", "東急リ"],
  // 東京建物
  ["ブリリア", "東建"],
  // 日鉄興和不動産
  ["グランリビオ", "日鉄"], ["リビオ", "日鉄"],
  // 積水ハウス
  ["グランドメゾン", "積水"],
  // 大和ハウス工業
  ["プレミスト", "大和"],
  // 新規（専用の収集フィードはまだ無く、タグ付けのみ対応）
  ["ローレルコート", "近鉄"], ["ローレルアイ", "近鉄"],           // 近鉄不動産
  ["クレヴィア", "伊藤忠"],                                        // 伊藤忠（都市開発）
  ["ディアナコート", "モリモト"], ["ピアース", "モリモト"],        // モリモト
  ["クラッシィ", "住友商事"],                                      // 住友商事（住友不動産とは別会社）
  ["アトラス", "旭化成"],                                          // 旭化成不動産レジデンス
  ["クリオ", "明和地所"],                                          // 明和地所
  ["オープンレジデンシア", "OH"], ["イノバス", "OH"], ["イノベイシア", "OH"], // オープンハウス
];

function devTags(title) {
  const t = title || "";
  const fromCompany = DEV_SHORT.filter(([full]) => t.includes(full)).map(([, sh]) => sh);
  const fromBrand = BRAND_SHORT.filter(([brand]) => t.includes(brand)).map(([, sh]) => sh);
  return Array.from(new Set([...fromCompany, ...fromBrand]));
}

// プレスリリース選別用
//  ・JUNK: ログイン/採用/会社情報など、プレスでないページを除外
//  ・PRESS_SIGNAL: 開発・竣工・取得・開業・決算 等「発表らしい語」。pressはこれを含むもののみ採用
const JUNK = ["ログイン", "ログアウト", "会員", "マイページ", "採用", "求人", "エントリー", "新卒", "中途",
  "お問い合わせ", "プライバシー", "個人情報", "サイトマップ", "利用規約", "会社概要", "企業情報",
  "よくあるご質問", "メンテナンス", "404", "Not Found", "ページが見つかりません"];
const PRESS_SIGNAL = ["竣工", "着工", "起工", "完成", "取得", "売却", "開業", "開発", "再開発", "分譲", "賃貸",
  "リニューアル", "改修", "建替", "締結", "提携", "出店", "開設", "プロジェクト", "タワー", "マンション",
  "オフィス", "商業施設", "ホテル", "物流施設", "まちづくり", "用地", "区画", "街区",
  "決算", "業績", "増益", "営業利益", "受注", "販売", "供給", "新築", "新発売", "発売開始", "リーシング",
  "グランドオープン", "分譲開始", "竣功"];
const isJunk = t => JUNK.some(k => (t || "").includes(k));
const isPressRelevant = t => PRESS_SIGNAL.some(k => (t || "").includes(k));

function toISO(item) {
  const d = new Date(item.isoDate || item.pubDate || Date.now());
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function loadExisting() {
  try {
    const arr = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ───────────────────────────────────────────────────────────
// メイン
// ───────────────────────────────────────────────────────────
(async () => {
  const existing = loadExisting();

  // サンプル/プレースホルダは取り込まない（次回実行で自動的に消える）
  const isPlaceholder = it =>
    !it || it.url === "#" || it.source === "（サンプル）" ||
    (typeof it.id === "string" && it.id.startsWith("sample"));

  const map = new Map();
  for (const it of existing) {
    if (isPlaceholder(it)) continue;
    if (it && it.id) map.set(it.id, it);
  }

  let added = 0;

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        const link = (item.link || "").trim();

        // タイトルと媒体名
        let title, source;
        if (feed.type === "google") {
          const sp = splitGoogleTitle(item.title || "");
          title = tidy(sp.title);
          source = sp.source || feed.name;
        } else {
          title = tidy(item.title || "");
          source = feed.name;
        }
        if (!title) continue;

        // ニュース・プレス共通: ログイン/採用/会社情報などの非記事ページを除外
        if (isJunk(title)) continue;
        // プレスは「発表らしい語」を含むものだけ（マンション/オフィス/都市開発/決算 等）
        if (feed.kind === "press" && !isPressRelevant(title)) continue;

        const id = normalizeUrl(link) || title;
        let tags = Array.from(new Set([...detectTags(title), ...devTags(title)]));
        // 公式サイト由来のプレスは、タイトルに社名が無くても所属デベロッパーを付与
        if (feed.dev) {
          tags = tags.filter(t => t !== "その他");
          tags = Array.from(new Set([...tags, feed.dev, "開発・デベロッパー"]));
        }

        // 厳選: 興味関心の外（タグが「その他」だけ）はストックしない
        if (tags.length === 1 && tags[0] === "その他") continue;

        // 要約: directフィードのみ採用（Googleの説明欄はリンク集なので使わない）
        let summary = "";
        if (feed.type !== "google") {
          summary = cleanSummary(item.contentSnippet || item.summary || item.content || "");
          if (summary && (summary === title || title.includes(summary) || summary.length < 15)) summary = "";
        }

        if (map.has(id)) {
          const cur = map.get(id);
          cur.tags = Array.from(new Set([...(cur.tags || []), ...tags]));
          if (!cur.summary && summary) cur.summary = summary;
        } else {
          map.set(id, { id, title, url: link, source, date: toISO(item), tags, summary, kind: feed.kind || "news" });
          added++;
        }
      }
      console.log(`OK   ${feed.name} (${(parsed.items || []).length}件)`);
    } catch (e) {
      console.warn(`SKIP ${feed.name}: ${e.message}`);
    }
    await sleep(1000); // レート制限回避：フィード間に待機（フィード本数が多いので長め）
  }

  // タイトル名寄せ：同一記事の転載を1本に（元媒体 > アグリゲーター）
  const byTitle = new Map();
  for (const it of map.values()) {
    const k = titleKey(it.title);
    if (!k) { byTitle.set(Symbol(), it); continue; }
    const cur = byTitle.get(k);
    if (!cur) { byTitle.set(k, it); continue; }
    let winner = cur, loser = it;
    if (rank(it.source) > rank(cur.source)) { winner = it; loser = cur; }
    winner.tags = Array.from(new Set([...(winner.tags || []), ...(loser.tags || [])]));
    if (!winner.summary && loser.summary) winner.summary = loser.summary;
    if (winner.kind !== "press" && loser.kind === "press") winner.kind = "press";
    byTitle.set(k, winner);
  }

  const all = Array.from(byTitle.values())
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(all, null, 2));

  // 更新時刻を記録（ページの「最終更新」表示用。HTML編集ではなくAction実行時のみ更新される）
  const META_PATH = "data/news_updated.json";
  fs.writeFileSync(META_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), count: all.length }, null, 2));

  console.log(`\n新規 ${added}件 / 合計 ${all.length}件 を ${OUT_PATH} に保存しました。`);
})();

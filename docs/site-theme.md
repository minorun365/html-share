# 画面のテーマとページの既定スタイル

一覧とインボックスの見た目（サイトのテーマ）と、エージェントが新しく作るページの既定スタイル（v2）をそろえて変えられます。どちらも「濃い青の帯」をやめ、淡い地にグラデーションを敷いて、カードや表を白い面に載せる作りです。

## サイトのテーマ

設定ファイルの `content.siteTheme` で選びます。省略すると `light` です。

```yaml
content:
  siteTheme: light               # 既定。淡い地にグラデ、上バーは地と同じ色の半透明
  # siteTheme: classic           # 以前の濃い青の上バーのまま
  # siteTheme: themes/mine.css   # 自前のテーマ（この設定ファイルからの相対パス）
```

| 値 | 画面 |
|---|---|
| `light` | 淡い水色の地に、右下から青緑のグラデと、右下の隅から覗く青→ターコイズの輪。上バー・カード・絞り込みチップは白い半透明の面 |
| `classic` | テーマを差し込まず、画面の元の配色（濃い青の上バー）で配る |
| `.css` で終わるパス | そのファイルの変数で `light` と同じ作りの画面にする |

`build` と `publish` のたびに、テーマの変数と共通の規則（`themes/site/_base.css`）を一覧（`app/index.html`）とインボックス（`review/index.html`）の `<style>` の末尾へ足します。元の CSS を後ろから上書きするので、画面のHTMLそのものは書き換えません。入口のページ（ログイン前の `index.html`）は独自の淡い配色なので対象外です。

テーマの `--t-base` は、画面の上端の色として `theme-color` と Web アプリのマニフェスト（`app.webmanifest` の `theme_color` と `background_color`）にも入ります。ホーム画面に追加したアプリは追加した時点の値を使うので、テーマを変えたら追加し直してください。

### 作りの決まり

- 上バーは帯にせず、地と同じ色の半透明にする。スクロールした中身が下へ潜るときだけ淡く隠れる
- 地のグラデは画面に固定した別の層（`body::before`）に描く。iPhone の Safari は `background-attachment: fixed` を無視するため
- すりガラスのぼかし（`backdrop-filter`）は横幅の広い画面だけに使う。スマホではスクロールが重くなる

### 自前のテーマを作る

`themes/site/light.css` を写して値を変え、`content.siteTheme` にそのパスを書きます。テーマのファイルは `--t-*` の変数を定義するだけで、どこに当てるかは `_base.css` が決めます。`--t-base`（`#rrggbb` の形）が無いテーマは `build` が止めます。

## ページの既定スタイル v2

新しいページは雛形から作ります。v2 の既定スタイル（`skills/create-html/assets/brief.css`）を埋め込んだ完全なHTMLが出るので、本文だけを差し替えます。

```bash
html-share new-page reports/weekly-sales.html --title "週次の売上まとめ"
# スキル単体で使うとき
node skills/create-html/scripts/new-page.mjs reports/weekly-sales.html --title "週次の売上まとめ"
```

`--theme` を省くと、`content.siteTheme` と同じ名前のページテーマがあればそれを、無ければ `light` を使います。既にあるファイルは `--force` を付けないと上書きしません。

v2 のページは `<html lang="ja" data-brief="light">` のように `data-brief` でテーマを名乗ります。v1 との違いは次のとおりで、部品のクラス名と色のトークン名は同じです。

| 部品 | v1（既存のページ） | v2（新しいページ） |
|---|---|---|
| ヒーロー | 濃い青グラデの全幅の帯に白文字 | 帯なし。地の上に濃い色の見出しと短いグラデの線 |
| 本文の地 | 白 | テーマのグラデ（画面に固定した `body::before`） |
| カード・表・目次 | 見出しが青グラデの帯 | 白い半透明の面。見出しは濃い文字と細い線 |
| グラデを使う所 | 帯・表の見出し行・カードの見出し | 線と節の番号の文字だけ |

`data-brief` の無いページは v1 のページとして扱い、直すときも v1 のまま直します。v1 の雛形は `skills/create-html/assets/brief-template.html` です。

### 検査

`skills/create-html/scripts/check-html.mjs` は、`data-brief` のあるページに v2 の規則を当てます。

- `data-brief` の値に対応する `:root[data-brief="..."]` の定義がページの CSS にあること
- v1 のヒーローの白文字（`.hero, .hero * { color: #fff }`）が残っていないこと。帯の無いヒーローでは文字が地に溶ける
- ヒーローに背景を付けていないこと
- `html { background: var(--page-bg) }` と、地のグラデを描く固定層 `body::before { position: fixed; background: var(--wash) }` があること

`data-brief` の無いページには、これまでどおり v1 の規則（ヒーローの白文字、カード内の表の帯の打ち消しなど）を当てます。

ページのテーマを足すときは、`brief.css` の `:root[data-brief="light"]` の塊を別の名前で写して値を変えます。雛形の `--theme` と検査は、`brief.css` とページに書かれた名前をそのまま受け付けます。

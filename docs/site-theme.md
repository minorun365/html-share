# 画面のテーマとページの既定スタイル

一覧とインボックスの見た目にあたるサイトのテーマと、エージェントが新しく作るページの既定スタイル v2 をそろえて変えられます。どちらも「濃い青の帯」をやめ、淡い地にグラデーションを敷いて、カードや表を白い面に載せる作りです。

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
| `light` | 淡い水色の地に、右下から青緑のグラデを敷き、右下の隅にかかる青→ターコイズの輪を重ねる。上バー・カード・絞り込みチップは白い半透明の面にする |
| `classic` | テーマを差し込まず、元の配色（濃い青の上バー）のまま使う |
| `.css` で終わるパス | そのファイルの変数で `light` と同じ作りの画面にする |

`build` と `publish` のたびに、テーマの変数と、`themes/site/_base.css` にある共通の規則を、一覧の `app/index.html` とインボックスの `review/index.html` の `<style>` 末尾へ追加します。元の CSS を後ろから上書きする仕組みのため、画面の HTML 自体はそのまま残ります。ログイン前の入口ページ（`index.html`）は独自の淡い配色のため対象外です。

テーマの `--t-base` は画面の上端の色として、`theme-color` と Web アプリのマニフェスト（`app.webmanifest` の `theme_color` と `background_color`）にも反映されます。ホーム画面に追加したアプリは追加した時点の値を使うので、テーマを変えたら追加し直してください。

### 作りの決まり

- 上バーは帯にせず、地と同じ色の半透明にする。スクロールした中身が下に重なるときだけ淡く隠れる
- iPhone の Safari は `background-attachment: fixed` を無視するため、地のグラデは画面に固定した別の層（`body::before`）に描く
- すりガラスのぼかし（`backdrop-filter`）は横幅の広い画面にだけ使う。スマホではスクロールが重くなる

### 自前のテーマを作る

`themes/site/light.css` をコピーして値を変え、`content.siteTheme` にそのパスを書きます。テーマファイル側では `--t-*` の変数だけを定義し、どの要素に適用するかは `_base.css` が決めます。`#rrggbb` 形式の `--t-base` が無いと、`build` が止まります。

## ページの既定スタイル v2

新しいページは雛形から作ります。v2 の既定スタイルである `skills/create-html/assets/brief.css` を埋め込んだ完全な HTML が生成されるので、本文だけを差し替えます。

```bash
html-share new-page reports/weekly-sales.html --title "週次の売上まとめ"
# スキル単体で使うとき
node skills/create-html/scripts/new-page.mjs reports/weekly-sales.html --title "週次の売上まとめ"
```

`--theme` を省略すると、`content.siteTheme` と同じ名前のページテーマがあればそれを、無ければ `light` を使います。既存のファイルは `--force` を付けないと上書きされません。

v2 のページは `<html lang="ja" data-brief="light">` のように `data-brief` でテーマを指定します。v1 との違いは次のとおりで、部品のクラス名と色のトークン名は同じです。

| 部品 | 既存のページ v1 | 新しいページ v2 |
|---|---|---|
| ヒーロー | 濃い青グラデの全幅の帯に白文字 | 帯は置かず、地の上に濃い色の見出しと短いグラデの線 |
| 本文の地 | 白 | テーマのグラデ（画面に固定した `body::before`） |
| カード・表・目次 | 見出しが青グラデの帯 | 白い半透明の面を使い、見出しは濃い文字と細い線 |
| グラデを使う所 | 帯・表の見出し行・カードの見出し | 線と節の番号の文字だけ |

`data-brief` の無いページは v1 のページとして扱い、修正するときも v1 のまま編集します。v1 の雛形は `skills/create-html/assets/brief-template.html` です。

### 検査

`skills/create-html/scripts/check-html.mjs` は、`data-brief` のあるページに v2 の規則を適用します。

- `data-brief` の値に対応する `:root[data-brief="..."]` の定義がページの CSS にあること
- v1 のヒーローで使っていた白文字（`.hero, .hero * { color: #fff }`）が残っていないこと。帯の無いヒーローでは文字が地に紛れてしまう
- ヒーローに背景を指定していないこと
- `html { background: var(--page-bg) }` と、地のグラデを描く固定層 `body::before { position: fixed; background: var(--wash) }` があること

`data-brief` の無いページには、これまでどおり v1 の規則（ヒーローの白文字や、カード内の表の帯の打ち消しなど）を適用します。

ページのテーマを追加するときは、`brief.css` の `:root[data-brief="light"]` のブロックを別名でコピーして値を変えます。雛形の `--theme` と検査は、`brief.css` とページに書かれた名前をそのまま受け付けます。

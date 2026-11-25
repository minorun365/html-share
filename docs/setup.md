# 初回セットアップ

HTML共有くんは自分のAWSアカウントに構築して使います。セットアップ後の日常操作は、Claude Codeに日本語で依頼できます。

## 必要なもの

- Node.js 22以降
- AWSアカウントとAWS CLIの認証
- 2つのホスト名
- 米国東部（バージニア北部）リージョンで発行したACM証明書
- Claude CodeまたはCodex

## インストール

```bash
git clone https://github.com/minorun365/html-share.git
cd html-share
npm install
npm run build
npm link
cp html-share.config.example.yaml html-share.config.yaml
```

`html-share.config.yaml` のサンプル値を、自分のAWS環境とドメインに置き換えてください。`content.roots` には共有を許可するディレクトリだけを列挙します。

## 署名鍵とAWS環境の作成

```bash
html-share keys init
html-share keys store
npm run deploy
html-share publish
```

設定した2つのホスト名を、CDKの出力に表示されるCloudFrontドメインへCNAMEまたはRoute 53エイリアスで向けます。

## スキルの追加

メモや調査結果を読みやすいHTMLに整える `create-html` を同梱しています。ほかに、PC作業の確認依頼をスマホに送る `mobile` と、スマホから置いた依頼をPCで引き取る `inbox` もあります。

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/create-html" ~/.claude/skills/create-html
ln -s "$(pwd)/skills/mobile" ~/.claude/skills/mobile
ln -s "$(pwd)/skills/inbox" ~/.claude/skills/inbox
```

複数のプロジェクトで使う場合は、設定を `~/.config/html-share/config.yaml` に置くか、`HTML_SHARE_CONFIG` で場所を指定します。

## 動作確認

Claude Codeに「このHTMLを共有くんに追加して」と依頼し、本人専用の一覧にページが表示されれば完了です。

開発者向けの検証コマンドは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

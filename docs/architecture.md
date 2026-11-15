# アーキテクチャ

## 信頼境界

```text
Claude Code / Codex
        │ device token
        ▼
管理面: console.example.com ── Cognito ── Review API / DynamoDB
        │ signed URL
        ▼
閲覧面: content.example.com ── CloudFront key group ── S3
```

管理面にはプロジェクト一覧、インボックス、認証APIだけを置きます。AIが生成したHTMLは閲覧面へ置き、管理面と同一オリジンにしません。

## 署名鍵

- RSA秘密鍵：ローカルの `.html-share/keys/private.pem` とParameter StoreのSecureString
- RSA公開鍵：CloudFront Public Key
- CLI：短期の共有URLと、ダッシュボード用の本人URLを生成
- 認証Lambda：本人ログイン後に管理面用のCloudFront署名Cookieを発行

## インボックスと承認依頼

ブラウザ用APIと端末用APIをパスで分けます。

- `/api/owner/*`：CloudFront署名Cookieが必要
- `/api/device/*`：ペアリング済み端末トークンが必要
- `/api/pairings/claim`：10分で失効する一度限りのコードと交換

本人がスマホから置く依頼は `/api/owner/reviews` へ投稿し、宛先を持たない `inbox` セッションへ固定します。ペアリング済みのどのPCからでも取り込み、完了にできます。任意の `target` はプロジェクトの呼び名のヒントで、ファイルパスではありません。取り込む側が依頼文と合わせて作業フォルダを見極めます。

依頼の状態は `waiting` と `completed` の2つだけで、「取り込み済み」を表す状態を持ちません。そのためエージェントは、作業の完了を待たず取り込んだ時点で完了にします。開いたままの依頼が「まだどのPCも拾っていないもの」を意味するようになり、スマホの一覧がそのまま受け渡しの状態を表します。進捗と結果はインボックスではなくチャットで返します。

端末トークンは端末へだけ返し、DynamoDBにはSHA-256ハッシュを保存します。

## スマホから画像を渡す

インボックスの依頼欄から、画像を最大20枚まで送れます。本文を書けば依頼に添付され、本文が空なら画像だけがPCへ届きます。

画像の中身はReview APIを通しません。CloudFrontからFunction URLへ転送する経路は本文のSHA-256ハッシュが要り、大きな画像に向かないためです。APIは1枚ずつのアップロード許可証（S3の署名付きPOST）だけを発行し、ブラウザが非公開の一時置き場（`UploadBucket`）へ直接送ります。

| API | 認証 | 役割 |
|---|---|---|
| `POST /api/owner/uploads` | 署名Cookie | 枚数分の許可証を発行する。`image/jpeg`・1枚15MBまで・10分で失効 |
| `POST /api/owner/uploads/<id>/commit` | 署名Cookie | 届いた画像をS3で数え直し、届いた分だけで束を `ready` にする |
| `GET /api/device/uploads` | 端末トークン | `ready` の束と、10分で失効する取り出し用の署名付きURLを返す |
| `POST /api/device/uploads/<id>/done` | 端末トークン | 取り込んだ束の画像と記録を消す |

依頼（`POST /api/owner/reviews`）に `attachmentBatch` を付けると、`ready` の束だけを受け付け、依頼に `attachmentBatch` と `attachmentCount` を、束に依頼の `taskId` を書きます。束はDynamoDBの `pk=UPLOAD` に置きます。

ブラウザは送る前に、画像をcanvasで長辺2000pxのJPEGへ描き直します。iPhoneの標準形式（HEIC）を読めないエージェントが多いことと、位置情報などの撮影データを落とすためです。透過部分には白を敷きます。管理面のCSPは、サムネイル用に `img-src blob:` を、直接送るために一時置き場のオリジンを `connect-src` へ足しています。バケットのCORSは管理面のオリジンからのPOSTだけを許可します。

PCでは `html-share review images` が届いた束を取り込み、`html-share review inbox` は画像つきの依頼を受け取った時点でその束を取り込んで、依頼の `images` に絶対パスを載せます。

- 置き場：`~/Pictures/html-share-inbox/<日付>/`（`HTML_SHARE_IMAGES_DIR` で変更可）。日付と時刻はPCの時刻で付けます
- 束と依頼の対応：同じフォルダの `.index.json`
- 手元への書き込みが済んでから `done` を呼ぶので、途中で失敗しても次の取り込みで取り直せます

画像は長く残しません。一時置き場からはPCが取り込んだ時点で消え、取り込み忘れはS3のライフサイクルとDynamoDBのTTLが7日で消します。PCに取り込んだものも、30日を過ぎた日付フォルダから消します。

## 閲覧面の表

スマホ幅では、はみ出した表を縦積みのカードへ畳みます。スクリプトはAPIを呼ばないので、閲覧面の `connect-src 'none'` はそのままです。相対パスのJSはCSPで読めないため、配信HTMLへインラインで埋め込みます。

## publishの排他

`publish` はローカルの生成物を作り直したうえで、バケットにあってローカルに無いキーを削除します。生成の途中はページが揃っていないため、2つの `publish` が重なると、まだ生成されていないページがバケットから消えます。どちらのコマンドも成功して終わるので、消えたことに気づく手がかりが残りません。

そのため、生成から送信までを `.html-share/publish.lock` で1プロセスに絞ります。送信の直前に他のプロセスの有無を確認するだけでは足りません。確認から送信完了までのあいだに始まった生成を止められないため、送り終えるまでロックを持ち続けます。

ロックの取得は `mkdir` のアトミック性だけで判定します。既にあるディレクトリへ自分のプロセスIDを書いて所有を主張すると、他のプロセスが持っているロックを奪うことになります。落ちたプロセスが残したロックは、プロセスIDが生きていなければ引き取ります。プロセスIDのファイルがまだ無いロックは、作られた直後の可能性があるため奪いません。

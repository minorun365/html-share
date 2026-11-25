# Security Policy

## Reporting a vulnerability

セキュリティ上の問題を見つけた場合、認証情報、共有URL、個人情報、再現用の実データは公開Issueに書かないでください。

GitHubのSecurity Advisoriesから非公開で報告してください。

https://github.com/minorun365/html-share/security/advisories/new

受領から7日以内に一次回答し、影響範囲と修正方針を連絡します。修正が公開されるまで、脆弱性の詳細を公開するのは控えてください。

## Supported versions

正式リリース後は、最新のマイナーバージョンだけをサポートします。`0.x` は公開前の評価版として扱います。

## Deployment responsibility

HTML共有くんはセルフホスト型です。AWSアカウント、ドメイン、認証ユーザー、配信するコンテンツ、共有URLは、各利用者が管理します。

本番用の依存関係は `npm run audit:prod` で検査します。CDKはローカルでインフラを合成するための開発用の依存として分けています。

2026年8月13日時点で最新の `aws-cdk-lib` には、`brace-expansion` の既知のアドバイザリが残っています。ローカルでのインフラ合成にだけ使われ、HTML共有くんのLambdaやブラウザには配布されません。修正版はDependabotで追跡します。

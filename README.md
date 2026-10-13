# 領収書発行・管理ツール｜Notion連携

個人用の領収書Webアプリ。領収書台帳・取引先・発行者設定・操作履歴・PDF原本はNotionで保管します。Supabaseは使用しません。元の領収書PDFツールは変更していません。

## 実装した機能

- 本人ログイン、下書き保存・編集、発行確認
- 明細別税区分、8%/10%混在、内税/外税、税率別に一度だけ端数処理
- 適格請求書/適格簡易請求書の書式、日本語・複数ページPDF
- NotionへPDF/JSON直接添付、SHA-256照合、原本再ダウンロード
- 年月付き採番、同時発行の直列化、二重発行防止、中断後の再開
- 履歴検索、取消理由、元書類と関連付けた訂正発行
- 取引先登録、発行者設定、操作履歴の再同期
- 食品1%の用途・予定期間・対象外ヘルプ（準備中、確定発行は拒否）

## ローカルで確認する

Node.js 24以上を使用します。

```sh
npm ci
cp .env.example .env.local
npm run password
```

表示された`APP_PASSWORD_HASH`を`.env.local`に設定し、`SESSION_SECRET`に32文字以上のランダム値を設定します。`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`で生成できます。秘密情報はGit/チャット/Notion本文に貼らないでください。

```sh
npm run dev
```

http://localhost:3000 を開きます。`STORAGE_MODE=demo`ではデータとPDFは`.data`へ保存されます。Notionに変更を加えず、発行フローを確認できます。発行者設定は空の状態なので、試験用情報を入力してください。デモで作った番号・ジャーナルを本番へ持ち込まず、Notion接続用には別のDATA_DIRを使います。

## Workが準備したNotion DBに接続する

1. 内部インテグレーションに読み取り・挿入・更新権限を設定し、4つのDBへ接続します。
2. Workが返した**data source ID**を使用します（親ページIDやdatabase IDではありません）。
3. `.env.local`またはホストのシークレットへ設定します。

```dotenv
STORAGE_MODE=notion
NOTION_TOKEN=実際のトークン
NOTION_RECEIPTS_DATA_SOURCE_ID=領収書台帳のdata-source-id
NOTION_CUSTOMERS_DATA_SOURCE_ID=取引先マスタのdata-source-id
NOTION_ISSUER_DATA_SOURCE_ID=発行者設定のdata-source-id
NOTION_AUDIT_DATA_SOURCE_ID=操作履歴のdata-source-id
DATA_DIR=.data/notion
```

```sh
npm run check:notion
npm run dev
```

必要なプロパティ名・型は`server/repository.ts`の`requiredSchemas`に定義しています。最初にWorkへ渡した指示書の4つのDBと、10％/8％/1％の金額項目を使用します。プロパティ名の`％`は全角です。JSONは台帳の`確定データJSON`へ保存するため、別の明細DBや追加プロパティは不要です。

発行者設定は空、または正しく設定した1件にしてください。登録番号は形式のみ検証し、実在する登録状況は本人が確認します。

**実際のNotion接続テストはトークン・ID設定後に実施してください。** 自動テストのNotion通信は模擬応答であり、実ワークスペースへの保存確認ではありません。

## 本番実行

```sh
npm run build
npm start
```

`APP_ORIGIN=https://実際のホスト名`と`STORAGE_MODE=notion`が必須。本番のデモ利用とHTTPオリジンは起動時に拒否します。HTTPS終端を用意し、Nodeプロセスへ転送してください。APIはすべて認証が必要です。

Dockerfileも用意しています。`/data`を非公開の永続ボリュームにし、環境変数を実行時に注入します。Dockerでの実起動は今回未検証です。

**単一プロセス・単一インスタンス専用です。** 採番と再試行に`DATA_DIR/operations.sqlite`を使用します。業務台帳の二重管理ではありませんが、中断中のJSON/PDFを含むため、DATA_DIRは保護・バックアップしてください。水平分散や一時ディスクのサーバーレス環境では使用しません。

## 検証

```sh
npm test
npm run build
```

税額・端数、1%の確定拒否、認証/CSRF、Notion接続先の所有権、同時発行、通信失敗・再起動後の復旧、原本改変検出、日本語複数ページPDFを検証します。

## 補足

- [構成・運用条件と未実装範囲](docs/architecture.md)
- [元ツールの移植判断](docs/source-audit.md)
- [Notion API：ファイル保管](https://developers.notion.com/guides/data-apis/uploading-small-files)
- [仕様書](https://app.notion.com/p/3f89ec180c3e812baf15f107978d9314)

PDFのNoto Sans JPはSIL Open Font License。ライセンスは`assets/fonts/OFL.txt`に同梱しています。電子帳簿保存法の完全適合は未検証です。

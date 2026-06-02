# chrome-extensions

個人用 Chrome Extension をまとめて管理するリポジトリ。すべて Manifest V3 / plain JS で、ビルドツールは不要。

## インストール方法（共通）

1. `chrome://extensions` を開く
2. 右上の **デベロッパーモード** をオン
3. **パッケージ化されていない拡張機能を読み込む** → 対象の `extensions/<name>/` ディレクトリを選択

ファイルを編集した後は、拡張機能カードの更新ボタンをクリックして反映する。

## Extensions

### [amazon-url-cleaner](extensions/amazon-url-cleaner/)

Amazon の商品 URL を `/dp/ASIN` 形式にリダイレクトする。

| 変換前 | 変換後 |
|---|---|
| `amazon.co.jp/商品名/dp/B08XYZ1234/ref=...?foo=bar` | `amazon.co.jp/dp/B08XYZ1234` |
| `amazon.com/gp/product/B08XYZ1234?tag=...` | `amazon.com/dp/B08XYZ1234` |

対応ドメイン: `amazon.co.jp`, `amazon.com`

### [url-memo-line](extensions/url-memo-line/)

登録した URL でだけ、ページ右下に 1 行メモを表示する。

- ツールバーの拡張機能アイコンから、開いている URL を登録 / 保存 / 解除できる
- オプションページで登録済み URL とメモを一覧編集できる
- URL は完全一致で判定し、ハッシュ部分だけは無視する
- 対応 URL: `http://` / `https://`

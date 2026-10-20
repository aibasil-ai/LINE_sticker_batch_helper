# LINE 貼圖批次草稿工具

使用 Node.js 與 Playwright，依照 `items.json` 逐組建立 LINE Creators Market 貼圖草稿：填入繁體中文、英文與日文文案、上傳 ZIP、核對圖片，以及設定並儲存價格。支援 Windows PowerShell 與 macOS 終端機。

執行過程會自動關閉可辨識的網站公告，並在公告提供該選項時勾選「以後不再顯示此畫面」。

**工具執行到草稿完成為止，不會按下「提出審核」。** `autoStartSale: true` 是商品日後審核通過後自動販售的設定。

## 快速開始

### 已安裝並完成登入

在專案資料夾開啟終端機，確認 `items.json` 的文案與 ZIP 路徑後，先檢查資料：

```sh
node run.cjs --check --auto
```

檢查通過後，執行整批或接續上次進度：

```sh
node run.cjs --resume --auto
```

- 依清單順序處理所有 `enabled` 不是 `false` 的項目；組數由清單決定。
- `--resume` 可用於首次執行，已完成的草稿會跳過。
- `--auto` 啟用圖片自動核對，不需要逐組在終端機輸入 `OK`，也會覆寫清單中的人工核對設定。
- 工具不會自動掃描素材資料夾或讀取文案 TXT，請先把每組資料填入清單。

### 全新安裝

需要 Node.js 20 以上版本（建議使用仍受支援的 LTS 版本）、npm，以及可使用的 LINE Creators Market 帳號。登入與批次執行會開啟 Chromium 視窗。

在專案資料夾執行：

```sh
npm install
npm exec -- playwright install chromium
node run.cjs --login
```

完成 LINE 登入並進入創作者管理後台後，回終端機按 Enter 儲存登入狀態。接著編輯 `items.json`，依照上方指令預檢並執行。

登入狀態預設儲存在 `line-auth.json`，內含帳號存取資料，請保留在自己的電腦。登入失效時，重新執行 `node run.cjs --login`，再續跑。

## 常用指令

| 需求 | 指令 |
| --- | --- |
| 查看參數 | `node run.cjs --help` |
| 檢查全部啟用組別，不連線 LINE | `node run.cjs --check --auto` |
| 整批執行或續跑 | `node run.cjs --resume --auto` |
| 只檢查指定組別 | `node run.cjs --check --auto --id ibusuki-002` |
| 只執行或續跑指定組別 | `node run.cjs --resume --auto --id ibusuki-002` |
| 儲存或更新登入狀態 | `node run.cjs --login` |
| 使用另一份清單 | `node run.cjs --resume --auto --items "另一份清單.json"` |

要處理全部組別，請勿加上 `--id`。即使指定 `--id`，`enabled: false` 的項目也不會執行。`--check` 與 `--login` 不可同時使用。

也可使用 `npm run check -- --auto`、`npm run resume -- --auto` 與 `npm run login`；npm 的額外參數需放在 `--` 之後。

### 單次覆寫 ZIP 路徑

```sh
node run.cjs --resume --auto --id ibusuki-002 --zip "/完整路徑/任意檔名.zip"
```

`--zip` 必須搭配 `--id`，只影響這次執行。每次續跑都要帶相同覆寫，或將正確路徑寫回清單。

## 設定清單

預設讀取 `run.cjs` 同一資料夾的 `items.json`。以下是單組設定範例；請替換 Copyright、文案與素材路徑：

```json
{
  "baseDir": ".",
  "authFile": "line-auth.json",
  "continueOnError": true,
  "defaults": {
    "copyright": "© 2026 Your Name",
    "stickerCount": 32,
    "useAI": true,
    "autoStartSale": true,
    "priceTier": "5"
  },
  "verification": {
    "mode": "auto",
    "timeoutMs": 180000
  },
  "items": [
    {
      "id": "ibusuki-002",
      "enabled": true,
      "zip": "sticker/002/ibusuki-upload.zip",
      "languages": {
        "zh-Hant": {
          "title": "海岸小列車與小海龜",
          "description": "小列車與小海龜，陪你打招呼、道謝與加油。"
        },
        "en": {
          "title": "Coastal Train and Tiny Turtle",
          "description": "A little train and a tiny turtle share greetings, thanks and encouragement."
        },
        "ja": {
          "title": "海辺の列車とこがめ",
          "description": "小さな列車とこがめが、あいさつや感謝、応援の気持ちを届けます。"
        }
      }
    }
  ]
}
```

### 欄位與限制

| 欄位 | 說明 |
| --- | --- |
| `baseDir` | ZIP 路徑基準，預設為清單所在資料夾（`.`）。 |
| `authFile` | 登入檔路徑，相對於清單所在資料夾，預設為 `line-auth.json`。 |
| `continueOnError` | 預設 `true`：單組網站操作失敗後繼續下一組；設為 `false` 則停止。 |
| `defaults` | 各組共用設定，同名欄位可在個別項目覆寫。 |
| `items[].id` | 每組唯一且非空的字串，用來對應進度；停用項目的 ID 也不可重複。 |
| `items[].enabled` | 設為 `false` 即停用；省略時會處理。 |
| `items[].zip` | `.zip` 檔路徑，可使用相對或完整路徑。 |
| `stickerCount` | 貼圖張數，支援 `8`、`16`、`24`、`32`、`40`，不含主圖與標籤。 |
| `copyright` | 必填，預估長度上限為 50。 |
| `useAI`、`autoStartSale` | 必須為布林值，目前網站操作流程僅支援兩者均為 `true`。 |
| `priceTier` | 後台價格選單的數字字串值，例如 `"5"`，並非實際金額。 |
| `languages` | 必須提供 `zh-Hant`、`en`、`ja` 各自的 `title` 與 `description`。 |
| `verification.mode` | `auto`、`manual` 或 `selector`；未設定時預設為 `auto`。 |
| `verification.timeoutMs` | 圖片核對的等待設定，預設 `180000` 毫秒，至少 `1000` 毫秒。 |

標題預估長度上限為 40，說明為 160；ASCII 字元計為 1，其他字元計為 2。標題不可換行，標題與說明不可為空，實際長度仍以網站計數為準。未設定的分類、創作者與地區等欄位沿用網站預設。

增加組別時，在 `items` 陣列新增物件即可。清單需使用有效 JSON 與 UTF-8 編碼，不能加註解或尾端逗號。請保留既有組別的 ID，不要用已完成商品的 ID 建立不同內容。

### 路徑規則

- `--items` 的相對路徑以目前終端機目錄為基準。
- `baseDir` 的相對路徑以清單所在資料夾為基準。
- 清單中的 `zip` 與 `--zip` 的相對路徑，都以解析後的 `baseDir` 為基準。
- 登入檔與 `results/` 位於清單對應的位置，不受 `baseDir` 影響；`authFile` 也可指定完整路徑。

例如，清單位於 `/work/batch/items.json` 且 `baseDir` 為 `.`，`sticker/002/ibusuki-upload.zip` 會解析為 `/work/batch/sticker/002/ibusuki-upload.zip`，與終端機目前目錄無關。

Windows JSON 路徑建議使用 `/`，例如 `C:/stickers/upload.zip`；若使用反斜線，需寫成 `C:\\stickers\\upload.zip`。終端機指令中的路徑若含空白，請加上雙引號。

## ZIP 素材規格

所有 PNG 必須直接放在 ZIP 根目錄，檔名如下（以 32 張貼圖為例）：

```text
main.png
tab.png
01.png
02.png
...
32.png
```

| 圖片 | 尺寸 |
| --- | --- |
| `main.png` | 240 × 240 |
| `tab.png` | 96 × 74 |
| `01.png` 至指定張數 | 最大 370 × 320，寬高須為正偶數 |

- 32 張貼圖的 ZIP 應包含 34 張 PNG（含主圖與標籤）。
- 不可缺圖、重複檔名，或混入文案 TXT、`.DS_Store`、`__MACOSX` 等額外檔案；圖片不可包在外層資料夾內。
- ZIP 大小上限為 60 MiB，每張 PNG 解壓後上限為 1 MiB。
- 支援未壓縮或標準 Deflate 壓縮，不支援加密、ZIP64 或分片 ZIP。

`--check` 會檢查所選項目的文案、設定、ZIP 結構、PNG 檔頭與尺寸，並核對既有進度的內容指紋；不需登入檔或啟動瀏覽器。預檢不包含透明像素、PNG CRC、美術品質或網站審核資格的驗證。

## 圖片核對模式

### 自動模式（建議）

使用 `--auto`，或將 `verification.mode` 設為 `"auto"`：

1. 讀取 ZIP，計算每張 PNG 的 SHA1、尺寸及整份 ZIP 的 SHA256。
2. 上傳後確認 `main`、`tab` 與每個圖號完整，沒有重複欄位或網站圖片錯誤。
3. 比對 LINE CDN 網址中的商品 ID、圖號與圖片 SHA1。
4. 確認圖片可由瀏覽器解碼，且尺寸與 ZIP 原圖一致。
5. 重新載入編輯頁，再次確認張數與全部圖片後，才記錄為 `images_verified`。

此核對依據目前觀察到的 LINE 頁面結構與 CDN 命名方式。網站改版或圖片處理方式變更時，核對可能失敗，程式會保留進度供續跑。

目前專案內的 `items.json` 設為 `"manual"`，因此快速開始指令明確加上 `--auto`。自動模式遇到登入失效時會停止，需重新登入後續跑。

### 人工與 selector 模式

- **人工模式**：將 `verification.mode` 設為 `"manual"`，且執行時不加 `--auto`。每組上傳後在瀏覽器核對圖片，再於終端機輸入 `OK`；續跑待確認上傳時，也可輸入 `RETRY` 重新上傳。需要互動式終端機。
- **selector 模式**：將 `verification.mode` 設為 `"selector"`，並提供非空的 `verification.readySelector`。程式等待該選擇器可見後繼續；請使用已自行確認能代表整組上傳完成的頁面訊號。

## 進度、錯誤與續跑

進度儲存在清單所在資料夾的 `results/`：

| 檔案 | 用途 |
| --- | --- |
| `progress.json` | 每組步驟、內容指紋、商品網址、圖片核對結果及錯誤。 |
| `summary.json` | 執行報告中的組別狀態、商品網址與錯誤摘要。 |
| `run.lock` | 執行鎖，避免同一份清單同時操作；正常結束時會移除。 |

預設單組網站操作失敗會記錄錯誤並繼續下一組；本次有失敗或因建立結果不明被略過的組別時，程序結束碼為 `1`。清單或 ZIP 預檢失敗會在網站操作前停止整批；登入失效或瀏覽器關閉也會停止。

修正問題後執行：

```sh
node run.cjs --resume --auto
```

| 進度階段 | 續跑行為 |
| --- | --- |
| `new` | 尚未開始建立，接著建立草稿。 |
| `creating`，已有商品網址 | 接續該商品的圖片上傳流程。 |
| `creating`，沒有商品網址 | 建立結果不明，略過並報錯，需先補綁網址。 |
| `metadata_saved` | 文案已儲存，接著上傳圖片。 |
| `upload_pending` | 自動模式先核對現有圖片；未齊全時，對同一商品重新上傳 ZIP。 |
| `images_verified` | 接著設定並儲存價格。 |
| `draft_ready` | 草稿完成，跳過。 |

### 補綁既有商品

若建立過程中斷，進度為 `creating` 且沒有商品網址，請先到後台找到對應商品，核對文案後補綁：

```sh
node run.cjs --id ibusuki-002 --attach-url "https://creator.line.me/my/123/sticker/4567890"
node run.cjs --resume --auto
```

請將範例網址替換為自己的完整商品管理網址：必須為 `https://creator.line.me/`，且路徑含 `/sticker/數字`。`--attach-url` 必須搭配 `--id`，僅適用於 `creating` 或 `metadata_saved` 的既有進度，只修改本機紀錄。

### 保留內容與進度

- ZIP 移動或改名但檔案內容完全相同，可以續跑；重新打包造成 ZIP 位元組改變，也會改變內容指紋。
- 文案、圖片、Copyright、張數或價格等設定與紀錄不同時，預檢會停止。即使已是 `draft_ready` 也會核對；全新商品請使用新 ID。
- 不加 `--resume` 執行已有進度的組別會被拒絕。請保留 `progress.json`，避免失去與既有商品的對應關係。
- 若出現 `run.lock`，先確認所有相關工具程序已結束，再移除該清單對應的 `results/run.lock` 後續跑。

## 更新舊版

1. 在舊工具終端機按 Ctrl+C，結束執行中的程序。
2. 將 `core.cjs`、`run.cjs`、`line-site.cjs`、`image-verification.cjs` 一起更新到原專案資料夾。
3. 保留自己的 `items.json`、`line-auth.json`、`results/` 與素材 ZIP；不要用範例清單覆蓋現有清單。
4. 在直接包含新版 `run.cjs` 的資料夾執行預檢，再以 `--resume --auto` 續跑。

若既有相依套件未變更且 Playwright 可正常使用，更新上述程式檔即可。若同步更新了套件設定，請重新執行 `npm install` 與 `npm exec -- playwright install chromium`。

## 常見問題

### 為什麼仍要求逐組輸入 OK？

確認執行指令有加 `--auto`，或清單已設定 `verification.mode: "auto"`。目前附帶的清單仍使用人工模式；若出現「未知參數：--auto」，表示執行中的 `run.cjs` 仍是舊版，請依更新步驟替換四個程式檔。

### 找不到 image-verification.cjs 或 Chromium？

前者需補上同版本的 `image-verification.cjs`；後者請在專案資料夾執行 `npm exec -- playwright install chromium`。

### 已上傳一半，改成自動模式會重複新增嗎？

保留原有 ID、清單與進度檔，以 `--resume --auto` 接續。已完成草稿會跳過；建立結果不明且沒有網址的項目會要求補綁，避免再次建立。

### 可以完全無人值守嗎？

登入有效、資料與網站操作正常時，整批草稿不需要人工輸入。登入或驗證要求出現時，先完成登入再續跑；網站改版造成定位或圖片核對失敗時，可能需要更新 `line-site.cjs` 或 `image-verification.cjs`。

## 測試

```sh
npm test
npm run test:announcements
```

- `npm test`：本機核心與 CLI 測試，涵蓋文案、路徑、ZIP 預檢、內容指紋、進度與執行鎖，不需 Chromium。
- `npm run test:announcements`：以 Chromium 執行本機 HTML fixtures，檢查多層公告、延遲公告與勾選後關閉等行為；需先安裝瀏覽器。

**目前已知測試問題**：CLI 測試會載入整份 `items.json`，但只為第一組建立 ZIP fixture。目前清單有兩組啟用項目，因此 `npm test` 的 CLI 預檢案例會因暫存測試資料夾缺少第二組 ZIP 而失敗，需同步補齊測試資料。

上述測試不會登入或上傳到 LINE。`validation-report.json` 是先前的驗證紀錄，最新結果請以實際執行測試為準。

# Muse Account Manager — Thiết kế

Ngày: 2026-11-02 · Trạng thái: chờ duyệt

## 1. Mục tiêu

Một tool chạy trên máy (Windows) để quản lý nhiều tài khoản **muse.ai** (trợ lý AI của Meta) và tạo ảnh/video hàng loạt:

- Nhập prompt, đính kèm ảnh tham chiếu.
- Tạo **ảnh** và **video**.
- Video xuất **1080p** và **thời lượng tùy chọn** (1–60 giây).
- Hàng đợi tự động chia việc cho các tài khoản, chạy song song (mặc định 3 luồng, chỉnh được).
- Tải kết quả về máy, xem lại trong thư viện.

Thành công nghĩa là: dán một loạt prompt vào hàng đợi, bấm chạy, quay lại thấy file ảnh/video 1080p đúng thời lượng trong `downloads/`, các tài khoản được dùng luân phiên, tài khoản hết lượt thì tự bỏ qua.

## 2. Những gì đã dò được trên muse.ai (2026-11-02)

Dò bằng tài khoản thật (đã được người dùng cho phép, tốn 1 ảnh + 1 video):

| Điểm | Quan sát |
|---|---|
| Kiểu sản phẩm | Trợ lý AI dạng chat (tên mặc định "Ren"). Tạo ảnh/video bằng cách **nhắn tin**, không có form. |
| Ô chat | `textarea[placeholder="Message"]`, gửi bằng Enter. |
| Đính kèm | `input[type=file][multiple]` ẩn trong composer (nút "Attach file"). |
| Đang làm / xong | Nút `button[aria-label="Stop"]` xuất hiện khi trợ lý đang làm, biến mất khi xong. Có thêm dòng trạng thái dưới avatar ("Creating image", "Checking preferences"). |
| Kết quả ảnh | `[data-pel-click="chat_media_click"] img`, `src` là `blob:` → WebP **1920×1280**. ~25 giây. |
| Kết quả video | `[data-hatch-video-wrapper="true"]`, thuộc tính `data-hatch-video-src` là `blob:` → MP4 **1152×768** (tỉ lệ theo ảnh tham chiếu 3:2), **10 giây**, **có âm thanh**, ~4,3 MB. ~70 giây. |
| Tải file | `fetch(blobUrl)` **trong trang** trả về đúng bytes gốc (MP4 `ftypisom`, WebP `RIFF`). Không tải thẳng bằng URL từ ngoài được. |
| Thời lượng / độ phân giải | Trợ lý cho biết video luôn 10 giây, không có tùy chọn; không có tùy chọn 1080p. |
| Lời trả lời | Văn bản ngắn tiếng Việt, ví dụ "Xong rồi nè Aaron, video 10 giây với…". |
| Thư viện | `/library/media?view=images`, `/library/media?view=video`. |
| Đăng nhập | Tài khoản muse.ai riêng (không phải Facebook). Đã đăng nhập ⇔ trang `https://muse.ai/` có ô chat. |

**Chưa dò được** (xử lý theo cách tổng quát, xem §8): câu báo hết lượt/hết credit trông thế nào; luồng đính kèm file thật (sẽ kiểm tra bằng cách đính kèm rồi gỡ ra, không gửi, để không tốn lượt).

## 3. Phạm vi

**Có:** quản lý tài khoản, hàng đợi ảnh + video, ảnh tham chiếu, thời lượng 1–60 giây, upscale 1080p, tải về, thư viện, cài đặt.

**Không (để sau nếu cần):** dùng Gmail/Calendar/các tính năng agent khác của muse.ai, đăng ký tài khoản tự động, nhập mật khẩu tự động, upscale bằng AI (Real-ESRGAN), chỉnh sửa video.

## 4. Kiến trúc

Node.js v24 (ESM), Express, Playwright (dùng Chrome đã cài trên máy — `channel: "chrome"`, dự phòng Edge), ffmpeg (đã cài). Giao diện là trang web tĩnh tại `http://localhost:3000`, cập nhật trực tiếp qua Server-Sent Events. Khởi động bằng `start.bat`.

```
tool muse AI/
  package.json, start.bat
  src/
    server.js        – Express: API REST + SSE + phục vụ public/
    config.js        – đường dẫn, đọc/ghi settings
    store.js         – lưu JSON an toàn (ghi file tạm rồi rename)
    events.js        – event bus nội bộ → SSE
    accounts.js      – CRUD tài khoản, trạng thái, đếm lượt theo ngày
    jobs.js          – CRUD việc, trạng thái, khôi phục khi khởi động lại
    planner.js       – (thuần) chia video thành các clip
    scheduler.js     – N luồng, chọn tài khoản, nghỉ giữa việc, cooldown
    runner.js        – chạy 1 việc: gọi driver từng clip → hậu kỳ → lưu
    muse/
      selectors.js   – MỌI selector của muse.ai gom ở đây
      messages.js    – mẫu tin nhắn gửi cho trợ lý
      classify.js    – (thuần) phân loại lời trả lời: hết lượt / từ chối / khác
      driver.js      – mở hồ sơ Chrome, kiểm tra đăng nhập, gửi 1 lượt chat, lấy media
      fakeDriver.js  – driver giả cho test
    media/
      ffmpeg.js      – dựng lệnh (thuần) + chạy: probe, lastFrame, concat, trim, upscale
  public/            – index.html, app.js, styles.css
  data/              – accounts.json, jobs.json, settings.json, errors/ (ảnh chụp lỗi)
  profiles/<id>/     – hồ sơ Chrome của từng tài khoản (giữ phiên đăng nhập)
  uploads/           – ảnh tham chiếu người dùng tải lên
  downloads/YYYY-MM-DD/ – kết quả cuối; downloads/raw/ – clip/ảnh gốc
  test/
```

Mỗi khối chỉ phụ thuộc vào giao diện của khối khác, ví dụ `runner` gọi `driver.runTurn()` mà không biết selector nào. Khi Meta đổi giao diện, chỉ sửa `selectors.js` (và có thể `driver.js`).

## 5. Dữ liệu

**Tài khoản** (`data/accounts.json`)
```
{ id, name, enabled, state: "needs_login" | "ready" | "cooldown" | "error",
  cooldownUntil, usage: { date: "YYYY-MM-DD", jobs }, lastUsedAt, lastError }
```
Hồ sơ Chrome nằm ở `profiles/<id>/`. Tool **không lưu mật khẩu**.

**Việc** (`data/jobs.json`)
```
{ id, type: "image" | "video", prompt, refImages: [đường dẫn],
  durationSec (video), upscale1080 (video),
  status: "queued" | "running" | "postprocessing" | "done" | "failed" | "refused" | "cancelled",
  progress: { clip, totalClips }, accountId, attempts,
  rawFiles: [], outputs: [], replyText, error, createdAt, updatedAt }
```
"Số lượng bản" trong form tạo ra N việc riêng.

**Cài đặt** (`data/settings.json`) — mặc định:

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| concurrency | 3 | Số luồng chạy song song (mỗi luồng = 1 tài khoản) |
| cooldownHours | 24 | Thời gian nghỉ khi tài khoản hết lượt |
| delayMinSec / delayMaxSec | 20 / 60 | Nghỉ ngẫu nhiên giữa 2 việc của cùng tài khoản |
| dailyCapPerAccount | 0 | Giới hạn việc/ngày/tài khoản (0 = không giới hạn) |
| headless | false | Ẩn cửa sổ trình duyệt |
| imageTimeoutMin / videoTimeoutMin | 3 / 6 | Chờ tối đa mỗi lượt |
| maxRetries | 2 | Số lần thử lại khi lỗi tạm thời |
| messageTemplates | xem §6.3 | Mẫu tin nhắn (sửa được) |

## 6. Bộ điều khiển muse.ai (driver)

### 6.1 Đăng nhập
"Thêm tài khoản" → tạo `profiles/<id>/` → mở cửa sổ Chrome (luôn hiện) tại `https://muse.ai/` → **người dùng tự đăng nhập** → bấm "Đã đăng nhập" trên giao diện tool → driver kiểm tra có ô chat → `ready`, rồi đóng cửa sổ.

### 6.2 Một lượt chat — `runTurn({ message, files }) → { media: [{kind, ext, bytes}], replyText }`
1. Mở (hoặc dùng lại) context của tài khoản, vào `https://muse.ai/`, chờ ô chat. Không thấy ô chat → lỗi `NOT_LOGGED_IN`.
2. Ghi lại danh sách media đang có (theo `blob:` src và aria-label) để phân biệt media mới.
3. Có file → `setInputFiles` vào `input[type=file]`, chờ ảnh xem trước xuất hiện.
4. Gõ tin nhắn vào textarea, nhấn Enter.
5. Chờ nút Stop **xuất hiện** (tối đa 30 giây) rồi **biến mất** (tối đa theo timeout). Sau đó chờ thêm 3 giây cho media hiện xong.
6. Lấy media mới: video từ `data-hatch-video-src`, ảnh từ `img` trong `chat_media_click`. Với mỗi cái, `fetch(blob)` trong trang → base64 → trả về Node.
7. Lấy văn bản trả lời cuối cùng của trợ lý.
8. Bất kỳ lỗi nào → chụp màn hình vào `data/errors/<jobId>-<thời gian>.png`.

### 6.3 Mẫu tin nhắn (mặc định, sửa được trong Cài đặt)
- Ảnh: `Tạo ngay 1 ảnh, không cần hỏi lại: {prompt}` (+ `Dùng ảnh đính kèm làm ảnh tham chiếu.` nếu có tham chiếu)
- Video: `Tạo ngay 1 video, không cần hỏi lại: {prompt}` (+ câu tham chiếu như trên)
- Video nối tiếp (clip 2+): `Dùng ảnh đính kèm làm khung hình mở đầu, tạo ngay 1 video nối tiếp liền mạch, không cần hỏi lại: {prompt}`

### 6.4 Phân loại khi không có media mới (`classify.js`)
- Có từ khóa hết lượt (`limit`, `credit`, `quota`, `upgrade`, `giới hạn`, `hết lượt`, `nâng cấp`, `tomorrow`, `ngày mai`…) → `LIMIT`
- Có từ khóa từ chối (`can't`, `cannot`, `policy`, `không thể`, `chính sách`, `vi phạm`…) → `REFUSED`
- Còn lại → `NO_MEDIA` (lỗi tạm thời, thử lại)

Danh sách từ khóa nằm trong một file, bổ sung khi gặp câu thật.

## 7. Hàng đợi và luồng xử lý

**Lập lịch:** tối đa `concurrency` việc chạy cùng lúc, mỗi tài khoản chỉ chạy 1 việc tại một thời điểm. Tài khoản đủ điều kiện là: bật, `ready`, hết cooldown, chưa chạm giới hạn ngày, đã nghỉ đủ thời gian. Trong số đó chọn tài khoản **dùng ít nhất hôm nay**. Việc lấy theo thứ tự FIFO. Bộ đếm lượt reset theo ngày.

**Việc ảnh:** 1 lượt chat → lưu mọi ảnh mới vào `downloads/YYYY-MM-DD/<jobId>_<n>.webp`.

**Việc video, thời lượng D giây:**
1. `planner`: số clip `n = ceil(D / 10)` (D ≤ 10 → 1 clip).
2. Clip 1: prompt + ảnh tham chiếu của người dùng.
3. Clip k > 1: dùng **cùng tài khoản**, đính kèm khung hình cuối của clip k−1 (`ffmpeg -sseof -0.1 … -frames:v 1`), dùng mẫu "nối tiếp".
4. Mỗi clip lưu vào `downloads/raw/<jobId>_clipK.mp4`.
5. Hậu kỳ (`status = postprocessing`):
   - Nối các clip bằng bộ lọc `concat` (mã hóa lại, giữ âm thanh).
   - Cắt đúng D giây (`-t D`).
   - Nếu bật 1080p: cạnh ngắn lên 1080 (ngang: `scale=-2:1080`, dọc: `scale=1080:-2`), `flags=lanczos`, `unsharp` nhẹ.
   - Mã hóa `libx264 -crf 18 -preset medium -pix_fmt yuv420p`, âm thanh `aac 192k`, `+faststart`.
   - Ví dụ: clip 1152×768 → 1620×1080; clip 1280×720 → 1920×1080.
6. Kết quả: `downloads/YYYY-MM-DD/<jobId>_<slug-prompt>.mp4`.

**Khởi động lại tool:** việc đang `running`/`postprocessing` quay về `queued`, các clip đã tải vẫn được giữ và dùng lại.

## 8. Xử lý lỗi

| Tình huống | Hành động |
|---|---|
| `NOT_LOGGED_IN` | Tài khoản → `needs_login`; việc về hàng đợi (không tính là một lần thử) |
| `LIMIT` | Tài khoản → `cooldown` trong `cooldownHours`; việc về hàng đợi (không tính là một lần thử) |
| `REFUSED` | Việc → `refused`, hiện lời trả lời của trợ lý, không thử lại |
| `NO_MEDIA`, quá thời gian, lỗi trình duyệt | Thử lại tối đa `maxRetries` lần; quá số lần → `failed` kèm ảnh chụp lỗi |
| Lỗi ffmpeg | Việc → `failed`, giữ nguyên clip gốc để thử hậu kỳ lại |
| Không còn tài khoản nào dùng được | Hàng đợi chờ; giao diện báo "Tất cả tài khoản đang hết lượt / cần đăng nhập" |
| Clip 2+ mà tài khoản gốc hết lượt | Chuyển sang tài khoản khác (vẫn đính kèm khung hình cuối) |

## 9. Giao diện (tiếng Việt, 5 tab)

- **Tạo mới:** Ảnh/Video, ô prompt, kéo-thả ảnh tham chiếu (nhiều ảnh), thanh thời lượng 1–60 giây và công tắc 1080p (chỉ cho video), số bản. Có chế độ "Nhập nhiều prompt" (mỗi dòng một việc).
- **Hàng đợi:** danh sách việc với trạng thái và tiến độ ("Clip 2/3", "Hậu kỳ"), tài khoản đang chạy, nút Hủy/Thử lại, nút Tạm dừng/Chạy toàn bộ.
- **Tài khoản:** thêm, đổi tên, xóa, bật/tắt, "Đăng nhập lại", "Mở cửa sổ" (dùng tay), số lượt hôm nay, hết cooldown lúc nào, lỗi gần nhất.
- **Thư viện:** lưới ảnh/video đã xong, xem trước, tải về, mở thư mục, "Dùng làm tham chiếu" (đưa ảnh sang form Tạo mới).
- **Cài đặt:** các khóa trong §5.

## 10. Kiểm thử

1. **Unit (node:test):** `planner`, `classify`, các lệnh ffmpeg dựng ra, chọn tài khoản/cooldown/giới hạn ngày/khoảng nghỉ trong `scheduler`, `store` (ghi an toàn, khôi phục).
2. **ffmpeg thật:** sinh video thử 1152×768 và 1280×720, 10 giây, có âm thanh (`testsrc` + `sine`) → chạy lastFrame, nối 2 clip, cắt 15 giây, upscale → `ffprobe` kiểm tra kích thước, thời lượng (±0,1 giây), có luồng âm thanh.
3. **Toàn luồng với `fakeDriver`:** 2 tài khoản giả, 5 việc, một tài khoản bị LIMIT giữa chừng → kiểm tra việc chuyển tài khoản, đủ file đầu ra, trạng thái cuối đúng.
4. **Thật trên muse.ai** (hỏi người dùng trước vì tốn lượt): đính kèm rồi gỡ (không gửi) để kiểm tra luồng đính kèm → 1 việc ảnh có tham chiếu → 1 video 15 giây 1080p.

## 11. Rủi ro và giới hạn

- **Điều khoản:** tự động hóa và dùng nhiều tài khoản có thể vi phạm điều khoản của Meta, nên có nguy cơ bị khóa tài khoản. Khoảng nghỉ ngẫu nhiên và giới hạn ngày chỉ giảm rủi ro, không loại bỏ được.
- **Giao diện thay đổi:** Meta đổi HTML thì phải sửa `selectors.js`. Tool báo lỗi rõ ràng kèm ảnh chụp để dễ sửa.
- **1080p là phóng to:** đúng kích thước 1080p, nhưng chi tiết không bằng video gốc 1080p.
- **Nối clip:** chỗ nối có thể không liền mạch hoàn toàn.
- **Trợ lý có thể "nói chuyện" thay vì làm** (hỏi lại, gợi ý). Mẫu tin nhắn yêu cầu "không cần hỏi lại", và nếu không có media thì thử lại.
- **Chat dài dần:** mọi việc dùng chung khung chat chính của tài khoản. Nếu sau này thấy chậm, sẽ thêm bước mở chat mới cho mỗi việc.

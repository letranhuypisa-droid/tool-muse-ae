# Muse Manager

Tool chạy trên máy để quản lý nhiều tài khoản **muse.ai** và tạo ảnh/video hàng loạt: nhập prompt, đính kèm ảnh tham chiếu, chọn thời lượng video, xuất 1080p, rồi tải kết quả về máy.

## Cần có

- Windows, **Node.js 24** trở lên
- **ffmpeg** (cài bằng `winget install Gyan.FFmpeg`)
- **Google Chrome** (nếu không có, tool sẽ dùng Microsoft Edge)

## Chạy tool

Bấm đúp **`start.bat`**. Lần đầu tool tự cài thư viện, sau đó mở trang `http://localhost:3000` trong trình duyệt. Giữ cửa sổ đen (console) mở trong lúc dùng. Muốn tắt tool thì đóng cửa sổ đó hoặc bấm Ctrl+C.

## Thêm tài khoản

1. Vào tab **Tài khoản**, gõ tên gợi nhớ, bấm **Thêm tài khoản**.
2. Tool mở một cửa sổ Chrome riêng cho tài khoản đó. Bạn **tự đăng nhập muse.ai** trong cửa sổ này.
3. Quay lại tool, bấm **Đã đăng nhập**. Trạng thái chuyển sang "Sẵn sàng".

Mỗi tài khoản có một hồ sơ Chrome riêng trong thư mục `profiles/`, nên các phiên đăng nhập không lẫn vào nhau. Tool **không lưu mật khẩu**. Nếu muse.ai đăng xuất, tài khoản sẽ chuyển về "Cần đăng nhập": bấm **Mở cửa sổ**, đăng nhập lại, rồi bấm **Đã đăng nhập**.

**Cửa sổ Chrome chỉ hiện lúc đăng nhập.** Sau đó mọi việc tạo ảnh/video chạy trong một cửa sổ Chrome đặt ngoài màn hình: bạn không thấy nó, chỉ có thể thấy biểu tượng Chrome trên thanh taskbar trong lúc tool đang tạo. Tool không dùng Chrome headless, vì muse.ai không nhận tin nhắn gửi từ đó. Muốn nhìn tool làm việc, bỏ chọn "Chạy ẩn" trong **Cài đặt**.

## Tạo ảnh / video

Vào tab **Tạo mới**:

- Chọn **Ảnh** hoặc **Video**, nhập prompt, kéo thả ảnh tham chiếu nếu cần (tối đa 9 ảnh).
- **Nhập nhiều prompt**: mỗi dòng sẽ thành một việc riêng.
- **Số bản**: tạo nhiều bản cho cùng một prompt.
- Bấm **Thêm vào hàng đợi**.

Tool tự chia việc cho các tài khoản đang sẵn sàng, mặc định chạy **3 việc cùng lúc** (chỉnh trong **Cài đặt**). Tiến độ xem ở tab **Hàng đợi**, kết quả xem ở tab **Thư viện**.

### Thời lượng và 1080p hoạt động thế nào

- muse.ai luôn tạo clip **10 giây**, độ phân giải khoảng 720p–768p.
- **Dưới 10 giây**: tool cắt bớt clip cho đúng số giây bạn chọn.
- **Trên 10 giây**: tool tạo nhiều clip nối nhau. Clip sau dùng khung hình cuối của clip trước làm ảnh tham chiếu, sau đó tool ghép lại và cắt đúng số giây. Chỗ nối có thể không liền mạch 100%.
- **1080p**: tool phóng video lên 1080 ở cạnh ngắn (ví dụ 1152×768 thành 1620×1080). File ra đúng kích thước 1080p nhưng chi tiết không nét bằng video gốc 1080p.

## Dùng bằng dòng lệnh (và với Claude Code)

Mọi việc trên giao diện đều làm được bằng lệnh `npm run muse -- <lệnh>`:

```bash
npm run muse -- start
npm run muse -- status
npm run muse -- add --prompt "Bãi cọc Bạch Đằng lúc bình minh" --type image --wait
npm run muse -- add --prompt "Drone bay qua bãi cọc" --duration 15 --ref downloads/2026-11-02/anh.webp --wait
npm run muse -- batch scenes.json --wait
```

Lệnh `start` bật tool ngầm và không mở trình duyệt. `npm run muse -- help` liệt kê đủ các lệnh và tùy chọn. Thêm `--json` để in kết quả dạng JSON.

Khi mở thư mục này trong một phiên **Claude Code**, Claude sẽ đọc [CLAUDE.md](CLAUDE.md) để biết cách dùng tool, gồm quy trình gợi ý cho kênh lịch sử: tạo ảnh chủ đạo cho từng cảnh trước, rồi tạo video lấy ảnh đó làm tham chiếu. Claude không đăng nhập thay bạn: khi một tài khoản cần đăng nhập, Claude sẽ nhờ bạn.

## File nằm ở đâu

| Thư mục | Nội dung |
|---|---|
| `downloads/YYYY-MM-DD/` | Ảnh và video hoàn chỉnh |
| `downloads/raw/` | Các clip gốc 10 giây từ muse.ai |
| `data/` | Danh sách tài khoản, hàng đợi, cài đặt |
| `data/errors/` | Ảnh chụp màn hình khi có lỗi (để dò lỗi) |
| `profiles/` | Hồ sơ Chrome của từng tài khoản (chứa phiên đăng nhập, đừng chia sẻ thư mục này) |

**Nên đặt tool ngoài OneDrive**, ví dụ `C:\dev\muse-manager`. Hồ sơ Chrome ghi file liên tục, khiến OneDrive đồng bộ suốt và đôi khi khóa file. Chuyển cả thư mục (gồm `profiles/` và `data/`) thì không phải đăng nhập lại. Nếu clone repo từ git sang chỗ mới, `profiles/` không đi theo, nên phải đăng nhập lại từng tài khoản.

## Khi gặp lỗi

- **Tài khoản "Hết lượt"**: tool tự nghỉ tài khoản đó 24 giờ (chỉnh trong Cài đặt) và chuyển việc sang tài khoản khác.
- **Việc báo "Lỗi"**: xem dòng lỗi trong tab Hàng đợi và ảnh chụp trong `data/errors/`, rồi bấm **Thử lại**.
- **Meta đổi giao diện muse.ai** nên tool không bấm được nữa: các "điểm bám" vào trang nằm trong `src/muse/selectors.js`, sửa ở đó.
- Muốn tool nhận ra câu báo hết lượt/từ chối mới: thêm từ khóa vào `src/muse/classify.js`.

## Lưu ý về rủi ro

Dùng công cụ tự động và nhiều tài khoản có thể vi phạm điều khoản của Meta, nên có nguy cơ bị khóa tài khoản. Khoảng nghỉ ngẫu nhiên giữa các việc và giới hạn việc mỗi ngày (trong Cài đặt) giảm rủi ro này nhưng không loại bỏ được.

## Dành cho người phát triển

```bash
npm install
npm test
```

Bộ test dùng Chrome thật (chế độ ẩn) với một trang "muse.ai giả", và ffmpeg thật với video tạo sẵn, nên không tốn lượt nào trên muse.ai.
